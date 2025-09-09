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

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory stores (fallback when MongoDB is unavailable)
const sessions = new Map(); // sessionId -> userId
const users = new Map(); // userId -> user (fallback)
const wallets = new Map(); // userId -> wallet (fallback)

// Initialize database connection
connectDB().catch(() => {
    console.log('⚠️  MongoDB connection failed, using in-memory storage');
});

// Fallback function for when MongoDB is unavailable
function ensureWallet(userId) {
    if (!wallets.has(userId)) wallets.set(userId, { main: 0, play: 50, coins: 1, gamesWon: 0 });
    return wallets.get(userId);
}

// Dev auth helper (Telegram initData verification)
const crypto = require('crypto');
function verifyTelegramInitData(initData) {
    if (!initData || !BOT_TOKEN) return null;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const data = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');
        const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const myHash = crypto.createHmac('sha256', secret).update(data).digest('hex');
        if (myHash !== hash) return null;
        const userJson = params.get('user');
        return userJson ? JSON.parse(userJson) : null;
    } catch { return null; }
}

app.post('/auth/telegram/verify', async (req, res) => {
    try {
        const { initData, devUserId } = req.body || {};
        let telegramUser = null;

        if (initData && BOT_TOKEN) {
            telegramUser = verifyTelegramInitData(initData);
            if (!telegramUser) return res.status(401).json({ error: 'INVALID_INIT_DATA' });
        } else if (devUserId) {
            telegramUser = { id: String(devUserId), first_name: 'Dev' };
        } else {
            return res.status(400).json({ error: 'MISSING_PARAMS' });
        }

        const userId = String(telegramUser.id);
        let user;

        try {
            // Try to use database first
            user = await UserService.createOrUpdateUser(telegramUser);
        } catch (dbError) {
            console.log('Database unavailable, using in-memory storage');
            // Fallback to in-memory storage
            const existingUser = users.get(userId) || {};
            user = {
                telegramId: userId,
                firstName: telegramUser.first_name || existingUser.firstName || 'User',
                lastName: telegramUser.last_name || existingUser.lastName || '',
                phone: existingUser.phone || null,
                isRegistered: !!existingUser.phone
            };
            users.set(userId, user);
            ensureWallet(userId);
        }

        // Create session
        const sessionId = crypto.randomBytes(16).toString('hex');
        sessions.set(sessionId, userId);

        res.json({
            sessionId,
            user: {
                id: user.telegramId || userId,
                name: user.firstName,
                phone: user.phone,
                firstName: user.firstName,
                lastName: user.lastName,
                isRegistered: user.isRegistered
            }
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

function authMiddleware(req, res, next) {
    const sid = req.headers['x-session'];
    if (sid && sessions.has(sid)) {
        req.userId = sessions.get(sid);
        return next();
    }
    return res.status(401).json({ error: 'UNAUTHORIZED' });
}

// Wallet endpoints
app.get('/wallet', authMiddleware, async (req, res) => {
    try {
        let wallet;
        try {
            // Try database first
            const user = await UserService.getUserByTelegramId(req.userId);
            if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
            wallet = await WalletService.getWallet(user._id);
        } catch (dbError) {
            console.log('Database unavailable, using in-memory wallet');
            // Fallback to in-memory storage
            wallet = ensureWallet(req.userId);
        }

        res.json({
            main: wallet.main,
            play: wallet.play,
            coins: wallet.coins,
            gamesWon: wallet.gamesWon
        });
    } catch (error) {
        console.error('Wallet fetch error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

app.post('/wallet/convert', authMiddleware, async (req, res) => {
    try {
        const { coins } = req.body || {};
        const amt = Math.max(0, Number(coins || 0));

        if (amt <= 0) return res.status(400).json({ error: 'INVALID_AMOUNT' });

        let wallet;
        try {
            // Try database first
            const user = await UserService.getUserByTelegramId(req.userId);
            if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
            const result = await WalletService.convertCoins(user._id, amt);
            wallet = result.wallet;
        } catch (dbError) {
            console.log('Database unavailable, using in-memory conversion');
            // Fallback to in-memory storage
            wallet = ensureWallet(req.userId);
            if (wallet.coins < amt) return res.status(400).json({ error: 'INSUFFICIENT_COINS' });
            wallet.coins -= amt;
            wallet.play += amt;
        }

        res.json({
            playAdded: amt,
            wallet: {
                main: wallet.main,
                play: wallet.play,
                coins: wallet.coins,
                gamesWon: wallet.gamesWon
            }
        });
    } catch (error) {
        console.error('Coin conversion error:', error);
        if (error.message === 'Insufficient coins') {
            res.status(400).json({ error: 'INSUFFICIENT_COINS' });
        } else {
            res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
        }
    }
});

// User profile endpoint
app.get('/user/profile', authMiddleware, async (req, res) => {
    try {
        let userData;
        try {
            // Try database first
            const user = await UserService.getUserByTelegramId(req.userId);
            if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

            const wallet = await WalletService.getWallet(user._id);
            userData = {
                user: {
                    id: user.telegramId,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    phone: user.phone,
                    isRegistered: user.isRegistered,
                    totalGamesPlayed: user.totalGamesPlayed,
                    totalGamesWon: user.totalGamesWon,
                    registrationDate: user.registrationDate
                },
                wallet: {
                    main: wallet.main,
                    play: wallet.play,
                    coins: wallet.coins,
                    gamesWon: wallet.gamesWon
                }
            };
        } catch (dbError) {
            console.log('Database unavailable, using in-memory profile');
            // Fallback to in-memory storage
            const user = users.get(req.userId) || { id: req.userId, firstName: 'User', phone: null };
            const wallet = ensureWallet(req.userId);
            userData = {
                user: {
                    id: user.id,
                    firstName: user.firstName,
                    lastName: user.lastName || '',
                    phone: user.phone,
                    isRegistered: !!user.phone,
                    totalGamesPlayed: 0,
                    totalGamesWon: 0,
                    registrationDate: new Date()
                },
                wallet: {
                    main: wallet.main,
                    play: wallet.play,
                    coins: wallet.coins,
                    gamesWon: wallet.gamesWon
                }
            };
        }

        res.json(userData);
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Transaction history endpoint
app.get('/user/transactions', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

        let transactions;
        try {
            // Try database first
            const user = await UserService.getUserByTelegramId(req.userId);
            if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

            const result = await WalletService.getTransactionHistory(user._id, parseInt(limit), parseInt(skip));
            transactions = result.transactions.map(t => ({
                id: t._id,
                type: t.type,
                amount: t.amount,
                description: t.description,
                status: t.status,
                createdAt: t.createdAt,
                gameId: t.gameId
            }));
        } catch (dbError) {
            console.log('Database unavailable, using empty transaction history');
            // Fallback to empty array
            transactions = [];
        }

        res.json({ transactions, total: transactions.length });
    } catch (error) {
        console.error('Transaction history error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Game history endpoint
app.get('/user/games', authMiddleware, async (req, res) => {
    try {
        let games;
        try {
            // Try database first
            const user = await UserService.getUserByTelegramId(req.userId);
            if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

            // This would need to be implemented in the Game model
            games = []; // Placeholder for now
        } catch (dbError) {
            console.log('Database unavailable, using empty game history');
            games = [];
        }

        res.json({ games });
    } catch (error) {
        console.error('Game history error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Basic route
app.get('/', (req, res) => {
    res.json({ message: 'Welcome to Bingo Backend API!' });
});

// Health check route
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Bingo game routes
app.get('/api/bingo/status', (req, res) => {
    res.json({
        gameStatus: 'ready',
        players: 0,
        message: 'Bingo game backend is running'
    });
});

// WebSocket server at /ws
const wss = new WebSocketServer({ noServer: true });

// --- Simple in-memory rooms with auto-cycling phases ---
const stakes = [10, 50];
const rooms = new Map();

function range(n, m) { return Array.from({ length: m - n + 1 }, (_, i) => n + i); }
function shuffle(arr) { return arr.sort(() => Math.random() - 0.5); }

function generateCard() {
    // Create a simple BINGO card with center 0
    const columns = [
        shuffle(range(1, 15)).slice(0, 5),
        shuffle(range(16, 30)).slice(0, 5),
        shuffle(range(31, 45)).slice(0, 5),
        shuffle(range(46, 60)).slice(0, 5),
        shuffle(range(61, 75)).slice(0, 5),
    ];
    const grid = Array.from({ length: 5 }, (_, r) => (
        Array.from({ length: 5 }, (_, c) => (r === 2 && c === 2 ? 0 : columns[c][r]))
    ));
    return { id: Math.floor(Math.random() * 1000) + 1, grid };
}

function makeRoom(stake) {
    const room = {
        stake,
        clients: new Set(),
        phase: 'registration',
        gameId: null,
        timer: null,
        called: [],
        nextStartAt: null,
        availableCards: range(1, 110),
        pot: 0,
        winners: [],
        cardById: new Map(),
    };

    function broadcast(type, payload) {
        room.clients.forEach(ws => {
            try { ws.send(JSON.stringify({ type, payload })); } catch { }
        });
    }

    function toRunning() {
        room.phase = 'running';
        room.gameId = `BB${Math.floor(Math.random() * 900000 + 100000)}`;
        room.called = [];
        room.winners = [];
        room.pot = stake * room.clients.size;
        room.cardById.clear();
        const numbers = shuffle(range(1, 75));
        // Give each client a random card for demo
        room.clients.forEach(ws => {
            const card = generateCard();
            room.cardById.set(card.id, card.grid);
            try { ws.send(JSON.stringify({ type: 'game_started', payload: { gameId: room.gameId, bet: stake, pot: room.pot, card, called: [] } })); } catch { }
        });
        let i = 0;
        let waitingForAudio = false;
        let audioTimeout = null;
        function maybeFinish() {
            if (i >= numbers.length || i >= 20) {
                toAnnounce();
                return true;
            }
            return false;
        }
        function sendNext() {
            if (maybeFinish()) return;
            const value = numbers[i++];
            room.called.push(value);
            waitingForAudio = true;
            broadcast('number_called', { gameId: room.gameId, value, called: room.called });
            // Fallback timeout to continue if no client acks
            clearTimeout(audioTimeout);
            audioTimeout = setTimeout(() => {
                if (waitingForAudio) {
                    waitingForAudio = false;
                    sendNext();
                }
            }, 2500);
        }
        room._onAudioDone = () => {
            if (!waitingForAudio) return;
            waitingForAudio = false;
            clearTimeout(audioTimeout);
            sendNext();
        };
        sendNext();
    }

    function toAnnounce() {
        room.phase = 'announce';
        const next = Date.now() + 5000;
        room.nextStartAt = next;
        const winnerCount = room.winners.length;
        const systemCut = Math.floor(room.pot * 0.20);
        const distributable = Math.max(0, room.pot - systemCut);
        const prizePerWinner = winnerCount > 0 ? Math.floor(distributable / winnerCount) : 0;
        const remainderToSystem = distributable - (prizePerWinner * winnerCount);
        const totalSystem = systemCut + remainderToSystem;
        const winnersPayload = room.winners.map(w => ({ ...w, prize: prizePerWinner, cardNumbers: room.cardById.get(w.cardId), called: room.called }));
        broadcast('game_finished', { gameId: room.gameId, winners: winnersPayload, prizePerWinner, systemCut: totalSystem, nextStartAt: next });

        // Persist finished game with system revenue (best-effort)
        (async () => {
            try {
                const finishedGame = new Game({
                    gameId: room.gameId,
                    stake: room.stake,
                    status: 'finished',
                    players: [],
                    calledNumbers: room.called,
                    winners: winnersPayload.map(w => ({
                        userId: undefined,
                        cartelaNumber: w.cardId,
                        prize: w.prize,
                        winningPattern: 'bingo'
                    })),
                    pot: room.pot,
                    systemCut: totalSystem,
                    totalPrizes: prizePerWinner * winnerCount,
                    startedAt: new Date(Date.now() - 30000),
                    finishedAt: new Date(),
                    registrationEndsAt: new Date(Date.now() - 45000)
                });
                await finishedGame.save();
            } catch (e) {
                // eslint-disable-next-line no-console
                console.log('Failed to persist game (non-fatal):', e?.message || e);
            }
        })();
        setTimeout(() => toRegistration(), 5000);
    }

    function toRegistration() {
        room.phase = 'registration';
        const ends = Date.now() + 15000;
        room.nextStartAt = ends;
        broadcast('registration_open', { gameId: `PENDING`, endsAt: ends, availableCards: room.availableCards.slice(0, 60) });
        setTimeout(() => {
            broadcast('registration_closed', { gameId: 'PENDING' });
            toRunning();
        }, 15000);
    }

    // Start loop
    toRegistration();

    // Public API
    room.onJoin = (ws) => {
        room.clients.add(ws);
        // Snapshot
        try { ws.send(JSON.stringify({ type: 'snapshot', payload: { phase: room.phase, gameId: room.gameId, called: room.called, availableCards: room.availableCards.slice(0, 60), endsAt: room.nextStartAt } })); } catch { }
        ws.on('close', () => room.clients.delete(ws));
    };

    return room;
}

stakes.forEach(s => rooms.set(String(s), makeRoom(s)));

server.on('upgrade', (request, socket, head) => {
    const { url } = request;
    if (!url || !url.startsWith('/ws')) {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

function send(ws, type, payload) {
    try { ws.send(JSON.stringify({ type, payload })); } catch { }
}

wss.on('connection', (ws, request) => {
    const url = new URL(request.url, `http://localhost:${PORT}`);
    const stake = url.searchParams.get('stake') || '10';
    const room = rooms.get(String(stake));
    if (!room) {
        send(ws, 'error', { code: 'NO_ROOM', message: 'Invalid stake' });
        ws.close();
        return;
    }
    room.onJoin(ws);

    ws.on('message', (buf) => {
        let msg = null;
        try { msg = JSON.parse(buf.toString()); } catch { }
        if (!msg) return;
        if (msg.type === 'select_card') {
            // For demo we do nothing; could mark reserved
        }
        if (msg.type === 'audio_done') {
            if (room && typeof room._onAudioDone === 'function') {
                room._onAudioDone();
            }
        }
        if (msg.type === 'bingo_claim') {
            // Add winner (avoid duplicates by cardId)
            const cardId = msg.payload.cardNumber;
            if (!room.winners.find(w => w.cardId === cardId)) {
                room.winners.push({ name: 'Player', cardId });
            }
            const winnerCount = room.winners.length;
            const systemCut = Math.floor(room.pot * 0.20);
            const distributable = Math.max(0, room.pot - systemCut);
            const prizePerWinner = winnerCount > 0 ? Math.floor(distributable / winnerCount) : 0;
            const remainderToSystem = distributable - (prizePerWinner * winnerCount);
            const totalSystem = systemCut + remainderToSystem;
            const winnersPayload = room.winners.map(w => ({ ...w, prize: prizePerWinner, cardNumbers: room.cardById.get(w.cardId), called: room.called }));
            // Notify all clients so everyone sees multi-winner state evolve
            room.clients.forEach(client => {
                send(client, 'bingo_accepted', { winners: winnersPayload, prizePerWinner, systemCut: totalSystem });
            });
        }
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Bingo Backend server running on port ${PORT}`);
    console.log(`📍 HTTP: http://localhost:${PORT}`);
    console.log(`🔍 Health: http://localhost:${PORT}/health`);
    console.log(`🔌 WS: ws://localhost:${PORT}/ws?stake=10`);
});

module.exports = app;

// --- Telegram Bot: deposit via pasted SMS ---
try {
    const { Telegraf } = require('telegraf');
    if (BOT_TOKEN) {
        const bot = new Telegraf(BOT_TOKEN);

        function parseReceipt(text) {
            if (typeof text !== 'string') return null;

            // Try different patterns for different payment methods
            const patterns = [
                // CBE SMS pattern
                /ETB\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
                // Telebirr pattern
                /(\d+(?:\.\d{1,2})?)\s*ETB/i,
                // General amount pattern
                /(\d+(?:\.\d{1,2})?)\s*ብር/i,
                // Simple number pattern
                /(\d+(?:\.\d{1,2})?)/i
            ];

            let amount = null;
            for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match) {
                    amount = Number(match[1]);
                    if (amount >= 50) break; // Minimum deposit amount
                }
            }

            if (!amount || amount < 50) return null;

            // Extract additional info
            const whenMatch = text.match(/on\s+([0-9]{2}\/[0-9]{2}\/[0-9]{4})\s+at\s+([0-9]{2}:[0-9]{2}:[0-9]{2})/i);
            const refMatch = text.match(/id=([A-Z0-9]+)/i) || text.match(/ref[:\s]*([A-Z0-9]+)/i);

            return {
                amount,
                when: whenMatch ? `${whenMatch[1]} ${whenMatch[2]}` : null,
                ref: refMatch ? refMatch[1] : null,
                type: text.toLowerCase().includes('telebirr') ? 'telebirr' :
                    text.toLowerCase().includes('commercial') ? 'commercial' :
                        text.toLowerCase().includes('abyssinia') ? 'abyssinia' :
                            text.toLowerCase().includes('cbe') ? 'cbe' : 'unknown'
            };
        }

        // Welcome message with inline keyboard (admin-aware)
        bot.start((ctx) => {
            // Ensure user exists in DB when starting bot (best-effort)
            (async () => {
                try { await UserService.createOrUpdateUser(ctx.from); } catch { }
            })();
            const isAdmin = String(ctx.from.id) === '966981995';
            if (isAdmin) {
                const adminText = '🛠️ Admin Panel';
                const keyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '📈 Today Revenue (20%)', callback_data: 'admin_today_revenue' }
                            ],
                            [
                                { text: '📊 This Week Revenue (20%)', callback_data: 'admin_week_revenue' }
                            ],
                            [{ text: '📣 Broadcast', callback_data: 'admin_broadcast' }]
                        ]
                    }
                };
                const photoPath = path.join(__dirname, 'static', 'lb.png');
                const photo = fs.existsSync(photoPath) ? { source: fs.createReadStream(photoPath) } : (WEBAPP_URL || '').replace(/\/$/, '') + '/lb.png';
                return ctx.replyWithPhoto(photo, { caption: adminText, reply_markup: keyboard.reply_markup });
            }

            const welcomeText = `👋 Welcome to Love Bingo! Choose an Option below.`;
            const keyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🎮 Play', callback_data: 'play' },
                            { text: '📝 Register', callback_data: 'register' }
                        ],
                        [
                            { text: '💵 Check Balance', callback_data: 'balance' },
                            { text: '💰 Deposit', callback_data: 'deposit' }
                        ],
                        [
                            { text: '☎️ Contact Support', callback_data: 'support' },
                            { text: '📖 Instruction', callback_data: 'instruction' }
                        ],
                        [
                            { text: '🎁 Transfer', callback_data: 'transfer' },
                            { text: '🤑 Withdraw', callback_data: 'withdraw' }
                        ],
                        [
                            { text: '🔗 Invite', callback_data: 'invite' }
                        ]
                    ]
                }
            };
            const photoPath = path.join(__dirname, 'static', 'lb.png');
            const photo = fs.existsSync(photoPath) ? { source: fs.createReadStream(photoPath) } : (WEBAPP_URL || '').replace(/\/$/, '') + '/lb.png';
            return ctx.replyWithPhoto(photo, { caption: welcomeText, reply_markup: keyboard.reply_markup });
        });

        // --- Admin actions ---
        async function ensureAdmin(ctx) {
            const isAdmin = String(ctx.from?.id) === '966981995';
            if (!isAdmin) {
                await ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => { });
                return false;
            }
            return true;
        }

        // Support /admin command to open admin panel
        bot.command('admin', async (ctx) => {
            if (String(ctx.from.id) !== '966981995') {
                return ctx.reply('Unauthorized');
            }
            const adminText = '🛠️ Admin Panel';
            const keyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📈 Today Revenue (20%)', callback_data: 'admin_today_revenue' }
                        ],
                        [
                            { text: '📊 This Week Revenue (20%)', callback_data: 'admin_week_revenue' }
                        ],
                        [{ text: '📣 Broadcast', callback_data: 'admin_broadcast' }]
                    ]
                }
            };
            return ctx.reply(adminText, keyboard);
        });

        bot.action('admin_today_revenue', async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            try {
                const start = new Date();
                start.setHours(0, 0, 0, 0);
                const end = new Date();
                end.setHours(23, 59, 59, 999);

                let todayRevenue = 0;
                try {
                    const games = await Game.find({ status: 'finished', finishedAt: { $gte: start, $lte: end } }, { systemCut: 1 });
                    todayRevenue = games.reduce((sum, g) => sum + (g.systemCut || 0), 0);
                } catch (e) {
                    // If DB unavailable, estimate from in-memory rooms last broadcasted finish event (not persisted)
                    todayRevenue = 0;
                }

                await ctx.answerCbQuery('');
                await ctx.reply(`📈 Today System Revenue (20% per game): ETB ${todayRevenue.toFixed(2)}`, {
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] }
                });
            } catch (err) {
                await ctx.reply('❌ Failed to fetch today revenue');
            }
        });

        bot.action('back_to_admin', async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            const adminText = '🛠️ Admin Panel';
            const keyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📈 Today Revenue (20%)', callback_data: 'admin_today_revenue' }
                        ],
                        [
                            { text: '📊 This Week Revenue (20%)', callback_data: 'admin_week_revenue' }
                        ],
                        [{ text: '📣 Broadcast', callback_data: 'admin_broadcast' }]
                    ]
                }
            };
            await ctx.editMessageText(adminText, keyboard).catch(() => ctx.reply(adminText, keyboard));
        });

        bot.action('admin_week_revenue', async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            try {
                const now = new Date();
                const day = now.getDay(); // 0=Sun,1=Mon,...
                const diffToMonday = (day === 0 ? -6 : 1 - day);
                const monday = new Date(now);
                monday.setHours(0, 0, 0, 0);
                monday.setDate(monday.getDate() + diffToMonday);
                const sunday = new Date(monday);
                sunday.setDate(sunday.getDate() + 6);
                sunday.setHours(23, 59, 59, 999);

                let weekRevenue = 0;
                try {
                    const games = await Game.find({ status: 'finished', finishedAt: { $gte: monday, $lte: sunday } }, { systemCut: 1 });
                    weekRevenue = games.reduce((sum, g) => sum + (g.systemCut || 0), 0);
                } catch (e) {
                    weekRevenue = 0;
                }

                await ctx.answerCbQuery('');
                await ctx.reply(`📊 This Week System Revenue (20% per game): ETB ${weekRevenue.toFixed(2)}`, {
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] }
                });
            } catch (err) {
                await ctx.reply('❌ Failed to fetch weekly revenue');
            }
        });

        // Simple in-memory state for admin broadcast flow
        const adminStates = new Map(); // adminId -> { mode: 'broadcast' | 'await_caption_media', pending?: { kind, fileId } }

        async function getBroadcastTargets() {
            // DB-only: do not use in-memory or admin fallbacks
            const dbUsers = await require('./models/User').find({}, { telegramId: 1 });
            const ids = (dbUsers || []).map(u => String(u.telegramId)).filter(Boolean);
            if (!ids.length) {
                throw new Error('NO_RECIPIENTS');
            }
            return Array.from(new Set(ids));
        }

        async function sendToAll(ids, sendOne) {
            const results = await Promise.allSettled(ids.map(id => sendOne(id)));
            const success = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - success;
            return { success, failed, total: results.length };
        }

        function buildBroadcastMarkup(caption) {
            const kb = { inline_keyboard: [] };
            if (isHttpsWebApp) {
                kb.inline_keyboard.push([{ text: 'Play', web_app: { url: WEBAPP_URL } }]);
            }
            const hasButtons = kb.inline_keyboard.length > 0;
            const base = hasButtons ? { reply_markup: kb } : {};
            if (caption !== undefined) {
                return { ...base, caption, parse_mode: 'HTML' };
            }
            return { ...base, parse_mode: 'HTML' };
        }

        async function sendPendingMediaToAll(pending, caption) {
            const targets = await getBroadcastTargets();
            const options = buildBroadcastMarkup(caption);
            if (pending.kind === 'photo') {
                return sendToAll(targets, async (id) => bot.telegram.sendPhoto(id, pending.fileId, options));
            }
            if (pending.kind === 'video') {
                return sendToAll(targets, async (id) => bot.telegram.sendVideo(id, pending.fileId, options));
            }
            if (pending.kind === 'document') {
                return sendToAll(targets, async (id) => bot.telegram.sendDocument(id, pending.fileId, options));
            }
            if (pending.kind === 'animation') {
                return sendToAll(targets, async (id) => bot.telegram.sendAnimation(id, pending.fileId, options));
            }
            throw new Error('UNSUPPORTED_MEDIA');
        }

        bot.action('admin_broadcast', async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            adminStates.set(String(ctx.from.id), { mode: 'broadcast' });
            await ctx.answerCbQuery('');
            await ctx.reply('📣 Send the message to broadcast now (text, photo, video, document, etc.).', { reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'back_to_admin' }]] } });
        });

        // Handle inline keyboard button clicks
        const isHttpsWebApp = typeof WEBAPP_URL === 'string' && WEBAPP_URL.startsWith('https://');

        bot.action('play', (ctx) => {
            ctx.answerCbQuery('🎮 Opening game...');
            const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
            if (isHttpsWebApp) {
                keyboard.inline_keyboard.unshift([{ text: '🌐 Open Web App', web_app: { url: WEBAPP_URL } }]);
            }
            const note = isHttpsWebApp ? '' : '\n\n⚠️ Web App button hidden because Telegram requires HTTPS. Set WEBAPP_URL in .env to an https URL.';
            ctx.reply('🎮 To play Bingo, please use our web app:' + note, { reply_markup: keyboard });
        });

        bot.action('register', (ctx) => {
            ctx.answerCbQuery('📝 Registration info...');
            const keyboard = {
                reply_markup: {
                    keyboard: [
                        [{ text: '📱 Share Contact', request_contact: true }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            };
            ctx.reply('📝 To complete registration, please share your contact information:\n\n📱 Click "Share Contact" below to provide your phone number.\n\n✅ This helps us verify your account and provide better support.', keyboard);
        });

        bot.action('balance', async (ctx) => {
            try {
                const userId = String(ctx.from.id);
                let w;

                try {
                    // Try database first
                    const userData = await UserService.getUserWithWallet(userId);
                    if (!userData || !userData.wallet) {
                        return ctx.reply('❌ Wallet not found. Please register first.');
                    }
                    w = userData.wallet;
                } catch (dbError) {
                    console.log('Database unavailable, using in-memory wallet');
                    // Fallback to in-memory storage
                    w = ensureWallet(userId);
                }

                ctx.answerCbQuery('💵 Balance checked');
                const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
                if (isHttpsWebApp) keyboard.inline_keyboard.unshift([{ text: '🌐 Open Web App', web_app: { url: WEBAPP_URL } }]);
                ctx.reply(`💵 Your Wallet Balance:\n\n💰 Main Wallet: ETB ${w.main.toFixed(2)}\n🎮 Play Balance: ETB ${w.play.toFixed(2)}\n🪙 Coins: ${w.coins.toFixed(0)}`, { reply_markup: keyboard });
            } catch (error) {
                console.error('Balance check error:', error);
                ctx.reply('❌ Error checking balance. Please try again.');
            }
        });

        bot.action('deposit', (ctx) => {
            ctx.answerCbQuery('💰 Deposit amount...');
            ctx.reply(`💰 Enter the amount you want to deposit, starting from 50 Birr.`);
        });

        bot.action('support', (ctx) => {
            ctx.answerCbQuery('☎️ Support info...');
            ctx.reply(`☎️ Contact Support:\n\n📞 For payment issues:\n@beteseb3\n@betesebbingosupport2\n\n💬 For general support:\n@betesebsupport\n\n⏰ Support hours:\n24/7 available`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
        });

        bot.action('instruction', (ctx) => {
            ctx.answerCbQuery('📖 Instructions...');
            const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
            if (isHttpsWebApp) keyboard.inline_keyboard.unshift([{ text: '🎮 Start Playing', web_app: { url: WEBAPP_URL } }]);
            ctx.reply(`📖 How to Play Love Bingo:\n\n1️⃣ Choose your stake (ETB 10 or 50)\n2️⃣ Select a bingo card\n3️⃣ Wait for numbers to be called\n4️⃣ Mark numbers on your card\n5️⃣ Call "BINGO!" when you win\n\n🎯 Win by getting 5 in a row (horizontal, vertical, or diagonal)\n\n💰 Prizes are shared among all winners!`, { reply_markup: keyboard });
        });

        bot.action('transfer', (ctx) => {
            ctx.answerCbQuery('🎁 Transfer info...');
            ctx.reply(`🎁 Transfer to Friends:\n\n💡 Transfer feature coming soon!\n\n🔮 You'll be able to:\n• Send play balance to friends\n• Gift coins to other players\n• Share winnings\n\n📱 Stay tuned for updates!`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
        });

        bot.action('withdraw', (ctx) => {
            ctx.answerCbQuery('🤑 Withdraw info...');
            ctx.reply(`🤑 Withdraw Funds:\n\n💡 Withdrawal feature coming soon!\n\n🔮 You'll be able to:\n• Withdraw to your bank account\n• Request via CBE transfer\n• Minimum withdrawal: ETB 50\n\n📞 Contact support for manual withdrawals`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '☎️ Contact Support', callback_data: 'support' }],
                        [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
        });

        bot.action('invite', (ctx) => {
            ctx.answerCbQuery('🔗 Invite friends...');
            const inviteLink = `https://t.me/${ctx.botInfo.username}?start=invite_${ctx.from.id}`;
            const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
            keyboard.inline_keyboard.unshift([{ text: '📤 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=Join me in Love Bingo!` }]);
            ctx.reply(`🔗 Invite Friends to Love Bingo!\n\n👥 Share this link with your friends:\n\n${inviteLink}\n\n🎁 Invite rewards coming soon!\n\n💡 The more friends you invite, the more rewards you'll get!`, { reply_markup: keyboard });
        });

        bot.action('back_to_menu', (ctx) => {
            ctx.answerCbQuery('🔙 Back to menu');
            const welcomeText = `👋 Welcome to Love Bingo! Choose an Option below.`;
            const keyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🎮 Play', callback_data: 'play' },
                            { text: '📝 Register', callback_data: 'register' }
                        ],
                        [
                            { text: '💵 Check Balance', callback_data: 'balance' },
                            { text: '💰 Deposit', callback_data: 'deposit' }
                        ],
                        [
                            { text: '☎️ Contact Support', callback_data: 'support' },
                            { text: '📖 Instruction', callback_data: 'instruction' }
                        ],
                        [
                            { text: '🎁 Transfer', callback_data: 'transfer' },
                            { text: '🤑 Withdraw', callback_data: 'withdraw' }
                        ],
                        [
                            { text: '🔗 Invite', callback_data: 'invite' }
                        ]
                    ]
                }
            };
            return ctx.editMessageText(welcomeText, keyboard);
        });

        // Telebirr deposit handler
        bot.action(/^deposit_telebirr_(\d+(?:\.\d{1,2})?)$/, (ctx) => {
            const amount = ctx.match[1];
            ctx.answerCbQuery('📱 Telebirr deposit...');
            ctx.reply(`📱 Telebirr Deposit Instructions:\n\n📋 Agent Details:\n👤 Name: TADESSE\n📱 Telebirr: 0912345678\n\n💡 Steps:\n1️⃣ Open your Telebirr app\n2️⃣ Select "Send Money"\n3️⃣ Enter agent number: 0912345678\n4️⃣ Enter amount: ETB ${amount}\n5️⃣ Send the transaction\n6️⃣ Paste the receipt here\n\n✅ Your wallet will be credited automatically!`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📱 Send Receipt', callback_data: 'send_receipt_telebirr' }],
                        [{ text: '🔙 Back to Deposit', callback_data: 'deposit' }]
                    ]
                }
            });
        });

        // Commercial Bank deposit handler
        bot.action(/^deposit_commercial_(\d+(?:\.\d{1,2})?)$/, (ctx) => {
            const amount = ctx.match[1];
            ctx.answerCbQuery('🏦 Commercial Bank deposit...');
            ctx.reply(`🏦 Commercial Bank Deposit Instructions:\n\n📋 Agent Details:\n👤 Name: TADESSE\n🏦 Account: 1000071603052\n🏛️ Bank: Commercial Bank of Ethiopia\n\n💡 Steps:\n1️⃣ Go to Commercial Bank\n2️⃣ Transfer to account: 1000071603052\n3️⃣ Enter amount: ETB ${amount}\n4️⃣ Complete the transaction\n5️⃣ Send the SMS receipt here\n\n✅ Your wallet will be credited automatically!`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📱 Send SMS Receipt', callback_data: 'send_receipt_commercial' }],
                        [{ text: '🔙 Back to Deposit', callback_data: 'deposit' }]
                    ]
                }
            });
        });

        // Abyssinia Bank deposit handler
        bot.action(/^deposit_abyssinia_(\d+(?:\.\d{1,2})?)$/, (ctx) => {
            const amount = ctx.match[1];
            ctx.answerCbQuery('🏛️ Abyssinia Bank deposit...');
            ctx.reply(`🏛️ Abyssinia Bank Deposit Instructions:\n\n📋 Agent Details:\n👤 Name: TADESSE\n🏦 Account: 2000081603052\n🏛️ Bank: Abyssinia Bank\n\n💡 Steps:\n1️⃣ Go to Abyssinia Bank\n2️⃣ Transfer to account: 2000081603052\n3️⃣ Enter amount: ETB ${amount}\n4️⃣ Complete the transaction\n5️⃣ Send the SMS receipt here\n\n✅ Your wallet will be credited automatically!`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📱 Send SMS Receipt', callback_data: 'send_receipt_abyssinia' }],
                        [{ text: '🔙 Back to Deposit', callback_data: 'deposit' }]
                    ]
                }
            });
        });

        // CBE Birr deposit handler
        bot.action(/^deposit_cbe_(\d+(?:\.\d{1,2})?)$/, (ctx) => {
            const amount = ctx.match[1];
            ctx.answerCbQuery('💳 CBE Birr deposit...');
            ctx.reply(`💳 CBE Birr Deposit Instructions:\n\n📋 Agent Details:\n👤 Name: TADESSE\n💳 CBE Birr: 0912345678\n🏦 Bank: Commercial Bank of Ethiopia\n\n💡 Steps:\n1️⃣ Open CBE Birr app\n2️⃣ Select "Send Money"\n3️⃣ Enter agent number: 0912345678\n4️⃣ Enter amount: ETB ${amount}\n5️⃣ Send the transaction\n6️⃣ Paste the receipt here\n\n✅ Your wallet will be credited automatically!`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📱 Send Receipt', callback_data: 'send_receipt_cbe' }],
                        [{ text: '🔙 Back to Deposit', callback_data: 'deposit' }]
                    ]
                }
            });
        });

        // Receipt handlers
        bot.action('send_receipt_telebirr', (ctx) => {
            ctx.answerCbQuery('📱 Ready for Telebirr receipt...');
            ctx.reply('📱 Send your Telebirr transaction receipt here:\n\n💡 Just paste the full receipt message you received from Telebirr.\n\n✅ Your wallet will be credited automatically!');
        });

        bot.action('send_receipt_commercial', (ctx) => {
            ctx.answerCbQuery('📱 Ready for Commercial Bank SMS...');
            ctx.reply('📱 Send your Commercial Bank SMS receipt here:\n\n💡 Just paste the full SMS message you received from the bank.\n\n✅ Your wallet will be credited automatically!');
        });

        bot.action('send_receipt_abyssinia', (ctx) => {
            ctx.answerCbQuery('📱 Ready for Abyssinia Bank SMS...');
            ctx.reply('📱 Send your Abyssinia Bank SMS receipt here:\n\n💡 Just paste the full SMS message you received from the bank.\n\n✅ Your wallet will be credited automatically!');
        });

        bot.action('send_receipt_cbe', (ctx) => {
            ctx.answerCbQuery('📱 Ready for CBE Birr receipt...');
            ctx.reply('📱 Send your CBE Birr transaction receipt here:\n\n💡 Just paste the full receipt message you received from CBE Birr.\n\n✅ Your wallet will be credited automatically!');
        });

        // Handle contact sharing
        bot.on('contact', async (ctx) => {
            try {
                const userId = String(ctx.from.id);
                const contact = ctx.message.contact;

                try {
                    // Ensure user exists first, then update phone
                    let user = await UserService.getUserByTelegramId(userId);
                    if (!user) {
                        user = await UserService.createOrUpdateUser(ctx.from);
                    }
                    await UserService.updateUserPhone(userId, contact.phone_number);
                } catch (dbError) {
                    console.log('Database unavailable, using in-memory registration');
                    // Fallback to in-memory storage
                    const user = users.get(userId) || { id: userId, firstName: ctx.from.first_name || 'User' };
                    user.phone = contact.phone_number;
                    user.firstName = contact.first_name || ctx.from.first_name || 'User';
                    user.lastName = contact.last_name || ctx.from.last_name || '';
                    user.isRegistered = true;
                    users.set(userId, user);
                }

                // Remove the contact keyboard
                ctx.reply('✅ Registration completed!\n\n📱 Phone: ' + contact.phone_number + '\n👤 Name: ' + (contact.first_name || '') + ' ' + (contact.last_name || '') + '\n\n🎮 You can now start playing!', {
                    reply_markup: { remove_keyboard: true }
                });
            } catch (error) {
                console.error('Contact registration error:', error);
                ctx.reply('❌ Registration failed. Please try again.');
            }

            // Show main menu
            const keyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🎮 Play', callback_data: 'play' },
                            { text: '📝 Register', callback_data: 'register' }
                        ],
                        [
                            { text: '💵 Check Balance', callback_data: 'balance' },
                            { text: '💰 Deposit', callback_data: 'deposit' }
                        ],
                        [
                            { text: '☎️ Contact Support', callback_data: 'support' },
                            { text: '📖 Instruction', callback_data: 'instruction' }
                        ],
                        [
                            { text: '🎁 Transfer', callback_data: 'transfer' },
                            { text: '🤑 Withdraw', callback_data: 'withdraw' }
                        ],
                        [
                            { text: '🔗 Invite', callback_data: 'invite' }
                        ]
                    ]
                }
            };

            setTimeout(() => {
                ctx.reply('🎮 Choose an option:', keyboard);
            }, 1000);
        });

        // Caption reply handler for media without caption (must be before generic hears)
        bot.on('text', async (ctx, next) => {
            try {
                const adminId = String(ctx.from.id);
                const state = adminStates.get(adminId);
                if (state && state.mode === 'await_caption_media' && adminId === '966981995') {
                    adminStates.delete(adminId);
                    try {
                        const result = await sendPendingMediaToAll(state.pending, ctx.message.text || '');
                        const { success, failed, total } = result;
                        await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    } catch (e) {
                        await ctx.reply('❌ Failed to broadcast.', { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    }
                    return; // handled
                }
            } catch { }
            return next();
        });

        // Handle SMS deposits and deposit amounts (when user sends text message)
        bot.hears(/.*/, async (ctx) => {
            try {
                // Skip if it's a command or callback
                if (ctx.message.text.startsWith('/') || ctx.update.callback_query) return;

                // Admin broadcast flows
                const adminId = String(ctx.from.id);
                const state = adminStates.get(adminId);
                if (state && String(ctx.from.id) === '966981995') {
                    if (state.mode === 'broadcast') {
                        adminStates.delete(adminId);
                        try {
                            const targets = await getBroadcastTargets();
                            const options = buildBroadcastMarkup();
                            const { success, failed, total } = await sendToAll(targets, async (id) => {
                                await bot.telegram.sendMessage(id, ctx.message.text, options);
                            });
                            await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                        } catch (e) {
                            const msg = e && e.message === 'NO_RECIPIENTS' ? '❌ No recipients found in database.' : '❌ Failed to broadcast.';
                            await ctx.reply(msg, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                        }
                        return;
                    }
                }

                const userId = String(ctx.from.id);
                const messageText = ctx.message.text || '';

                // First check if it's a deposit amount (simple number)
                const amountMatch = messageText.match(/^(\d+(?:\.\d{1,2})?)$/);
                if (amountMatch) {
                    const amount = Number(amountMatch[1]);
                    if (amount >= 50) {
                        // Store the deposit amount and show payment options
                        ctx.reply(`💡 You can only deposit money using the options below.\n\n📋 Transfer Methods:\n1️⃣ From Telebirr to Agent Telebirr only\n2️⃣ From Commercial Bank to Agent Commercial Bank only\n3️⃣ From Abyssinia Bank to Agent Abyssinia Bank only\n4️⃣ From CBE Birr to Agent CBE Birr only\n\n🏦 Choose your preferred payment option:`, {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '📱 Telebirr', callback_data: `deposit_telebirr_${amount}` }],
                                    [{ text: '🏦 Commercial Bank', callback_data: `deposit_commercial_${amount}` }],
                                    [{ text: '🏛️ Abyssinia Bank', callback_data: `deposit_abyssinia_${amount}` }],
                                    [{ text: '💳 CBE Birr', callback_data: `deposit_cbe_${amount}` }],
                                    [{ text: '❌ Cancel', callback_data: 'back_to_menu' }]
                                ]
                            }
                        });
                        return;
                    } else {
                        return ctx.reply('❌ Minimum deposit amount is 50 Birr. Please enter a valid amount.');
                    }
                }

                // Otherwise, try to parse as a receipt
                const parsed = parseReceipt(messageText);

                if (!parsed) {
                    return ctx.reply('❌ Could not detect amount in your message.\n\n💡 Please paste the full receipt from your payment method.\n\n📋 Make sure it contains the amount (minimum ETB 50).');
                }

                let w;
                try {
                    // Try database first
                    let user = await UserService.getUserByTelegramId(userId);
                    if (!user) {
                        // Create user from Telegram profile if they never opened the web app
                        user = await UserService.createOrUpdateUser(ctx.from);
                    }
                    const result = await WalletService.processDeposit(user._id, parsed.amount, parsed);
                    w = result.wallet;
                } catch (dbError) {
                    console.log('Database unavailable, using in-memory deposit');
                    // Fallback to in-memory storage
                    w = ensureWallet(userId);
                    w.main += parsed.amount;
                }

                const paymentType = parsed.type === 'telebirr' ? '📱 Telebirr' :
                    parsed.type === 'commercial' ? '🏦 Commercial Bank' :
                        parsed.type === 'abyssinia' ? '🏛️ Abyssinia Bank' :
                            parsed.type === 'cbe' ? '💳 CBE Birr' : '💳 Payment';

                const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
                if (isHttpsWebApp) keyboard.inline_keyboard.unshift([{ text: '🎮 Start Playing', web_app: { url: WEBAPP_URL } }]);

                return ctx.reply(`✅ Deposit Successful!\n\n${paymentType} deposit of ETB ${parsed.amount.toFixed(2)} has been credited to your wallet!\n\n💰 Main Wallet: ETB ${w.main.toFixed(2)}\n🎮 Play Balance: ETB ${w.play.toFixed(2)}\n🪙 Coins: ${w.coins.toFixed(0)}\n\n🎮 Ready to play!`, { reply_markup: keyboard });
            } catch (error) {
                console.error('SMS deposit error:', error);
                ctx.reply('❌ Deposit failed. Please try again or contact support.');
            }
        });

        // Handle admin sending media for broadcast (photo, video, document, etc.)
        bot.on(['photo', 'video', 'document', 'audio', 'voice', 'sticker', 'animation'], async (ctx) => {
            const adminId = String(ctx.from.id);
            const state = adminStates.get(adminId);
            if (!state || (state.mode !== 'broadcast' && state.mode !== 'await_caption_media') || adminId !== '966981995') return;
            try {
                let targets = [];
                targets = await getBroadcastTargets();

                if (ctx.message.photo) {
                    const best = ctx.message.photo[ctx.message.photo.length - 1];
                    const fileId = best?.file_id;
                    const caption = ctx.message.caption || '';
                    if (!caption) {
                        adminStates.set(adminId, { mode: 'await_caption_media', pending: { kind: 'photo', fileId } });
                        await ctx.reply('✍️ Type caption for this image, or tap Skip.', { reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip', callback_data: 'skip_broadcast_caption' }]] } });
                    } else {
                        adminStates.delete(adminId);
                        const options = buildBroadcastMarkup(caption);
                        const { success, failed, total } = await sendToAll(targets, async (id) => {
                            await bot.telegram.sendPhoto(id, fileId, options);
                        });
                        await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    }
                } else if (ctx.message.video) {
                    const fileId = ctx.message.video.file_id;
                    const caption = ctx.message.caption || '';
                    if (!caption) {
                        adminStates.set(adminId, { mode: 'await_caption_media', pending: { kind: 'video', fileId } });
                        await ctx.reply('✍️ Type caption for this video, or tap Skip.', { reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip', callback_data: 'skip_broadcast_caption' }]] } });
                    } else {
                        adminStates.delete(adminId);
                        const options = buildBroadcastMarkup(caption);
                        const { success, failed, total } = await sendToAll(targets, async (id) => {
                            await bot.telegram.sendVideo(id, fileId, options);
                        });
                        await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    }
                } else if (ctx.message.document) {
                    const fileId = ctx.message.document.file_id;
                    const caption = ctx.message.caption || '';
                    if (!caption) {
                        adminStates.set(adminId, { mode: 'await_caption_media', pending: { kind: 'document', fileId } });
                        await ctx.reply('✍️ Type caption for this document, or tap Skip.', { reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip', callback_data: 'skip_broadcast_caption' }]] } });
                    } else {
                        adminStates.delete(adminId);
                        const options = buildBroadcastMarkup(caption);
                        const { success, failed, total } = await sendToAll(targets, async (id) => {
                            await bot.telegram.sendDocument(id, fileId, options);
                        });
                        await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    }
                } else if (ctx.message.audio) {
                    const fileId = ctx.message.audio.file_id;
                    const options = buildBroadcastMarkup('');
                    const { success, failed, total } = await sendToAll(targets, async (id) => {
                        await bot.telegram.sendAudio(id, fileId, options);
                    });
                    await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                } else if (ctx.message.voice) {
                    const fileId = ctx.message.voice.file_id;
                    const options = buildBroadcastMarkup('');
                    const { success, failed, total } = await sendToAll(targets, async (id) => {
                        await bot.telegram.sendVoice(id, fileId, options);
                    });
                    await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                } else if (ctx.message.sticker) {
                    const fileId = ctx.message.sticker.file_id;
                    const { success, failed, total } = await sendToAll(targets, async (id) => {
                        await bot.telegram.sendSticker(id, fileId);
                    });
                    await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                } else if (ctx.message.animation) {
                    const fileId = ctx.message.animation.file_id;
                    const caption = ctx.message.caption || '';
                    if (!caption) {
                        adminStates.set(adminId, { mode: 'await_caption_media', pending: { kind: 'animation', fileId } });
                        await ctx.reply('✍️ Type caption for this animation, or tap Skip.', { reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip', callback_data: 'skip_broadcast_caption' }]] } });
                    } else {
                        adminStates.delete(adminId);
                        const options = buildBroadcastMarkup(caption);
                        const { success, failed, total } = await sendToAll(targets, async (id) => {
                            await bot.telegram.sendAnimation(id, fileId, options);
                        });
                        await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    }
                }
            } catch (e) {
                const msg = e && e.message === 'NO_RECIPIENTS' ? '❌ No recipients found in database.' : '❌ Failed to broadcast.';
                await ctx.reply(msg, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
            }
        });

        bot.action('skip_broadcast_caption', async (ctx) => {
            const adminId = String(ctx.from.id);
            if (adminId !== '966981995') return;
            const state = adminStates.get(adminId);
            if (!state || state.mode !== 'await_caption_media') return;
            adminStates.delete(adminId);
            try {
                const result = await sendPendingMediaToAll(state.pending, '');
                const { success, failed, total } = result;
                await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
            } catch (e) {
                await ctx.reply('❌ Failed to broadcast.', { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
            }
        });

        // Ensure polling works even if a webhook was previously set
        bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => { });
        bot.telegram.getMe()
            .then((me) => {
                console.log(`🤖 Starting Telegram bot @${me.username}`);
                return bot.launch();
            })
            .then(() => console.log('✅ Telegram bot started with long polling'))
            .catch((err) => console.error('❌ Failed to start Telegram bot:', err));

        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } else {
        console.warn('⚠️ BOT_TOKEN not set. Telegram bot is disabled. Create a .env with BOT_TOKEN=...');
    }
} catch { }
