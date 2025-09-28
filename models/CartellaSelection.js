const mongoose = require('mongoose');

const cartellaSelectionSchema = new mongoose.Schema({
    cartellaNumber: {
        type: Number,
        required: true,
        min: 1,
        max: 100
    },
    playerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    playerName: {
        type: String,
        required: true
    },
    stake: {
        type: Number,
        required: true,
        min: 0
    },
    gameId: {
        type: String,
        default: null
    },
    status: {
        type: String,
        enum: ['selected', 'confirmed', 'cancelled'],
        default: 'selected'
    },
    selectedAt: {
        type: Date,
        default: Date.now
    },
    confirmedAt: {
        type: Date,
        default: null
    },
    cancelledAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

// Indexes for efficient querying
cartellaSelectionSchema.index({ cartellaNumber: 1, status: 1 });
cartellaSelectionSchema.index({ playerId: 1, status: 1 });
cartellaSelectionSchema.index({ gameId: 1 });
cartellaSelectionSchema.index({ selectedAt: -1 });
cartellaSelectionSchema.index({ status: 1, selectedAt: -1 });

// Compound index to ensure unique cartella per game
cartellaSelectionSchema.index({ cartellaNumber: 1, gameId: 1, status: 1 }, {
    unique: true,
    partialFilterExpression: { status: { $in: ['selected', 'confirmed'] } }
});

module.exports = mongoose.model('CartellaSelection', cartellaSelectionSchema);
