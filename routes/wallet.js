const express = require('express');
const WalletService = require('../services/walletService');
const { authMiddleware } = require('./auth');

const router = express.Router();

// GET /wallet
router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const wallet = await WalletService.getWalletByUserId(userId);
        if (!wallet) {
            return res.status(404).json({ error: 'WALLET_NOT_FOUND' });
        }
        res.json({ wallet });
    } catch (error) {
        console.error('Wallet fetch error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// POST /wallet/convert
router.post('/convert', authMiddleware, async (req, res) => {
    try {
        const { amount } = req.body;
        const userId = req.userId;

        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'INVALID_AMOUNT' });
        }

        const result = await WalletService.convertCoins(userId, parseFloat(amount));
        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        res.json({
            success: true,
            newBalance: result.newBalance,
            convertedAmount: result.convertedAmount
        });
    } catch (error) {
        console.error('Convert error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// GET /wallet/deposit-history
router.get('/deposit-history', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const transactions = await WalletService.getTransactionHistory(userId, 'deposit');
        res.json({ transactions });
    } catch (error) {
        console.error('Deposit history error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// POST /wallet/withdraw
router.post('/withdraw', authMiddleware, async (req, res) => {
    try {
        const { amount, destination } = req.body;
        const userId = req.userId;

        if (!amount || isNaN(amount) || amount < 50 || amount > 10000) {
            return res.status(400).json({ error: 'INVALID_AMOUNT' });
        }

        if (!destination || typeof destination !== 'string' || destination.trim().length === 0) {
            return res.status(400).json({ error: 'DESTINATION_REQUIRED' });
        }

        const result = await WalletService.processWithdrawal(userId, parseFloat(amount), destination.trim());
        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        res.json({
            success: true,
            transactionId: result.transactionId,
            message: 'Withdrawal request submitted for admin approval'
        });
    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

module.exports = router;
