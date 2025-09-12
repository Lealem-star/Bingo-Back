const express = require('express');
const Transaction = require('../models/Transaction');
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
