const express = require('express');
const BingoCards = require('../data/cartellas');

const router = express.Router();

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
