const mongoose = require('mongoose');

const smsRecordSchema = new mongoose.Schema({
    phoneNumber: {
        type: String,
        required: true,
        index: true
    },
    message: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    },
    source: {
        type: String,
        enum: ['forwarder', 'user', 'receiver', 'agent'],
        required: true
    },
    parsedData: {
        amount: { type: Number, default: null },
        reference: { type: String, default: null },
        datetime: { type: String, default: null },
        paymentMethod: { type: String, default: null },
        rawMessage: { type: String, required: true }
    },
    status: {
        type: String,
        enum: ['pending', 'matched', 'verified', 'rejected'],
        default: 'pending'
    },
    matchedWith: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SMSRecord',
        default: null
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, {
    timestamps: true
});

// Indexes for efficient querying
smsRecordSchema.index({ phoneNumber: 1, timestamp: -1 });
smsRecordSchema.index({ source: 1, status: 1 });
smsRecordSchema.index({ 'parsedData.amount': 1 });
smsRecordSchema.index({ 'parsedData.reference': 1 });

module.exports = mongoose.model('SMSRecord', smsRecordSchema);
