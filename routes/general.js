const express = require('express');
const BingoCards = require('../data/cartellas');

const router = express.Router();

// In-memory storage for selected cartellas (in production, use Redis or database)
let selectedCartellas = new Map(); // cartellaNumber -> { playerId, playerName, selectedAt }
let cartellaSelections = []; // Store selection history

// GET /
router.get('/', (req, res) => {
    res.json({ message: 'Welcome to Bingo Backend API!' });
});

// GET /health
router.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// GET /debug
router.get('/debug', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        headers: req.headers,
        jwt_secret_set: !!process.env.JWT_SECRET
    });
});

// GET /api/bingo/status
router.get('/api/bingo/status', (req, res) => {
    res.json({
        gameStatus: 'ready',
        message: 'Bingo game is ready to start'
    });
});

// GET /api/game/status - Game countdown and status endpoint
router.get('/api/game/status', (req, res) => {
    try {
        // For now, simulate countdown logic
        // In a real implementation, this would be managed by a game service
        const now = new Date();
        const seconds = now.getSeconds();

        // Simulate countdown that resets every 15 seconds
        const countdown = 15 - (seconds % 15);

        // Simulate random player count (0-5 players) with some persistence
        // Use a seed based on current minute to make it more consistent
        const minute = now.getMinutes();
        const seed = minute * 7 + Math.floor(seconds / 10);
        const playersCount = Math.floor((Math.sin(seed) + 1) * 3); // 0-6 players

        // Determine game status based on countdown and players
        let gameStatus = 'waiting';
        if (countdown <= 5 && playersCount >= 1) {
            gameStatus = 'starting';
        } else if (countdown === 0 && playersCount >= 1) {
            gameStatus = 'playing';
        }

        res.json({
            success: true,
            countdown: countdown,
            playersCount: playersCount,
            gameStatus: gameStatus,
            gameId: gameStatus === 'playing' ? `game_${Date.now()}` : null,
            takenCartellas: Array.from(selectedCartellas.entries()).map(([number, data]) => ({
                cartellaNumber: number,
                playerId: data.playerId,
                playerName: data.playerName,
                selectedAt: data.selectedAt
            })),
            recentSelections: cartellaSelections.slice(-10), // Last 10 selections
            timestamp: now.toISOString()
        });
    } catch (error) {
        console.error('Error fetching game status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch game status'
        });
    }
});

// POST /api/cartellas/select - Select a cartella
router.post('/api/cartellas/select', async (req, res) => {
    try {
        const { cartellaNumber, playerId, playerName, stake } = req.body;

        if (!cartellaNumber || cartellaNumber < 1 || cartellaNumber > BingoCards.cards.length) {
            return res.status(400).json({
                success: false,
                error: 'Invalid cartella number'
            });
        }

        // Check if cartella is already taken
        if (selectedCartellas.has(cartellaNumber)) {
            return res.status(409).json({
                success: false,
                error: 'Cartella already taken',
                takenBy: selectedCartellas.get(cartellaNumber).playerName
            });
        }

        // Validate player balance if playerId is provided
        if (playerId && playerId !== 'anonymous') {
            try {
                const UserService = require('../services/userService');
                const userData = await UserService.getUserWithWalletById(playerId);

                if (!userData || !userData.wallet) {
                    return res.status(400).json({
                        success: false,
                        error: 'Player wallet not found'
                    });
                }

                const requiredAmount = stake || 10; // Default stake if not provided
                const playWalletBalance = userData.wallet.play || 0;

                if (playWalletBalance < requiredAmount) {
                    return res.status(400).json({
                        success: false,
                        error: 'Insufficient balance',
                        required: requiredAmount,
                        available: playWalletBalance,
                        shortfall: requiredAmount - playWalletBalance
                    });
                }
            } catch (walletError) {
                console.error('Error checking wallet balance:', walletError);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to verify wallet balance'
                });
            }
        }

        // Add to selected cartellas
        const selectionData = {
            playerId: playerId || 'anonymous',
            playerName: playerName || 'Anonymous Player',
            selectedAt: new Date().toISOString()
        };
        selectedCartellas.set(cartellaNumber, selectionData);

        // Add to selection history
        const selection = {
            cartellaNumber,
            ...selectionData,
            timestamp: Date.now()
        };

        cartellaSelections.push(selection);

        // Keep only last 50 selections to prevent memory issues
        if (cartellaSelections.length > 50) {
            cartellaSelections = cartellaSelections.slice(-50);
        }

        res.json({
            success: true,
            message: 'Cartella selected successfully',
            cartellaNumber,
            selection,
            takenCartellas: Array.from(selectedCartellas.entries()).map(([number, data]) => ({
                cartellaNumber: number,
                playerId: data.playerId,
                playerName: data.playerName,
                selectedAt: data.selectedAt
            }))
        });

    } catch (error) {
        console.error('Error selecting cartella:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to select cartella'
        });
    }
});

// GET /api/cartellas/taken - Get all taken cartellas
router.get('/api/cartellas/taken', (req, res) => {
    try {
        res.json({
            success: true,
            takenCartellas: Array.from(selectedCartellas.entries()).map(([number, data]) => ({
                cartellaNumber: number,
                playerId: data.playerId,
                playerName: data.playerName,
                selectedAt: data.selectedAt
            })),
            recentSelections: cartellaSelections.slice(-20),
            totalSelected: selectedCartellas.size
        });
    } catch (error) {
        console.error('Error fetching taken cartellas:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch taken cartellas'
        });
    }
});

// POST /api/cartellas/reset - Reset all selections (for testing/admin)
router.post('/api/cartellas/reset', (req, res) => {
    try {
        selectedCartellas.clear();
        cartellaSelections = [];

        res.json({
            success: true,
            message: 'All cartella selections have been reset'
        });
    } catch (error) {
        console.error('Error resetting cartellas:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reset cartellas'
        });
    }
});

// GET /api/cartellas - Serve all bingo cards
router.get('/api/cartellas', (req, res) => {
    try {
        res.json({
            success: true,
            cards: BingoCards.cards,
            totalCards: BingoCards.cards.length
        });
    } catch (error) {
        console.error('Error serving cartellas:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to load cartellas data'
        });
    }
});

// GET /api/cartellas/:cardNumber - Serve specific card
router.get('/api/cartellas/:cardNumber', (req, res) => {
    try {
        const cardNumber = parseInt(req.params.cardNumber);

        if (isNaN(cardNumber) || cardNumber < 1 || cardNumber > BingoCards.cards.length) {
            return res.status(400).json({
                success: false,
                error: 'Invalid card number. Must be between 1 and ' + BingoCards.cards.length
            });
        }

        const cardIndex = cardNumber - 1;
        const card = BingoCards.cards[cardIndex];

        res.json({
            success: true,
            cardNumber: cardNumber,
            card: card
        });
    } catch (error) {
        console.error('Error serving cartella:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to load cartella data'
        });
    }
});

module.exports = router;
