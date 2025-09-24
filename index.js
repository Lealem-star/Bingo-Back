const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const connectDB = require('./config/database');
const UserService = require('./services/userService');
const WalletService = require('./services/walletService');
const Game = require('./models/Game');
const jwt = require('jsonwebtoken');

// Import routes
const { router: authRoutes, authMiddleware } = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const generalRoutes = require('./routes/general');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_here_change_this';

// Health check endpoint to keep service alive
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Use routes
app.use('/auth', authRoutes);
app.use('/wallet', walletRoutes);
app.use('/user', userRoutes);
app.use('/admin', adminRoutes);
app.use('/', generalRoutes);

// Initialize database connection
connectDB().catch(() => {
    console.log('⚠️  MongoDB connection failed. The service requires a database.');
});

// WebSocket server at /ws
const wss = new WebSocketServer({ noServer: true });

// --- Simple in-memory rooms with auto-cycling phases ---
const stakes = [10, 50];
const rooms = new Map(); // stake -> room
let currentStakeIndex = 0;

function makeRoom(stake) {
    const room = {
        id: `room_${stake}`,
        stake,
        phase: 'waiting', // waiting, registration, running, announce
        currentGameId: null,
        players: new Map(), // userId -> { ws, cartella, name }
        selectedPlayers: new Set(), // userIds who have successfully bet
        calledNumbers: [],
        cartellas: new Map(), // userId -> cartella
        winners: [],
        takenCards: new Set(), // numbers chosen during registration (1-100)
        userCardSelections: new Map(), // userId -> cardNumber
        startTime: null,
        registrationEndTime: null,
        gameEndTime: null,
        onJoin: async (ws) => {
            room.players.set(ws.userId, { ws, cartella: null, name: 'Player' });
            ws.room = room;
            broadcast('snapshot', {
                phase: room.phase,
                playersCount: room.selectedPlayers.size,
                calledNumbers: room.calledNumbers,
                stake: room.stake,
                takenCards: Array.from(room.takenCards),
                yourSelection: room.userCardSelections.get(ws.userId) || null
            }, room);
        },
        onLeave: (ws) => {
            room.players.delete(ws.userId);
            room.selectedPlayers.delete(ws.userId);
            room.cartellas.delete(ws.userId);
            const prev = room.userCardSelections.get(ws.userId);
            if (prev !== undefined && prev !== null) {
                room.takenCards.delete(prev);
                room.userCardSelections.delete(ws.userId);
            }
            broadcast('players_update', { playersCount: room.selectedPlayers.size }, room);
            broadcast('registration_update', { takenCards: Array.from(room.takenCards) }, room);
        }
    };
    return room;
}

function broadcast(type, payload, targetRoom = null) {
    const message = JSON.stringify({ type, payload });
    if (targetRoom) {
        // Broadcast to specific room
        targetRoom.players.forEach(({ ws }) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(message);
            }
        });
    } else {
        // Broadcast to all rooms (fallback)
        rooms.forEach(room => {
            room.players.forEach(({ ws }) => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(message);
                }
            });
        });
    }
}

function startRegistration(room) {
    room.phase = 'registration';
    room.registrationEndTime = Date.now() + 30000; // 30 seconds
    room.startTime = Date.now();
    room.takenCards.clear();
    room.userCardSelections.clear();
    room.currentGameId = null;
    broadcast('registration_open', {
        stake: room.stake,
        playersCount: room.selectedPlayers.size,
        duration: 30000,
        availableCards: Array.from({ length: 100 }, (_, i) => i + 1), // Generate 1-100 available cards
        takenCards: []
    }, room);

    setTimeout(() => {
        if (room.phase === 'registration') {
            startGame(room);
        }
    }, 30000);
}

function startGame(room) {
    if (room.selectedPlayers.size === 0) {
        room.phase = 'waiting';
        broadcast('game_cancelled', { reason: 'No players' }, room);
        // Do not auto-restart registration; wait for a player to trigger it
        return;
    }

    room.phase = 'running';
    room.calledNumbers = [];
    room.winners = [];
    room.gameEndTime = Date.now() + 300000; // 5 minutes max
    room.currentGameId = `LB${Date.now()}`;

    // Generate cartellas for all players
    room.selectedPlayers.forEach(userId => {
        const cartella = generateCartella();
        room.cartellas.set(userId, cartella);
        const player = room.players.get(userId);
        if (player) {
            player.cartella = cartella;
        }
    });

    // Send individual game_started messages to each player with their specific card
    room.selectedPlayers.forEach(userId => {
        const player = room.players.get(userId);
        if (player && player.ws) {
            const card = room.cartellas.get(userId);
            player.ws.send(JSON.stringify({
                type: 'game_started',
                payload: {
                    gameId: room.currentGameId,
                    stake: room.stake,
                    playersCount: room.selectedPlayers.size,
                    calledNumbers: room.calledNumbers,
                    card: card
                }
            }));
        }
    });

    // Start calling numbers
    callNextNumber(room);
}

function callNextNumber(room) {
    if (room.phase !== 'running' || room.calledNumbers.length >= 75) {
        toAnnounce(room);
        return;
    }

    let number;
    do {
        number = Math.floor(Math.random() * 75) + 1;
    } while (room.calledNumbers.includes(number));

    room.calledNumbers.push(number);
    broadcast('number_called', { gameId: room.currentGameId, number, calledNumbers: room.calledNumbers, value: number, called: room.calledNumbers }, room);

    // Check for winners
    checkWinners(room);

    // Call next number after delay
    setTimeout(() => callNextNumber(room), 2000);
}

function checkWinners(room) {
    const winners = [];
    room.cartellas.forEach((cartella, userId) => {
        if (checkBingo(cartella, room.calledNumbers)) {
            winners.push({ userId, cartella });
        }
    });

    if (winners.length > 0) {
        room.winners = winners;
        toAnnounce(room);
    }
}

function toAnnounce(room) {
    room.phase = 'announce';
    broadcast('game_ended', {
        gameId: room.currentGameId,
        winners: room.winners,
        calledNumbers: room.calledNumbers,
        stake: room.stake
    }, room);

    // Process winnings
    if (room.winners.length > 0) {
        const pot = room.selectedPlayers.size * room.stake;
        const systemCut = Math.floor(pot * 0.2); // 20% system cut
        const prizePool = pot - systemCut;
        const prizePerWinner = Math.floor(prizePool / room.winners.length);

        room.winners.forEach(async (winner) => {
            try {
                await WalletService.processGameWin(winner.userId, prizePerWinner);
            } catch (error) {
                console.error('Game win processing error:', error);
            }
        });

        // Save game to database
        const game = new Game({
            gameId: `game_${Date.now()}`,
            stake: room.stake,
            players: Array.from(room.selectedPlayers).map(userId => ({ userId })),
            winners: room.winners.map(w => ({ userId: w.userId, prize: prizePerWinner })),
            calledNumbers: room.calledNumbers,
            pot,
            systemCut,
            prizePool,
            status: 'completed',
            finishedAt: new Date()
        });
        game.save().catch(console.error);
    }

    // Reset room after delay, then immediately start a new registration round
    setTimeout(() => {
        room.phase = 'waiting';
        room.players.clear();
        room.selectedPlayers.clear();
        room.cartellas.clear();
        room.calledNumbers = [];
        room.winners = [];
        room.startTime = null;
        room.registrationEndTime = null;
        room.gameEndTime = null;
        broadcast('snapshot', { phase: 'waiting', playersCount: 0, calledNumbers: [], stake: room.stake, gameId: null, called: [] }, room);
        // Next registration will be triggered by first player selection
    }, 10000);
}

function generateCartella() {
    const cartella = [];
    for (let i = 0; i < 5; i++) {
        const row = [];
        for (let j = 0; j < 5; j++) {
            let number;
            do {
                number = Math.floor(Math.random() * 15) + 1 + (j * 15);
            } while (row.includes(number));
            row.push(number);
        }
        cartella.push(row);
    }
    return cartella;
}

function checkBingo(cartella, calledNumbers) {
    // Check rows
    for (let i = 0; i < 5; i++) {
        if (cartella[i].every(num => calledNumbers.includes(num))) {
            return true;
        }
    }

    // Check columns
    for (let j = 0; j < 5; j++) {
        if (cartella.every(row => calledNumbers.includes(row[j]))) {
            return true;
        }
    }

    // Check diagonals
    if (cartella.every((row, i) => calledNumbers.includes(row[i]))) {
        return true;
    }
    if (cartella.every((row, i) => calledNumbers.includes(row[4 - i]))) {
        return true;
    }

    return false;
}

// Removed minute-based auto-cycler. Rounds will be chained after each game ends,
// and initial registration will start at server boot.

// WebSocket connection handling
wss.on('connection', async (ws, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token') || '';
    const stakeParam = Number(url.searchParams.get('stake') || '');

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        ws.userId = String(payload.sub);
    } catch (error) {
        ws.close(1008, 'Invalid token');
        return;
    }

    // Auto-join room based on URL stake param (aligns with frontend behavior)
    if (!Number.isNaN(stakeParam) && stakes.includes(stakeParam)) {
        if (!rooms.has(stakeParam)) {
            rooms.set(stakeParam, makeRoom(stakeParam));
        }
        const room = rooms.get(stakeParam);
        await room.onJoin(ws);
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'join_room') {
                const stake = data.stake;
                if (!rooms.has(stake)) {
                    rooms.set(stake, makeRoom(stake));
                }
                const room = rooms.get(stake);
                room.onJoin(ws);
            } else if (data.type === 'select_card') {
                const room = ws.room;
                const cardNumber = Number(data.cardNumber || data.payload?.cardNumber);
                if (room && Number.isInteger(cardNumber) && cardNumber >= 1 && cardNumber <= 100) {
                    // If waiting, open registration immediately and continue to process the selection
                    if (room.phase === 'waiting') {
                        startRegistration(room);
                    }
                    const previous = room.userCardSelections.get(ws.userId);
                    if (previous) {
                        room.takenCards.delete(previous);
                    }
                    if (room.takenCards.has(cardNumber)) {
                        // Already taken, notify user
                        ws.send(JSON.stringify({ type: 'selection_rejected', payload: { reason: 'TAKEN', cardNumber } }));
                        return;
                    }

                    // Process game bet when player selects a cartella
                    try {
                        const result = await WalletService.processGameBet(ws.userId, room.stake);
                        if (!result.success) {
                            ws.send(JSON.stringify({ type: 'error', message: result.error }));
                            return;
                        }
                        // Add player to selectedPlayers when they successfully bet
                        room.selectedPlayers.add(ws.userId);
                    } catch (error) {
                        console.error('Game bet error during card selection:', error);
                        ws.send(JSON.stringify({ type: 'error', message: 'Failed to process bet' }));
                        return;
                    }

                    room.userCardSelections.set(ws.userId, cardNumber);
                    room.takenCards.add(cardNumber);
                    ws.send(JSON.stringify({ type: 'selection_confirmed', payload: { cardNumber, playersCount: room.selectedPlayers.size } }));
                    // Immediately inform all clients about players count to update UI top bar
                    broadcast('players_update', { playersCount: room.selectedPlayers.size }, room);
                    broadcast('registration_update', { takenCards: Array.from(room.takenCards) }, room);
                }
            } else if (data.type === 'start_registration') {
                // Optional: reply with snapshot; selection itself now triggers registration
                const room = ws.room;
                try { ws.send(JSON.stringify({ type: 'snapshot', payload: { phase: room?.phase || 'unknown', playersCount: room?.selectedPlayers?.size || 0, calledNumbers: room?.calledNumbers || [], stake: room?.stake, takenCards: Array.from(room?.takenCards || []), yourSelection: room?.userCardSelections?.get(ws.userId) || null } })); } catch { }
            } else if (data.type === 'claim_bingo') {
                const room = ws.room;
                if (room && room.phase === 'running') {
                    const cartella = room.cartellas.get(ws.userId);
                    if (cartella && checkBingo(cartella, room.calledNumbers)) {
                        room.winners.push({ userId: ws.userId, cartella });
                        toAnnounce(room);
                    }
                }
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    ws.on('close', () => {
        if (ws.room) {
            ws.room.onLeave(ws);
        }
    });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// Start server
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 WebSocket available at ws://localhost:${PORT}/ws`);

    // Initialize rooms without auto-starting registration; wait for first selection
    stakes.forEach((stake) => {
        if (!rooms.has(stake)) {
            rooms.set(stake, makeRoom(stake));
        }
        const room = rooms.get(stake);
        room.phase = 'waiting';
        broadcast('snapshot', { phase: 'waiting', playersCount: 0, calledNumbers: [], stake: room.stake, gameId: null, called: [] }, room);
    });
});

// Start Telegram bot
if (BOT_TOKEN) {
    const { startTelegramBot } = require('./telegram/bot');
    startTelegramBot({ BOT_TOKEN, WEBAPP_URL });
} else {
    console.log('⚠️  BOT_TOKEN not set. Telegram bot is disabled.');
}
