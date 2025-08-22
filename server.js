const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const gameLogic = require('./public/logic.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

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
    // ... (tutti gli altri handler rimangono invariati, non serve copiarli di nuovo)
    socket.on('createRoom', (playerName) => {
        let roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        while(rooms[roomCode]){
            roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        }

        socket.join(roomCode);
        rooms[roomCode] = {
            players: {
                [socket.id]: {
                    id: socket.id,
                    name: playerName,
                    hand: [],
                    score: 0,
                    dressed: false,
                    groups: [] 
                }
            },
            gameState: {
                roomCode: roomCode,
                players: {},
                currentPlayerId: null,
                currentManche: 1,
                deck: [],
                discardPile: [],
                tableCombinations: [],
                gamePhase: 'waiting', 
                turnPhase: 'draw', 
                hasDrawn: false,
            }
        };
        
        console.log(`Stanza creata: ${roomCode} da ${playerName}`);
        socket.emit('roomCreated', { roomCode, playerId: socket.id });
        updateRoomState(roomCode);
    });

    socket.on('joinRoom', ({ roomCode, playerName }) => {
        roomCode = roomCode.toUpperCase();
        const room = rooms[roomCode];
        if (!room) {
            return socket.emit('error', 'Stanza non trovata.');
        }
        if (Object.keys(room.players).length >= 2) {
            return socket.emit('error', 'La stanza è piena.');
        }

        socket.join(roomCode);
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            hand: [],
            score: 0,
            dressed: false,
            groups: []
        };
        
        console.log(`${playerName} si è unito alla stanza ${roomCode}`);
        
        if (Object.keys(room.players).length === 2) {
            startGame(roomCode);
        } else {
            updateRoomState(roomCode);
        }
    });

    socket.on('updateGroups', (newGroups) => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const player = rooms[roomCode].players[socket.id];
        if (player) {
            player.groups = newGroups;
        }
    });
    
    socket.on('drawFromDeck', () => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        
        if (state.currentPlayerId !== socket.id || state.turnPhase !== 'draw' || state.hasDrawn) {
            return socket.emit('message', {title: "Azione non permessa", message: "Non puoi pescare ora."});
        }
        if (state.deck.length === 0) {
            return socket.emit('message', {title: "Mazzo vuoto", message: "Il mazzo è finito!"});
        }

        const card = state.deck.pop();
        const player = room.players[socket.id];
        player.hand.push(card);
        if (!player.groups || player.groups.length === 0) {
            player.groups = [[]];
        }
        player.groups[0].push(card.id);

        state.hasDrawn = true;
        state.turnPhase = 'play';

        updateRoomState(roomCode);
    });
    
    socket.on('drawFromDiscard', () => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;

        if (state.currentPlayerId !== socket.id || state.turnPhase !== 'draw' || state.hasDrawn) {
            return socket.emit('message', {title: "Azione non permessa", message: "Non puoi pescare ora."});
        }
        if (state.discardPile.length === 0) {
            return socket.emit('message', {title: "Scarto vuoto", message: "Non ci sono carte da pescare."});
        }

        const card = state.discardPile.pop();
        const player = room.players[socket.id];
        player.hand.push(card);
        if (!player.groups || player.groups.length === 0) {
            player.groups = [[]];
        }
        player.groups[0].push(card.id);

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

        if (state.currentPlayerId !== socket.id || !state.hasDrawn) {
            return socket.emit('message', {title: "Azione non permessa", message: "Non puoi scartare ora."});
        }
        if (cardIndex < 0 || cardIndex >= player.hand.length) {
            return socket.emit('message', {title: "Carta non valida", message: "La carta selezionata non è valida."});
        }

        const discardedCard = player.hand.splice(cardIndex, 1)[0];
        player.groups.forEach(group => {
            const indexInGroup = group.indexOf(discardedCard.id);
            if (indexInGroup > -1) {
                group.splice(indexInGroup, 1);
            }
        });

        state.discardPile.push(discardedCard);

        if (player.hand.length === 0) {
            console.log(`Il giocatore ${player.name} ha chiuso la manche.`);
        } else {
            endTurn(roomCode);
        }
    });

    socket.on('dressHand', (selectedIndexes) => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        const player = room.players[socket.id];

        if (state.currentPlayerId !== socket.id || !state.hasDrawn || player.dressed) {
            return socket.emit('message', {title: "Azione non permessa", message: "Non puoi calare la regola della manche ora."});
        }

        const selectedCards = selectedIndexes.map(i => player.hand[i]);
        
        if (selectedCards.some(card => card === undefined)) {
            return socket.emit('message', {title: "Errore", message: "Selezione di carte non valida. Riprova."});
        }

        const manche = gameLogic.manches[state.currentManche - 1];

        if (gameLogic.validateCombination(selectedCards, manche.requirement)) {
            const selectedCardIds = selectedCards.map(c => c.id);
            player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
            player.groups.forEach(group => {
                const newGroup = group.filter(id => !selectedCardIds.includes(id));
                group.length = 0;
                Array.prototype.push.apply(group, newGroup);
            });
            
            state.tableCombinations.push({
                player: player.name,
                type: manche.name,
                cards: selectedCards,
                playerId: socket.id
            });
            player.dressed = true;
            state.turnPhase = 'discard';

            socket.emit('message', {title: "Ben fatto!", message: `Hai calato correttamente: ${manche.name}`});
            updateRoomState(roomCode);
        } else {
            socket.emit('message', {title: "Combinazione non valida", message: `Le carte selezionate non soddisfano la regola: ${manche.desc}`});
        }
    });

    // ==========================================================
    // ===== SOSTITUISCI QUESTO BLOCCO NEL TUO server.js =====
    // ==========================================================
    socket.on('attachCards', (selectedIndexes) => {
        const roomCode = findRoomBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        const state = room.gameState;
        const player = room.players[socket.id];

        if (state.currentPlayerId !== socket.id || !state.hasDrawn || !player.dressed || state.turnPhase !== 'play') {
            return socket.emit('message', { title: "Azione non permessa", message: "Non puoi calare o attaccare carte in questo momento." });
        }
        if (!selectedIndexes || selectedIndexes.length === 0) return;

        const selectedCards = selectedIndexes.map(i => player.hand[i]);

        if (selectedCards.some(card => card === undefined)) {
            return socket.emit('message', { title: "Errore", message: "Selezione di carte non valida. Riprova." });
        }

        // SCENARIO 1: Calare una NUOVA combinazione (richiede >= 3 carte)
        if (selectedIndexes.length >= 3) {
            const jokers = selectedCards.filter(c => c.isJoker).length;
            const nonJokers = selectedCards.filter(c => !c.isJoker);
            let combinationType = null;

            if (gameLogic.isValidSet(nonJokers, jokers)) {
                combinationType = selectedCards.length === 3 ? 'Tris' : 'Poker';
            } else if (gameLogic.isValidRun(nonJokers, jokers)) {
                combinationType = 'Scala';
            }

            if (combinationType) {
                const selectedCardIds = selectedCards.map(c => c.id);
                player.hand = player.hand.filter(c => !selectedCardIds.includes(c.id));
                player.groups.forEach(group => {
                    group.splice(0, group.length, ...group.filter(id => !selectedCardIds.includes(id)));
                });
                state.tableCombinations.push({ player: player.name, type: combinationType, cards: selectedCards, playerId: socket.id });
                socket.emit('message', { title: "Combinazione Calata!", message: `Hai formato: ${combinationType}.` });
                updateRoomState(roomCode);
                return; // Azione completata con successo
            }
        }

        // SCENARIO 2: Attaccare carte a una combinazione ESISTENTE (funziona anche con 1 carta)
        let attached = false;
        for (const card of selectedCards) {
            for (const combo of state.tableCombinations) {
                const newComboCards = [...combo.cards, card];
                const comboType = combo.type.toLowerCase().split(' ')[0];

                // Controlla se l'aggiunta è valida
                if (gameLogic.validateCombination(newComboCards, comboType) ||
                   (comboType === 'tris' && gameLogic.validateCombination(newComboCards, 'poker')) ||
                   (comboType === 'poker' && gameLogic.validateCombination(newComboCards, 'poker')) ||
                   (comboType === 'scala' && gameLogic.validateCombination(newComboCards, 'scala')))
                {
                    combo.cards.push(card); // Aggiungi la carta alla combinazione sul tavolo
                    
                    // Rimuovi la carta dalla mano e dai gruppi del giocatore
                    const cardIndexInHand = player.hand.findIndex(c => c.id === card.id);
                    if (cardIndexInHand > -1) player.hand.splice(cardIndexInHand, 1);
                    player.groups.forEach(group => {
                        const indexInGroup = group.indexOf(card.id);
                        if (indexInGroup > -1) group.splice(indexInGroup, 1);
                    });
                    
                    attached = true;
                    break; // Passa alla prossima carta da attaccare
                }
            }
            if(attached) break; // Se hai attaccato una carta, esci dal loop principale
        }

        if(attached){
             socket.emit('message', { title: "Carte Attaccate!", message: `Hai attaccato le carte con successo.` });
             updateRoomState(roomCode);
             return;
        }

        // Se nessun scenario ha avuto successo
        socket.emit('message', { title: "Mossa non valida", message: "Le carte selezionate non possono essere calate o attaccate." });
    });

    socket.on('disconnect', () => {
        console.log(`Utente disconnesso: ${socket.id}`);
        const roomCode = findRoomBySocketId(socket.id);
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            if (Object.keys(rooms[roomCode].players).length === 0) {
                delete rooms[roomCode];
                console.log(`Stanza ${roomCode} eliminata.`);
            } else {
                io.to(roomCode).emit('playerLeft', 'L\'avversario si è disconnesso. La partita è terminata.');
                delete rooms[roomCode];
            }
        }
    });
});

function updateRoomState(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const publicGameState = { ...room.gameState, players: {}, deckCount: room.gameState.deck.length, };
    delete publicGameState.deck;

    for (const playerId in room.players) {
        publicGameState.players[playerId] = {
            id: room.players[playerId].id,
            name: room.players[playerId].name,
            cardCount: room.players[playerId].hand.length,
            score: room.players[playerId].score,
            dressed: room.players[playerId].dressed,
            groups: room.players[playerId].groups,
        };
    }

    for (const playerId in room.players) {
        const privateState = { ...publicGameState, playerHand: room.players[playerId].hand }
        io.to(playerId).emit('gameStateUpdate', privateState);
    }
}

function startGame(roomCode) {
    const room = rooms[roomCode];
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
            room.players[pid].hand.push(state.deck.pop());
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

    const currentPlayerIndex = playerIds.indexOf(state.currentPlayerId);
    const nextPlayerIndex = (currentPlayerIndex + 1) % playerIds.length;
    state.currentPlayerId = playerIds[nextPlayerIndex];

    state.hasDrawn = false;
    state.turnPhase = 'draw';

    console.log(`Turno terminato. Ora è il turno di ${room.players[state.currentPlayerId].name}`);
    updateRoomState(roomCode);
}

server.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
});