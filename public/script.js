// Global variables
let jokersToDefine = [];
let originalAction = null;
let originalSelection = [];
let jokerAssignments = [];
let isSwappingJoker = false;
let previousPlayerId = null; // NUOVA VARIABILE: per tracciare il turno precedente

const socket = io();
let gameState = {};
let myPlayerId = null;
let selectedCardIndexes = new Set();

// ==========================================================
// # SOCKET EVENT HANDLERS
// ==========================================================
socket.on('connect', () => { updateConnectionStatus('connected'); myPlayerId = socket.id; });
socket.on('disconnect', () => { updateConnectionStatus('disconnected'); });
socket.on('roomCreated', ({ roomCode, playerId }) => { myPlayerId = playerId; showWaitingScreen(roomCode); });

socket.on('gameStateUpdate', (serverState) => {
    // ===== MODIFICA CHIAVE QUI =====
    // Controlla se il turno è appena passato a questo giocatore
    if (previousPlayerId !== myPlayerId && serverState.currentPlayerId === myPlayerId && serverState.gamePhase === 'playing') {
        showMessage("È il tuo turno!", "Tocca a te giocare.");
    }
    previousPlayerId = serverState.currentPlayerId; // Aggiorna il tracker del turno

    gameState = serverState;
    console.log("Nuovo stato ricevuto:", gameState);
    if (gameState.currentPlayerId !== myPlayerId) selectedCardIndexes.clear();
    if (gameState.gamePhase === 'waiting') {
        showWaitingScreen(gameState.roomCode);
        updateWaitingRoom();
    }
    else if (gameState.gamePhase === 'playing') { 
        showGameScreen(); 
        updateUI(); 
    }
});

socket.on('error', (message) => { showMessage('Errore', message); });
socket.on('playerLeft', (message) => { showMessage('Partita terminata', message); setTimeout(() => location.reload(), 3000); });
socket.on('message', ({ title, message }) => { showMessage(title, message.replace(/\n/g, '<br>')); });

// ==========================================================
// # GAME ACTIONS
// ==========================================================
function createRoom() { const playerName = document.getElementById('player-name').value.trim(); if (!playerName) return showMessage('Errore', 'Inserisci il tuo nome per continuare'); socket.emit('createRoom', playerName); }
function joinRoom() { const playerName = document.getElementById('player-name').value.trim(); const roomCode = document.getElementById('room-code').value.trim(); if (!playerName || !roomCode) return showMessage('Errore', 'Inserisci nome e codice stanza'); socket.emit('joinRoom', { roomCode, playerName }); }
function requestStartGame() { socket.emit('startGameRequest'); }
function drawFromDeck() { socket.emit('drawFromDeck'); }
function drawFromDiscard() { socket.emit('drawFromDiscard'); }
function dressHand() { handleActionWithJokers(getSelectedCardIndexes(), 'dressHand'); }
function attachCards() { handleActionWithJokers(getSelectedCardIndexes(), 'attachCards'); }
function discardCard() {
    const selectedIndexes = getSelectedCardIndexes();
    if (selectedIndexes.length !== 1) return showMessage('Attenzione', 'Seleziona una sola carta da scartare.');
    socket.emit('discardCard', selectedIndexes[0]);
    selectedCardIndexes.clear();
}

// ==========================================================
// # JOKER LOGIC
// ==========================================================
function populateJokerValues() { const select = document.getElementById('joker-value-select'); const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']; values.forEach(v => { const option = document.createElement('option'); option.value = v; option.textContent = v; select.appendChild(option); });}
function handleActionWithJokers(selectedIndexes, actionType) {
    const selectedCards = selectedIndexes.map(i => gameState.playerHand[i]);
    const jokersInSelection = selectedIndexes.filter(i => gameState.playerHand[i] && gameState.playerHand[i].isJoker);
    if (jokersInSelection.length > 0) {
        jokersToDefine = [...jokersInSelection];
        originalAction = actionType;
        originalSelection = selectedIndexes;
        jokerAssignments = [];
        promptNextJoker();
    } else {
        socket.emit(actionType, { selectedIndexes });
        selectedCardIndexes.clear();
    }
}
function promptNextJoker() {
    if (jokersToDefine.length > 0) {
        const numDefined = jokerAssignments.length + 1;
        const totalJokers = jokerAssignments.length + jokersToDefine.length;
        document.getElementById('joker-modal-title').textContent = `Assegna Valore al Jolly (${numDefined}/${totalJokers})`;
        document.getElementById('joker-modal').style.display = 'flex';
    } else {
        sendActionWithJokerData();
    }
}
function sendActionWithJokerData() {
    document.getElementById('joker-modal').style.display = 'none';
    socket.emit(originalAction, { selectedIndexes: originalSelection, jokerAssignments: jokerAssignments });
    selectedCardIndexes.clear();
}
document.getElementById('confirm-joker-btn').addEventListener('click', () => {
    const jokerIndex = jokersToDefine.shift();
    const value = document.getElementById('joker-value-select').value;
    const suit = document.getElementById('joker-suit-select').value;
    jokerAssignments.push({ index: jokerIndex, becomes: { value, suit } });
    promptNextJoker();
});
function attemptJokerSwap(tableJokerId, comboIndex) {
    const selectedIndexes = getSelectedCardIndexes();
    if (selectedIndexes.length !== 1) {
        showMessage('Azione non valida', 'Per scambiare un Jolly, seleziona prima una singola carta dalla tua mano che abbia lo stesso valore del Jolly.');
        return;
    }
    const handCardIndex = selectedIndexes.values().next().value;
    const handCardId = gameState.playerHand[handCardIndex].id;
    socket.emit('swapJoker', { handCardId, tableJokerId, comboIndex });
    selectedCardIndexes.clear();
}

// ==========================================================
// # UI RENDERING FUNCTIONS
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
function getSelectedCardIndexes() { return Array.from(selectedCardIndexes); }
function updateUI() {
    if (!gameState || !gameState.players) return;
    const playersContainer = document.getElementById('players-container');
    playersContainer.innerHTML = ''; 
    const playerIds = Object.keys(gameState.players);
    const myIndex = playerIds.indexOf(myPlayerId);
    if (myIndex > -1) {
        playerIds.splice(myIndex, 1);
        playerIds.unshift(myPlayerId);
    }
    playerIds.forEach(pid => {
        const player = gameState.players[pid];
        const playerEl = document.createElement('div');
        playerEl.className = 'player';
        playerEl.classList.toggle('current', player.id === gameState.currentPlayerId);
        playerEl.classList.toggle('dressed', player.dressed);
        playerEl.innerHTML = `<div class="player-name">${player.id === myPlayerId ? `${player.name} (Tu)` : player.name}</div><div class="player-score">Punti: ${player.score}</div><div class="player-cards">Carte: ${player.cardCount}</div>`;
        playersContainer.appendChild(playerEl);
    });

    const manche = manches[gameState.currentManche - 1];
    document.getElementById('manche-title').textContent = `Manche ${gameState.currentManche}: ${manche.name}`;
    document.getElementById('manche-desc').textContent = manche.desc;
    document.getElementById('game-round').textContent = gameState.currentManche;
    const currentPlayer = gameState.players[gameState.currentPlayerId];
    document.getElementById('current-turn').textContent = currentPlayer ? currentPlayer.name : 'In attesa...';
    
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
        discardContainer.innerHTML = `<div class="card ${topCard.isRed ? 'red' : 'black'}" onclick="drawFromDiscard()">${topCard.isJoker ? '🃏' : topCard.value + topCard.suit}</div>`;
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
    combinations.forEach((combo, comboIndex) => {
        const comboEl = document.createElement('div');
        comboEl.className = 'combination';
        let cardsHTML = '';
        combo.cards.forEach(card => {
            let jokerValueHTML = '';
            let jokerSuitHTML = '';
            let suitColorClass = card.isRed ? 'red' : 'black';
            if (card.isJoker && card.assignedValue) {
                jokerValueHTML = `<span class="joker-value">${card.assignedValue}</span>`;
                const isRedSuit = card.assignedSuit === '♥' || card.assignedSuit === '♦';
                jokerSuitHTML = `<span class="joker-suit ${isRedSuit ? 'red' : 'black'}">${card.assignedSuit}</span>`;
            }
            const onClickAction = (card.isJoker && card.assignedValue) 
                ? `onclick="attemptJokerSwap('${card.id}', ${comboIndex})"` 
                : '';
            cardsHTML += `<div class="card ${card.isJoker ? 'joker' : suitColorClass}" ${onClickAction}>${card.isJoker ? '🃏' : card.value + card.suit}${jokerValueHTML}${jokerSuitHTML}</div>`;
        });
        comboEl.innerHTML = `<div class="combination-title">${combo.player}: ${combo.type}</div><div class="combination-cards">${cardsHTML}</div>`;
        tableEl.appendChild(comboEl);
    });
}
function updateButtons() {
    const isMyTurn = gameState.currentPlayerId === myPlayerId;
    const hasSelected = selectedCardIndexes.size > 0;
    const myPlayerInfo = gameState.players ? gameState.players[myPlayerId] : null;
    if (!myPlayerInfo) return;
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
    if (addToDom) container.appendChild(newGroup);
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    new Sortable(newGroup, {
        group: 'player-hand',
        animation: 150,
        forceFallback: !isTouchDevice,
        onEnd: function () {
            setTimeout(sendGroupsToServer, 0);
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
    if (selectedCardIndexes.has(handIndex)) cardEl.classList.add('selected');
    return cardEl;
}
function sendGroupsToServer() {
    const container = document.getElementById('player-hand-container');
    const groups = [];
    let cardCountInDom = 0;
    container.querySelectorAll('.card-group').forEach(groupEl => {
        const cardIdsInGroup = [];
        groupEl.querySelectorAll('.card').forEach(cardEl => {
            cardIdsInGroup.push(cardEl.dataset.cardId);
            cardCountInDom++;
        });
        groups.push(cardIdsInGroup);
    });
    if (gameState.playerHand && gameState.playerHand.length !== cardCountInDom) {
        console.error("Discrepanza nel conteggio delle carte! Ridisegno forzato della mano.");
        updatePlayerHand();
        return;
    }
    socket.emit('updateGroups', groups);
}

// ==========================================================
// # FUNZIONI DI GESTIONE SCHERMATE E MODAL
// ==========================================================
function updateConnectionStatus(status) { const statusEl = document.getElementById('connection-status'); statusEl.className = `connection-status ${status}`; statusEl.textContent = status === 'connected' ? 'Online' : 'Connecting...'; }
function showJoinRoom() { document.getElementById('join-room').style.display = 'block'; }
function showWaitingScreen(roomCode) {
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('waiting-screen').style.display = 'block';
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('room-code-display').textContent = roomCode;
}
function updateWaitingRoom() {
    const playersListEl = document.getElementById('waiting-players');
    const startGameBtn = document.getElementById('start-game-btn');
    if (!gameState.players) return;
    const playerNames = Object.values(gameState.players).map(p => p.name);
    playersListEl.innerHTML = `Giocatori: ${playerNames.join(', ')}`;
    if (myPlayerId === gameState.hostId && playerNames.length >= 2) {
        startGameBtn.style.display = 'block';
    } else {
        startGameBtn.style.display = 'none';
    }
}
function showGameScreen() {
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('waiting-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'block';
}
function showMessage(title, message) {
    const modal = document.getElementById('message-modal');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-message').innerHTML = message.replace(/\n/g, '<br>');
    modal.style.display = 'flex';
}
function closeModal() { 
    document.getElementById('message-modal').style.display = 'none'; 
    document.getElementById('joker-modal').style.display = 'none';
}

// Initialize
populateJokerValues();