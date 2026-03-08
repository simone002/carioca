const { createClient } = require('redis');

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
 * Trova una stanza e il giocatore dato il suo uniquePlayerId.
 */
async function findRoomAndPlayerByUniqueId(uniquePlayerId) {
    const roomKeys = await redisClient.keys('room:*');
    for (const roomKey of roomKeys) {
        try {
            const roomDataString = await redisClient.get(roomKey);
            if (!roomDataString) continue;
            const room = JSON.parse(roomDataString);
            if (!room?.players) continue;
            for (const socketId in room.players) {
                if (room.players[socketId].uniquePlayerId === uniquePlayerId) {
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
 */
async function findRoomBySocketId(socketId) {
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

module.exports = { redisClient, connectRedis, findRoomAndPlayerByUniqueId, findRoomBySocketId };
