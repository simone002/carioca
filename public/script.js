const socket = io();

// Stato locale (sarà una copia speculare di quello del server)
let gameState = {};
let myPlayerId = null;
let selectedCardIndexes = new Set(); // Usiamo un Set per gestire gli indici delle carte selezionate

// ==========================================================
// # GESTIONE CONNESSIONE E EVENTI DAL SERVER
// ==========================================================

socket.on('connect', () => {
    updateConnectionStatus('connected');
    myPlayerId = socket.id;
});

socket.on('disconnect', () => {
    updateConnectionStatus('disconnected');
});

socket.on('roomCreated', ({ roomCode, playerId }) => {
    myPlayerId = playerId;
    showWaitingScreen(roomCode);
});

socket.on('gameStateUpdate', (serverState) => {
    gameState = serverState;
    console.log("Nuovo stato ricevuto dal server:", gameState);

    // Se non è il nostro turno, svuotiamo la selezione per sicurezza
    if (gameState.currentPlayerId !== myPlayerId) {
        selectedCardIndexes.clear();
    }
    
    if (gameState.gamePhase === 'waiting') {
        updateWaitingRoom();
    } else if (gameState.gamePhase === 'playing') {
        showGameScreen();
        updateUI();
    }
});

socket.on('error', (message) => {
    showMessage('Errore', message);
});

socket.on('playerLeft', (message) => {
    showMessage('Partita terminata', message);
    setTimeout(() => location.reload(), 3000);
});

socket.on('message', ({ title, message }) => {
    showMessage(title, message);
});


// ==========================================================
// # FUNZIONI CHE INVIANO AZIONI AL SERVER (EMITTERS)
// ==========================================================

function createRoom() {
    const playerName = document.getElementById('player-name').value.trim();
    if (!playerName) {
        return showMessage('Errore', 'Inserisci il tuo nome per continuare');
    }
    socket.emit('createRoom', playerName);
}

function joinRoom() {
    const playerName = document.getElementById('player-name').value.trim();
    const roomCode = document.getElementById('room-code').value.trim();
    if (!playerName || !roomCode) {
        return showMessage('Errore', 'Inserisci nome e codice stanza');
    }
    socket.emit('joinRoom', { roomCode, playerName });
}

function drawFromDeck() {
    socket.emit('drawFromDeck');
}

function drawFromDiscard() {
    socket.emit('drawFromDiscard');
}

function dressHand() {
    socket.emit('dressHand', getSelectedCardIndexes());
    // ===== CORREZIONE QUI =====
    // Svuota la selezione dopo aver inviato l'azione
    selectedCardIndexes.clear();
}

function attachCards() {
    socket.emit('attachCards', getSelectedCardIndexes());
    // ===== CORREZIONE QUI =====
    // Svuota la selezione anche qui
    selectedCardIndexes.clear();
}

function discardCard() {
    const selectedIndexes = getSelectedCardIndexes();
    if (selectedIndexes.length !== 1) {
        return showMessage('Attenzione', 'Seleziona una sola carta da scartare.');
    }
    socket.emit('discardCard', selectedIndexes[0]);
    selectedCardIndexes.clear(); // Deseleziona dopo lo scarto
}

// ==========================================================
// # FUNZIONI DI AGGIORNAMENTO DELLA UI (RENDER)
// ==========================================================

function selectCard(cardElement) {
    if (gameState.currentPlayerId !== myPlayerId) return;

    const cardId = cardElement.dataset.cardId;
    const hand = gameState.playerHand;
    const handIndex = hand.findIndex(c => c.id === cardId);

    if (handIndex === -1) return; 

    if (selectedCardIndexes.has(handIndex)) {
        selectedCardIndexes.delete(handIndex);
        cardElement.classList.remove('selected');
    } else {
        selectedCardIndexes.add(handIndex);
        cardElement.classList.add('selected');
    }
    updateButtons();
}

function getSelectedCardIndexes() {
    return Array.from(selectedCardIndexes);
}

function updateUI() {
    if (!gameState || !gameState.players || Object.keys(gameState.players).length === 0) {
        return; 
    }

    const manche = manches[gameState.currentManche - 1];
    document.getElementById('manche-title').textContent = `Manche ${gameState.currentManche}: ${manche.name}`;
    document.getElementById('manche-desc').textContent = manche.desc;
    document.getElementById('game-round').textContent = gameState.currentManche;
    const currentPlayer = gameState.players[gameState.currentPlayerId];
    document.getElementById('current-turn').textContent = currentPlayer ? currentPlayer.name : 'In attesa...';

    const playerIds = Object.keys(gameState.players);
    const myPlayerInfo = gameState.players[myPlayerId];
    const opponentId = playerIds.find(id => id !== myPlayerId);
    const opponentInfo = opponentId ? gameState.players[opponentId] : null;
    
    if (myPlayerInfo) {
        const p1El = document.getElementById('player1');
        p1El.querySelector('.player-name').textContent = `${myPlayerInfo.name} (Tu)`;
        p1El.querySelector('.player-score').textContent = `Punti: ${myPlayerInfo.score}`;
        p1El.querySelector('.player-cards').textContent = `Carte: ${myPlayerInfo.cardCount}`;
        p1El.classList.toggle('current', myPlayerInfo.id === gameState.currentPlayerId);
        p1El.classList.toggle('dressed', myPlayerInfo.dressed);
    }
    const p2El = document.getElementById('player2');
    if (opponentInfo) {
        p2El.style.display = '';
        p2El.querySelector('.player-name').textContent = opponentInfo.name;
        p2El.querySelector('.player-score').textContent = `Punti: ${opponentInfo.score}`;
        p2El.querySelector('.player-cards').textContent = `Carte: ${opponentInfo.cardCount}`;
        p2El.classList.toggle('current', opponentInfo.id === gameState.currentPlayerId);
        p2El.classList.toggle('dressed', opponentInfo.dressed);
    } else {
        p2El.style.display = 'none';
    }

    document.getElementById('deck-count').textContent = gameState.deckCount || 0;
    
    updateDiscardPile();
    updatePlayerHand();
    updateTableCombinations();
    updateButtons();
}

function updatePlayerHand() {
    const container = document.getElementById('player-hand-container');
    container.innerHTML = ''; 

    const myPlayerData = gameState.players[myPlayerId];
    if (!myPlayerData || !myPlayerData.groups) return;

    myPlayerData.groups.forEach(groupOfIds => {
        const groupEl = createNewGroup(false); 

        groupOfIds.forEach(cardId => {
            const cardData = gameState.playerHand.find(c => c.id === cardId);
            if (cardData) {
                const cardEl = createCardElement(cardData);
                groupEl.appendChild(cardEl);
            }
        });
        container.appendChild(groupEl);
    });

    if (container.children.length === 0 && (gameState.playerHand && gameState.playerHand.length > 0)) {
        const firstGroup = createNewGroup();
        gameState.playerHand.forEach(cardData => {
            firstGroup.appendChild(createCardElement(cardData));
        });
    } else if (container.children.length === 0) {
        createNewGroup();
    }
}

function updateDiscardPile() {
    const discardContainer = document.getElementById('discard-pile');
    if (gameState.discardPile && gameState.discardPile.length > 0) {
        const topCard = gameState.discardPile[gameState.discardPile.length - 1];
        discardContainer.innerHTML = `<div class="card ${topCard.isRed ? 'red' : 'black'}" onclick="drawFromDiscard()">
            ${topCard.isJoker ? '🃏' : topCard.value + topCard.suit}
        </div>`;
    } else {
        discardContainer.innerHTML = '<div class="card back">Vuoto</div>';
    }
}

function updateTableCombinations() {
    const tableEl = document.getElementById('table-combinations');
    const combinations = gameState.tableCombinations || [];
    if (combinations.length === 0) {
        tableEl.innerHTML = '<div style="opacity: 0.6;">Nessuna combinazione sul tavolo</div>';
        return;
    }
    tableEl.innerHTML = '';
    combinations.forEach(combo => {
        const comboEl = document.createElement('div');
        comboEl.className = 'combination';
        let cardsHTML = '';
        combo.cards.forEach(card => {
            cardsHTML += `<div class="card ${card.isJoker ? 'joker' : (card.isRed ? 'red' : 'black')}">${card.isJoker ? '🃏' : card.value + card.suit}</div>`;
        });
        comboEl.innerHTML = `
            <div class="combination-title">${combo.player}: ${combo.type}</div>
            <div class="combination-cards">${cardsHTML}</div>
        `;
        tableEl.appendChild(comboEl);
    });
}

function updateButtons() {
    const isMyTurn = gameState.currentPlayerId === myPlayerId;
    const hasSelected = selectedCardIndexes.size > 0;
    const myPlayerInfo = gameState.players[myPlayerId];
    
    const canDraw = isMyTurn && gameState.turnPhase === 'draw' && !gameState.hasDrawn;
    const canPlay = isMyTurn && gameState.turnPhase !== 'draw' && gameState.hasDrawn;
    const canDiscard = isMyTurn && gameState.hasDrawn && selectedCardIndexes.size === 1;

    document.getElementById('deck-card').style.cursor = canDraw ? 'pointer' : 'not-allowed';
    document.getElementById('discard-pile').style.cursor = canDraw ? 'pointer' : 'not-allowed';

    document.getElementById('dress-btn').disabled = !(canPlay && hasSelected && !myPlayerInfo.dressed);
    document.getElementById('attach-btn').disabled = !(canPlay && hasSelected && myPlayerInfo.dressed);
    document.getElementById('discard-btn').disabled = !canDiscard;
}

function createNewGroup(addToDom = true) {
    const container = document.getElementById('player-hand-container');
    const newGroup = document.createElement('div');
    newGroup.className = 'card-group';
    
    if(addToDom) {
        container.appendChild(newGroup);
    }

    new Sortable(newGroup, {
        group: 'player-hand',
        animation: 150,
        onEnd: function () {
            sendGroupsToServer();
        }
    });

    return newGroup;
}

function createCardElement(cardData) {
    const cardEl = document.createElement('div');
    cardEl.className = `card ${cardData.isJoker ? 'joker' : (cardData.isRed ? 'red' : 'black')}`;
    cardEl.textContent = cardData.isJoker ? '🃏' : cardData.value + cardData.suit;
    cardEl.dataset.cardId = cardData.id;
    cardEl.onclick = () => selectCard(cardEl);
    
    const handIndex = gameState.playerHand.findIndex(c => c.id === cardData.id);
    if (selectedCardIndexes.has(handIndex)) {
        cardEl.classList.add('selected');
    }
    
    return cardEl;
}

function sendGroupsToServer() {
    const container = document.getElementById('player-hand-container');
    const groups = [];
    container.querySelectorAll('.card-group').forEach(groupEl => {
        const cardIdsInGroup = [];
        groupEl.querySelectorAll('.card').forEach(cardEl => {
            cardIdsInGroup.push(cardEl.dataset.cardId);
        });
        groups.push(cardIdsInGroup);
    });
    socket.emit('updateGroups', groups);
}

// ==========================================================
// # FUNZIONI DI GESTIONE DELLE SCHERMATE E MODAL
// ==========================================================

function updateConnectionStatus(status) {
    const statusEl = document.getElementById('connection-status');
    statusEl.className = `connection-status ${status}`;
    statusEl.textContent = status === 'connected' ? 'Online' : 'Connecting...';
}

function showJoinRoom() {
    document.getElementById('join-room').style.display = 'block';
}

function showWaitingScreen(roomCode) {
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('waiting-screen').style.display = 'block';
    document.getElementById('room-code-display').textContent = roomCode;
}

function updateWaitingRoom() {
    const playersListEl = document.getElementById('waiting-players');
    playersListEl.innerHTML = '';
    const playerNames = Object.values(gameState.players).map(p => p.name);
    playersListEl.innerHTML = `Giocatori: ${playerNames.join(', ')}`;
}

function showGameScreen() {
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('waiting-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'block';
}

function showMessage(title, message) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-message').textContent = message;
    document.getElementById('message-modal').style.display = 'block';
}

function closeModal() {
    document.getElementById('message-modal').style.display = 'none';
}