const { createClient } = require('redis');

/** TTL stanze Redis: 2 ore. Le stanze attive rinnovano il TTL ad ogni salvataggio. */
const ROOM_TTL = 7200;

const redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
        tls: true,
        rejectUnauthorized: false
    }
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

async function connectRedis() {
    try {
        await redisClient.connect();
        console.log('✅ Connesso a Upstash Redis con successo!');
    } catch (e) {
        console.error('❌ Errore connessione Redis:', e);
    }
}

/**
 * Salva la stanza con TTL. Usare sempre questa funzione al posto di set diretto.
 */
async function saveRoom(roomCode, room) {
    await redisClient.set(`room:${roomCode}`, JSON.stringify(room), { EX: ROOM_TTL });
}

// ------------------------------------------------------------------
// INDICI SECONDARI: evitano la scansione lineare di tutte le stanze
// ------------------------------------------------------------------

/** Imposta l'indice uniquePlayerId → roomCode */
async function setPlayerRoomIndex(uniquePlayerId, roomCode) {
    await redisClient.set(`player:${uniquePlayerId}`, roomCode, { EX: ROOM_TTL });
}

/** Rimuove l'indice uniquePlayerId */
async function delPlayerRoomIndex(uniquePlayerId) {
    if (uniquePlayerId) await redisClient.del(`player:${uniquePlayerId}`);
}

/** Imposta l'indice socketId → roomCode */
async function setSocketRoomIndex(socketId, roomCode) {
    await redisClient.set(`socket:${socketId}`, roomCode, { EX: ROOM_TTL });
}

/** Rimuove l'indice socketId */
async function delSocketRoomIndex(socketId) {
    if (socketId) await redisClient.del(`socket:${socketId}`);
}

// ------------------------------------------------------------------
// LOOKUP STANZE
// ------------------------------------------------------------------

/**
 * Trova una stanza e il giocatore dato il suo uniquePlayerId.
 * Usa prima l'indice O(1), poi fallback a scansione completa.
 */
async function findRoomAndPlayerByUniqueId(uniquePlayerId) {
    // Fast path
    const cachedRoomCode = await redisClient.get(`player:${uniquePlayerId}`);
    if (cachedRoomCode) {
        try {
            const roomDataString = await redisClient.get(`room:${cachedRoomCode}`);
            if (roomDataString) {
                const room = JSON.parse(roomDataString);
                if (room?.players) {
                    for (const socketId in room.players) {
                        if (room.players[socketId].uniquePlayerId === uniquePlayerId) {
                            return { roomCode: room.gameState.roomCode, room, oldSocketId: socketId };
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`Errore lookup indice player ${uniquePlayerId}:`, e);
        }
        // Indice stale: rimuove
        await redisClient.del(`player:${uniquePlayerId}`);
    }

    // Fallback: scansione completa
    const roomKeys = await redisClient.keys('room:*');
    for (const roomKey of roomKeys) {
        try {
            const roomDataString = await redisClient.get(roomKey);
            if (!roomDataString) continue;
            const room = JSON.parse(roomDataString);
            if (!room?.players) continue;
            for (const socketId in room.players) {
                if (room.players[socketId].uniquePlayerId === uniquePlayerId) {
                    // Ripristina l'indice
                    await setPlayerRoomIndex(uniquePlayerId, room.gameState.roomCode);
                    return { roomCode: room.gameState.roomCode, room, oldSocketId: socketId };
                }
            }
        } catch (e) {
            console.error(`Errore parsing stanza ${roomKey}:`, e);
        }
    }
    return { roomCode: null, room: null, oldSocketId: null };
}

/**
 * Trova la stanza in cui si trova un dato socket.
 * Usa prima l'indice O(1), poi fallback a scansione completa.
 */
async function findRoomBySocketId(socketId) {
    // Fast path
    const cachedRoomCode = await redisClient.get(`socket:${socketId}`);
    if (cachedRoomCode) {
        try {
            const roomDataString = await redisClient.get(`room:${cachedRoomCode}`);
            if (roomDataString) {
                const room = JSON.parse(roomDataString);
                if (room.players?.[socketId]) {
                    return { roomCode: room.gameState.roomCode, room };
                }
            }
        } catch (e) {
            console.error(`Errore lookup indice socket ${socketId}:`, e);
        }
        // Indice stale
        await redisClient.del(`socket:${socketId}`);
    }

    // Fallback: scansione completa
    const roomKeys = await redisClient.keys('room:*');
    for (const roomKey of roomKeys) {
        try {
            const roomDataString = await redisClient.get(roomKey);
            if (!roomDataString) continue;
            const room = JSON.parse(roomDataString);
            if (room.players?.[socketId]) {
                return { roomCode: room.gameState.roomCode, room };
            }
        } catch (e) {
            console.error(`Errore parsing stanza ${roomKey}:`, e);
        }
    }
    return { roomCode: null, room: null };
}

module.exports = {
    redisClient, connectRedis, ROOM_TTL, saveRoom,
    setPlayerRoomIndex, delPlayerRoomIndex,
    setSocketRoomIndex, delSocketRoomIndex,
    findRoomAndPlayerByUniqueId, findRoomBySocketId
};
