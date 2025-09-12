const express = require('express');

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

module.exports = router;
