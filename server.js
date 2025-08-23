const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const gameLogic = require('./public/logic.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;

// Serve i file statici dalla cartella 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Oggetto per memorizzare lo stato di tutte le stanze
let rooms = {};

/**
 * Trova il codice di una stanza dato l'ID di un socket.
 * @param {string} socketId - L'ID del socket del giocatore.
 * @returns {string|null} Il codice della stanza o null se non trovata.
 */
function findRoomBySocketId(socketId) {
    for (const roomCode in rooms) {
        if (rooms[roomCode].players[socketId]) {
            return roomCode;
        }
    }
    return null;
}

io.on('connection', (socket) => {
    console.log(`Un utente si è connesso: ${socket.id}`);

    // --- GESTIONE STANZE ---

    socket.on('createRoom', (playerName) => {
        let roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        while(rooms[roomCode]){ roomCode = Math.random().toString(36).substring(2, 8).toUpperCase(); }
        
        socket.join(roomCode);
        
        rooms[roomCode] = {
            hostId: socket.id,
            players: {
                [socket.id]: { id: socket.id, name: playerName, hand: [], score: 0, dressed: false, groups: [] }
            },
            gameState: {
                roomCode: roomCode, players: {}, currentPlayerId: null, currentManche: 1, deck: [], discardPile: [], tableCombinations: [], gamePhase: 'waiting', turnPhase: 'draw', hasDrawn: false,
            }
        };
        
        socket.emit('roomCreated', { roomCode, playerId: socket.id });
        updateRoomState(roomCode);
    });

    socket.on('joinRoom', ({ roomCode, playerName }) => {
        roomCode = roomCode.toUpperCase();
        const room = rooms[roomCode];
        
        if (!room) return socket.emit('error', 'Stanza non trovata.');
        if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('error', 'La stanza è piena.');
        if (room.gameState.gamePhase === 'playing') return socket.emit('error', 'La partita è già iniziata.');
        
        socket.join(roomCode);
        room.players[socket.id] = { id: socket.id, name: playerName, hand: [], score: 0, dressed: false, groups: [] };
        updateRoomState(roomCode);
    });

    socket.on('startGameRequest', () => {
        const roomCode = findRoomBySocketId(socket.id);
        const room = rooms[roomCode];
        
        if (room && room.hostId === socket.id) {
            if (Object.keys(room.players).length >= 2) {
                startGame(roomCode);
            } else {
                socket.emit('message', {title: "Attendi", message: "Servono almeno 2 giocatori per iniziare."});
            }
        }
    });

    // --- AZIONI DI GIOCO ---

    socket.on('updateGroups', (newGroups) => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const player = rooms[roomCode].players[socket.id];
        if (player) {
            player.groups = newGroups;
        }
    });

    socket.on('addNewGroup', () => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const player = rooms[roomCode].players[socket.id];
        if (player && player.groups) {
            player.groups.push([]);
            updateRoomState(roomCode);
        }
    });

    socket.on('drawFromDeck', () => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        
        if (state.currentPlayerId !== socket.id || state.turnPhase !== 'draw' || state.hasDrawn) return;
        if (state.deck.length === 0) {
            if (state.discardPile.length <= 1) return socket.emit('message', {title: "Mazzo vuoto", message: "Il mazzo e lo scarto sono finiti!"});
            // Rimescola lo scarto nel mazzo
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
        updateRoomState(roomCode);
    });
    
    socket.on('drawFromDiscard', () => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
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
        updateRoomState(roomCode);
    });

    socket.on('discardCard', (cardIndex) => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        const player = room.players[socket.id];
        
        if (state.currentPlayerId !== socket.id || !state.hasDrawn) return;
        if (cardIndex < 0 || cardIndex >= player.hand.length) return;
        
        const discardedCard = player.hand.splice(cardIndex, 1)[0];
        player.groups.forEach(group => {
            const indexInGroup = group.indexOf(discardedCard.id);
            if (indexInGroup > -1) group.splice(indexInGroup, 1);
        });
        
        state.discardPile.push(discardedCard);
        
        if (player.hand.length === 0) {
            endManche(roomCode);
        } else {
            endTurn(roomCode);
        }
    });
    
    socket.on('dressHand', (data) => {
        const { selectedIndexes, jokerAssignments = [] } = data;
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        const player = room.players[socket.id];

        if (state.currentPlayerId !== socket.id || !state.hasDrawn || player.dressed) return;

        if (player.hand.length === selectedIndexes.length) {
            return socket.emit('message', {
                title: "Mossa non permessa",
                message: "Non puoi calare tutte le carte. Devi conservarne almeno una per lo scarto finale."
            });
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

        const manche = gameLogic.manches[state.currentManche - 1];
        if (gameLogic.validateCombination(virtualCards, manche.requirement)) {
            const selectedCardIds = originalSelectedCards.map(c => c.id);
            player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
            player.groups.forEach(group => {
                group.splice(0, group.length, ...group.filter(id => !selectedCardIds.includes(id)));
            });
            state.tableCombinations.push({ player: player.name, type: manche.name, cards: originalSelectedCards });
            player.dressed = true;
            state.turnPhase = 'discard'; // Can be 'play' or 'discard', depends on rules
            socket.emit('message', {title: "Ben fatto!", message: `Hai calato: ${manche.name}`});
            updateRoomState(roomCode);
        } else {
            socket.emit('message', {title: "Combinazione non valida", message: `La regola della manche (${manche.name}) non è soddisfatta.`});
        }
    });

    socket.on('attachCards', (data) => {
        const { selectedIndexes, jokerAssignments = [] } = data;
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        const player = room.players[socket.id];

        if (state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed) return;
        if (!selectedIndexes || selectedIndexes.length === 0) return;
        if (player.hand.length === selectedIndexes.length) {
            return socket.emit('message', {
                title: "Mossa non permessa",
                message: "Non puoi calare tutte le carte. Devi conservarne almeno una per lo scarto finale."
            });
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

        // Logica per calare una nuova combinazione (>= 3 carte)
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
        
        // Logica per attaccare una o più carte a combinazioni esistenti
        if (!moveMade) {
             for (const combo of state.tableCombinations) {
                const combinedCards = [...combo.cards, ...originalSelectedCards];
                const combinedVirtualCards = [...combo.cards, ...virtualCards];
                
                if (gameLogic.isValidSet(combinedVirtualCards) || gameLogic.isValidRun(combinedVirtualCards)) {
                    const selectedCardIds = originalSelectedCards.map(c => c.id);
                    player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
                    player.groups.forEach(g => g.splice(0, g.length, ...g.filter(id => !selectedCardIds.includes(id))));
                    
                    combo.cards.push(...originalSelectedCards);
                    if (gameLogic.isValidRun(combinedVirtualCards)) {
                        combo.type = 'Scala'; // Potrebbe diventare una scala
                        sortCards(combo.cards);
                    }
                    socket.emit('message', { title: "Carte Attaccate!", message: `Hai attaccato con successo.` });
                    moveMade = true;
                    break; 
                }
            }
        }

        if (moveMade) {
            updateRoomState(roomCode);
        } else {
            socket.emit('message', { title: "Mossa non valida", message: "Le carte selezionate non formano una combinazione valida né possono essere attaccate." });
        }
    });
    
    socket.on('swapJoker', ({ handCardId, tableJokerId, comboIndex }) => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        const player = room.players[socket.id];
        
        if (state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed) return;
        
        const combo = state.tableCombinations[comboIndex];
        const jokerOnTable = combo ? combo.cards.find(c => c.id === tableJokerId) : null;
        const cardInHand = player.hand.find(c => c.id === handCardId);
        
        if (!jokerOnTable || !cardInHand || !jokerOnTable.assignedValue) return;

        if (cardInHand.value === jokerOnTable.assignedValue && cardInHand.suit === jokerOnTable.assignedSuit) {
            const jokerIndexOnTable = combo.cards.findIndex(c => c.id === tableJokerId);
            const handCardIndex = player.hand.findIndex(c => c.id === handCardId);

            // Scambia le carte
            combo.cards[jokerIndexOnTable] = cardInHand;
            player.hand[handCardIndex] = { ...jokerOnTable, assignedValue: undefined, assignedSuit: undefined }; // Pulisce il jolly

            // Aggiorna i gruppi
            player.groups.forEach(g => {
                const i = g.indexOf(handCardId);
                if (i > -1) g[i] = jokerOnTable.id;
            });
            
            if (combo.type === 'Scala') sortCards(combo.cards);

            socket.emit('message', { title: "Scambio Riuscito!", message: "Hai preso il Jolly!" });
            updateRoomState(roomCode);
        } else {
            socket.emit('message', { title: "Scambio non valido", message: "La carta non corrisponde al valore del Jolly." });
        }
    });

    // --- GESTIONE CONNESSIONE ---

    socket.on('disconnect', () => {
        console.log(`Un utente si è disconnesso: ${socket.id}`);
        const roomCode = findRoomBySocketId(socket.id);
        if (roomCode && rooms[roomCode]) {
            const room = rooms[roomCode];
            const disconnectedPlayerName = room.players[socket.id]?.name || 'Un giocatore';
            const wasCurrentPlayer = room.gameState.currentPlayerId === socket.id;

            delete room.players[socket.id];
            
            const remainingPlayers = Object.keys(room.players);

            if (remainingPlayers.length < 2 && room.gameState.gamePhase === 'playing') {
                io.to(roomCode).emit('message', { title: "Partita Terminata", message: `${disconnectedPlayerName} si è disconnesso. La partita non può continuare.`});
                delete rooms[roomCode];
            } else if (remainingPlayers.length === 0) {
                 delete rooms[roomCode];
            } else {
                if (room.hostId === socket.id) { // Se l'host si disconnette, ne viene eletto uno nuovo
                    room.hostId = remainingPlayers[0];
                }
                if (wasCurrentPlayer) { // Se era il turno del giocatore disconnesso, passa al prossimo
                    endTurn(roomCode, true);
                } else {
                    io.to(roomCode).emit('message', { title: "Giocatore Disconnesso", message: `${disconnectedPlayerName} ha lasciato la stanza.`});
                    updateRoomState(roomCode);
                }
            }
        }
    });

    socket.on('keep-alive', () => {});
});

// --- FUNZIONI DI GESTIONE DEL GIOCO ---

function updateRoomState(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // Crea uno stato pubblico senza mazzo e mani private
    const publicGameState = { 
        ...room.gameState, 
        players: {}, 
        deckCount: room.gameState.deck ? room.gameState.deck.length : 0, 
        hostId: room.hostId 
    };
    delete publicGameState.deck;

    // Popola lo stato pubblico con i dati visibili dei giocatori
    for (const playerId in room.players) {
        publicGameState.players[playerId] = {
            id: playerId, 
            name: room.players[playerId].name, 
            cardCount: room.players[playerId].hand.length, 
            score: room.players[playerId].score, 
            dressed: room.players[playerId].dressed,
        };
    }

    // Invia a ogni giocatore il suo stato privato con la sua mano
    for (const playerId in room.players) {
        const privateState = { 
            ...publicGameState, 
            playerHand: room.players[playerId].hand,
            // Invia i gruppi solo al giocatore proprietario per evitare cheating
            players: {
                ...publicGameState.players,
                [playerId]: {
                    ...publicGameState.players[playerId],
                    groups: room.players[playerId].groups
                }
            }
        };
        io.to(playerId).emit('gameStateUpdate', privateState);
    }
}

function startGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const state = room.gameState;
    const playerIds = Object.keys(room.players);

    // Reset stato manche
    state.gamePhase = 'playing';
    state.turnPhase = 'draw';
    state.hasDrawn = false;
    state.deck = gameLogic.createDeck();
    state.tableCombinations = [];

    // Reset stato giocatori
    playerIds.forEach(pid => {
        room.players[pid].hand = [];
        room.players[pid].dressed = false;
        room.players[pid].groups = [];
    });

    // Distribuisci carte
    const cardsToDeal = playerIds.length > 2 ? 11 : 13;
    for(let i = 0; i < cardsToDeal; i++) {
        playerIds.forEach(pid => {
            if (state.deck.length > 0) {
                room.players[pid].hand.push(state.deck.pop());
            }
        });
    }

    // Inizializza i gruppi
    playerIds.forEach(pid => {
        const player = room.players[pid];
        player.groups = [player.hand.map(card => card.id)];
    });
    
    state.discardPile = [state.deck.pop()];
    state.currentPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
    
    console.log(`Partita iniziata nella stanza ${roomCode}. Turno di ${room.players[state.currentPlayerId].name}`);
    updateRoomState(roomCode);
}

function sortCards(cards) {
    const valueOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const getCardValue = (card) => (card.isJoker && card.assignedValue) ? card.assignedValue : card.value;
    cards.sort((a, b) => valueOrder.indexOf(getCardValue(a)) - valueOrder.indexOf(getCardValue(b)));
}

function endTurn(roomCode, forceImmediateUpdate = false) {
    const room = rooms[roomCode];
    if (!room || !room.gameState.currentPlayerId) return;
    const state = room.gameState;
    const playerIds = Object.keys(room.players);
    if (playerIds.length === 0) return;

    const currentPlayerIndex = playerIds.indexOf(state.currentPlayerId);
    
    if (currentPlayerIndex === -1) {
        state.currentPlayerId = playerIds[0];
    } else {
        const nextPlayerIndex = (currentPlayerIndex + 1) % playerIds.length;
        state.currentPlayerId = playerIds[nextPlayerIndex];
    }
    
    state.hasDrawn = false;
    state.turnPhase = 'draw';

    console.log(`Turno terminato. Ora è il turno di ${room.players[state.currentPlayerId]?.name || 'sconosciuto'}`);
    if (forceImmediateUpdate) {
        updateRoomState(roomCode);
    } else {
        setTimeout(() => updateRoomState(roomCode), 200); // Leggero ritardo per fluidità
    }
}

function endManche(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const state = room.gameState;
    const winnerId = state.currentPlayerId;
    
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
        title: `Manche ${state.currentManche} Vinta da ${room.players[winnerId].name}!`,
        message: `Punteggi della manche:\n${finalScores.join('\n')}`
    });

    if (state.currentManche >= gameLogic.manches.length) {
        endGame(roomCode);
    } else {
        state.currentManche++;
        setTimeout(() => {
            if(rooms[roomCode]) startGame(roomCode);
        }, 8000); // Aumentato il ritardo per dare tempo di leggere i punteggi
    }
}

function endGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    const allPlayers = Object.values(room.players).sort((a, b) => a.score - b.score);
    const winner = allPlayers[0];
    const ranking = allPlayers.map((p, i) => `${i+1}. ${p.name} (${p.score} punti)`).join('\n');
    
    io.to(roomCode).emit('message', { 
        title: "Partita Terminata!", 
        message: `Il vincitore è ${winner.name}!\n\nClassifica finale:\n${ranking}`
    });
    
    // Distruggi la stanza dopo un po' di tempo
    setTimeout(() => {
        delete rooms[roomCode];
    }, 20000);
}

server.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
});