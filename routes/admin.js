const express = require('express');
const Transaction = require('../models/Transaction');
const Game = require('../models/Game');
const Post = require('../models/Post');
const { authMiddleware } = require('./auth');

const router = express.Router();

// Admin middleware
function adminMiddleware(req, res, next) {
    // For now, we'll use the same auth middleware
    // In production, you might want to add additional admin role checks
    return authMiddleware(req, res, next);
}

// POST /admin/withdrawals/:id/approve
router.post('/withdrawals/:id/approve', adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const transaction = await Transaction.findById(id);

        if (!transaction) {
            return res.status(404).json({ error: 'TRANSACTION_NOT_FOUND' });
        }

        if (transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
            return res.status(400).json({ error: 'INVALID_TRANSACTION_STATUS' });
        }

        // Deduct from user's main wallet
        const WalletService = require('../services/walletService');
        const result = await WalletService.processWithdrawalApproval(transaction.userId, transaction.amount);

        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        // Update transaction status
        transaction.status = 'completed';
        transaction.processedAt = new Date();
        await transaction.save();

        res.json({
            success: true,
            message: 'Withdrawal approved successfully'
        });
    } catch (error) {
        console.error('Withdrawal approval error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// POST /admin/withdrawals/:id/deny
router.post('/withdrawals/:id/deny', adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const transaction = await Transaction.findById(id);

        if (!transaction) {
            return res.status(404).json({ error: 'TRANSACTION_NOT_FOUND' });
        }

        if (transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
            return res.status(400).json({ error: 'INVALID_TRANSACTION_STATUS' });
        }

        // Update transaction status
        transaction.status = 'cancelled';
        transaction.processedAt = new Date();
        await transaction.save();

        res.json({
            success: true,
            message: 'Withdrawal denied successfully'
        });
    } catch (error) {
        console.error('Withdrawal denial error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// GET /admin/withdrawals
router.get('/withdrawals', adminMiddleware, async (req, res) => {
    try {
        const withdrawals = await Transaction.find({
            type: 'withdrawal',
            status: 'pending'
        }).sort({ createdAt: -1 });

        res.json({ withdrawals });
    } catch (error) {
        console.error('Withdrawals fetch error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

module.exports = router;

// --- Admin Posts ---
router.get('/posts', adminMiddleware, async (req, res) => {
    try {
        const posts = await Post.find({}).sort({ createdAt: -1 }).lean();
        res.json({ posts });
    } catch (e) { res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' }); }
});

router.post('/posts', adminMiddleware, async (req, res) => {
    try {
        const { kind, url, caption, active } = req.body || {};
        if (!kind || !url) return res.status(400).json({ error: 'INVALID_INPUT' });
        const post = await Post.create({ kind, url, caption: caption || '', active: active !== false });
        res.json({ success: true, post });
    } catch (e) { res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' }); }
});

router.patch('/posts/:id', adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const update = {};
        ['kind', 'url', 'caption', 'active'].forEach(k => { if (k in req.body) update[k] = req.body[k]; });
        const post = await Post.findByIdAndUpdate(id, { $set: update }, { new: true });
        if (!post) return res.status(404).json({ error: 'NOT_FOUND' });
        res.json({ success: true, post });
    } catch (e) { res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' }); }
});

router.delete('/posts/:id', adminMiddleware, async (req, res) => {
    try { await Post.findByIdAndDelete(req.params.id); res.json({ success: true }); }
    catch { res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' }); }
});

// --- Admin Balance (withdraw/deposit overviews) ---
router.get('/balances/withdrawals', adminMiddleware, async (req, res) => {
    try {
        const { status = 'pending' } = req.query;
        const withdrawals = await Transaction.find({ type: 'withdrawal', status }).sort({ createdAt: -1 }).lean();
        res.json({ withdrawals });
    } catch { res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' }); }
});

router.get('/balances/deposits', adminMiddleware, async (req, res) => {
    try {
        const { from, to } = req.query;
        const q = { type: 'deposit' };
        if (from || to) { q.createdAt = {}; if (from) q.createdAt.$gte = new Date(from); if (to) q.createdAt.$lte = new Date(to); }
        const deposits = await Transaction.find(q).sort({ createdAt: -1 }).lean();
        res.json({ deposits });
    } catch { res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' }); }
});

// --- Admin Statistics ---
router.get('/stats/today', adminMiddleware, async (req, res) => {
    try {
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const end = new Date(); end.setHours(23, 59, 59, 999);
        const games = await Game.find({ finishedAt: { $gte: start, $lte: end } }, { systemCut: 1, players: 1 }).lean();
        const totalPlayers = games.reduce((s, g) => s + (Array.isArray(g.players) ? g.players.length : 0), 0);
        const systemCut = games.reduce((s, g) => s + (g.systemCut || 0), 0);
        res.json({ totalPlayers, systemCut });
    } catch { res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' }); }
});

router.get('/stats/revenue/by-day', adminMiddleware, async (req, res) => {
    try {
        const days = Number(req.query.days || 7);
        const since = new Date(); since.setDate(since.getDate() - (days - 1)); since.setHours(0, 0, 0, 0);
        const games = await Game.find({ finishedAt: { $gte: since } }, { systemCut: 1, finishedAt: 1 }).lean();
        const byDay = {};
        for (const g of games) {
            const key = new Date(g.finishedAt).toISOString().slice(0, 10);
            byDay[key] = (byDay[key] || 0) + (g.systemCut || 0);
        }
        const list = Object.entries(byDay).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([day, revenue]) => ({ day, revenue }));
        res.json({ revenueByDay: list });
    } catch { res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' }); }
});
