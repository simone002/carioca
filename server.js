const express = require('express');
require('dotenv').config();
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { createClient } = require('redis');
const gameLogic = require('./public/logic.js');

const app = express();
const server = http.createServer(app);
// ✅ CON QUESTA NUOVA VERSIONE
const io = new Server(server, {
    pingInterval: 5000,
    pingTimeout: 10000,
    cors: {
        origin: "https://carioca-02wq.onrender.com", // Autorizza esplicitamente il tuo sito
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;

// --- Connessione a Redis ---
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', (err) => console.log('Redis Client Error', err));
(async () => { await redisClient.connect(); console.log('Connesso a Redis con successo!'); })();
// -------------------------

app.use(express.static(path.join(__dirname, 'public')));

async function findRoomAndPlayerByUniqueId(uniquePlayerId) {
    const roomKeys = await redisClient.keys('room:*');
    for (const roomKey of roomKeys) {
        try {
            const roomDataString = await redisClient.get(roomKey);
            if (roomDataString) {
                const room = JSON.parse(roomDataString);
                if (room && room.players) {
                    for (const socketId in room.players) {
                        if (room.players[socketId].uniquePlayerId === uniquePlayerId) {
                            return { roomCode: room.gameState.roomCode, room, oldSocketId: socketId };
                        }
                    }
                }
            }
        } catch (e) { console.error(`Errore parsing stanza ${roomKey}:`, e); }
    }
    return { roomCode: null, room: null, oldSocketId: null };
}

async function findRoomBySocketId(socketId) {
    const roomKeys = await redisClient.keys('room:*');
    for (const roomKey of roomKeys) {
        try {
            const roomDataString = await redisClient.get(roomKey);
            if (roomDataString) {
                const room = JSON.parse(roomDataString);
                if (room.players && room.players[socketId]) {
                    return { roomCode: room.gameState.roomCode, room };
                }
            }
        } catch (e) { console.error(`Errore parsing stanza ${roomKey}:`, e); }
    }
    return { roomCode: null, room: null };
}


io.on('connection', (socket) => {
    console.log(`Un utente si è connesso: ${socket.id}`);

    socket.on('createRoom', async ({ playerName, uniquePlayerId }) => {
        let roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        while (await redisClient.exists(`room:${roomCode}`)) {
            roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        }

        socket.join(roomCode);
        socket.roomCode = roomCode;

        const newUniquePlayerId = uniquePlayerId || `player_${Math.random().toString(36).substring(2, 15)}`;
        const room = {
            hostId: socket.id,
            players: { [socket.id]: { id: socket.id, name: playerName, uniquePlayerId: newUniquePlayerId, hand: [], score: 0, dressed: false, groups: [] } },
            gameState: { roomCode, players: {}, currentPlayerId: null, currentManche: 1, deck: [], discardPile: [], tableCombinations: [], gamePhase: 'waiting', turnPhase: 'draw', hasDrawn: false, mancheOrder: [] }
        };

        await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
        socket.emit('roomCreated', { roomCode, playerId: socket.id, uniquePlayerId: newUniquePlayerId });
        updateRoomState(roomCode, room);
    });

    socket.on('joinRoom', async ({ roomCode, playerName, uniquePlayerId }) => {
        roomCode = roomCode.toUpperCase();
        const roomDataString = await redisClient.get(`room:${roomCode}`);
        if (!roomDataString) return socket.emit('error', 'Stanza non trovata.');

        const room = JSON.parse(roomDataString);
        if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('error', 'La stanza è piena.');
        if (room.gameState.gamePhase !== 'waiting') return socket.emit('error', 'La partita è già iniziata.');

        socket.join(roomCode);
        socket.roomCode = roomCode;

        const newUniquePlayerId = uniquePlayerId || `player_${Math.random().toString(36).substring(2, 15)}`;
        room.players[socket.id] = { id: socket.id, name: playerName, uniquePlayerId: newUniquePlayerId, hand: [], score: 0, dressed: false, groups: [] };

        await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
        socket.emit('joinedRoom', { uniquePlayerId: newUniquePlayerId });
        updateRoomState(roomCode, room);
    });

    socket.on('reconnectPlayer', async ({ uniquePlayerId }) => {
        if (!uniquePlayerId) return;
        const { roomCode, room, oldSocketId } = await findRoomAndPlayerByUniqueId(uniquePlayerId);

        if (roomCode && room && oldSocketId && room.players[oldSocketId]) {
            const newSocketId = socket.id;
            const playerData = room.players[oldSocketId];
            
            if (oldSocketId !== newSocketId) {
                delete room.players[oldSocketId];
                playerData.id = newSocketId;
                room.players[newSocketId] = playerData;

                if (room.gameState.currentPlayerId === oldSocketId) room.gameState.currentPlayerId = newSocketId;
                if (room.hostId === oldSocketId) room.hostId = newSocketId;
            }

            socket.join(roomCode);
            socket.roomCode = roomCode;

            await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
            updateRoomState(roomCode, room);
            console.log(`Giocatore ${playerData.name} riconnesso alla stanza ${roomCode}.`);
        }
    });

    socket.on('startGameRequest', async (customMancheOrder) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;

        if (room.hostId === socket.id && Object.keys(room.players).length >= 2) {
            room.gameState.mancheOrder = (customMancheOrder && customMancheOrder.length === gameLogic.manches.length)
                ? customMancheOrder
                : gameLogic.manches.map(m => m.requirement);
            await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
            await startGame(roomCode);
        }
    });

    socket.on('chooseNextManche', async ({ choice }) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;
        const state = room.gameState;
        const winnerId = room.gameState.currentPlayerId;

        if (socket.id !== winnerId || state.gamePhase !== 'choose_next_manche') return;

        const playedManches = state.mancheOrder.slice(0, state.currentManche - 1);
        let remainingManches = gameLogic.manches.map(m => m.requirement).filter(req => !playedManches.includes(req));

        if (remainingManches.includes(choice)) {
            remainingManches = remainingManches.filter(req => req !== choice);
            state.mancheOrder = [...playedManches, choice, ...remainingManches];
            
            const chosenMancheData = gameLogic.manches.find(m => m.requirement === choice);
            io.to(roomCode).emit('message', {
                title: "Prossima Manche Scelta",
                message: `${room.players[winnerId].name} ha scelto: ${chosenMancheData.name}`
            });
            
            await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
            setTimeout(() => startGame(roomCode), 4000);
        }
    });

    socket.on('updateGroups', async (newGroups) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const roomDataString = await redisClient.get(`room:${roomCode}`);
        if (!roomDataString) return;
        const room = JSON.parse(roomDataString);

        if (room.players[socket.id]) {
            room.players[socket.id].groups = newGroups;
            await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
        }
    });

    socket.on('drawFromDeck', async () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;
        const state = room.gameState;
        const player = room.players[socket.id];

        if (!player || state.currentPlayerId !== socket.id || state.hasDrawn) return;
        
        if (state.deck.length === 0) {
            if (state.discardPile.length <= 1) return socket.emit('message', { title: "Mazzo vuoto", message: "Non ci sono più carte." });
            const topDiscard = state.discardPile.pop();
            state.deck = gameLogic.shuffleDeck(state.discardPile);
            state.discardPile = [topDiscard];
            io.to(roomCode).emit('message', { title: "Mazzo Terminato", message: "Il pozzo degli scarti è stato rimescolato." });
        }

        const card = state.deck.pop();
        player.hand.push(card);
        if (!player.groups || player.groups.length === 0) player.groups = [[]];
        player.groups[0].unshift(card.id);
        state.hasDrawn = true;
        state.turnPhase = 'play'; // ✅ RIGA MANCANTE DA AGGIUNGERE

        await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
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
        if (state.discardPile.length === 0) return socket.emit('message', {title: "Scarto vuoto", message: "Non ci sono carte da pescare."});
        
        const card = state.discardPile.pop();
        player.hand.push(card);
        if (!player.groups || player.groups.length === 0) player.groups = [[]];
        player.groups[0].unshift(card.id);
        state.hasDrawn = true;
        state.turnPhase = 'play'; // ✅ RIGA MANCANTE DA AGGIUNGERE
        
        await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
        updateRoomState(roomCode, room);
    });

    socket.on('discardCard', async (cardIndex) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;
        const state = room.gameState;
        const player = room.players[socket.id];
        
        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn) return;
        if (cardIndex < 0 || cardIndex >= player.hand.length) return;
        
        const cardToDiscard = player.hand[cardIndex];
        const currentMancheRequirement = state.mancheOrder[state.currentManche - 1];

        if (currentMancheRequirement === 'scala' && !player.dressed) {
            if (cardToDiscard.value === '5' || cardToDiscard.value === '10') {
                return socket.emit('message', { title: "Mossa non Permessa", message: "Nella manche Scala, non puoi scartare un 5 o un 10 finché non hai calato." });
            }
        }
        
        const discardedCard = player.hand.splice(cardIndex, 1)[0];
        player.groups.forEach(group => {
            const indexInGroup = group.indexOf(discardedCard.id);
            if (indexInGroup > -1) group.splice(indexInGroup, 1);
        });
        state.discardPile.push(discardedCard);
        
        await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
        
        if (player.hand.length === 0) {
            await endManche(roomCode);
        } else {
            await endTurn(roomCode);
        }
    });
    
    socket.on('dressHand', async (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;
        const { selectedIndexes, jokerAssignments = [] } = data;
        const state = room.gameState;
        const player = room.players[socket.id];

        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn || player.dressed) return;
        
        const originalSelectedCards = selectedIndexes.map(i => player.hand[i]);
        if (originalSelectedCards.some(card => card === undefined)) return;
        
        const currentMancheRequirement = state.mancheOrder[state.currentManche - 1];
        const hasJoker = originalSelectedCards.some(card => card.isJoker);

        if (hasJoker && currentMancheRequirement !== 'chiusura in mano') {
            return socket.emit('message', { title: "Mossa non Permessa", message: "Non puoi usare un Jolly per calare la combinazione principale." });
        }
        
        let virtualCards = JSON.parse(JSON.stringify(originalSelectedCards));
        jokerAssignments.forEach(assignment => {
            const jokerInHand = player.hand[assignment.index];
            if (jokerInHand && jokerInHand.isJoker) {
                const virtualCardIndex = virtualCards.findIndex(c => c.id === jokerInHand.id);
                if(virtualCardIndex !== -1){
                    virtualCards[virtualCardIndex] = { ...assignment.becomes, isVirtual: true, points: gameLogic.getCardPoints(assignment.becomes.value) };
                    const originalCard = originalSelectedCards.find(c => c.id === jokerInHand.id);
                    if(originalCard){
                        originalCard.assignedValue = assignment.becomes.value;
                        originalCard.assignedSuit = assignment.becomes.suit;
                    }
                }
            }
        });
        
        const manche = gameLogic.manches.find(m => m.requirement === currentMancheRequirement);
        if (!manche) return;

        if (gameLogic.validateCombination(virtualCards, manche.requirement)) {
            const selectedCardIds = originalSelectedCards.map(c => c.id);
            player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
            player.groups.forEach(group => group.splice(0, group.length, ...group.filter(id => !selectedCardIds.includes(id))));
            state.tableCombinations.push({ player: player.name, type: manche.name, cards: originalSelectedCards });
            player.dressed = true;
            
            await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
            updateRoomState(roomCode, room);
            socket.emit('message', {title: "Ben fatto!", message: `Hai calato: ${manche.name}`});
        } else {
            socket.emit('message', {title: "Combinazione non valida", message: `La regola della manche (${manche.name}) non è soddisfatta.`});
        }
    });

    socket.on('attachCards', async (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;
    
        const { selectedIndexes, jokerAssignments = [] } = data;
        const state = room.gameState;
        const player = room.players[socket.id];
    
        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed) return;
    
        const originalSelectedCards = selectedIndexes.map(i => player.hand[i]);
        if (originalSelectedCards.some(card => card === undefined)) return;
    
        let virtualCards = JSON.parse(JSON.stringify(originalSelectedCards));
        jokerAssignments.forEach(assignment => {
            const jokerInHand = player.hand[assignment.index];
            if(jokerInHand && jokerInHand.isJoker){
                const virtualCardIndex = virtualCards.findIndex(c => c.id === jokerInHand.id);
                if(virtualCardIndex !== -1){
                    virtualCards[virtualCardIndex] = { ...assignment.becomes, isVirtual: true, points: gameLogic.getCardPoints(assignment.becomes.value) };
                    const originalCard = originalSelectedCards.find(c => c.id === jokerInHand.id);
                    if(originalCard){
                        originalCard.assignedValue = assignment.becomes.value;
                        originalCard.assignedSuit = assignment.becomes.suit;
                    }
                }
            }
        });
        
        let moveMade = false;
    
        if (selectedIndexes.length >= 3) {
            let combinationType = null;
            if (gameLogic.isValidSet(virtualCards)) {
                combinationType = virtualCards.length === 3 ? 'Tris' : (virtualCards.length === 4 ? 'Poker' : 'Set');
            } else if (gameLogic.isValidRun(virtualCards)) {
                combinationType = 'Scala';
            }
    
            if (combinationType) {
                const selectedCardIds = originalSelectedCards.map(c => c.id);
                player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
                player.groups.forEach(g => g.splice(0, g.length, ...g.filter(id => !selectedCardIds.includes(id))));
                const newCombination = { player: player.name, type: combinationType, cards: originalSelectedCards };
                if (combinationType === 'Scala') sortCards(newCombination.cards);
                state.tableCombinations.push(newCombination);
                socket.emit('message', { title: "Combinazione Calata!", message: `Hai formato: ${combinationType}.` });
                moveMade = true;
            }
        }
        
        if (!moveMade) {
             for (const combo of state.tableCombinations) {
                const combinedVirtualCards = [...combo.cards, ...virtualCards];
                if (gameLogic.isValidSet(combinedVirtualCards) || gameLogic.isValidRun(combinedVirtualCards)) {
                    const selectedCardIds = originalSelectedCards.map(c => c.id);
                    player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
                    player.groups.forEach(g => g.splice(0, g.length, ...g.filter(id => !selectedCardIds.includes(id))));
                    combo.cards.push(...originalSelectedCards);
                    if (gameLogic.isValidRun(combinedVirtualCards)) {
                        combo.type = 'Scala';
                        sortCards(combo.cards);
                    }
                    socket.emit('message', { title: "Carte Attaccate!", message: `Hai attaccato con successo.` });
                    moveMade = true;
                    break; 
                }
            }
        }
    
        if (moveMade) {
            await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
            updateRoomState(roomCode, room);
        } else {
            socket.emit('message', { title: "Mossa non valida", message: "Le carte non sono valide." });
        }
    });

    socket.on('swapJoker', async ({ handCardId, tableJokerId, comboIndex }) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;
    
        const state = room.gameState;
        const player = room.players[socket.id];
        
        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed) return;
        
        const combo = state.tableCombinations[comboIndex];
        const jokerOnTable = combo ? combo.cards.find(c => c.id === tableJokerId) : null;
        const cardInHand = player.hand.find(c => c.id === handCardId);
        
        if (!jokerOnTable || !cardInHand || !jokerOnTable.assignedValue) return;
    
        if (cardInHand.value === jokerOnTable.assignedValue && cardInHand.suit === jokerOnTable.assignedSuit) {
            const jokerIndexOnTable = combo.cards.findIndex(c => c.id === tableJokerId);
            const handCardIndex = player.hand.findIndex(c => c.id === handCardId);
    
            const cleanJoker = { ...jokerOnTable };
            delete cleanJoker.assignedValue;
            delete cleanJoker.assignedSuit;
    
            combo.cards[jokerIndexOnTable] = cardInHand;
            player.hand[handCardIndex] = cleanJoker;
    
            player.groups.forEach(g => {
                const i = g.indexOf(handCardId);
                if (i > -1) g[i] = jokerOnTable.id;
            });
            
            if (combo.type === 'Scala') sortCards(combo.cards);
            
            await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
            updateRoomState(roomCode, room);
            socket.emit('message', { title: "Scambio Riuscito!", message: "Hai preso il Jolly!" });
        } else {
            socket.emit('message', { title: "Scambio non valido", message: "La carta non corrisponde al Jolly." });
        }
    });



    socket.on('disconnect', async () => {
        const { roomCode, room } = await findRoomBySocketId(socket.id);
        if (roomCode && room) {
            console.log(`Giocatore ${room.players[socket.id]?.name || socket.id} disconnesso da ${roomCode}`);
            // La logica di riconnessione gestirà il rientro. 
            // Potremmo aggiungere un timer per rimuovere definitivamente i giocatori inattivi, ma per ora lo lasciamo così.
        }
    });
});

async function updateRoomState(roomCode, roomObject = null) {
    let room;
    if (roomObject) {
        room = roomObject;
    } else {
        const roomDataString = await redisClient.get(`room:${roomCode}`);
        if (!roomDataString) return;
        room = JSON.parse(roomDataString);
    }
    
    let currentMancheData = null;
    if (room.gameState.gamePhase === 'playing' && room.gameState.mancheOrder && room.gameState.mancheOrder.length > 0) {
        const currentMancheRequirement = room.gameState.mancheOrder[room.gameState.currentManche - 1];
        currentMancheData = gameLogic.manches.find(m => m.requirement === currentMancheRequirement);
    }

    const publicGameState = { 
        ...room.gameState, players: {}, 
        deckCount: room.gameState.deck.length, 
        hostId: room.hostId, mancheOrder: room.gameState.mancheOrder,
        currentMancheData: currentMancheData 
    };
    delete publicGameState.deck;

    for (const playerId in room.players) {
        const player = room.players[playerId];
        publicGameState.players[playerId] = {
            id: playerId, name: player.name, uniquePlayerId: player.uniquePlayerId,
            cardCount: player.hand.length, score: player.score, dressed: player.dressed,
        };
    }

    for (const playerId in room.players) {
        const socket = io.sockets.sockets.get(playerId);
        if (socket) {
            const player = room.players[playerId];
            const privateState = { 
                ...publicGameState, playerHand: player.hand,
                players: {
                    ...publicGameState.players,
                    [playerId]: { ...publicGameState.players[playerId], groups: player.groups }
                }
            };
            socket.emit('gameStateUpdate', privateState);
        }
    }
}

async function startGame(roomCode) {
    const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
    if (!room) return;
    
    const state = room.gameState;
    const playerIds = Object.keys(room.players);

    state.gamePhase = 'playing';
    state.hasDrawn = false;
    state.deck = gameLogic.createDeck();
    state.tableCombinations = [];
    playerIds.forEach(pid => {
        room.players[pid].hand = [];
        room.players[pid].dressed = false;
    });

    const cardsToDeal = playerIds.length > 2 ? 11 : 13;
    for(let i = 0; i < cardsToDeal; i++) {
        for(const pid of playerIds) {
            if (state.deck.length > 0) room.players[pid].hand.push(state.deck.pop());
        }
    }
    playerIds.forEach(pid => {
        room.players[pid].groups = [room.players[pid].hand.map(card => card.id)];
    });
    state.discardPile = [state.deck.pop()];
    state.currentPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
    
    await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
    updateRoomState(roomCode, room);
}

async function endTurn(roomCode, forceImmediateUpdate = false) {
    const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
    if (!room) return;

    const state = room.gameState;
    const playerIds = Object.keys(room.players);
    if (playerIds.length === 0) { // Se non ci sono più giocatori, cancella la stanza
        await redisClient.del(`room:${roomCode}`);
        return;
    }

    const currentPlayerIndex = playerIds.indexOf(state.currentPlayerId);
    state.currentPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length] || playerIds[0];
    state.hasDrawn = false;
    
    await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
    if (forceImmediateUpdate) {
        updateRoomState(roomCode, room);
    } else {
        setTimeout(() => updateRoomState(roomCode, null), 200);
    }
}

async function endManche(roomCode) {
    const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
    if (!room) return;
    
    const state = room.gameState;
    const winnerId = state.currentPlayerId;
    const winner = room.players[winnerId];
    
    let finalScores = [];
    Object.values(room.players).forEach(player => {
        let points = (player.id !== winnerId && player.hand) ? player.hand.reduce((sum, card) => sum + card.points, 0) : 0;
        player.score += points;
        finalScores.push(`${player.name}: ${points} (Tot: ${player.score})`);
    });

    io.to(roomCode).emit('message', {
        title: `Manche ${state.currentManche} Vinta da ${winner.name}!`,
        message: `Punteggi:\n${finalScores.join('\n')}`
    });

    state.currentManche++;
    
    if (state.currentManche > state.mancheOrder.length) {
        await redisClient.set(`room:${roomCode}`, JSON.stringify(room)); // Salva i punteggi finali prima di terminare
        await endGame(roomCode);
    } else {
        state.gamePhase = 'choose_next_manche';
        await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
        
        const playedManches = state.mancheOrder.slice(0, state.currentManche - 1);
        const remainingManches = gameLogic.manches.filter(m => !playedManches.includes(m.requirement));

        io.to(roomCode).emit('promptChooseNextManche', { winnerId, winnerName: winner.name, remainingManches });
    }
}

async function endGame(roomCode) {
    const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
    if (!room) return;
    
    const allPlayers = Object.values(room.players).sort((a, b) => a.score - b.score);
    const winner = allPlayers[0];
    const ranking = allPlayers.map((p, i) => `${i+1}. ${p.name} (${p.score} punti)`).join('\n');
    
    io.to(roomCode).emit('message', { 
        title: "Partita Terminata!", 
        message: `Il vincitore è ${winner.name}!\n\nClassifica finale:\n${ranking}`
    });
    
    await redisClient.del(`room:${roomCode}`);
}

function sortCards(cards) {
    const valueOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const getCardValue = (card) => (card.isJoker && card.assignedValue) ? card.assignedValue : card.value;
    cards.sort((a, b) => valueOrder.indexOf(getCardValue(a)) - valueOrder.indexOf(getCardValue(b)));
}

server.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
});