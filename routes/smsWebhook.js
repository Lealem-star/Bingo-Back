const express = require('express');
const router = express.Router();
const SmsForwarderService = require('../services/smsForwarderService');

// Webhook endpoint for SMS forwarder service
// This would be called by your SMS forwarding service (like Twilio, AWS SNS, etc.)
router.post('/webhook', async (req, res) => {
    try {
        const {
            from,           // Sender phone number
            to,             // Receiver phone number  
            body,           // SMS message content
            timestamp,      // Message timestamp
            messageId       // Unique message ID
        } = req.body;

        console.log('SMS Webhook received:', { from, to, body: body?.substring(0, 100) + '...' });

        // Determine if this is from a user or receiver based on phone number
        // You'll need to configure which numbers are your agent numbers
        const agentNumbers = process.env.AGENT_PHONE_NUMBERS?.split(',') || [];
        const isFromAgent = agentNumbers.includes(from);

        const source = isFromAgent ? 'receiver' : 'user';

        // Store the SMS
        const smsRecord = await SmsForwarderService.storeIncomingSMS({
            phoneNumber: from,
            message: body,
            timestamp: timestamp ? new Date(timestamp) : new Date(),
            source,
            messageId
        });

        // Try to match with existing SMS
        await attemptAutoMatching(smsRecord);

        res.json({
            success: true,
            message: 'SMS processed successfully',
            smsId: smsRecord._id
        });

    } catch (error) {
        console.error('SMS webhook error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process SMS'
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

        const potentialMatches = await require('../models/SMSRecord').find({
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
