const express = require('express');
const UserService = require('../services/userService');
const WalletService = require('../services/walletService');
const Game = require('../models/Game');
const { authMiddleware } = require('./auth');

const router = express.Router();

// GET /user/profile
router.get('/profile', authMiddleware, async (req, res) => {
    try {
        const telegramId = String(req.userId);
        const userData = await UserService.getUserWithWallet(telegramId);

        if (!userData) {
            return res.status(404).json({ error: 'USER_NOT_FOUND' });
        }

        // Get game statistics using Mongo ObjectId
        const dbUserId = userData.user._id;
        const games = await Game.find({
            $or: [
                { 'players.userId': dbUserId },
                { 'winners.userId': dbUserId }
            ]
        }).sort({ createdAt: -1 });

        const totalGames = games.length;
        const gamesWon = games.filter(game =>
            game.winners.some(winner => String(winner.userId) === String(dbUserId))
        ).length;

        res.json({
            user: {
                firstName: userData.firstName,
                lastName: userData.lastName,
                phone: userData.phone,
                isRegistered: userData.isRegistered,
                totalGamesPlayed: totalGames,
                totalGamesWon: gamesWon,
                registrationDate: userData.createdAt
            },
            wallet: userData.wallet
        });
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// GET /user/summary
router.get('/summary', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const userData = await UserService.getUserWithWallet(userId);

        if (!userData) {
            return res.status(404).json({ error: 'USER_NOT_FOUND' });
        }

        // Get game statistics
        const games = await Game.find({
            $or: [
                { 'players.userId': userId },
                { 'winners.userId': userId }
            ]
        }).sort({ createdAt: -1 });

        const totalGames = games.length;
        const gamesWon = games.filter(game =>
            game.winners.some(winner => winner.userId === userId)
        ).length;

        res.json({
            totalGames,
            gamesWon,
            winRate: totalGames > 0 ? (gamesWon / totalGames * 100).toFixed(1) : 0,
            wallet: userData.wallet
        });
    } catch (error) {
        console.error('User summary error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// GET /user/transactions
router.get('/transactions', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const transactions = await WalletService.getTransactionHistory(userId);
        res.json({ transactions });
    } catch (error) {
        console.error('Transaction history error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// GET /user/games
router.get('/games', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const games = await Game.find({
            $or: [
                { 'players.userId': userId },
                { 'winners.userId': userId }
            ]
        }).sort({ createdAt: -1 }).limit(50);

        const gameData = games.map(game => {
            const userPlayer = game.players.find(p => p.userId === userId);
            const userWinner = game.winners.find(w => w.userId === userId);

            return {
                id: game._id,
                gameId: game.gameId,
                stake: game.stake,
                status: game.status,
                finishedAt: game.finishedAt,
                userResult: {
                    participated: !!userPlayer,
                    won: !!userWinner,
                    prize: userWinner ? userWinner.prize : 0
                }
            };
        });

        res.json({ games: gameData });
    } catch (error) {
        console.error('Game history error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

module.exports = router;
