const gameLogic = require('./public/logic.js');

let _io;
let _redisClient;

function init(io, redisClient) {
    _io = io;
    _redisClient = redisClient;
}

// ============================================
// ORDINAMENTO CARTE (Asso Basso/Alto)
// ============================================
function sortCards(cards) {
    const hasKing = cards.some(c => (c.isJoker && c.assignedValue === 'K') || c.value === 'K');
    const hasAce  = cards.some(c => (c.isJoker && c.assignedValue === 'A') || c.value === 'A');
    const aceIsHigh = hasKing && hasAce;

    const getVal = (card) => {
        const v = (card.isJoker && card.assignedValue) ? card.assignedValue : card.value;
        if (v === 'A') return aceIsHigh ? 14 : 1;
        if (v === 'K') return 13;
        if (v === 'Q') return 12;
        if (v === 'J') return 11;
        return parseInt(v);
    };

    cards.sort((a, b) => getVal(a) - getVal(b));
}

// ============================================
// AGGIORNAMENTO STATO AI CLIENT
// ============================================
async function updateRoomState(roomCode, roomObject = null) {
    let room = roomObject;
    if (!room) {
        const data = await _redisClient.get(`room:${roomCode}`);
        if (!data) return;
        room = JSON.parse(data);
    }

    let currentMancheData = null;
    const { gameState } = room;
    if (gameState.gamePhase === 'playing' && gameState.mancheOrder?.length > 0) {
        const req = gameState.mancheOrder[gameState.currentManche - 1];
        currentMancheData = gameLogic.manches.find(m => m.requirement === req);
    }

    // Stato pubblico (niente mazzo, niente mani)
    const publicState = {
        ...gameState,
        players: {},
        deckCount: gameState.deck.length,
        hostId: room.hostId,
        mancheOrder: gameState.mancheOrder,
        currentMancheData
    };
    delete publicState.deck;

    for (const pid in room.players) {
        const p = room.players[pid];
        publicState.players[pid] = {
            id: pid,
            name: p.name,
            uniquePlayerId: p.uniquePlayerId,
            cardCount: p.hand.length,
            score: p.score,
            dressed: p.dressed,
        };
    }

    // Invia a ciascun giocatore il proprio stato privato (mano + gruppi)
    for (const pid in room.players) {
        const socket = _io.sockets.sockets.get(pid);
        if (socket) {
            const p = room.players[pid];
            socket.emit('gameStateUpdate', {
                ...publicState,
                playerHand: p.hand,
                players: {
                    ...publicState.players,
                    [pid]: { ...publicState.players[pid], groups: p.groups }
                }
            });
        }
    }
}

// ============================================
// AVVIO PARTITA / MANCHE
// ============================================
async function startGame(roomCode) {
    const room = JSON.parse(await _redisClient.get(`room:${roomCode}`));
    if (!room) return;

    const state = room.gameState;
    const playerIds = Object.keys(room.players);

    state.gamePhase = 'playing';
    state.turnPhase = 'draw';
    state.hasDrawn = false;
    state.discardRequests = [];
    state.pendingDiscardRequest = null;
    state.deck = gameLogic.createDeck();
    state.tableCombinations = [];

    // Reset mani (i punteggi persistono tra manche)
    playerIds.forEach(pid => {
        room.players[pid].hand = [];
        room.players[pid].dressed = false;
    });

    // Distribuisci carte: 13 per 2 giocatori, 11 per 3-4
    const cardsToDeal = playerIds.length > 2 ? 11 : 13;
    for (let i = 0; i < cardsToDeal; i++) {
        for (const pid of playerIds) {
            if (state.deck.length > 0) room.players[pid].hand.push(state.deck.pop());
        }
    }

    // Crea i gruppi visivi per il frontend
    playerIds.forEach(pid => {
        room.players[pid].groups = [room.players[pid].hand.map(c => c.id)];
    });

    // Prima carta nello scarto, giocatore iniziale casuale
    state.discardPile = [state.deck.pop()];
    state.currentPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];

    await _redisClient.set(`room:${roomCode}`, JSON.stringify(room));
    updateRoomState(roomCode, room);
}

// ============================================
// FINE TURNO
// ============================================
async function endTurn(roomCode) {
    const room = JSON.parse(await _redisClient.get(`room:${roomCode}`));
    if (!room) return;

    const state = room.gameState;
    const playerIds = Object.keys(room.players);
    if (playerIds.length === 0) {
        await _redisClient.del(`room:${roomCode}`);
        return;
    }

    const currentIndex = playerIds.indexOf(state.currentPlayerId);
    state.pendingDiscardRequest = null;
    state.discardRequests = [];
    state.hasDrawn = false;
    state.turnPhase = 'draw';
    state.currentPlayerId = playerIds[(currentIndex + 1) % playerIds.length] || playerIds[0];

    await _redisClient.set(`room:${roomCode}`, JSON.stringify(room));
    // Piccolo delay per dare tempo al client di animare la carta scartata
    setTimeout(() => updateRoomState(roomCode, null), 200);
}

// ============================================
// FINE MANCHE
// ============================================
async function endManche(roomCode) {
    const room = JSON.parse(await _redisClient.get(`room:${roomCode}`));
    if (!room) return;

    const state = room.gameState;
    const winnerId = state.currentPlayerId;
    const winner = room.players[winnerId];

    // Calcola punti penalità per chi ha ancora carte in mano
    const scoreLines = [];
    Object.values(room.players).forEach(player => {
        const penalty = (player.id !== winnerId && player.hand)
            ? player.hand.reduce((sum, card) => sum + card.points, 0)
            : 0;
        player.score += penalty;
        scoreLines.push(`${player.name}: ${penalty} (Tot: ${player.score})`);
    });

    _io.to(roomCode).emit('message', {
        title: `Manche ${state.currentManche} Vinta da ${winner.name}!`,
        message: `Punteggi:\n${scoreLines.join('\n')}`
    });

    state.currentManche++;

    if (state.currentManche > state.mancheOrder.length) {
        await _redisClient.set(`room:${roomCode}`, JSON.stringify(room));
        await endGame(roomCode);
    } else {
        state.gamePhase = 'choose_next_manche';
        await _redisClient.set(`room:${roomCode}`, JSON.stringify(room));

        const playedManches = state.mancheOrder.slice(0, state.currentManche - 1);
        const remainingManches = gameLogic.manches.filter(m => !playedManches.includes(m.requirement));
        _io.to(roomCode).emit('promptChooseNextManche', { winnerId, winnerName: winner.name, remainingManches });
    }
}

// ============================================
// FINE PARTITA
// ============================================
async function endGame(roomCode) {
    const room = JSON.parse(await _redisClient.get(`room:${roomCode}`));
    if (!room) return;

    const sorted = Object.values(room.players).sort((a, b) => a.score - b.score);
    const winner = sorted[0];
    const ranking = sorted.map((p, i) => `${i + 1}. ${p.name} (${p.score} punti)`).join('\n');

    _io.to(roomCode).emit('message', {
        title: "Partita Terminata!",
        message: `Il vincitore è ${winner.name}!\n\nClassifica finale:\n${ranking}`
    });

    await _redisClient.del(`room:${roomCode}`);
}

module.exports = { init, sortCards, updateRoomState, startGame, endTurn, endManche, endGame };
