const gameLogic = require('./public/logic.js');
const {
    findRoomAndPlayerByUniqueId, findRoomBySocketId,
    saveRoom, setPlayerRoomIndex, setSocketRoomIndex, delSocketRoomIndex
} = require('./redisClient.js');
const { sortCards, updateRoomState, startGame, endTurn, endManche, endGame } = require('./gameEngine.js');

const MAX_PLAYERS = 4;

/** Secondi di attesa prima di saltare il turno di un giocatore disconnesso */
const SKIP_TURN_DELAY_MS = 30_000;

// Timers per saltare il turno ai giocatori disconnessi: uniquePlayerId → timeout handle
const disconnectTimers = new Map();

// ------------------------------------------------------------------
// RATE LIMITING  (max 20 eventi/secondo per socket)
// ------------------------------------------------------------------
const rateLimiter = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 1000;

function checkRateLimit(socketId) {
    const now = Date.now();
    let entry = rateLimiter.get(socketId);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    }
    entry.count++;
    rateLimiter.set(socketId, entry);
    return entry.count <= RATE_LIMIT;
}

// ------------------------------------------------------------------
// VALIDAZIONE INPUT
// ------------------------------------------------------------------

/**
 * Sanifica il nome del giocatore: stringa, 1-20 caratteri, non solo spazi.
 * Restituisce la stringa ripulita oppure null se non valida.
 */
function sanitizePlayerName(name) {
    if (typeof name !== 'string') return null;
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (trimmed.length < 1 || trimmed.length > 20) return null;
    return trimmed;
}

/**
 * Registra tutti gli event handler Socket.IO per un socket connesso.
 */
function registerHandlers(io, socket, redisClient) {

    console.log(`Un utente si è connesso: ${socket.id}`);

    // Rate limiting middleware: blocca socket che inviano troppi eventi
    socket.use(([event], next) => {
        if (!checkRateLimit(socket.id)) {
            return socket.emit('error', 'Troppe richieste. Rallenta!');
        }
        next();
    });

    // ------------------------------------------------------------------
    // GESTIONE STANZE
    // ------------------------------------------------------------------

    socket.on('createRoom', async ({ playerName, uniquePlayerId }) => {
        const name = sanitizePlayerName(playerName);
        if (!name) return socket.emit('error', 'Nome giocatore non valido (1-20 caratteri).');

        let roomCode = generateRoomCode();
        while (await redisClient.exists(`room:${roomCode}`)) {
            roomCode = generateRoomCode();
        }

        socket.join(roomCode);
        socket.roomCode = roomCode;

        const newUniqueId = uniquePlayerId || generateUniqueId();
        const room = {
            hostId: socket.id,
            players: {
                [socket.id]: createPlayerObject(socket.id, name, newUniqueId)
            },
            gameState: createInitialGameState(roomCode)
        };

        await saveRoom(roomCode, room);
        await setPlayerRoomIndex(newUniqueId, roomCode);
        await setSocketRoomIndex(socket.id, roomCode);
        socket.emit('roomCreated', { roomCode, playerId: socket.id, uniquePlayerId: newUniqueId });
        updateRoomState(roomCode, room);
    });

    socket.on('joinRoom', async ({ roomCode, playerName, uniquePlayerId }) => {
        const name = sanitizePlayerName(playerName);
        if (!name) return socket.emit('error', 'Nome giocatore non valido (1-20 caratteri).');

        roomCode = roomCode.toUpperCase();
        const roomDataString = await redisClient.get(`room:${roomCode}`);
        if (!roomDataString) return socket.emit('error', 'Stanza non trovata.');

        const room = JSON.parse(roomDataString);
        if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('error', 'La stanza è piena.');
        if (room.gameState.gamePhase !== 'waiting') return socket.emit('error', 'La partita è già iniziata.');

        socket.join(roomCode);
        socket.roomCode = roomCode;

        const newUniqueId = uniquePlayerId || generateUniqueId();
        room.players[socket.id] = createPlayerObject(socket.id, name, newUniqueId);

        await saveRoom(roomCode, room);
        await setPlayerRoomIndex(newUniqueId, roomCode);
        await setSocketRoomIndex(socket.id, roomCode);
        socket.emit('joinedRoom', { uniquePlayerId: newUniqueId });
        updateRoomState(roomCode, room);
    });

    socket.on('reconnectPlayer', async ({ uniquePlayerId }) => {
        if (!uniquePlayerId) return;

        // Annulla il timer di skip turno se il giocatore si riconnette in tempo
        if (disconnectTimers.has(uniquePlayerId)) {
            clearTimeout(disconnectTimers.get(uniquePlayerId));
            disconnectTimers.delete(uniquePlayerId);
        }

        const { roomCode, room, oldSocketId } = await findRoomAndPlayerByUniqueId(uniquePlayerId);
        if (!roomCode || !room || !oldSocketId || !room.players[oldSocketId]) return;

        const newSocketId = socket.id;
        const playerData = room.players[oldSocketId];

        if (oldSocketId !== newSocketId) {
            delete room.players[oldSocketId];
            playerData.id = newSocketId;
            room.players[newSocketId] = playerData;

            if (room.gameState.currentPlayerId === oldSocketId) room.gameState.currentPlayerId = newSocketId;
            if (room.hostId === oldSocketId) room.hostId = newSocketId;

            // Aggiorna gli indici: rimuove il vecchio socketId, aggiunge il nuovo
            await delSocketRoomIndex(oldSocketId);
        }

        socket.join(roomCode);
        socket.roomCode = roomCode;

        await saveRoom(roomCode, room);
        await setPlayerRoomIndex(uniquePlayerId, roomCode);
        await setSocketRoomIndex(newSocketId, roomCode);
        updateRoomState(roomCode, room);
        console.log(`Giocatore ${playerData.name} riconnesso alla stanza ${roomCode}.`);
    });

    socket.on('startGameRequest', async (customMancheOrder) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;

        const isHost = room.hostId === socket.id;
        const hasEnoughPlayers = Object.keys(room.players).length >= 2;
        if (!isHost || !hasEnoughPlayers) return;

        const defaultOrder = gameLogic.manches.map(m => m.requirement);
        room.gameState.mancheOrder = (customMancheOrder?.length === defaultOrder.length)
            ? customMancheOrder
            : defaultOrder;

        await saveRoom(roomCode, room);
        await startGame(roomCode);
    });

    // ------------------------------------------------------------------
    // SCELTA MANCHE
    // ------------------------------------------------------------------

    socket.on('chooseNextManche', async ({ choice }) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;

        const state = room.gameState;
        const winnerId = state.currentPlayerId;
        if (socket.id !== winnerId || state.gamePhase !== 'choose_next_manche') return;

        const playedManches = state.mancheOrder.slice(0, state.currentManche - 1);
        let remaining = gameLogic.manches.map(m => m.requirement).filter(r => !playedManches.includes(r));

        if (!remaining.includes(choice)) return;

        remaining = remaining.filter(r => r !== choice);
        state.mancheOrder = [...playedManches, choice, ...remaining];

        const chosen = gameLogic.manches.find(m => m.requirement === choice);
        io.to(roomCode).emit('message', {
            title: "Prossima Manche Scelta",
            message: `${room.players[winnerId].name} ha scelto: ${chosen.name}`
        });

        await saveRoom(roomCode, room);
        setTimeout(() => startGame(roomCode), 4000);
    });

    // ------------------------------------------------------------------
    // AGGIORNAMENTO GRUPPI (drag & drop)
    // ------------------------------------------------------------------

    socket.on('updateGroups', async (newGroups) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const data = await redisClient.get(`room:${roomCode}`);
        if (!data) return;
        const room = JSON.parse(data);

        if (room.players[socket.id]) {
            room.players[socket.id].groups = newGroups;
            await saveRoom(roomCode, room);
        }
    });

    // ------------------------------------------------------------------
    // PRENOTAZIONE SCARTO
    // ------------------------------------------------------------------

    socket.on('bookDiscard', async () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;

        const state = room.gameState;
        // Solo i giocatori non di turno, durante la fase di pesca, possono prenotare
        if (state.currentPlayerId === socket.id || state.turnPhase !== 'draw') return;

        if (!state.discardRequests) state.discardRequests = [];
        if (state.discardRequests.includes(socket.id)) return;

        state.discardRequests.push(socket.id);
        await saveRoom(roomCode, room);

        socket.emit('message', { title: "Prenotazione", message: "Hai richiesto lo scarto. Se hai la priorità, sarà tuo." });
        io.to(roomCode).emit('discardBookedUpdate', { count: state.discardRequests.length });
    });

    // ------------------------------------------------------------------
    // PESCA
    // ------------------------------------------------------------------

    socket.on('drawFromDeck', async () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;

        const state = room.gameState;
        const currentPlayer = room.players[socket.id];
        if (!currentPlayer || state.currentPlayerId !== socket.id || state.hasDrawn) return;

        // Rimescola il pozzo se il mazzo è finito
        if (state.deck.length === 0) {
            if (state.discardPile.length <= 1) {
                return socket.emit('message', { title: "Mazzo vuoto", message: "Non ci sono più carte." });
            }
            const topDiscard = state.discardPile.pop();
            state.deck = gameLogic.shuffleDeck(state.discardPile);
            state.discardPile = [topDiscard];
            io.to(roomCode).emit('message', { title: "Mazzo Terminato", message: "Il pozzo degli scarti è stato rimescolato." });
        }

        // Assegna lo scarto a chi aveva prenotato (priorità di giro)
        if (state.discardRequests?.length > 0 && state.discardPile.length > 0) {
            const winnerId = pickDiscardWinner(state.discardRequests, state.currentPlayerId, room.players);
            if (winnerId) {
                const bookingPlayer = room.players[winnerId];
                const stolenCard = state.discardPile.pop();
                bookingPlayer.hand.push(stolenCard);
                if (!bookingPlayer.groups?.length) bookingPlayer.groups = [[]];
                bookingPlayer.groups[0].push(stolenCard.id);

                io.to(roomCode).emit('message', {
                    title: "Scarto Assegnato",
                    message: `${bookingPlayer.name} prende lo scarto (priorità di giro).`
                });
            }
        }
        state.discardRequests = [];

        // Pesca normale dal mazzo per il giocatore di turno
        const card = state.deck.pop();
        currentPlayer.hand.push(card);
        if (!currentPlayer.groups?.length) currentPlayer.groups = [[]];
        currentPlayer.groups[0].unshift(card.id);

        state.hasDrawn = true;
        state.turnPhase = 'play';

        await saveRoom(roomCode, room);
        updateRoomState(roomCode, room);
    });

    socket.on('drawFromDiscard', async () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;

        const state = room.gameState;
        const player = room.players[socket.id];
        if (!player || state.currentPlayerId !== socket.id || state.hasDrawn) return;
        if (state.discardPile.length === 0) {
            return socket.emit('message', { title: "Scarto vuoto", message: "Non ci sono carte da pescare." });
        }

        // Il giocatore di turno ha la priorità su chiunque avesse prenotato
        state.discardRequests = [];
        state.pendingDiscardRequest = null;

        const card = state.discardPile.pop();
        player.hand.push(card);
        if (!player.groups?.length) player.groups = [[]];
        player.groups[0].unshift(card.id);

        state.hasDrawn = true;
        state.turnPhase = 'play';

        await saveRoom(roomCode, room);
        updateRoomState(roomCode, room);
    });

    // ------------------------------------------------------------------
    // SCARTO
    // ------------------------------------------------------------------

    socket.on('discardCard', async (cardIndex) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;

        const state = room.gameState;
        const player = room.players[socket.id];
        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn) return;
        if (cardIndex < 0 || cardIndex >= player.hand.length) return;

        // Regola speciale Scala: non si può scartare 5 o 10 prima di aver calato
        const mancheReq = state.mancheOrder[state.currentManche - 1];
        if (mancheReq === 'scala' && !player.dressed) {
            const cardToDiscard = player.hand[cardIndex];
            if (cardToDiscard.value === '5' || cardToDiscard.value === '10') {
                return socket.emit('message', {
                    title: "Mossa non Permessa",
                    message: "Nella manche Scala, non puoi scartare un 5 o un 10 finché non hai calato."
                });
            }
        }

        const discarded = player.hand.splice(cardIndex, 1)[0];
        player.groups.forEach(group => {
            const i = group.indexOf(discarded.id);
            if (i > -1) group.splice(i, 1);
        });
        state.discardPile.push(discarded);

        await saveRoom(roomCode, room);

        if (player.hand.length === 0) {
            await endManche(roomCode);
        } else {
            await endTurn(roomCode);
        }
    });

    // ------------------------------------------------------------------
    // CALATA (DRESS HAND)
    // ------------------------------------------------------------------

    socket.on('dressHand', async (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;

        const { selectedIndexes, jokerAssignments = [] } = data;
        const state = room.gameState;
        const player = room.players[socket.id];
        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn || player.dressed) return;

        const originalCards = selectedIndexes.map(i => player.hand[i]);
        if (originalCards.some(c => c === undefined)) return;

        const mancheReq = state.mancheOrder[state.currentManche - 1];
        const hasJoker = originalCards.some(c => c.isJoker);

        if (hasJoker && mancheReq !== 'chiusura in mano') {
            return socket.emit('message', {
                title: "Mossa non Permessa",
                message: "Non puoi usare un Jolly per calare la combinazione principale."
            });
        }

        const virtualCards = applyJokerAssignments(originalCards, player.hand, jokerAssignments);
        const manche = gameLogic.manches.find(m => m.requirement === mancheReq);
        if (!manche) return;

        if (!gameLogic.validateCombination(virtualCards, manche.requirement)) {
            return socket.emit('message', {
                title: "Combinazione non valida",
                message: `La regola della manche (${manche.name}) non è soddisfatta.`
            });
        }

        const selectedIds = originalCards.map(c => c.id);
        player.hand = player.hand.filter(c => !selectedIds.includes(c.id));
        player.groups.forEach(g => g.splice(0, g.length, ...g.filter(id => !selectedIds.includes(id))));

        if (manche.requirement === 'scala') sortCards(originalCards);
        state.tableCombinations.push({ player: player.name, type: manche.name, cards: originalCards });
        player.dressed = true;

        await saveRoom(roomCode, room);
        updateRoomState(roomCode, room);
        socket.emit('message', { title: "Ben fatto!", message: `Hai calato: ${manche.name}` });
    });

    // ------------------------------------------------------------------
    // ATTACCA CARTE
    // ------------------------------------------------------------------

    socket.on('attachCards', async (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;

        const { selectedIndexes, jokerAssignments = [] } = data;
        const state = room.gameState;
        const player = room.players[socket.id];
        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed) return;

        const originalCards = selectedIndexes.map(i => player.hand[i]);
        if (originalCards.some(c => c === undefined)) return;

        const virtualCards = applyJokerAssignments(originalCards, player.hand, jokerAssignments);
        let moveMade = false;

        // Caso 1: Nuova combinazione (Tris o Scala)
        if (selectedIndexes.length >= 3) {
            let type = null;
            if (gameLogic.isValidSet(virtualCards)) {
                type = virtualCards.length === 4 ? 'Poker' : 'Tris';
            } else if (gameLogic.isValidRun(virtualCards)) {
                type = 'Scala';
            }

            if (type) {
                const ids = originalCards.map(c => c.id);
                player.hand = player.hand.filter(c => !ids.includes(c.id));
                player.groups.forEach(g => g.splice(0, g.length, ...g.filter(id => !ids.includes(id))));
                if (type === 'Scala') sortCards(originalCards);
                state.tableCombinations.push({ player: player.name, type, cards: originalCards });
                socket.emit('message', { title: "Combinazione Calata!", message: `Hai formato: ${type}.` });
                moveMade = true;
            }
        }

        // Caso 2: Attacca a combinazione esistente
        if (!moveMade) {
            for (const combo of state.tableCombinations) {
                const combined = [...combo.cards, ...virtualCards];
                if (gameLogic.isValidSet(combined) || gameLogic.isValidRun(combined)) {
                    const ids = originalCards.map(c => c.id);
                    player.hand = player.hand.filter(c => !ids.includes(c.id));
                    player.groups.forEach(g => g.splice(0, g.length, ...g.filter(id => !ids.includes(id))));
                    combo.cards.push(...originalCards);
                    if (gameLogic.isValidRun(combined)) {
                        combo.type = 'Scala';
                        sortCards(combo.cards);
                    }
                    socket.emit('message', { title: "Carte Attaccate!", message: "Hai attaccato con successo." });
                    moveMade = true;
                    break;
                }
            }
        }

        if (moveMade) {
            await saveRoom(roomCode, room);
            updateRoomState(roomCode, room);
        } else {
            socket.emit('message', { title: "Mossa non valida", message: "Le carte non formano un gioco valido." });
        }
    });

    // ------------------------------------------------------------------
    // SCAMBIO JOLLY
    // ------------------------------------------------------------------

    socket.on('swapJoker', async ({ handCardId, tableJokerId, comboIndex }) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;

        const state = room.gameState;
        const player = room.players[socket.id];
        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed) return;

        const combo = state.tableCombinations[comboIndex];
        const jokerOnTable = combo?.cards.find(c => c.id === tableJokerId);
        const cardInHand = player.hand.find(c => c.id === handCardId);

        if (!jokerOnTable || !cardInHand || !jokerOnTable.assignedValue) return;

        if (cardInHand.value !== jokerOnTable.assignedValue || cardInHand.suit !== jokerOnTable.assignedSuit) {
            return socket.emit('message', {
                title: "Scambio non valido",
                message: "La carta non corrisponde al Jolly (controlla valore e seme)."
            });
        }

        const jokerIndex = combo.cards.findIndex(c => c.id === tableJokerId);
        const handIndex = player.hand.findIndex(c => c.id === handCardId);

        const cleanJoker = { ...jokerOnTable };
        delete cleanJoker.assignedValue;
        delete cleanJoker.assignedSuit;

        combo.cards[jokerIndex] = cardInHand;
        player.hand[handIndex] = cleanJoker;

        player.groups.forEach(g => {
            const i = g.indexOf(handCardId);
            if (i > -1) g[i] = jokerOnTable.id;
        });

        if (combo.type === 'Scala') sortCards(combo.cards);

        await saveRoom(roomCode, room);
        updateRoomState(roomCode, room);
        socket.emit('message', { title: "Scambio Riuscito!", message: "Hai preso il Jolly!" });
    });

    // ------------------------------------------------------------------
    // DISCONNESSIONE
    // ------------------------------------------------------------------

    socket.on('disconnect', async () => {
        // Pulisce l'entry del rate limiter
        rateLimiter.delete(socket.id);
        // Rimuove l'indice socket
        await delSocketRoomIndex(socket.id);

        const { roomCode, room } = await findRoomBySocketId(socket.id);
        if (!room) return;

        const player = room.players[socket.id];
        const name = player?.name || socket.id;
        console.log(`Giocatore ${name} disconnesso da ${roomCode}`);

        // Se era il turno del giocatore disconnesso, avvia un timer per saltarlo
        if (
            room.gameState.gamePhase === 'playing' &&
            room.gameState.currentPlayerId === socket.id &&
            player?.uniquePlayerId
        ) {
            const uniqueId = player.uniquePlayerId;
            const oldSocketId = socket.id;

            const timer = setTimeout(async () => {
                disconnectTimers.delete(uniqueId);
                const roomData = await redisClient.get(`room:${roomCode}`);
                if (!roomData) return;
                const currentRoom = JSON.parse(roomData);
                // Salta solo se il giocatore è ancora disconnesso (stesso socketId = non riconnesso)
                if (currentRoom.gameState.currentPlayerId !== oldSocketId) return;
                io.to(roomCode).emit('message', {
                    title: "Turno Saltato",
                    message: `${name} è disconnesso. Turno passato automaticamente.`
                });
                await endTurn(roomCode);
            }, SKIP_TURN_DELAY_MS);

            disconnectTimers.set(uniqueId, timer);
        }
    });
}

// ------------------------------------------------------------------
// FUNZIONI HELPER PRIVATE
// ------------------------------------------------------------------

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateUniqueId() {
    return `player_${Math.random().toString(36).substring(2, 15)}`;
}

function createPlayerObject(socketId, name, uniquePlayerId) {
    return { id: socketId, name, uniquePlayerId, hand: [], score: 0, dressed: false, groups: [] };
}

function createInitialGameState(roomCode) {
    return {
        roomCode,
        players: {},
        currentPlayerId: null,
        currentManche: 1,
        deck: [],
        discardPile: [],
        tableCombinations: [],
        gamePhase: 'waiting',
        turnPhase: 'draw',
        hasDrawn: false,
        mancheOrder: [],
        discardRequests: [],
        pendingDiscardRequest: null
    };
}

/**
 * Determina chi tra i richiedenti ha la priorità di giro (il più vicino al giocatore di turno).
 */
function pickDiscardWinner(requesters, currentPlayerId, players) {
    const playerIds = Object.keys(players);
    const currentIndex = playerIds.indexOf(currentPlayerId);

    let winnerId = null;
    let minDistance = Infinity;

    requesters.forEach(requesterId => {
        const reqIndex = playerIds.indexOf(requesterId);
        const distance = (reqIndex - currentIndex + playerIds.length) % playerIds.length;
        if (distance > 0 && distance < minDistance) {
            minDistance = distance;
            winnerId = requesterId;
        }
    });

    return winnerId;
}

/**
 * Sostituisce i jolly nelle carte selezionate con le loro assegnazioni virtuali.
 */
function applyJokerAssignments(originalCards, fullHand, jokerAssignments) {
    const virtualCards = JSON.parse(JSON.stringify(originalCards));
    jokerAssignments.forEach(assignment => {
        const jokerInHand = fullHand[assignment.index];
        if (!jokerInHand?.isJoker) return;

        const idx = virtualCards.findIndex(c => c.id === jokerInHand.id);
        if (idx !== -1) {
            virtualCards[idx] = { ...assignment.becomes, isVirtual: true, points: gameLogic.getCardPoints(assignment.becomes.value) };
            const orig = originalCards.find(c => c.id === jokerInHand.id);
            if (orig) {
                orig.assignedValue = assignment.becomes.value;
                orig.assignedSuit = assignment.becomes.suit;
            }
        }
    });
    return virtualCards;
}

module.exports = { registerHandlers };
