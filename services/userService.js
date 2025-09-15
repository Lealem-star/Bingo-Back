const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');

class UserService {
    // Create or update user from Telegram data
    static async createOrUpdateUser(telegramUser, phone = null) {
        try {
            const existingUser = await User.findOne({ telegramId: String(telegramUser.id) });

            if (existingUser) {
                // Update existing user
                existingUser.firstName = telegramUser.first_name || existingUser.firstName;
                existingUser.lastName = telegramUser.last_name || existingUser.lastName;
                existingUser.username = telegramUser.username || existingUser.username;
                existingUser.lastActive = new Date();

                if (phone && !existingUser.phone) {
                    existingUser.phone = phone;
                    existingUser.isRegistered = true;
                }

                await existingUser.save();
                return existingUser;
            } else {
                // Create new user
                const newUser = new User({
                    telegramId: String(telegramUser.id),
                    firstName: telegramUser.first_name || 'User',
                    lastName: telegramUser.last_name || '',
                    username: telegramUser.username || '',
                    phone: phone,
                    isRegistered: !!phone,
                    registrationDate: new Date(),
                    lastActive: new Date()
                });

                await newUser.save();

                // Create wallet for new user
                await this.createWallet(newUser._id);

                return newUser;
            }
        } catch (error) {
            console.error('Error creating/updating user:', error);
            throw error;
        }
    }

    // Create wallet for user
    static async createWallet(userId) {
        try {
            const existingWallet = await Wallet.findOne({ userId });
            if (existingWallet) {
                return existingWallet;
            }

            const newWallet = new Wallet({
                userId,
                balance: 0,
                coins: 0,
                gamesWon: 0
            });

            await newWallet.save();
            return newWallet;
        } catch (error) {
            console.error('Error creating wallet:', error);
            throw error;
        }
    }

    // Get user by Telegram ID
    static async getUserByTelegramId(telegramId) {
        try {
            return await User.findOne({ telegramId: String(telegramId) });
        } catch (error) {
            console.error('Error getting user by Telegram ID:', error);
            throw error;
        }
    }

    // Get user with wallet
    static async getUserWithWallet(telegramId) {
        try {
            const user = await User.findOne({ telegramId: String(telegramId) });
            if (!user) return null;

            const wallet = await Wallet.findOne({ userId: user._id });
            return { user, wallet };
        } catch (error) {
            console.error('Error getting user with wallet:', error);
            throw error;
        }
    }

    // Update user phone number
    static async updateUserPhone(telegramId, phone) {
        try {
            const user = await User.findOne({ telegramId: String(telegramId) });
            if (!user) return null;

            user.phone = phone;
            user.isRegistered = true;
            await user.save();

            return user;
        } catch (error) {
            console.error('Error updating user phone:', error);
            throw error;
        }
    }

    // Get user statistics
    static async getUserStats(telegramId) {
        try {
            const user = await User.findOne({ telegramId: String(telegramId) });
            if (!user) return null;

            const wallet = await Wallet.findOne({ userId: user._id });
            const totalTransactions = await Transaction.countDocuments({ userId: user._id });
            const totalDeposits = await Transaction.aggregate([
                { $match: { userId: user._id, type: 'deposit', status: 'completed' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]);

            return {
                user,
                wallet,
                totalTransactions,
                totalDeposits: totalDeposits[0]?.total || 0
            };
        } catch (error) {
            console.error('Error getting user stats:', error);
            throw error;
        }
    }
}

module.exports = UserService;
