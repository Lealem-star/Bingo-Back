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

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_here_change_this';

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
            telegramUser = { id: String(devUserId), first_name: 'Dev', last_name: 'User', username: 'dev' };
        } else {
            return res.status(400).json({ error: 'MISSING_PARAMS' });
        }

        const userId = String(telegramUser.id);
        let user;

        user = await UserService.createOrUpdateUser(telegramUser);

        // For dev users, ensure they have a wallet and are registered
        if (devUserId) {
            const wallet = await WalletService.getWallet(user._id);
            if (!user.isRegistered) {
                user.isRegistered = true;
                user.phone = '+1234567890'; // Dev phone
                await user.save();
            }
        }

        // Issue JWT
        const token = jwt.sign({ sub: user.telegramId || userId, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            token,
            sessionId: token,
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
    try {
        const auth = req.headers['authorization'] || '';
        const sidHeader = req.headers['x-session'] || '';
        let token = '';
        const parts = auth.split(' ');
        if (parts.length === 2 && parts[0] === 'Bearer') {
            token = parts[1];
        } else if (typeof sidHeader === 'string' && sidHeader) {
            token = sidHeader;
        }
        if (token) {
            const payload = jwt.verify(token, JWT_SECRET);
            req.userId = String(payload.sub);
            return next();
        }
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    } catch (e) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
}

// Wallet endpoints
app.get('/wallet', authMiddleware, async (req, res) => {
    try {
        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
        const wallet = await WalletService.getWallet(user._id);

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
        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
        const result = await WalletService.convertCoins(user._id, amt);
        const wallet = result.wallet;

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
        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

        const wallet = await WalletService.getWallet(user._id);
        const userData = {
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

        res.json(userData);
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Unified user summary: profile + wallet + recent transactions + recent games
app.get('/user/summary', authMiddleware, async (req, res) => {
    try {
        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
        const w = await WalletService.getWallet(user._id);
        const profile = {
            id: user.telegramId,
            firstName: user.firstName,
            lastName: user.lastName,
            phone: user.phone,
            isRegistered: user.isRegistered,
            totalGamesPlayed: user.totalGamesPlayed,
            totalGamesWon: user.totalGamesWon,
            registrationDate: user.registrationDate
        };
        const wallet = { main: w.main, play: w.play, coins: w.coins, gamesWon: w.gamesWon };
        const tx = await WalletService.getTransactionHistory(user._id, 10, 0);
        const transactions = (tx.transactions || []).map(t => ({
            id: t._id,
            type: t.type,
            amount: t.amount,
            description: t.description,
            status: t.status,
            createdAt: t.createdAt,
            gameId: t.gameId
        }));
        const games = [];

        res.json({ profile, wallet, transactions, games });
    } catch (error) {
        console.error('User summary error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Deposit history only (filter transactions by type=deposit)
app.get('/wallet/deposit-history', authMiddleware, async (req, res) => {
    try {
        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
        const tx = await WalletService.getTransactionHistory(user._id, 100, 0);
        const deposits = (tx.transactions || [])
            .filter(t => t.type === 'deposit')
            .map(t => ({ id: t._id, amount: t.amount, status: t.status, createdAt: t.createdAt, ref: t.meta?.ref }));
        res.json({ deposits });
    } catch (error) {
        console.error('Deposit history error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Transaction history endpoint
app.get('/user/transactions', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

        const result = await WalletService.getTransactionHistory(user._id, parseInt(limit), parseInt(skip));
        const transactions = result.transactions.map(t => ({
            id: t._id,
            type: t.type,
            amount: t.amount,
            description: t.description,
            status: t.status,
            createdAt: t.createdAt,
            gameId: t.gameId
        }));

        res.json({ transactions, total: transactions.length });
    } catch (error) {
        console.error('Transaction history error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Withdrawal request endpoint
app.post('/wallet/withdraw', authMiddleware, async (req, res) => {
    try {
        const { amount, destination } = req.body || {};
        const amt = Number(amount || 0);

        if (amt < 50) return res.status(400).json({ error: 'MINIMUM_WITHDRAWAL_50' });
        if (amt > 10000) return res.status(400).json({ error: 'MAXIMUM_WITHDRAWAL_10000' });

        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

        const wallet = await WalletService.getWallet(user._id);
        if (wallet.main < amt) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });

        // Create withdrawal request
        const Transaction = require('./models/Transaction');
        const withdrawal = new Transaction({
            userId: user._id,
            type: 'withdrawal',
            amount: -amt,
            description: `Withdrawal request: ETB ${amt} to ${destination || 'Not specified'}`,
            status: 'pending',
            reference: `WDR${Date.now()}`,
            balanceBefore: {
                main: wallet.main,
                play: wallet.play,
                coins: wallet.coins
            },
            balanceAfter: {
                main: wallet.main,
                play: wallet.play,
                coins: wallet.coins
            }
        });
        await withdrawal.save();

        res.json({
            withdrawalId: withdrawal._id,
            amount: amt,
            status: 'pending',
            reference: withdrawal.reference
        });
    } catch (error) {
        console.error('Withdrawal request error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Admin withdrawal approval endpoint
app.post('/admin/withdrawals/:id/approve', authMiddleware, async (req, res) => {
    try {
        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user || user.role !== 'admin') return res.status(403).json({ error: 'UNAUTHORIZED' });

        const Transaction = require('./models/Transaction');
        const withdrawal = await Transaction.findById(req.params.id);
        if (!withdrawal || withdrawal.type !== 'withdrawal') return res.status(404).json({ error: 'WITHDRAWAL_NOT_FOUND' });

        if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'ALREADY_PROCESSED' });

        // Approve withdrawal - deduct from wallet
        const result = await WalletService.updateBalance(withdrawal.userId, { main: withdrawal.amount });

        // Update withdrawal status
        withdrawal.status = 'completed';
        withdrawal.balanceAfter = result.balanceAfter;
        await withdrawal.save();

        // Update wallet totals
        await require('./models/Wallet').findOneAndUpdate(
            { userId: withdrawal.userId },
            {
                $inc: { totalWithdrawn: Math.abs(withdrawal.amount) },
                $set: { lastWithdrawalDate: new Date() }
            }
        );

        res.json({ status: 'approved', withdrawalId: withdrawal._id });
    } catch (error) {
        console.error('Withdrawal approval error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Admin withdrawal denial endpoint
app.post('/admin/withdrawals/:id/deny', authMiddleware, async (req, res) => {
    try {
        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user || user.role !== 'admin') return res.status(403).json({ error: 'UNAUTHORIZED' });

        const Transaction = require('./models/Transaction');
        const withdrawal = await Transaction.findById(req.params.id);
        if (!withdrawal || withdrawal.type !== 'withdrawal') return res.status(404).json({ error: 'WITHDRAWAL_NOT_FOUND' });

        if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'ALREADY_PROCESSED' });

        withdrawal.status = 'cancelled';
        await withdrawal.save();

        res.json({ status: 'denied', withdrawalId: withdrawal._id });
    } catch (error) {
        console.error('Withdrawal denial error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Get pending withdrawals for admin
app.get('/admin/withdrawals', authMiddleware, async (req, res) => {
    try {
        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user || user.role !== 'admin') return res.status(403).json({ error: 'UNAUTHORIZED' });

        const Transaction = require('./models/Transaction');
        const User = require('./models/User');

        const withdrawals = await Transaction.find({ type: 'withdrawal', status: 'pending' })
            .populate('userId', 'firstName lastName phone telegramId')
            .sort({ createdAt: -1 })
            .limit(50);

        const formatted = withdrawals.map(w => ({
            id: w._id,
            amount: Math.abs(w.amount),
            description: w.description,
            reference: w.reference,
            createdAt: w.createdAt,
            user: {
                name: `${w.userId.firstName} ${w.userId.lastName}`.trim(),
                phone: w.userId.phone,
                telegramId: w.userId.telegramId
            }
        }));

        res.json({ withdrawals: formatted });
    } catch (error) {
        console.error('Get withdrawals error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Game history endpoint
app.get('/user/games', authMiddleware, async (req, res) => {
    try {
        const user = await UserService.getUserByTelegramId(req.userId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

        const { page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

        // Get games where user participated
        const games = await Game.find({
            $or: [
                { 'players.userId': req.userId },
                { 'winners.userId': req.userId }
            ]
        })
            .sort({ finishedAt: -1 })
            .limit(parseInt(limit))
            .skip(parseInt(skip))
            .select('gameId stake status calledNumbers winners pot systemCut totalPrizes startedAt finishedAt');

        const formattedGames = games.map(game => {
            const userWinner = game.winners.find(w => w.userId === req.userId);
            const userPlayer = game.players.find(p => p.userId === req.userId);

            return {
                id: game._id,
                gameId: game.gameId,
                stake: game.stake,
                status: game.status,
                calledNumbers: game.calledNumbers,
                pot: game.pot,
                systemCut: game.systemCut,
                totalPrizes: game.totalPrizes,
                startedAt: game.startedAt,
                finishedAt: game.finishedAt,
                userResult: {
                    participated: !!userPlayer,
                    won: !!userWinner,
                    prize: userWinner ? userWinner.prize : 0,
                    cardNumber: userWinner ? userWinner.cartelaNumber : null
                }
            };
        });

        const total = await Game.countDocuments({
            $or: [
                { 'players.userId': req.userId },
                { 'winners.userId': req.userId }
            ]
        });

        res.json({ games: formattedGames, total });
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

// Debug endpoint
app.get('/debug', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        headers: req.headers,
        jwt_secret_set: !!process.env.JWT_SECRET
    });
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
        selectedByUserId: new Set(),
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
        room.pot = stake * room.selectedByUserId.size;
        room.cardById.clear();
        const numbers = shuffle(range(1, 75));
        // Give each client a random card for demo
        room.clients.forEach(ws => {
            const card = generateCard();
            room.cardById.set(card.id, card.grid);
            try { ws.send(JSON.stringify({ type: 'game_started', payload: { gameId: room.gameId, bet: stake, pot: room.pot, playersCount: room.selectedByUserId.size, card, called: [] } })); } catch { }
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

        // Process winnings for each winner
        (async () => {
            try {
                for (const winner of room.winners) {
                    if (winner.userId && prizePerWinner > 0) {
                        try {
                            const user = await UserService.getUserByTelegramId(winner.userId);
                            if (user) {
                                await WalletService.processGameWin(user._id, prizePerWinner, room.gameId);
                            }
                        } catch (error) {
                            console.error('Prize processing error for user', winner.userId, error);
                        }
                    }
                }
            } catch (e) {
                console.error('Prize processing error:', e);
            }
        })();

        // Persist finished game with system revenue (best-effort)
        (async () => {
            try {
                const finishedGame = new Game({
                    gameId: room.gameId,
                    stake: room.stake,
                    status: 'finished',
                    players: Array.from(room.clients).map(ws => ({ userId: ws.userId, hasBet: ws.hasBet })),
                    calledNumbers: room.called,
                    winners: winnersPayload.map(w => ({
                        userId: w.userId,
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
        room.selectedByUserId.clear();
        const ends = Date.now() + 15000;
        room.nextStartAt = ends;
        broadcast('registration_open', { gameId: `PENDING`, endsAt: ends, availableCards: room.availableCards.slice(0, 60), playersCount: room.selectedByUserId.size });
        setTimeout(() => {
            broadcast('registration_closed', { gameId: 'PENDING' });
            toRunning();
        }, 15000);
    }

    // Start loop
    toRegistration();

    // Public API
    room.onJoin = async (ws) => {
        room.clients.add(ws);

        // Process bet when user joins during registration phase
        if (room.phase === 'registration' && ws.userId) {
            try {
                const user = await UserService.getUserByTelegramId(ws.userId);
                if (user) {
                    const wallet = await WalletService.getWallet(user._id);
                    if (wallet.play >= room.stake) {
                        await WalletService.processGameBet(user._id, room.stake, room.gameId || 'PENDING');
                        ws.hasBet = true;
                        room.selectedByUserId.add(ws.userId);
                        broadcast('players_update', { playersCount: room.selectedByUserId.size });
                    } else {
                        send(ws, 'error', { code: 'INSUFFICIENT_BALANCE', message: `Insufficient play balance. Need ${room.stake} ETB` });
                        ws.close();
                        return;
                    }
                }
            } catch (error) {
                console.error('Bet processing error:', error);
                send(ws, 'error', { code: 'BET_FAILED', message: 'Failed to process bet' });
                ws.close();
                return;
            }
        }

        // Snapshot
        try { ws.send(JSON.stringify({ type: 'snapshot', payload: { phase: room.phase, gameId: room.gameId, called: room.called, availableCards: room.availableCards.slice(0, 60), endsAt: room.nextStartAt, playersCount: room.selectedByUserId.size } })); } catch { }
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

wss.on('connection', async (ws, request) => {
    const url = new URL(request.url, `http://localhost:${PORT}`);
    const stake = url.searchParams.get('stake') || '10';
    const token = url.searchParams.get('token') || '';

    // Authenticate user
    let userId = null;
    if (token) {
        try {
            const payload = jwt.verify(token, JWT_SECRET);
            userId = String(payload.sub);
        } catch (e) {
            send(ws, 'error', { code: 'INVALID_TOKEN', message: 'Authentication failed' });
            ws.close();
            return;
        }
    } else {
        send(ws, 'error', { code: 'NO_TOKEN', message: 'Authentication required' });
        ws.close();
        return;
    }

    const room = rooms.get(String(stake));
    if (!room) {
        send(ws, 'error', { code: 'NO_ROOM', message: 'Invalid stake' });
        ws.close();
        return;
    }

    // Store user info on the websocket
    ws.userId = userId;
    room.onJoin(ws);

    ws.on('message', async (buf) => {
        let msg = null;
        try { msg = JSON.parse(buf.toString()); } catch { }
        if (!msg) return;

        if (msg.type === 'select_card') {
            // Mark that this user selected a cartella and is participating
            if (room && ws.userId) {
                room.selectedByUserId.add(ws.userId);
                room.clients.forEach(client => {
                    send(client, 'players_update', { playersCount: room.selectedByUserId.size });
                });
            }
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
                room.winners.push({ name: 'Player', cardId, userId: ws.userId });
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

// --- Telegram Bot moved into separate module ---
try {
    const { startTelegramBot } = require('./telegram/bot.js');
    startTelegramBot({ BOT_TOKEN, WEBAPP_URL });
} catch { }

