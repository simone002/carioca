const express = require('express');
require('dotenv').config(); // ✅ AGGIUNGI QUESTA RIGA QUI
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { createClient } = require('redis');
const gameLogic = require('./public/logic.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingInterval: 5000,
    pingTimeout: 10000,
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;

// --- Connessione a Redis ---
const redisClient = createClient({
    url: process.env.REDIS_URL // Legge l'URL dalle variabili d'ambiente di Render
});
redisClient.on('error', (err) => console.log('Redis Client Error', err));
(async () => {
    await redisClient.connect();
    console.log('Connesso a Redis con successo!');
})();
// -------------------------

app.use(express.static(path.join(__dirname, 'public')));

async function findRoomBySocketId(socketId) {
    const allRoomCodes = await redisClient.keys('*');
    for (const roomCode of allRoomCodes) {
        try {
            const roomDataString = await redisClient.get(roomCode);
            if (roomDataString) {
                const room = JSON.parse(roomDataString);
                if (room.players && room.players[socketId]) {
                    return { roomCode, room };
                }
            }
        } catch (e) {
            console.error(`Errore nel parsing dei dati per la stanza ${roomCode}:`, e);
        }
    }
    return { roomCode: null, room: null };
}

io.on('connection', (socket) => {
    console.log(`Un utente si è connesso: ${socket.id}`);

    socket.on('createRoom', async (playerName) => {
        let roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        while(await redisClient.exists(roomCode)){ 
            roomCode = Math.random().toString(36).substring(2, 8).toUpperCase(); 
        }
        
        socket.join(roomCode);
        socket.roomCode = roomCode;
        
        const room = {
            hostId: socket.id,
            players: {
                [socket.id]: { id: socket.id, name: playerName, hand: [], score: 0, dressed: false, groups: [] }
            },
            gameState: {
                roomCode: roomCode, players: {}, currentPlayerId: null, currentManche: 1, deck: [], discardPile: [], tableCombinations: [], gamePhase: 'waiting', turnPhase: 'draw', hasDrawn: false, mancheOrder: []
            }
        };
        
        await redisClient.set(roomCode, JSON.stringify(room));
        
        socket.emit('roomCreated', { roomCode, playerId: socket.id });
        updateRoomState(roomCode, room);
    });

    socket.on('joinRoom', async ({ roomCode, playerName }) => {
        roomCode = roomCode.toUpperCase();
        const roomDataString = await redisClient.get(roomCode);
        if (!roomDataString) return socket.emit('error', 'Stanza non trovata.');
        
        const room = JSON.parse(roomDataString);
        
        if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('error', 'La stanza è piena.');
        if (room.gameState.gamePhase === 'playing') return socket.emit('error', 'La partita è già iniziata.');
        
        socket.join(roomCode);
        socket.roomCode = roomCode;
        room.players[socket.id] = { id: socket.id, name: playerName, hand: [], score: 0, dressed: false, groups: [] };
        
        await redisClient.set(roomCode, JSON.stringify(room));
        updateRoomState(roomCode, room);
    });

    socket.on('startGameRequest', async (customMancheOrder) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        
        const room = JSON.parse(await redisClient.get(roomCode));
        if (!room) return;

        if (room.hostId === socket.id && Object.keys(room.players).length >= 2) {
            if (customMancheOrder && customMancheOrder.length === gameLogic.manches.length) {
                room.gameState.mancheOrder = customMancheOrder;
            } else {
                room.gameState.mancheOrder = gameLogic.manches.map(m => m.requirement);
            }
            await redisClient.set(roomCode, JSON.stringify(room));
            await startGame(roomCode);
        }
    });

    socket.on('chooseNextManche', async ({ choice }) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(roomCode));
        if (!room) return;

        const state = room.gameState;
        const winnerId = room.gameState.currentPlayerId; // L'ultimo giocatore di turno era il vincitore

        // Solo il vincitore può scegliere
        if (socket.id !== winnerId || state.gamePhase !== 'choose_next_manche') return;

        // Rimuovi la manche scelta dalle rimanenti e mettila come prossima nell'ordine
        const playedManches = state.mancheOrder.slice(0, state.currentManche - 1);
        const allMancheRequirements = gameLogic.manches.map(m => m.requirement);
        let remainingManches = allMancheRequirements.filter(req => !playedManches.includes(req));

        if (remainingManches.includes(choice)) {
            // Rimuovi la scelta dalle rimanenti
            remainingManches = remainingManches.filter(req => req !== choice);
            // Ricostruisci l'ordine futuro
            const futureOrder = [choice, ...remainingManches];
            // Aggiorna l'ordine completo della partita
            state.mancheOrder = [...playedManches, ...futureOrder];
            
            const chosenMancheData = gameLogic.manches.find(m => m.requirement === choice);
            io.to(roomCode).emit('message', {
                title: "Prossima Manche Scelta",
                message: `${room.players[winnerId].name} ha scelto: ${chosenMancheData.name}`
            });
            
            await redisClient.set(roomCode, JSON.stringify(room));
            
            // Avvia la nuova manche dopo un breve ritardo
            setTimeout(() => {
                startGame(roomCode);
            }, 4000);
        }
    });
    
    socket.on('updateGroups', async (newGroups) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const roomDataString = await redisClient.get(roomCode);
        if(!roomDataString) return;
        const room = JSON.parse(roomDataString);

        if (room && room.players[socket.id]) {
            room.players[socket.id].groups = newGroups;
            await redisClient.set(roomCode, JSON.stringify(room));
        }
    });
    
    socket.on('addNewGroup', async () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(roomCode));
        if (room && room.players[socket.id] && room.players[socket.id].groups) {
            room.players[socket.id].groups.push([]);
            await redisClient.set(roomCode, JSON.stringify(room));
            updateRoomState(roomCode, room);
        }
    });

    socket.on('drawFromDeck', async () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(roomCode));
        if (!room) return;

        const state = room.gameState;
        if (state.currentPlayerId !== socket.id || state.turnPhase !== 'draw' || state.hasDrawn) return;
        
        if (state.deck.length === 0) {
            if (state.discardPile.length <= 1) return socket.emit('message', {title: "Mazzo vuoto", message: "Il mazzo e lo scarto sono finiti!"});
            const topDiscard = state.discardPile.pop();
            state.deck = gameLogic.shuffleDeck(state.discardPile);
            state.discardPile = [topDiscard];
            io.to(roomCode).emit('message', {title: "Mazzo Terminato", message: "Il pozzo degli scarti è stato rimescolato nel mazzo."});
        }

        const card = state.deck.pop();
        const player = room.players[socket.id];
        player.hand.push(card);
        if (!player.groups || player.groups.length === 0) player.groups = [[]];
        player.groups[0].unshift(card.id);
        
        state.hasDrawn = true;
        state.turnPhase = 'play';
        
        await redisClient.set(roomCode, JSON.stringify(room));
        updateRoomState(roomCode, room);
    });

    socket.on('drawFromDiscard', async () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(roomCode));
        if (!room) return;

        const state = room.gameState;
        if (state.currentPlayerId !== socket.id || state.turnPhase !== 'draw' || state.hasDrawn) return;
        if (state.discardPile.length === 0) return socket.emit('message', {title: "Scarto vuoto", message: "Non ci sono carte da pescare."});
        
        const card = state.discardPile.pop();
        const player = room.players[socket.id];
        player.hand.push(card);
        if (!player.groups || player.groups.length === 0) player.groups = [[]];
        player.groups[0].unshift(card.id);
        
        state.hasDrawn = true;
        state.turnPhase = 'play';
        
        await redisClient.set(roomCode, JSON.stringify(room));
        updateRoomState(roomCode, room);
    });

    // In server.js

    socket.on('discardCard', async (cardIndex) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(roomCode));
        if (!room) return;

        const state = room.gameState;
        const player = room.players[socket.id];
        
        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn) return;
        if (cardIndex < 0 || cardIndex >= player.hand.length) return;
        
        const cardToDiscard = player.hand[cardIndex];

        // ✅ INIZIO NUOVA REGOLA CONDIZIONALE
        // Controlla qual è la manche corrente
        const currentMancheRequirement = state.mancheOrder[state.currentManche - 1];

        // Se siamo nella manche 'scala' E il giocatore non ha ancora calato...
        if (currentMancheRequirement === 'scala' && !player.dressed) {
            // ...allora non può scartare un 5 o un 10.
            if (cardToDiscard.value === '5' || cardToDiscard.value === '10') {
                return socket.emit('message', {
                    title: "Mossa non Permessa",
                    message: "Nella manche Scala, non puoi scartare un 5 o un 10 finché non hai calato."
                });
            }
        }
        // ✅ FINE NUOVA REGOLA CONDIZIONALE

        const discardedCard = player.hand.splice(cardIndex, 1)[0];
        player.groups.forEach(group => {
            const indexInGroup = group.indexOf(discardedCard.id);
            if (indexInGroup > -1) group.splice(indexInGroup, 1);
        });
        
        state.discardPile.push(discardedCard);
        
        await redisClient.set(roomCode, JSON.stringify(room));
        
        if (player.hand.length === 0) {
            await endManche(roomCode);
        } else {
            await endTurn(roomCode);
        }
    });
    
    socket.on('dressHand', async (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(roomCode));
        if (!room) return;

        const { selectedIndexes, jokerAssignments = [] } = data;
        const state = room.gameState;
        const player = room.players[socket.id];

        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn || player.dressed) return;
        if (player.hand.length === selectedIndexes.length) {
            return socket.emit('message', {title: "Mossa non permessa", message: "Non puoi calare tutte le carte."});
        }
        
        const originalSelectedCards = selectedIndexes.map(i => player.hand[i]);
        if (originalSelectedCards.some(card => card === undefined)) return;

        const hasJoker = originalSelectedCards.some(card => card.isJoker);
        
        // Blocca i jolly, MA SOLO SE la manche NON è 'chiusura in mano'
        if (hasJoker && currentMancheRequirement !== 'chiusura in mano') {
            return socket.emit('message', {
                title: "Mossa non Permessa",
                message: "Non puoi usare un Jolly per calare la combinazione principale della manche."
            });
        }
        
        let virtualCards = JSON.parse(JSON.stringify(originalSelectedCards));
        jokerAssignments.forEach(assignment => {
            const jokerCardInHand = player.hand[assignment.index];
            if (jokerCardInHand && jokerCardInHand.isJoker) {
                const selectionIndexToReplace = virtualCards.findIndex(c => c.id === jokerCardInHand.id);
                if (selectionIndexToReplace !== -1) {
                    virtualCards[selectionIndexToReplace] = { ...assignment.becomes, points: gameLogic.getCardPoints(assignment.becomes.value), isVirtual: true };
                    const originalJoker = originalSelectedCards.find(c => c.id === jokerCardInHand.id);
                    if (originalJoker) {
                        originalJoker.assignedValue = assignment.becomes.value;
                        originalJoker.assignedSuit = assignment.becomes.suit;
                    }
                }
            }
        });
        
        const currentMancheRequirement = state.mancheOrder[state.currentManche - 1];
        const manche = gameLogic.manches.find(m => m.requirement === currentMancheRequirement);
        if (!manche) return;

        if (gameLogic.validateCombination(virtualCards, manche.requirement)) {
            const selectedCardIds = originalSelectedCards.map(c => c.id);
            player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
            player.groups.forEach(group => group.splice(0, group.length, ...group.filter(id => !selectedCardIds.includes(id))));
            state.tableCombinations.push({ player: player.name, type: manche.name, cards: originalSelectedCards });
            player.dressed = true;
            state.turnPhase = 'play';
            
            await redisClient.set(roomCode, JSON.stringify(room));
            updateRoomState(roomCode, room);
            socket.emit('message', {title: "Ben fatto!", message: `Hai calato: ${manche.name}`});
        } else {
            socket.emit('message', {title: "Combinazione non valida", message: `La regola della manche (${manche.name}) non è soddisfatta.`});
        }
    });

    socket.on('attachCards', async (data) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(roomCode));
        if (!room) return;
    
        const { selectedIndexes, jokerAssignments = [] } = data;
        const state = room.gameState;
        const player = room.players[socket.id];
    
        if (!player || state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed) return;
        if (!selectedIndexes || selectedIndexes.length === 0) return;
        if (player.hand.length === selectedIndexes.length) {
            return socket.emit('message', {title: "Mossa non permessa", message: "Non puoi calare tutte le carte."});
        }
    
        const originalSelectedCards = selectedIndexes.map(i => player.hand[i]);
        if (originalSelectedCards.some(card => card === undefined)) return;
    
        let virtualCards = JSON.parse(JSON.stringify(originalSelectedCards));
        jokerAssignments.forEach(assignment => {
            const jokerCardInHand = player.hand[assignment.index];
            if (jokerCardInHand && jokerCardInHand.isJoker) {
                const selectionIndexToReplace = virtualCards.findIndex(c => c.id === jokerCardInHand.id);
                if (selectionIndexToReplace !== -1) {
                    virtualCards[selectionIndexToReplace] = { ...assignment.becomes, points: gameLogic.getCardPoints(assignment.becomes.value), isVirtual: true };
                    const originalJoker = originalSelectedCards.find(c => c.id === jokerCardInHand.id);
                    if (originalJoker) {
                        originalJoker.assignedValue = assignment.becomes.value;
                        originalJoker.assignedSuit = assignment.becomes.suit;
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
            await redisClient.set(roomCode, JSON.stringify(room));
            updateRoomState(roomCode, room);
        } else {
            socket.emit('message', { title: "Mossa non valida", message: "Le carte non sono valide." });
        }
    });

    socket.on('swapJoker', async ({ handCardId, tableJokerId, comboIndex }) => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(roomCode));
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
            
            await redisClient.set(roomCode, JSON.stringify(room));
            updateRoomState(roomCode, room);
            socket.emit('message', { title: "Scambio Riuscito!", message: "Hai preso il Jolly!" });
        } else {
            socket.emit('message', { title: "Scambio non valido", message: "La carta non corrisponde al Jolly." });
        }
    });

    socket.on('disconnect', async () => {
        console.log(`Un utente si è disconnesso: ${socket.id}`);
        const { roomCode, room } = await findRoomBySocketId(socket.id);

        if (roomCode && room) {
            const wasCurrentPlayer = room.gameState.currentPlayerId === socket.id;
            delete room.players[socket.id];
            
            const remainingPlayers = Object.keys(room.players);

            if (remainingPlayers.length < 2 && room.gameState.gamePhase === 'playing') {
                io.to(roomCode).emit('message', { title: "Partita Terminata", message: `Un giocatore si è disconnesso.`});
                await redisClient.del(roomCode);
            } else if (remainingPlayers.length === 0) {
                 await redisClient.del(roomCode);
            } else {
                if (room.hostId === socket.id) {
                    room.hostId = remainingPlayers[0];
                }
                await redisClient.set(roomCode, JSON.stringify(room));
                
                if (wasCurrentPlayer) {
                    await endTurn(roomCode, true);
                } else {
                    updateRoomState(roomCode, room);
                }
            }
        }
    });
});

async function updateRoomState(roomCode, roomObject = null) {
    let room;
    if (roomObject) {
        room = roomObject;
    } else {
        const roomDataString = await redisClient.get(roomCode);
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
        deckCount: room.gameState.deck ? room.gameState.deck.length : 0, 
        hostId: room.hostId, mancheOrder: room.gameState.mancheOrder,
        currentMancheData: currentMancheData 
    };
    delete publicGameState.deck;

    for (const playerId in room.players) {
        publicGameState.players[playerId] = {
            id: playerId, name: room.players[playerId].name, 
            cardCount: room.players[playerId].hand.length, 
            score: room.players[playerId].score, dressed: room.players[playerId].dressed,
        };
    }

    for (const playerId in room.players) {
        const socket = io.sockets.sockets.get(playerId);
        if (socket) {
            const privateState = { 
                ...publicGameState, playerHand: room.players[playerId].hand,
                players: {
                    ...publicGameState.players,
                    [playerId]: {
                        ...publicGameState.players[playerId],
                        groups: room.players[playerId].groups
                    }
                }
            };
            socket.emit('gameStateUpdate', privateState);
        }
    }
}

async function startGame(roomCode) {
    const room = JSON.parse(await redisClient.get(roomCode));
    if (!room) return;
    
    const state = room.gameState;
    const playerIds = Object.keys(room.players);

    state.gamePhase = 'playing';
    state.turnPhase = 'draw';
    state.hasDrawn = false;
    state.deck = gameLogic.createDeck();
    state.tableCombinations = [];
    if (!state.mancheOrder || state.mancheOrder.length === 0) {
        state.mancheOrder = gameLogic.manches.map(m => m.requirement);
    }
    playerIds.forEach(pid => {
        room.players[pid].hand = [];
        room.players[pid].dressed = false;
        room.players[pid].groups = [];
    });

    const cardsToDeal = playerIds.length > 2 ? 11 : 13;
    for(let i = 0; i < cardsToDeal; i++) {
        playerIds.forEach(pid => {
            if (state.deck.length > 0) room.players[pid].hand.push(state.deck.pop());
        });
    }
    playerIds.forEach(pid => {
        room.players[pid].groups = [room.players[pid].hand.map(card => card.id)];
    });
    state.discardPile = [state.deck.pop()];
    state.currentPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
    
    await redisClient.set(roomCode, JSON.stringify(room));
    updateRoomState(roomCode, room);
}

async function endTurn(roomCode, forceImmediateUpdate = false) {
    const room = JSON.parse(await redisClient.get(roomCode));
    if (!room) return;

    const state = room.gameState;
    const playerIds = Object.keys(room.players);
    if (playerIds.length === 0) return;

    const currentPlayerIndex = playerIds.indexOf(state.currentPlayerId);
    state.currentPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length];
    state.hasDrawn = false;
    state.turnPhase = 'draw';
    
    await redisClient.set(roomCode, JSON.stringify(room));
    if (forceImmediateUpdate) {
        updateRoomState(roomCode, room);
    } else {
        setTimeout(() => updateRoomState(roomCode, room), 200);
    }
}

async function endManche(roomCode) {
    const room = JSON.parse(await redisClient.get(roomCode));
    if (!room) return;
    
    const state = room.gameState;
    const winnerId = state.currentPlayerId;
    const winner = room.players[winnerId];
    
    let finalScores = [];
    Object.values(room.players).forEach(player => {
        let points = 0;
        if (player.id !== winnerId && player.hand) {
            points = player.hand.reduce((sum, card) => sum + card.points, 0);
            player.score += points;
        }
        finalScores.push(`${player.name}: ${points} punti (Totale: ${player.score})`);
    });

    io.to(roomCode).emit('message', {
        title: `Manche ${state.currentManche} Vinta da ${winner.name}!`,
        message: `Punteggi della manche:\n${finalScores.join('\n')}`
    });

    state.currentManche++;

    if (state.currentManche > state.mancheOrder.length) {
        await redisClient.set(roomCode, JSON.stringify(room));
        await endGame(roomCode);
    } else {
        // Invece di avviare subito la partita, entriamo in una nuova fase
        state.gamePhase = 'choose_next_manche';
        await redisClient.set(roomCode, JSON.stringify(room));
        
        // Calcola le manche non ancora giocate
        const playedManches = state.mancheOrder.slice(0, state.currentManche - 1);
        const allMancheRequirements = gameLogic.manches.map(m => m.requirement);
        const remainingManches = allMancheRequirements.filter(req => !playedManches.includes(req));

        // Invia un evento a tutti i giocatori
        io.to(roomCode).emit('promptChooseNextManche', {
            winnerId: winnerId,
            winnerName: winner.name,
            remainingManches: remainingManches.map(req => gameLogic.manches.find(m => m.requirement === req))
        });
    }
}

async function endGame(roomCode) {
    const room = JSON.parse(await redisClient.get(roomCode));
    if (!room) return;
    
    const allPlayers = Object.values(room.players).sort((a, b) => a.score - b.score);
    const winner = allPlayers[0];
    const ranking = allPlayers.map((p, i) => `${i+1}. ${p.name} (${p.score} punti)`).join('\n');
    
    io.to(roomCode).emit('message', { 
        title: "Partita Terminata!", 
        message: `Il vincitore è ${winner.name}!\n\nClassifica finale:\n${ranking}`
    });
    
    await redisClient.del(roomCode);
}

server.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
});