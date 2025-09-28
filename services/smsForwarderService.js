const mongoose = require('mongoose');

// SMS Forwarder Service for dual SMS verification
class SmsForwarderService {

    // Store incoming SMS from forwarder
    static async storeIncomingSMS(smsData) {
        try {
            const smsRecord = new SMSRecord({
                phoneNumber: smsData.phoneNumber,
                message: smsData.message,
                timestamp: smsData.timestamp || new Date(),
                source: smsData.source || 'forwarder',
                parsedData: this.parseSMSContent(smsData.message),
                status: 'pending'
            });

            await smsRecord.save();
            return smsRecord;
        } catch (error) {
            console.error('Error storing SMS:', error);
            throw error;
        }
    }

    // Parse SMS content to extract transaction details
    static parseSMSContent(message) {
        const patterns = {
            // Amount patterns
            amount: [
                /ETB\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
                /(\d+(?:\.\d{1,2})?)\s*ETB/i,
                /(\d+(?:\.\d{1,2})?)\s*ብር/i,
                /(\d+(?:\.\d{1,2})?)/i
            ],
            // Reference/Transaction ID patterns
            reference: [
                /id=([A-Z0-9]+)/i,
                /ref[:\s]*([A-Z0-9]+)/i,
                /transaction[:\s]*([A-Z0-9]+)/i,
                /txn[:\s]*([A-Z0-9]+)/i
            ],
            // Date/Time patterns
            datetime: [
                /on\s+([0-9]{2}\/[0-9]{2}\/[0-9]{4})\s+at\s+([0-9]{2}:[0-9]{2}:[0-9]{2})/i,
                /([0-9]{2}\/[0-9]{2}\/[0-9]{4})\s+([0-9]{2}:[0-9]{2})/i
            ],
            // Payment method patterns
            paymentMethod: [
                /telebirr/i,
                /commercial/i,
                /abyssinia/i,
                /cbe/i,
                /birr/i
            ]
        };

        const parsed = {
            amount: null,
            reference: null,
            datetime: null,
            paymentMethod: null,
            rawMessage: message
        };

        // Extract amount
        for (const pattern of patterns.amount) {
            const match = message.match(pattern);
            if (match) {
                parsed.amount = Number(match[1]);
                if (parsed.amount >= 50) break; // Minimum deposit amount
            }
        }

        // Extract reference
        for (const pattern of patterns.reference) {
            const match = message.match(pattern);
            if (match) {
                parsed.reference = match[1];
                break;
            }
        }

        // Extract datetime
        for (const pattern of patterns.datetime) {
            const match = message.match(pattern);
            if (match) {
                parsed.datetime = match[0];
                break;
            }
        }

        // Extract payment method
        for (const pattern of patterns.paymentMethod) {
            if (pattern.test(message)) {
                parsed.paymentMethod = pattern.source.replace(/[\/i]/g, '');
                break;
            }
        }

        return parsed;
    }

    // Match user SMS with receiver SMS
    static async matchSMS(userSMS, receiverSMS) {
        try {
            const userParsed = userSMS.parsedData;
            const receiverParsed = receiverSMS.parsedData;

            // Matching criteria
            const matches = {
                amountMatch: false,
                referenceMatch: false,
                timeMatch: false,
                paymentMethodMatch: false
            };

            // Amount matching (exact match required)
            if (userParsed.amount && receiverParsed.amount) {
                matches.amountMatch = Math.abs(userParsed.amount - receiverParsed.amount) < 0.01;
            }

            // Reference matching (if available)
            if (userParsed.reference && receiverParsed.reference) {
                matches.referenceMatch = userParsed.reference === receiverParsed.reference;
            }

            // Time matching (within 5 minutes)
            if (userParsed.datetime && receiverParsed.datetime) {
                const userTime = new Date(userParsed.datetime);
                const receiverTime = new Date(receiverParsed.datetime);
                const timeDiff = Math.abs(userTime - receiverTime);
                matches.timeMatch = timeDiff <= 5 * 60 * 1000; // 5 minutes
            }

            // Payment method matching
            if (userParsed.paymentMethod && receiverParsed.paymentMethod) {
                matches.paymentMethodMatch = userParsed.paymentMethod === receiverParsed.paymentMethod;
            }

            // Calculate match score
            const matchScore = Object.values(matches).filter(Boolean).length;
            const totalCriteria = Object.keys(matches).length;

            return {
                matches,
                matchScore,
                totalCriteria,
                confidence: (matchScore / totalCriteria) * 100,
                isVerified: matchScore >= 2 // At least 2 criteria must match
            };
        } catch (error) {
            console.error('Error matching SMS:', error);
            return { isVerified: false, confidence: 0 };
        }
    }

    // Create deposit verification record
    static async createDepositVerification(userId, userSMS, receiverSMS, matchResult) {
        try {
            const verification = new DepositVerification({
                userId,
                userSMS: userSMS._id,
                receiverSMS: receiverSMS._id,
                amount: userSMS.parsedData.amount,
                matchResult,
                status: matchResult.isVerified ? 'verified' : 'pending_review',
                createdAt: new Date()
            });

            await verification.save();
            return verification;
        } catch (error) {
            console.error('Error creating deposit verification:', error);
            throw error;
        }
    }

    // Get pending verifications for admin review
    static async getPendingVerifications(limit = 50, skip = 0) {
        try {
            const verifications = await DepositVerification.find({ status: 'pending_review' })
                .populate('userId', 'firstName lastName phone telegramId')
                .populate('userSMS')
                .populate('receiverSMS')
                .sort({ createdAt: -1 })
                .limit(limit)
                .skip(skip);

            return verifications;
        } catch (error) {
            console.error('Error getting pending verifications:', error);
            throw error;
        }
    }

    // Approve deposit verification
    static async approveVerification(verificationId, adminId) {
        try {
            const verification = await DepositVerification.findById(verificationId)
                .populate('userId')
                .populate('userSMS')
                .populate('receiverSMS');

            if (!verification) {
                throw new Error('Verification not found');
            }

            if (verification.status !== 'pending_review') {
                throw new Error('Verification already processed');
            }

            // Process the deposit
            const WalletService = require('./walletService');
            const result = await WalletService.processDeposit(
                verification.userId._id,
                verification.amount,
                {
                    userSMS: verification.userSMS.parsedData,
                    receiverSMS: verification.receiverSMS.parsedData,
                    verificationId: verification._id
                }
            );

            // Update verification status
            verification.status = 'approved';
            verification.approvedBy = adminId;
            verification.approvedAt = new Date();
            await verification.save();

            return result;
        } catch (error) {
            console.error('Error approving verification:', error);
            throw error;
        }
    }

    // Reject deposit verification
    static async rejectVerification(verificationId, adminId, reason) {
        try {
            const verification = await DepositVerification.findById(verificationId);

            if (!verification) {
                throw new Error('Verification not found');
            }

            verification.status = 'rejected';
            verification.rejectedBy = adminId;
            verification.rejectedAt = new Date();
            verification.rejectionReason = reason;
            await verification.save();

            return verification;
        } catch (error) {
            console.error('Error rejecting verification:', error);
            throw error;
        }
    }
}

module.exports = SmsForwarderService;
