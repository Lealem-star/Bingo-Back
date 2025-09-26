const express = require('express');
const WalletService = require('../services/walletService');
const UserService = require('../services/userService');
const { authMiddleware } = require('./auth');

const router = express.Router();

// GET /wallet
router.get('/', authMiddleware, async (req, res) => {
    try {
        const user = await UserService.getUserById(req.userId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

        const wallet = await WalletService.getWallet(user._id);
        if (!wallet) return res.status(404).json({ error: 'WALLET_NOT_FOUND' });

        // Unified wallet response with main/play structure
        res.json({
            balance: wallet.balance ?? 0,
            main: wallet.main ?? wallet.balance ?? 0,
            play: wallet.play ?? wallet.balance ?? 0,
            coins: wallet.coins ?? 0,
            gamesWon: wallet.gamesWon ?? 0
        });
    } catch (error) {
        console.error('Wallet fetch error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// POST /wallet/convert
router.post('/convert', authMiddleware, async (req, res) => {
    try {
        const { coins, targetWallet } = req.body;
        const dbUserId = req.userId;
        if (!coins || isNaN(coins) || Number(coins) <= 0) {
            return res.status(400).json({ error: 'INVALID_AMOUNT' });
        }
        const user = await UserService.getUserById(dbUserId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

        const result = await WalletService.convertCoins(user._id, Number(coins), targetWallet || 'main');
        return res.json({ wallet: result.wallet });
    } catch (error) {
        console.error('Convert error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// POST /wallet/transfer
router.post('/transfer', authMiddleware, async (req, res) => {
    try {
        const { amount, direction } = req.body;
        const dbUserId = req.userId;

        if (!amount || isNaN(amount) || Number(amount) <= 0) {
            return res.status(400).json({ error: 'INVALID_AMOUNT' });
        }

        if (!direction || !['main-to-play', 'play-to-main'].includes(direction)) {
            return res.status(400).json({ error: 'INVALID_DIRECTION' });
        }

        const user = await UserService.getUserById(dbUserId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

        const result = await WalletService.transferFunds(user._id, Number(amount), direction);
        return res.json({ wallet: result.wallet });
    } catch (error) {
        console.error('Transfer error:', error);
        if (error.message === 'Insufficient funds') {
            res.status(400).json({ error: 'INSUFFICIENT_FUNDS' });
        } else {
            res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
        }
    }
});

// GET /wallet/deposit-history
router.get('/deposit-history', authMiddleware, async (req, res) => {
    try {
        const dbUserId = req.userId;
        const user = await UserService.getUserById(dbUserId);
        if (!user) {
            return res.status(404).json({ error: 'USER_NOT_FOUND' });
        }
        const transactions = await WalletService.getTransactionHistory(user._id, 'deposit');
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
        const dbUserId = req.userId;

        if (!amount || isNaN(amount) || amount < 50 || amount > 10000) {
            return res.status(400).json({ error: 'INVALID_AMOUNT' });
        }

        if (!destination || typeof destination !== 'string' || destination.trim().length === 0) {
            return res.status(400).json({ error: 'DESTINATION_REQUIRED' });
        }

        const user = await UserService.getUserById(dbUserId);
        if (!user) {
            return res.status(404).json({ error: 'USER_NOT_FOUND' });
        }

        const result = await WalletService.processWithdrawal(user._id, parseFloat(amount), destination.trim());
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
