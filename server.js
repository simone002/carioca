const express = require('express');
require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const { redisClient, connectRedis } = require('./redisClient.js');
const gameEngine = require('./gameEngine.js');
const { registerHandlers } = require('./socketHandlers.js');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    pingInterval: 5000,
    pingTimeout: 10000,
    cors: {
        origin: process.env.CLIENT_URL || '*',
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;

// Avvia connessione Redis e inizializza il motore di gioco
connectRedis();
gameEngine.init(io, redisClient);

app.use(express.static(path.join(__dirname, 'public')));

// Registra tutti gli handler Socket.IO
io.on('connection', (socket) => {
    registerHandlers(io, socket, redisClient);
});

server.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
});