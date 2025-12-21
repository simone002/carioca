const express = require('express');
require('dotenv').config();
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { createClient } = require('redis');
const gameLogic = require('./public/logic.js'); // Assicurati che il percorso sia corretto

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    pingInterval: 5000,
    pingTimeout: 10000,
    cors: {
        origin: "https://carioca-02wq.onrender.com", // Il tuo dominio
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;

// --- Connessione a Redis (Versione Upstash) ---
const redisClient = createClient({ 
    url: process.env.REDIS_URL,
    socket: {
        tls: true, // Obbligatorio per Upstash
        rejectUnauthorized: false // Evita errori di certificato su alcuni server
    }
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

(async () => { 
    try {
        await redisClient.connect(); 
        console.log('✅ Connesso a Upstash Redis con successo!');
    } catch (e) {
        console.error('❌ Errore connessione Redis:', e);
    }
})();
// -------------------------

app.use(express.static(path.join(__dirname, 'public')));

// --- Funzioni Helper per Redis ---
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

// --- Logica Socket.IO ---
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

    socket.on('bookDiscard', async () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;
        
        const state = room.gameState;

        // Non puoi prenotare se è il tuo turno
        if (state.currentPlayerId === socket.id) return;
        if (state.turnPhase !== 'draw') return;

        // Se l'array non esiste (sicurezza), crealo
        if (!state.discardRequests) state.discardRequests = [];

        // Se il giocatore non si è già prenotato, aggiungilo alla lista
        if (!state.discardRequests.includes(socket.id)) {
            state.discardRequests.push(socket.id);
            
            await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
            
            // Conferma al giocatore che la prenotazione è registrata
            socket.emit('message', { title: "Prenotazione", message: "Hai richiesto lo scarto. Se hai la priorità, sarà tuo." });
            
            // (Opzionale) Aggiorna l'interfaccia degli altri per mostrare quante persone vogliono la carta
            io.to(roomCode).emit('discardBookedUpdate', { count: state.discardRequests.length });
        }
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

        // >= 2 giocatori (modifica a 1 per test se necessario)
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
        const currentPlayer = room.players[socket.id];

        if (!currentPlayer || state.currentPlayerId !== socket.id || state.hasDrawn) return;
        
        // (Logica mazzo vuoto esistente...)
        if (state.deck.length === 0) {
           // ... (copia tua logica mazzo vuoto qui) ...
           if (state.discardPile.length <= 1) return socket.emit('message', { title: "Mazzo vuoto", message: "Non ci sono più carte." });
           const topDiscard = state.discardPile.pop();
           state.deck = gameLogic.shuffleDeck(state.discardPile);
           state.discardPile = [topDiscard];
           io.to(roomCode).emit('message', { title: "Mazzo Terminato", message: "Il pozzo degli scarti è stato rimescolato." });
        }

        // ============================================================
        // LOGICA ASSEGNAZIONE SCARTO PER PRIORITÀ DI GIRO
        // ============================================================
        if (state.discardRequests && state.discardRequests.length > 0 && state.discardPile.length > 0) {
            
            const playerIds = Object.keys(room.players); // Ordine di inserimento/connessione (o usa un array ordinato se lo hai)
            
            // Troviamo l'indice del giocatore corrente
            const currentTurnIndex = playerIds.indexOf(state.currentPlayerId);
            
            let winnerId = null;
            let minDistance = Infinity;

            // Calcoliamo la distanza di ogni richiedente dal giocatore di turno
            state.discardRequests.forEach(requesterId => {
                const reqIndex = playerIds.indexOf(requesterId);
                
                // Formula magica per la distanza ciclica (senso orario)
                // Esempio: Giocatori [0, 1, 2, 3]. Turno 1. Richiedente 3.
                // (3 - 1 + 4) % 4 = 2 passi di distanza.
                let distance = (reqIndex - currentTurnIndex + playerIds.length) % playerIds.length;
                
                if (distance < minDistance) {
                    minDistance = distance;
                    winnerId = requesterId;
                }
            });

            // Assegniamo la carta al vincitore
            if (winnerId) {
                const bookingPlayer = room.players[winnerId];
                const stolenCard = state.discardPile.pop();
                
                bookingPlayer.hand.push(stolenCard);
                if (!bookingPlayer.groups || bookingPlayer.groups.length === 0) bookingPlayer.groups = [[]];
                bookingPlayer.groups[0].push(stolenCard.id);

                io.to(roomCode).emit('message', { 
                    title: "Scarto Assegnato", 
                    message: `${bookingPlayer.name} prende lo scarto (priorità di giro).` 
                });
            }
        }
        // Reset delle richieste
        state.discardRequests = []; 
        // ============================================================

        // Pesca normale dal mazzo per il giocatore di turno
        const card = state.deck.pop();
        currentPlayer.hand.push(card);
        if (!currentPlayer.groups || currentPlayer.groups.length === 0) currentPlayer.groups = [[]];
        currentPlayer.groups[0].unshift(card.id);
        
        state.hasDrawn = true;
        state.turnPhase = 'play';

        await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
        updateRoomState(roomCode, room);
    });

    socket.on('drawFromDiscard', async () => {
        const roomCode = socket.roomCode;
        if (!roomCode) return;
        
        // 1. Recupera lo stato aggiornato
        const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
        if (!room) return;
        
        const state = room.gameState;
        const player = room.players[socket.id];

        state.discardRequests = [];
        // 2. Controlli di sicurezza (è il tuo turno? hai già pescato?)
        if (!player || state.currentPlayerId !== socket.id || state.hasDrawn) return;
        
        // 3. Controlla se ci sono carte da pescare
        if (state.discardPile.length === 0) {
            return socket.emit('message', { title: "Scarto vuoto", message: "Non ci sono carte da pescare." });
        }
        
        // ============================================================
        // LOGICA PRENOTAZIONE (La parte importante)
        // ============================================================
        // Poiché il giocatore di turno HA DECISO di prendere lo scarto,
        // lui ha la priorità su chiunque altro.
        // Se qualcuno aveva prenotato ("comprato") questa carta, la sua richiesta viene annullata.
        state.pendingDiscardRequest = null; 
        // ============================================================

        // 4. Sposta la carta dallo scarto alla mano
        const card = state.discardPile.pop();
        player.hand.push(card);

        // 5. Aggiorna i gruppi visivi (aggiunge la carta al primo gruppo)
        if (!player.groups || player.groups.length === 0) player.groups = [[]];
        player.groups[0].unshift(card.id);
        
        // 6. Aggiorna lo stato del turno
        state.hasDrawn = true;
        state.turnPhase = 'play'; // Ora deve scartare o calare
        
        // 7. Salva e invia aggiornamenti
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
        // Rimuovi anche dai gruppi
        player.groups.forEach(group => {
            const indexInGroup = group.indexOf(discardedCard.id);
            if (indexInGroup > -1) group.splice(indexInGroup, 1);
        });
        
        state.discardPile.push(discardedCard);
        
        await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
        
        // Se ha 0 carte ha chiuso
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

        // Regola speciale: Chiusura in mano può usare jolly
        if (hasJoker && currentMancheRequirement !== 'chiusura in mano') {
            return socket.emit('message', { title: "Mossa non Permessa", message: "Non puoi usare un Jolly per calare la combinazione principale." });
        }
        
        // Crea carte virtuali per la validazione
        let virtualCards = JSON.parse(JSON.stringify(originalSelectedCards));
        jokerAssignments.forEach(assignment => {
            const jokerInHand = player.hand[assignment.index];
            if (jokerInHand && jokerInHand.isJoker) {
                const virtualCardIndex = virtualCards.findIndex(c => c.id === jokerInHand.id);
                if(virtualCardIndex !== -1){
                    virtualCards[virtualCardIndex] = { ...assignment.becomes, isVirtual: true, points: gameLogic.getCardPoints(assignment.becomes.value) };
                    
                    // Assegna valori anche alle carte originali che finiranno sul tavolo
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

        // La funzione gameLogic.validateCombination gestirà 'chiusura in mano' (validando le 13 carte)
        if (gameLogic.validateCombination(virtualCards, manche.requirement)) {
            const selectedCardIds = originalSelectedCards.map(c => c.id);
            player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
            player.groups.forEach(group => group.splice(0, group.length, ...group.filter(id => !selectedCardIds.includes(id))));
            
            // Ordina la combinazione per visualizzazione corretta
            if (manche.requirement === 'scala') sortCards(originalSelectedCards);

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
    
        // Caso 1: Nuova combinazione (Tris o Scala separata)
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
                
                if (combinationType === 'Scala') sortCards(originalSelectedCards);
                
                const newCombination = { player: player.name, type: combinationType, cards: originalSelectedCards };
                state.tableCombinations.push(newCombination);
                
                socket.emit('message', { title: "Combinazione Calata!", message: `Hai formato: ${combinationType}.` });
                moveMade = true;
            }
        }
        
        // Caso 2: Attaccare a combinazioni esistenti
        if (!moveMade) {
             for (const combo of state.tableCombinations) {
                // Uniamo le carte virtuali a quelle già sul tavolo per verificare
                const combinedVirtualCards = [...combo.cards, ...virtualCards];
                
                // NOTA: isValidSet e isValidRun gestiranno la logica (incluso Asso Alto/Basso se aggiornate in logic.js)
                if (gameLogic.isValidSet(combinedVirtualCards) || gameLogic.isValidRun(combinedVirtualCards)) {
                    
                    const selectedCardIds = originalSelectedCards.map(c => c.id);
                    player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
                    player.groups.forEach(g => g.splice(0, g.length, ...g.filter(id => !selectedCardIds.includes(id))));
                    
                    combo.cards.push(...originalSelectedCards);
                    
                    if (gameLogic.isValidRun(combinedVirtualCards)) {
                        combo.type = 'Scala';
                        sortCards(combo.cards); // Riordina la scala con le nuove carte
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
            socket.emit('message', { title: "Mossa non valida", message: "Le carte non sono valide per creare o attaccare giochi." });
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
    
        // Controllo corrispondenza (inclusi Semi)
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
            socket.emit('message', { title: "Scambio non valido", message: "La carta non corrisponde al Jolly (controlla valore e seme)." });
        }
    });

    socket.on('disconnect', async () => {
        const { roomCode, room } = await findRoomBySocketId(socket.id);
        if (roomCode && room) {
            console.log(`Giocatore ${room.players[socket.id]?.name || socket.id} disconnesso da ${roomCode}`);
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
                    // Invia i gruppi del giocatore specifico
                    [playerId]: { ...publicGameState.players[playerId], groups: player.groups }
                }
            };
            socket.emit('gameStateUpdate', privateState);
        }
    }
}

async function startGame(roomCode) {
    // 1. Scarichiamo la stanza da Redis
    const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
    if (!room) return;
    
    // 2. Creiamo il riferimento allo stato (che è stato creato in createRoom)
    const state = room.gameState;
    const playerIds = Object.keys(room.players);

    // ============================================================
    // RESET VARIABILI PER LA NUOVA MANCHE
    // ============================================================
    state.gamePhase = 'playing';
    state.turnPhase = 'draw'; 
    state.hasDrawn = false;
    state.discardRequests =[];
    
    // ★ IMPORTANTE: Resettiamo la richiesta di scarto all'inizio della manche
    state.pendingDiscardRequest = null; 

    state.deck = gameLogic.createDeck();
    state.tableCombinations = []; // Pulisce il tavolo
    
    // Reset delle mani dei giocatori
    playerIds.forEach(pid => {
        room.players[pid].hand = [];
        room.players[pid].dressed = false;
        // Nota: non resettiamo 'score', quello persiste tra le manche
    });

    // ============================================================
    // DISTRIBUZIONE CARTE
    // ============================================================
    // Se ci sono più di 2 giocatori, si danno 11 carte. Se sono in 2, se ne danno 13.
    const cardsToDeal = playerIds.length > 2 ? 11 : 13;
    
    for(let i = 0; i < cardsToDeal; i++) {
        for(const pid of playerIds) {
            if (state.deck.length > 0) room.players[pid].hand.push(state.deck.pop());
        }
    }

    // Creiamo i gruppi visivi per il frontend
    playerIds.forEach(pid => {
        room.players[pid].groups = [room.players[pid].hand.map(card => card.id)];
    });

    // ============================================================
    // PREPARAZIONE PRIMO TURNO
    // ============================================================
    // Mettiamo la prima carta nello scarto
    state.discardPile = [state.deck.pop()];
    
    // Scegliamo un primo giocatore a caso
    state.currentPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
    
    // Salviamo tutto su Redis e aggiorniamo i client
    await redisClient.set(`room:${roomCode}`, JSON.stringify(room));
    updateRoomState(roomCode, room);
}

async function endTurn(roomCode, forceImmediateUpdate = false) {
    const room = JSON.parse(await redisClient.get(`room:${roomCode}`));
    if (!room) return;

    const state = room.gameState;
    const playerIds = Object.keys(room.players);
    if (playerIds.length === 0) { 
        await redisClient.del(`room:${roomCode}`);
        return;
    }

    const currentPlayerIndex = playerIds.indexOf(state.currentPlayerId);
    
    // Reset variabili turno
    state.pendingDiscardRequest = null;
    state.discardRequests = [];
    state.hasDrawn = false;
    state.turnPhase = 'draw'; // <--- AGGIUNGI QUESTA RIGA FONDAMENTALE!

    // Passa turno
    state.currentPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length] || playerIds[0];
    
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
        await redisClient.set(`room:${roomCode}`, JSON.stringify(room)); 
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

// ============================================
// # ORDINAMENTO INTELLIGENTE (Asso Basso/Alto)
// ============================================
function sortCards(cards) {
    // 1. Controlla se è una scala con Asso Alto (Q, K, A)
    const hasKing = cards.some(c => (c.isJoker && c.assignedValue === 'K') || c.value === 'K');
    const hasAce = cards.some(c => (c.isJoker && c.assignedValue === 'A') || c.value === 'A');
    // Se c'è K e A, assumiamo sia una scala alta
    const aceIsHigh = hasKing && hasAce; 

    // Mappatura numerica per l'ordinamento
    const getVal = (card) => {
        let v = (card.isJoker && card.assignedValue) ? card.assignedValue : card.value;
        if (v === 'A') return aceIsHigh ? 14 : 1; // Asso dinamico
        if (v === 'K') return 13;
        if (v === 'Q') return 12;
        if (v === 'J') return 11;
        return parseInt(v);
    };

    cards.sort((a, b) => getVal(a) - getVal(b));
}

server.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
});