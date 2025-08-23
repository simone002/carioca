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

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

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
        if (Object.keys(room.players).length >= MAX_PLAYERS) {
            return socket.emit('error', 'La stanza è piena.');
        }
        if (room.gameState.gamePhase === 'playing') {
            return socket.emit('error', 'La partita è già iniziata.');
        }
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
    
    socket.on('updateGroups', (newGroups) => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const player = rooms[roomCode].players[socket.id];
        if (player) player.groups = newGroups;
    });
    
    socket.on('drawFromDeck', () => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        if (state.currentPlayerId !== socket.id || state.turnPhase !== 'draw' || state.hasDrawn) return;
        if (state.deck.length === 0) return socket.emit('message', {title: "Mazzo vuoto", message: "Il mazzo è finito!"});
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

        // ✅ NUOVO BLOCCO DI CODICE DA AGGIUNGERE QUI
        if (player.hand.length === selectedIndexes.length) {
            return socket.emit('message', {
                title: "Mossa non permessa",
                message: "Non puoi calare tutte le carte che hai in mano. Devi conservarne almeno una per lo scarto finale."
            });
        }
        // ✅ FINE DEL NUOVO BLOCCO

        const originalSelectedCards = selectedIndexes.map(i => player.hand[i]);
        if (originalSelectedCards.some(card => card === undefined)) return;
        
        let virtualCards = JSON.parse(JSON.stringify(originalSelectedCards));
        jokerAssignments.forEach(assignment => {
            const jokerCardInHand = player.hand[assignment.index];
            if (jokerCardInHand && jokerCardInHand.isJoker) {
                const selectionIndexToReplace = virtualCards.findIndex(c => c.id === jokerCardInHand.id);
                if (selectionIndexToReplace !== -1) {
                    virtualCards[selectionIndexToReplace] = { ...assignment.becomes, points: gameLogic.getCardPoints(assignment.becomes.value), isVirtual: true };
                    originalSelectedCards.find(c => c.id === jokerCardInHand.id).assignedValue = assignment.becomes.value;
                    originalSelectedCards.find(c => c.id === jokerCardInHand.id).assignedSuit = assignment.becomes.suit;
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
            state.turnPhase = 'discard';
            socket.emit('message', {title: "Ben fatto!", message: `Hai calato: ${manche.name}`});
            updateRoomState(roomCode);
        } else {
            socket.emit('message', {title: "Combinazione non valida", message: `La regola della manche non è soddisfatta.`});
        }
    });

    // In server.js

    socket.on('attachCards', (data) => {
        const { selectedIndexes, jokerAssignments = [] } = data;
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;

        const room = rooms[roomCode];
        const state = room.gameState;
        const player = room.players[socket.id];

        // Controlli di base sullo stato del gioco e del giocatore
        if (state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed || state.turnPhase !== 'play') return;
        if (!selectedIndexes || selectedIndexes.length === 0) return;

        // Controllo per impedire di calare tutte le carte in mano
        if (player.hand.length === selectedIndexes.length) {
            return socket.emit('message', {
                title: "Mossa non permessa",
                message: "Non puoi calare tutte le carte che hai in mano. Devi conservarne almeno una per lo scarto finale."
            });
        }

        // Prepara le carte selezionate, applicando i valori scelti per i jolly
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
                    if(originalJoker) {
                        originalJoker.assignedValue = assignment.becomes.value;
                        originalJoker.assignedSuit = assignment.becomes.suit;
                    }
                }
            }
        });

        // === LOGICA PER CALARE UNA NUOVA COMBINAZIONE (>= 3 CARTE) ===
        if (selectedIndexes.length >= 3) {
            const jokers = virtualCards.filter(c => c.isJoker || c.isVirtual).length;
            const nonJokers = virtualCards.filter(c => !c.isJoker && !c.isVirtual);
            let combinationType = null;

            if (gameLogic.isValidSet(nonJokers, jokers)) {
                combinationType = virtualCards.length === 3 ? 'Tris' : 'Poker';
            } else if (gameLogic.isValidRun(nonJokers, jokers)) {
                combinationType = 'Scala';
            }

            if (combinationType) {
                const selectedCardIds = originalSelectedCards.map(c => c.id);
                player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
                player.groups.forEach(group => {
                    group.splice(0, group.length, ...group.filter(id => !selectedCardIds.includes(id)));
                });
                const newCombination = { player: player.name, type: combinationType, cards: originalSelectedCards };
                if (combinationType === 'Scala') {
                    sortCards(newCombination.cards);
                }
                state.tableCombinations.push(newCombination);
                socket.emit('message', { title: "Combinazione Calata!", message: `Hai formato: ${combinationType}.` });
                updateRoomState(roomCode);
                return;
            }
        }

        // === LOGICA PER ATTACCARE UNA SOLA CARTA ===
        if (selectedIndexes.length === 1) {
            const originalCardToAttach = originalSelectedCards[0];

            // 1. TENTA PRIMA LO SCAMBIO DEL JOLLY
            for (const combo of state.tableCombinations) {
                const jokerIndexOnTable = combo.cards.findIndex(c =>
                    c.isJoker &&
                    c.assignedValue === originalCardToAttach.value &&
                    c.assignedSuit === originalCardToAttach.suit
                );

                if (jokerIndexOnTable !== -1) {
                    const jokerOnTable = combo.cards[jokerIndexOnTable];
                    const handCardIndex = player.hand.findIndex(c => c.id === originalCardToAttach.id);

                    delete jokerOnTable.assignedValue;
                    delete jokerOnTable.assignedSuit;

                    combo.cards[jokerIndexOnTable] = originalCardToAttach;
                    player.hand[handCardIndex] = jokerOnTable;

                    player.groups.forEach(group => {
                        const i = group.indexOf(originalCardToAttach.id);
                        if (i > -1) group[i] = jokerOnTable.id;
                    });
                    
                    if (combo.type === 'Scala') sortCards(combo.cards);

                    socket.emit('message', { title: "Jolly Scambiato!", message: "Hai preso il Jolly dal tavolo!" });
                    updateRoomState(roomCode);
                    return;
                }
            }

            // 2. SE NESSUNO SCAMBIO È AVVENUTO, TENTA L'ATTACCO NORMALE
            const virtualCardToAttach = virtualCards[0];
            for (const combo of state.tableCombinations) {
                const comboJokers = combo.cards.filter(c => c.isJoker);
                const comboRealCards = combo.cards.filter(c => !c.isJoker);
                const newCardIsJoker = virtualCardToAttach.isJoker || virtualCardToAttach.isVirtual;
                const allJokersCount = comboJokers.length + (newCardIsJoker ? 1 : 0);
                const allRealCards = newCardIsJoker ? [...comboRealCards] : [...comboRealCards, virtualCardToAttach];

                if (gameLogic.isValidSet(allRealCards, allJokersCount) || gameLogic.isValidRun(allRealCards, allJokersCount)) {
                    combo.cards.push(originalCardToAttach);
                    if (combo.type === 'Scala' || gameLogic.isValidRun(allRealCards, allJokersCount)) {
                        combo.type = 'Scala';
                        sortCards(combo.cards);
                    }
                    
                    const cardIndexInHand = player.hand.findIndex(c => c.id === originalCardToAttach.id);
                    if (cardIndexInHand > -1) player.hand.splice(cardIndexInHand, 1);
                    player.groups.forEach(group => {
                        const indexInGroup = group.indexOf(originalCardToAttach.id);
                        if (indexInGroup > -1) group.splice(indexInGroup, 1);
                    });

                    socket.emit('message', { title: "Carta Attaccata!", message: `Hai attaccato la carta con successo.` });
                    updateRoomState(roomCode);
                    return;
                }
            }
        }

        // Se il codice arriva qui, nessuna mossa valida è stata trovata
        socket.emit('message', { title: "Mossa non valida", message: "Le carte selezionate non possono essere calate o attaccate." });
    });

    socket.on('swapJoker', ({ handCardId, tableJokerId, comboIndex }) => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        const player = room.players[socket.id];
        if (state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed) return socket.emit('message', { title: "Azione non permessa", message: "Non puoi scambiare un Jolly ora." });
        const combo = state.tableCombinations[comboIndex];
        const jokerOnTable = combo ? combo.cards.find(c => c.id === tableJokerId) : null;
        const cardInHand = player.hand.find(c => c.id === handCardId);
        if (!jokerOnTable || !cardInHand) return socket.emit('message', { title: "Errore", message: "Carte non valide." });

        if (cardInHand.value === jokerOnTable.assignedValue && cardInHand.suit === jokerOnTable.assignedSuit) {
            const jokerIndexOnTable = combo.cards.findIndex(c => c.id === tableJokerId);
            const handCardIndex = player.hand.findIndex(c => c.id === handCardId);
            delete jokerOnTable.assignedValue;
            delete jokerOnTable.assignedSuit;
            player.hand.push(jokerOnTable);
            if (!player.groups[0]) player.groups[0] = [];
            player.groups[0].unshift(jokerOnTable.id);
            combo.cards[jokerIndexOnTable] = cardInHand;

            // ✅ NUOVA RIGA DA AGGIUNGERE
            // Se la combinazione è una scala, ordinala dopo lo scambio.
            if (combo.type === 'Scala') {
                sortCards(combo.cards);
            }

            player.hand.splice(handCardIndex, 1);
            player.groups.forEach(g => {
                const i = g.indexOf(handCardId);
                if (i > -1) g.splice(i, 1);
            });
            socket.emit('message', { title: "Scambio Riuscito!", message: "Hai preso il Jolly!" });
            updateRoomState(roomCode);
        } else {
            socket.emit('message', { title: "Scambio non valido", message: "La carta non corrisponde al valore del Jolly." });
        }
    });

    

    socket.on('disconnect', () => {
        const roomCode = findRoomBySocketId(socket.id);
        if (roomCode && rooms[roomCode]) {
            const room = rooms[roomCode];
            const disconnectedPlayerName = room.players[socket.id]?.name || 'Un giocatore';
            const wasCurrentPlayer = room.gameState.currentPlayerId === socket.id;

            delete room.players[socket.id];
            console.log(`${disconnectedPlayerName} disconnesso dalla stanza ${roomCode}. Giocatori rimasti: ${Object.keys(room.players).length}`);
            
            const remainingPlayers = Object.keys(room.players);

            if (remainingPlayers.length < 2 && room.gameState.gamePhase === 'playing') {
                io.to(roomCode).emit('message', { title: "Partita Terminata", message: `${disconnectedPlayerName} si è disconnesso. La partita finisce.`});
                delete rooms[roomCode];
            } else if (remainingPlayers.length === 0) {
                 delete rooms[roomCode];
            } else {
                 if(room.hostId === socket.id){ // Se l'host si disconnette, ne viene eletto uno nuovo
                     room.hostId = remainingPlayers[0];
                 }
                 if(wasCurrentPlayer){ // Se era il turno del giocatore disconnesso, passa al prossimo
                    endTurn(roomCode, true); // Passa il turno senza aspettare lo scarto
                 } else {
                    io.to(roomCode).emit('message', { title: "Giocatore Disconnesso", message: `${disconnectedPlayerName} ha lasciato la stanza.`});
                    updateRoomState(roomCode);
                 }
            }
        }
    });

    socket.on('keep-alive', () => { /* Gestisce il ping per tenere attivo il server */ });
});

function updateRoomState(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const publicGameState = { ...room.gameState, players: {}, deckCount: room.gameState.deck ? room.gameState.deck.length : 0, hostId: room.hostId };
    delete publicGameState.deck;
    for (const playerId in room.players) {
        publicGameState.players[playerId] = {
            id: playerId, name: room.players[playerId].name, cardCount: room.players[playerId].hand.length, score: room.players[playerId].score, dressed: room.players[playerId].dressed, groups: room.players[playerId].groups,
        };
    }
    for (const playerId in room.players) {
        const privateState = { ...publicGameState, playerHand: room.players[playerId].hand }
        io.to(playerId).emit('gameStateUpdate', privateState);
    }
}

function startGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const state = room.gameState;
    state.gamePhase = 'playing';
    state.turnPhase = 'draw';
    state.hasDrawn = false;
    state.deck = gameLogic.createDeck();
    const playerIds = Object.keys(room.players);
    playerIds.forEach(pid => {
        room.players[pid].hand = [];
        room.players[pid].dressed = false;
        room.players[pid].groups = [];
    });
    const cardsToDeal = playerIds.length > 2 ? 11 : 13; // 11 carte se si gioca in 3 o 4
    for(let i = 0; i < cardsToDeal; i++) {
        playerIds.forEach(pid => {
            if (state.deck.length > 0) {
                room.players[pid].hand.push(state.deck.pop());
            }
        });
    }
    playerIds.forEach(pid => {
        const player = room.players[pid];
        const cardIdsInHand = player.hand.map(card => card.id);
        player.groups = [cardIdsInHand];
    });
    state.discardPile = [state.deck.pop()];
    state.currentPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
    state.tableCombinations = [];
    console.log(`Partita iniziata nella stanza ${roomCode}. Turno di ${room.players[state.currentPlayerId].name}`);
    updateRoomState(roomCode);
}

/**
 * Ordina un array di carte in base al loro valore numerico.
 * Gestisce anche gli Assi (A) come valore più basso.
 * @param {Array} cards - L'array di carte da ordinare.
 */
function sortCards(cards) {
    const valueOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    
    // Funzione per ottenere il valore di una carta, anche se è un jolly assegnato
    const getCardValue = (card) => {
        if (card.isJoker && card.assignedValue) {
            return card.assignedValue;
        }
        return card.value;
    };

    cards.sort((a, b) => {
        const valueA = valueOrder.indexOf(getCardValue(a));
        const valueB = valueOrder.indexOf(getCardValue(b));
        return valueA - valueB;
    });
}


function endTurn(roomCode, forceImmediateUpdate = false) {
    const room = rooms[roomCode];
    if (!room || !room.gameState.currentPlayerId) return;
    const state = room.gameState;
    const playerIds = Object.keys(room.players);
    if(playerIds.length === 0) return;

    const currentPlayerIndex = playerIds.indexOf(state.currentPlayerId);
    if(currentPlayerIndex === -1) { // Il giocatore di turno non esiste più
        state.currentPlayerId = playerIds[0]; // Imposta il primo della lista come nuovo giocatore di turno
    } else {
        const nextPlayerIndex = (currentPlayerIndex + 1) % playerIds.length;
        state.currentPlayerId = playerIds[nextPlayerIndex];
    }
    
    state.hasDrawn = false;
    state.turnPhase = 'draw';

    if (forceImmediateUpdate) {
        updateRoomState(roomCode);
    } else {
        console.log(`Turno terminato. Ora è il turno di ${room.players[state.currentPlayerId].name}`);
        updateRoomState(roomCode);
    }
}

function endManche(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const state = room.gameState;
    const winnerId = state.currentPlayerId;
    const playerIds = Object.keys(room.players);

    let finalScores = [];
    playerIds.forEach(pid => {
        const player = room.players[pid];
        let points = 0;
        if (pid !== winnerId && player.hand) {
            points = player.hand.reduce((sum, card) => sum + card.points, 0);
            player.score += points;
        }
        finalScores.push(`${player.name}: ${points} punti (Tot: ${player.score})`);
    });

    io.to(roomCode).emit('message', {
        title: `Manche ${state.currentManche} Vinta da ${room.players[winnerId].name}!`,
        message: `Punteggi della manche:\n${finalScores.join('\n')}`
    });

    if (state.currentManche >= 8) {
        endGame(roomCode);
    } else {
        state.currentManche++;
        setTimeout(() => {
            if(rooms[roomCode]) startGame(roomCode);
        }, 5000);
    }
}

function endGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    const allPlayers = Object.values(room.players);
    allPlayers.sort((a, b) => a.score - b.score);
    const winner = allPlayers[0];
    
    io.to(roomCode).emit('message', { 
        title: "Partita Terminata!", 
        message: `${winner.name} ha vinto con un punteggio finale di ${winner.score} punti!`
    });
    
    setTimeout(() => {
        delete rooms[roomCode];
    }, 10000);
}


server.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
});