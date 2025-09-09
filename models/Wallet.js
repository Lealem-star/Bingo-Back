const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    main: {
        type: Number,
        default: 0,
        min: 0
    },
    play: {
        type: Number,
        default: 50,
        min: 0
    },
    coins: {
        type: Number,
        default: 1,
        min: 0
    },
    gamesWon: {
        type: Number,
        default: 0
    },
    totalDeposited: {
        type: Number,
        default: 0
    },
    totalWithdrawn: {
        type: Number,
        default: 0
    },
    lastDepositDate: {
        type: Date,
        default: null
    },
    lastWithdrawalDate: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

// userId already has unique index from schema definition

module.exports = mongoose.model('Wallet', walletSchema);
