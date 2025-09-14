const express = require('express');
const WalletService = require('../services/walletService');
const UserService = require('../services/userService');
const { authMiddleware } = require('./auth');

const router = express.Router();

// GET /wallet
router.get('/', authMiddleware, async (req, res) => {
    try {
        const telegramId = String(req.userId);
        const user = await UserService.getUserByTelegramId(telegramId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

        const wallet = await WalletService.getWallet(user._id);
        if (!wallet) return res.status(404).json({ error: 'WALLET_NOT_FOUND' });

        // Return flat object for frontend expectations
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

// POST /wallet/convert
router.post('/convert', authMiddleware, async (req, res) => {
    try {
        const { coins } = req.body;
        const telegramId = String(req.userId);
        if (!coins || isNaN(coins) || Number(coins) <= 0) {
            return res.status(400).json({ error: 'INVALID_AMOUNT' });
        }
        const user = await UserService.getUserByTelegramId(telegramId);
        if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

        const result = await WalletService.convertCoins(user._id, Number(coins));
        return res.json({ wallet: result.wallet });
    } catch (error) {
        console.error('Convert error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// GET /wallet/deposit-history
router.get('/deposit-history', authMiddleware, async (req, res) => {
    try {
        const telegramUserId = req.userId;
        const user = await UserService.getUserByTelegramId(telegramUserId);
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
        const telegramUserId = req.userId;

        if (!amount || isNaN(amount) || amount < 50 || amount > 10000) {
            return res.status(400).json({ error: 'INVALID_AMOUNT' });
        }

        if (!destination || typeof destination !== 'string' || destination.trim().length === 0) {
            return res.status(400).json({ error: 'DESTINATION_REQUIRED' });
        }

        const user = await UserService.getUserByTelegramId(telegramUserId);
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
