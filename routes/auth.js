const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const UserService = require('../services/userService');
const WalletService = require('../services/walletService');

const router = express.Router();

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_here_change_this';
const BOT_TOKEN = process.env.BOT_TOKEN || '';

// Telegram initData verification
function verifyTelegramInitData(initData) {
    if (!initData || !BOT_TOKEN) return null;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const data = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');
        const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const myHash = crypto.createHmac('sha256', secret).update(data).digest('hex');
        if (myHash !== hash) return null;
        const userJson = params.get('user');
        return userJson ? JSON.parse(userJson) : null;
    } catch (e) {
        return null;
    }
}

// Auth middleware
function authMiddleware(req, res, next) {
    try {
        const auth = req.headers['authorization'] || '';
        const sidHeader = req.headers['x-session'] || '';
        let token = '';
        const parts = auth.split(' ');
        if (parts.length === 2 && parts[0] === 'Bearer') {
            token = parts[1];
        } else if (typeof sidHeader === 'string' && sidHeader) {
            token = sidHeader;
        }
        if (token) {
            const payload = jwt.verify(token, JWT_SECRET);
            req.userId = String(payload.sub);
            return next();
        }
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    } catch (e) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
}

// POST /auth/telegram/verify
router.post('/telegram/verify', async (req, res) => {
    try {
        const { initData } = req.body;
        let user = null;
        let userId = null;

        if (initData) {
            // Telegram verification
            const telegramUser = verifyTelegramInitData(initData);
            if (!telegramUser) {
                return res.status(400).json({ error: 'INVALID_TELEGRAM_DATA' });
            }
            userId = String(telegramUser.id);
            user = await UserService.getUserByTelegramId(userId);
            if (!user) {
                user = await UserService.createOrUpdateUser(telegramUser);
            }
            // Ensure user has a wallet
            if (user) {
                const wallet = await WalletService.getWallet(user._id);
                if (!wallet) {
                    await WalletService.createWallet(user._id);
                }
            }
        } else {
            return res.status(400).json({ error: 'MISSING_TELEGRAM_DATA' });
        }

        if (!user) {
            return res.status(500).json({ error: 'USER_CREATION_FAILED' });
        }

        // Issue JWT
        const token = jwt.sign({ sub: user.telegramId || userId, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            token,
            sessionId: token,
            user: {
                id: user.telegramId || userId,
                name: user.firstName,
                phone: user.phone,
                firstName: user.firstName,
                lastName: user.lastName,
                isRegistered: user.isRegistered
            }
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

module.exports = { router, authMiddleware };
