const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Transaction = require('../models/Transaction');
const Game = require('../models/Game');
const Post = require('../models/Post');
const { authMiddleware } = require('./auth');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            const uploadDir = path.join(__dirname, '..', 'uploads');
            console.log('Upload directory:', uploadDir);

            if (!fs.existsSync(uploadDir)) {
                console.log('Creating upload directory:', uploadDir);
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            // Check if directory is writable
            fs.access(uploadDir, fs.constants.W_OK, (err) => {
                if (err) {
                    console.error('Upload directory is not writable:', err);
                    cb(new Error('Upload directory is not writable'));
                } else {
                    console.log('Upload directory is writable');
                    cb(null, uploadDir);
                }
            });
        } catch (error) {
            console.error('Error setting up upload directory:', error);
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname);
        console.log('Generated filename:', filename);
        cb(null, filename);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|mp4|mov|avi|webm/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only images and videos are allowed'));
        }
    }
});

// Admin middleware
function adminMiddleware(req, res, next) {
    console.log('Admin middleware check:', {
        method: req.method,
        path: req.path,
        headers: {
            authorization: req.headers.authorization ? 'Present' : 'Missing',
            'x-session': req.headers['x-session'] ? 'Present' : 'Missing'
        }
    });

    // For now, we'll use the same auth middleware
    // In production, you might want to add additional admin role checks
    return authMiddleware(req, res, (err) => {
        if (err) {
            console.error('Admin middleware auth error:', err);
            return res.status(401).json({ error: 'UNAUTHORIZED' });
        }

        console.log('Admin middleware passed, userId:', req.userId);
        next();
    });
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

router.post('/posts', adminMiddleware, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            console.error('Multer error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'FILE_TOO_LARGE' });
            }
            if (err.code === 'LIMIT_UNEXPECTED_FILE') {
                return res.status(400).json({ error: 'UNEXPECTED_FILE_FIELD' });
            }
            return res.status(400).json({ error: 'FILE_UPLOAD_ERROR', details: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        console.log('File upload request received:', {
            body: req.body,
            file: req.file ? {
                filename: req.file.filename,
                originalname: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size
            } : 'No file'
        });

        const { kind, caption, active } = req.body || {};

        if (!kind) {
            console.log('Missing kind field');
            return res.status(400).json({ error: 'INVALID_INPUT' });
        }

        let url = '';
        let filename = '';

        if (req.file) {
            // File upload
            filename = req.file.filename;
            url = `/uploads/${filename}`;
            console.log('File processed:', { filename, url });
        } else {
            console.log('No file uploaded');
            return res.status(400).json({ error: 'NO_FILE_UPLOADED' });
        }

        // Convert active string to boolean
        const isActive = active === 'true' || active === true;

        const post = await Post.create({
            kind,
            url,
            filename,
            caption: caption || '',
            active: isActive
        });

        console.log('Post created successfully:', post);
        res.json({ success: true, post });
    } catch (e) {
        console.error('Post creation error:', e);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
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
