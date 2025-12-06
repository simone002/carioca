// Manche definitions
const manches = [
    { name: "Coppia", desc: "Devi calare una coppia (2 carte uguali) Vestite", requirement: "coppia" },
    { name: "Doppia Coppia", desc: "Devi calare due coppie diverse, una vestita e una non vestita", requirement: "doppiacoppia" },
    { name: "Tris", desc: "Devi calare un tris (3 carte uguali)", requirement: "tris" },
    { name: "Scala", desc: "Devi calare una scala di 5 carte consecutive", requirement: "scala" },
    { name: "Poker", desc: "Devi calare stessa carta dei 4 semi", requirement: "poker" },
    { name: "Full", desc: "Devi calare un full (tris + coppia)", requirement: "full" },
    { name: "Scala 40", desc: "Devi calare 40 con un minimo di 3 carte per gioco", requirement: "scala40" },
    { name: "Chiusura in mano", desc: "Devi calare tutte le regole con rimanente alla fine 1 carta da scartare", requirement: "chiusura in mano" }
];

// Card suits and values
const suits = ['♠', '♥', '♦', '♣'];
const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function getCardPoints(value) {
    if (value === 'A') return 11;
    if (['J', 'Q', 'K'].includes(value)) return 10;
    return parseInt(value) || 10;
}

function createDeck() {
    let deck = [];
    for (let i = 0; i < 2; i++) {
        for (let suit of suits) {
            for (let value of values) {
                deck.push({
                    suit: suit,
                    value: value,
                    isRed: suit === '♥' || suit === '♦',
                    points: getCardPoints(value),
                    id: `${value}${suit}${i}` // Unique ID for each card
                });
            }
        }
    }
    for (let i = 0; i < 4; i++) {
        deck.push({
            suit: '🃏',
            value: 'JOKER',
            isRed: false,
            points: 25,
            isJoker: true,
            id: `JOKER${i}`
        });
    }
    return shuffleDeck(deck);
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// ============================================
//  TUTTE LE FUNZIONI DI VALIDAZIONE
// ============================================

function validateCombination(cards, requirement) {
    switch (requirement) {
        case 'coppia':
            return validateCoppia(cards);
        case 'doppiacoppia':
            return validateDoppiaCoppia(cards);
        case 'tris':
            return validateTris(cards);
        case 'scala':
            return validateScala(cards);
        case 'poker':
            return validatePoker(cards);
        case 'full':
            return validateFull(cards);
        case 'scala40':
            return validateScala40(cards);
        case 'chiusura in mano': // Corretto il requirement name
            return validateChiusura(cards);
        default:
            return false;
    }
}

function validateCoppia(cards) {
    if (cards.length !== 2) return false;
    const validValues = ["A", "K", "Q", "J"];
    let jokers = cards.filter(c => c.isJoker).length;
    let nonJokers = cards.filter(c => !c.isJoker);
    if (jokers === 2) return true;
    if (jokers === 1) {
        return validValues.includes(nonJokers[0].value);
    }
    return nonJokers[0].value === nonJokers[1].value &&
           validValues.includes(nonJokers[0].value) &&
           nonJokers[0].suit !== nonJokers[1].suit;
}

function validateDoppiaCoppia(cards) {
    if (cards.length !== 4) return false;
    const vested = ["A", "K", "Q", "J"];
    let valuesCount = {};
    let jokers = 0;
    cards.forEach(c => {
        if (c.isJoker) jokers++;
        else valuesCount[c.value] = (valuesCount[c.value] || 0) + 1;
    });
    
    let pairs = Object.keys(valuesCount).filter(v => valuesCount[v] >= 2);
    let singles = Object.keys(valuesCount).filter(v => valuesCount[v] === 1);
    
    while (jokers > 0 && singles.length > 0) {
        pairs.push(singles.pop());
        jokers--;
    }
    
    if (jokers >= 2) {
        pairs.push('joker-pair-1'); // Placeholder for a pair of jokers
        jokers -= 2;
    }
    if (jokers >= 2) {
        pairs.push('joker-pair-2');
    }
    
    if (pairs.length !== 2) return false;

    let hasVested = pairs.some(v => vested.includes(v) || v.startsWith('joker'));
    let hasUnvested = pairs.some(v => !vested.includes(v) || v.startsWith('joker'));

    return hasVested && hasUnvested;
}


function validateTris(cards) {
    if (cards.length !== 3) return false;
    let jokers = cards.filter(c => c.isJoker).length;
    let nonJokers = cards.filter(c => !c.isJoker);
    if (nonJokers.length <= 1) return true;
    const firstValue = nonJokers[0].value;
    if (!nonJokers.every(c => c.value === firstValue)) return false;
    const suits = new Set(nonJokers.map(c => c.suit));
    return suits.size === nonJokers.length;
}

function validateScala(cards) {
    if (cards.length !== 5) return false;
    // Scala requires same suit, but your validateSequenza allows different suits unless specified
    // Assuming a run of 5 consecutive cards of the same suit.
    const nonJokers = cards.filter(c => !c.isJoker);
    if (nonJokers.length > 0) {
        const firstSuit = nonJokers[0].suit;
        if (!nonJokers.every(c => c.suit === firstSuit)) return false;
    }
    return validateSequenza(cards, 5);
}

function validatePoker(cards) {
    if (cards.length !== 4) return false;
    let jokers = cards.filter(c => c.isJoker).length;
    let nonJokers = cards.filter(c => !c.isJoker);
    if (nonJokers.length <= 1) return true;
    const firstValue = nonJokers[0].value;
    if (!nonJokers.every(c => c.value === firstValue)) return false;
    const suits = new Set(nonJokers.map(c => c.suit));
    return suits.size === nonJokers.length;
}

function validateFull(cards) {
    if (cards.length !== 5) return false;
    let valueCounts = {};
    let jokers = 0;
    cards.forEach(card => {
        if (card.isJoker) jokers++;
        else valueCounts[card.value] = (valueCounts[card.value] || 0) + 1;
    });

    let counts = Object.values(valueCounts).sort((a, b) => b - a);

    if (jokers === 0) return counts[0] === 3 && counts[1] === 2;
    if (jokers === 1) return (counts[0] === 3 && counts.length === 2) || (counts[0] === 2 && counts[1] === 2);
    if (jokers === 2) return counts[0] === 3 || (counts[0] === 2 && counts.length > 1) || counts[0] === 1 && counts.length === 3;
    if (jokers >= 3) return true; // Can always make a full house
    
    return false;
}

function validateScala40(cards) {
    // Gestisce sia carte reali che "virtuali" assegnate ai jolly
    const allCards = cards.map(c => c.isJoker ? { ...c, assignedValue: c.assignedValue, assignedSuit: c.assignedSuit } : c);

    const totalPoints = allCards.reduce((sum, card) => sum + card.points, 0);
    if (totalPoints < 40) return false;

    // Ora controlliamo se le carte possono essere suddivise in giochi validi
    return canPartitionIntoMelds(allCards);
}

function canPartitionIntoMelds(cards) {
    // Caso base: se non ci sono più carte, abbiamo trovato una soluzione.
    if (cards.length === 0) return true;

    const n = cards.length;
    // La combinazione più piccola è di 3 carte.
    if (n < 3) return false;

    // Funzione per generare tutte le possibili combinazioni di carte
    const getCombinations = (arr, size) => {
        const result = [];
        const f = (prefix, arr) => {
            if (prefix.length === size) {
                result.push(prefix);
                return;
            }
            for (let i = 0; i < arr.length; i++) {
                f(prefix.concat(arr[i]), arr.slice(i + 1));
            }
        };
        f([], arr);
        return result;
    };
    
    // Prova a formare un gioco valido con 3, 4 o 5 carte
    for (const size of [3, 4, 5]) {
        if (n >= size) {
            const combinations = getCombinations(cards, size);
            for (const potentialMeld of combinations) {
                
                const jokers = potentialMeld.filter(c => c.isJoker).length;
                const nonJokers = potentialMeld.filter(c => !c.isJoker);
                
                // Se la combinazione trovata è un gioco valido...
                if (isValidSet(nonJokers, jokers) || isValidRun(nonJokers, jokers)) {
                    
                    // ...crea un nuovo set di carte rimanenti...
                    const remainingCards = cards.filter(card => !potentialMeld.includes(card));
                    
                    // ...e prova ricorsivamente a partizionare le carte rimanenti.
                    if (canPartitionIntoMelds(remainingCards)) {
                        return true; // Se la ricorsione ha successo, abbiamo finito.
                    }
                }
            }
        }
    }

    // Se abbiamo provato tutte le combinazioni e non abbiamo trovato una soluzione, fallisci.
    return false;
}

function isValidSet(nonJokers, jokers) {
    if (nonJokers.length + jokers < 3) return false;
    if (nonJokers.length === 0) return true;
    const value = nonJokers[0].value;
    if (!nonJokers.every(c => c.value === value)) return false;
    const suits = new Set(nonJokers.map(c => c.suit));
    return suits.size === nonJokers.length;
}


function isValidRun(cards) {
    // Passiamo semplicemente la lunghezza attuale delle carte come requisito.
    // In questo modo usiamo la logica "intelligente" dell'Asso che abbiamo appena scritto.
    return validateSequenza(cards, cards.length);
}

function validateChiusura(cards) {
    // Serve avere almeno carte sufficienti per un gioco (3) + 1 scarto
    if (cards.length < 4) return false;

    // Proviamo a scartare una carta alla volta
    for (let i = 0; i < cards.length; i++) {
        // Crea una mano temporanea rimuovendo la carta all'indice 'i'
        const handMinusOne = cards.slice(0, i).concat(cards.slice(i + 1));

        // Controlla se le carte rimanenti formano giochi validi completi
        if (canPartitionIntoMelds(handMinusOne)) {
            return true; // Trovata una chiusura valida!
        }
    }
    
    return false; // Nessuna combinazione di chiusura trovata
}

function canPartitionIntoValidGames(cards) {
    if (cards.length === 0) return true;
    if (cards.length < 3) return false;

    // A backtracking or dynamic programming solution is needed here for efficiency.
    // This is a placeholder for that complex logic. For now, we assume it works.
    // A simple check could be to see if they can be grouped greedily, which is not perfect.
    return true; // Placeholder for a very complex algorithm
}

function getCardNumericValue(value, aceIsHigh = false) {
    if (value === 'A') return aceIsHigh ? 14 : 1;
    if (value === 'J') return 11;
    if (value === 'Q') return 12;
    if (value === 'K') return 13;
    return parseInt(value);
}

function validateSequenza(cards, requiredLength) {
    if (cards.length !== requiredLength) return false;
    let jokers = cards.filter(c => c.isJoker).length;
    let nonJokers = cards.filter(c => !c.isJoker);

    if (nonJokers.length === 0) return jokers >= requiredLength;

    const suit = nonJokers[0].suit;
    if (!nonJokers.every(c => c.suit === suit)) return false;

    // Check 1: Ace as Low (1)
    const lowValues = nonJokers.map(c => getCardNumericValue(c.value, false)).sort((a, b) => a - b);
    if (checkGaps(lowValues, jokers)) return true;

    // Check 2: Ace as High (14)
    // Constraint: High Ace runs cannot contain 2, 3, 4, etc.
    if (nonJokers.some(c => c.value === 'A')) {
        const highValues = nonJokers.map(c => getCardNumericValue(c.value, true)).sort((a, b) => a - b);
        // If we use High Ace, the smallest card cannot be < 10 (unless it's the Ace itself which is now 14)
        // Actually, just checking gaps is sufficient, because [2, 14] is a gap of 11, which fails naturally.
        if (checkGaps(highValues, jokers)) return true;
    }

    return false;
}

// Helper to calculate gaps
function checkGaps(sortedValues, jokerCount) {
    // Check for duplicates (invalid in a run)
    if (new Set(sortedValues).size !== sortedValues.length) return false;

    let gaps = 0;
    for (let i = 0; i < sortedValues.length - 1; i++) {
        gaps += (sortedValues[i + 1] - sortedValues[i]) - 1;
    }
    return gaps <= jokerCount;
}


// Esporta le funzioni per poterle usare nel server
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        manches,
        createDeck,
        shuffleDeck,
        validateCombination,
        validateCoppia,
        validateDoppiaCoppia,
        validateTris,
        validateScala,
        validatePoker,
        validateFull,
        validateScala40,
        validateChiusura,
        getCardNumericValue,
        getCardPoints,
        isValidSet, 
        isValidRun, 
    };

    // In fondo al file public/logic.js
}