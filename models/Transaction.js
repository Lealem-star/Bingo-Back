const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    type: {
        type: String,
        enum: ['deposit', 'withdrawal', 'game_bet', 'game_win', 'coin_conversion', 'bonus', 'refund', 'wallet_transfer'],
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    currency: {
        type: String,
        default: 'ETB'
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'cancelled'],
        default: 'completed'
    },
    description: {
        type: String,
        required: true
    },
    reference: {
        type: String,
        default: null
    },
    gameId: {
        type: String,
        default: null
    },
    smsData: {
        type: Object,
        default: null
    },
    balanceBefore: {
        main: { type: Number, default: 0 },
        play: { type: Number, default: 0 },
        coins: { type: Number, default: 0 }
    },
    balanceAfter: {
        main: { type: Number, default: 0 },
        play: { type: Number, default: 0 },
        coins: { type: Number, default: 0 }
    }
}, {
    timestamps: true
});

// Create indexes
transactionSchema.index({ userId: 1 });
transactionSchema.index({ type: 1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ gameId: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
