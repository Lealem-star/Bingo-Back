const express = require('express');
const router = express.Router();
const SmsForwarderService = require('../services/smsForwarderService');
const SMSRecord = require('../models/SMSRecord');
const DepositVerification = require('../models/DepositVerification');

// POST /sms-forwarder/incoming - Receive SMS from forwarder
router.post('/incoming', async (req, res) => {
    try {
        const { phoneNumber, message, timestamp, source = 'forwarder' } = req.body;

        if (!phoneNumber || !message) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: phoneNumber, message'
            });
        }

        // Store the incoming SMS
        const smsRecord = await SmsForwarderService.storeIncomingSMS({
            phoneNumber,
            message,
            timestamp: timestamp ? new Date(timestamp) : new Date(),
            source
        });

        // Try to match with existing user SMS
        await attemptAutoMatching(smsRecord);

        res.json({
            success: true,
            message: 'SMS received and processed',
            smsId: smsRecord._id
        });
    } catch (error) {
        console.error('SMS forwarder error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process SMS'
        });
    }
});

// POST /sms-forwarder/user-sms - User forwards their SMS
router.post('/user-sms', async (req, res) => {
    try {
        const { userId, message, phoneNumber } = req.body;

        if (!userId || !message) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, message'
            });
        }

        // Store user SMS
        const userSMS = await SmsForwarderService.storeIncomingSMS({
            phoneNumber: phoneNumber || 'user',
            message,
            source: 'user',
            userId
        });

        // Try to match with existing receiver SMS
        await attemptAutoMatching(userSMS);

        res.json({
            success: true,
            message: 'User SMS received and processed',
            smsId: userSMS._id
        });
    } catch (error) {
        console.error('User SMS error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process user SMS'
        });
    }
});

// GET /sms-forwarder/verifications - Get pending verifications
router.get('/verifications', async (req, res) => {
    try {
        const { limit = 50, skip = 0, status = 'pending_review' } = req.query;

        const verifications = await DepositVerification.find({ status })
            .populate('userId', 'firstName lastName phone telegramId')
            .populate('userSMS')
            .populate('receiverSMS')
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .skip(parseInt(skip));

        res.json({
            success: true,
            verifications
        });
    } catch (error) {
        console.error('Get verifications error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get verifications'
        });
    }
});

// POST /sms-forwarder/approve/:id - Approve verification
router.post('/approve/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { adminId } = req.body;

        const result = await SmsForwarderService.approveVerification(id, adminId);

        res.json({
            success: true,
            message: 'Verification approved and deposit processed',
            transaction: result.transaction
        });
    } catch (error) {
        console.error('Approve verification error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to approve verification'
        });
    }
});

// POST /sms-forwarder/reject/:id - Reject verification
router.post('/reject/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { adminId, reason } = req.body;

        const result = await SmsForwarderService.rejectVerification(id, adminId, reason);

        res.json({
            success: true,
            message: 'Verification rejected',
            verification: result
        });
    } catch (error) {
        console.error('Reject verification error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to reject verification'
        });
    }
});

// GET /sms-forwarder/stats - Get verification statistics
router.get('/stats', async (req, res) => {
    try {
        const stats = await DepositVerification.aggregate([
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                    totalAmount: { $sum: '$amount' }
                }
            }
        ]);

        const totalSMS = await SMSRecord.countDocuments();
        const matchedSMS = await SMSRecord.countDocuments({ status: 'matched' });

        res.json({
            success: true,
            stats: {
                verifications: stats,
                sms: {
                    total: totalSMS,
                    matched: matchedSMS,
                    matchRate: totalSMS > 0 ? (matchedSMS / totalSMS) * 100 : 0
                }
            }
        });
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get statistics'
        });
    }
});

// Helper function to attempt automatic matching
async function attemptAutoMatching(newSMS) {
    try {
        // Find potential matches based on amount and time window
        const timeWindow = 10 * 60 * 1000; // 10 minutes
        const startTime = new Date(newSMS.timestamp.getTime() - timeWindow);
        const endTime = new Date(newSMS.timestamp.getTime() + timeWindow);

        const potentialMatches = await SMSRecord.find({
            _id: { $ne: newSMS._id },
            'parsedData.amount': newSMS.parsedData.amount,
            timestamp: { $gte: startTime, $lte: endTime },
            status: 'pending'
        });

        for (const potentialMatch of potentialMatches) {
            // Check if they are from different sources
            if (potentialMatch.source !== newSMS.source) {
                const matchResult = await SmsForwarderService.matchSMS(newSMS, potentialMatch);

                if (matchResult.isVerified) {
                    // Create deposit verification
                    const userSMS = newSMS.source === 'user' ? newSMS : potentialMatch;
                    const receiverSMS = newSMS.source === 'receiver' ? newSMS : potentialMatch;

                    await SmsForwarderService.createDepositVerification(
                        userSMS.userId,
                        userSMS,
                        receiverSMS,
                        matchResult
                    );

                    // Update SMS records status
                    newSMS.status = 'matched';
                    newSMS.matchedWith = potentialMatch._id;
                    await newSMS.save();

                    potentialMatch.status = 'matched';
                    potentialMatch.matchedWith = newSMS._id;
                    await potentialMatch.save();

                    console.log(`Auto-matched SMS: ${newSMS._id} with ${potentialMatch._id}`);
                    break;
                }
            }
        }
    } catch (error) {
        console.error('Auto-matching error:', error);
    }
}

module.exports = router;
