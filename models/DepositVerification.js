const mongoose = require('mongoose');

const depositVerificationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    userSMS: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SMSRecord',
        required: true
    },
    receiverSMS: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SMSRecord',
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    matchResult: {
        matches: {
            amountMatch: { type: Boolean, default: false },
            referenceMatch: { type: Boolean, default: false },
            timeMatch: { type: Boolean, default: false },
            paymentMethodMatch: { type: Boolean, default: false }
        },
        matchScore: { type: Number, default: 0 },
        totalCriteria: { type: Number, default: 0 },
        confidence: { type: Number, default: 0 },
        isVerified: { type: Boolean, default: false }
    },
    status: {
        type: String,
        enum: ['pending_review', 'verified', 'approved', 'rejected'],
        default: 'pending_review',
        index: true
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    approvedAt: {
        type: Date,
        default: null
    },
    rejectedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    rejectedAt: {
        type: Date,
        default: null
    },
    rejectionReason: {
        type: String,
        default: null
    },
    transactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Transaction',
        default: null
    }
}, {
    timestamps: true
});

// Indexes for efficient querying
depositVerificationSchema.index({ userId: 1, status: 1 });
depositVerificationSchema.index({ status: 1, createdAt: -1 });
depositVerificationSchema.index({ amount: 1 });
depositVerificationSchema.index({ 'matchResult.confidence': -1 });

module.exports = mongoose.model('DepositVerification', depositVerificationSchema);
