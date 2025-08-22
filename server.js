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
    // ... createRoom, joinRoom, updateGroups, draw, discard handlers
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

    socket.on('attachCards', (data) => {
        const { selectedIndexes, jokerAssignments = [] } = data;
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        const player = room.players[socket.id];

        if (state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed || state.turnPhase !== 'play') return;
        if (!selectedIndexes || selectedIndexes.length === 0) return;

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

        if (selectedIndexes.length >= 3) {
            const jokers = virtualCards.filter(c => c.isJoker || c.isVirtual).length;
            const nonJokers = virtualCards.filter(c => !c.isJoker && !c.isVirtual);
            let combinationType = null;
            if (gameLogic.isValidSet(nonJokers, jokers)) combinationType = virtualCards.length === 3 ? 'Tris' : 'Poker';
            else if (gameLogic.isValidRun(nonJokers, jokers)) combinationType = 'Scala';

            if (combinationType) {
                const selectedCardIds = originalSelectedCards.map(c => c.id);
                player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
                player.groups.forEach(group => {
                    group.splice(0, group.length, ...group.filter(id => !selectedCardIds.includes(id)));
                });
                state.tableCombinations.push({ player: player.name, type: combinationType, cards: originalSelectedCards });
                socket.emit('message', { title: "Combinazione Calata!", message: `Hai formato: ${combinationType}.` });
                updateRoomState(roomCode);
                return;
            }
        }

        if (selectedIndexes.length === 1) {
            const cardToAttach = virtualCards[0];
            for (const combo of state.tableCombinations) {
                let comboCardsWithJokerValues = combo.cards.map(c => {
                    if (c.isJoker && c.assignedValue) {
                        return { value: c.assignedValue, suit: c.assignedSuit, isVirtual: true, points: gameLogic.getCardPoints(c.assignedValue) };
                    }
                    return c;
                });

                const newComboCards = [...comboCardsWithJokerValues, cardToAttach];
                let isValidAttach = false;
                
                const virtualJokers = newComboCards.filter(c => c.isJoker || c.isVirtual).length;
                const virtualNonJokers = newComboCards.filter(c => !c.isJoker && !c.isVirtual);

                if (gameLogic.isValidSet(virtualNonJokers, virtualJokers)) isValidAttach = true;
                else if (gameLogic.isValidRun(virtualNonJokers, virtualJokers)) isValidAttach = true;

                if (isValidAttach) {
                    const originalCardToAttach = originalSelectedCards[0];
                    combo.cards.push(originalCardToAttach);
                    const cardIndexInHand = player.hand.findIndex(c => c.id === originalCardToAttach.id);
                    if (cardIndexInHand > -1) player.hand.splice(cardIndexInHand, 1);
                    player.groups.forEach(group => {
                        const indexInGroup = group.indexOf(originalCardToAttach.id);
                        if (indexInGroup > -1) group.splice(indexInGroup, 1);
                    });
                    if (combo.cards.length === 3 && combo.type === "Coppia") combo.type = "Tris";
                    if (combo.cards.length === 4 && combo.type === "Tris") combo.type = "Poker";
                    socket.emit('message', { title: "Carta Attaccata!", message: `Hai attaccato la carta con successo.` });
                    updateRoomState(roomCode);
                    return;
                }
            }
        }
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
            const disconnectedPlayerName = rooms[roomCode].players[socket.id]?.name || 'Un giocatore';
            delete rooms[roomCode].players[socket.id];
            
            if (Object.keys(rooms[roomCode].players).length < 2 && rooms[roomCode].gameState.gamePhase === 'playing') {
                io.to(roomCode).emit('message', { title: "Partita Terminata", message: `${disconnectedPlayerName} si è disconnesso. La partita finisce.`});
                delete rooms[roomCode];
            } else if (Object.keys(rooms[roomCode].players).length === 0) {
                 delete rooms[roomCode];
            } else {
                 io.to(roomCode).emit('message', { title: "Giocatore Disconnesso", message: `${disconnectedPlayerName} ha lasciato la stanza.`});
                 updateRoomState(roomCode);
            }
        }
    });
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
    for(let i = 0; i < 13; i++) {
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

function endTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const state = room.gameState;
    const playerIds = Object.keys(room.players);
    if(playerIds.length === 0) return;
    const currentPlayerIndex = playerIds.indexOf(state.currentPlayerId);
    const nextPlayerIndex = (currentPlayerIndex + 1) % playerIds.length;
    state.currentPlayerId = playerIds[nextPlayerIndex];
    state.hasDrawn = false;
    state.turnPhase = 'draw';
    console.log(`Turno terminato. Ora è il turno di ${room.players[state.currentPlayerId].name}`);
    updateRoomState(roomCode);
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
        setTimeout(() => startGame(roomCode), 5000);
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
    
    setTimeout(() => delete rooms[roomCode], 10000);
}


server.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
});