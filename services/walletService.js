const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

class WalletService {
    // Get wallet by user ID
    static async getWallet(userId) {
        try {
            let wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                wallet = await this.createWallet(userId);
            }
            return wallet;
        } catch (error) {
            console.error('Error getting wallet:', error);
            throw error;
        }
    }

    // Create wallet
    static async createWallet(userId) {
        try {
            const wallet = new Wallet({
                userId,
                balance: 0,
                coins: 0,
                gamesWon: 0
            });
            await wallet.save();
            return wallet;
        } catch (error) {
            console.error('Error creating wallet:', error);
            throw error;
        }
    }

    // Update wallet balance
    static async updateBalance(userId, updates) {
        try {
            const wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                throw new Error('Wallet not found');
            }

            const balanceBefore = {
                balance: wallet.balance,
                coins: wallet.coins
            };

            // Update balances
            if (updates.balance !== undefined) wallet.balance = Math.max(0, wallet.balance + updates.balance);
            if (updates.coins !== undefined) wallet.coins = Math.max(0, wallet.coins + updates.coins);
            if (updates.gamesWon !== undefined) wallet.gamesWon += updates.gamesWon;

            await wallet.save();

            return {
                wallet,
                balanceBefore,
                balanceAfter: {
                    balance: wallet.balance,
                    coins: wallet.coins
                }
            };
        } catch (error) {
            console.error('Error updating wallet balance:', error);
            throw error;
        }
    }

    // Process deposit
    static async processDeposit(userId, amount, smsData = null) {
        try {
            // Credit fiat balance
            const result = await this.updateBalance(userId, { balance: amount });

            // Gift coins: 50 birr -> 10 coins => 0.2 coin per birr
            const giftCoins = Math.floor(amount * 0.2);
            if (giftCoins > 0) {
                await this.updateBalance(userId, { coins: giftCoins });
            }

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'deposit',
                amount,
                description: `Deposit via SMS: ETB ${amount}${giftCoins ? ` (+${giftCoins} coins gift)` : ''}`,
                reference: smsData?.ref || null,
                smsData,
                balanceBefore: result.balanceBefore,
                balanceAfter: result.balanceAfter
            });
            await transaction.save();

            // Update wallet total deposited
            await Wallet.findOneAndUpdate(
                { userId },
                {
                    $inc: { totalDeposited: amount },
                    $set: { lastDepositDate: new Date() }
                }
            );

            return { wallet: result.wallet, transaction };
        } catch (error) {
            console.error('Error processing deposit:', error);
            throw error;
        }
    }

    // Convert coins to fiat balance at 100 coins = 1 birr
    static async convertCoins(userId, coins) {
        try {
            const wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                throw new Error('Wallet not found');
            }

            if (wallet.coins < coins) {
                throw new Error('Insufficient coins');
            }

            // Conversion rate: 100 coins -> 1 birr
            const birrAmount = Math.floor(coins / 100);
            if (birrAmount <= 0) {
                throw new Error('MIN_CONVERSION_NOT_MET');
            }

            const coinsToDeduct = birrAmount * 100;
            const result = await this.updateBalance(userId, {
                coins: -coinsToDeduct,
                balance: birrAmount
            });

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'coin_conversion',
                amount: birrAmount,
                description: `Converted ${coinsToDeduct} coins to ETB ${birrAmount}`,
                balanceBefore: result.balanceBefore,
                balanceAfter: result.balanceAfter
            });
            await transaction.save();

            return { wallet: result.wallet, transaction };
        } catch (error) {
            console.error('Error converting coins:', error);
            throw error;
        }
    }

    // Process game bet
    static async processGameBet(userId, amount, gameId) {
        try {
            const result = await this.updateBalance(userId, { balance: -amount });

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'game_bet',
                amount: -amount,
                description: `Game bet: ETB ${amount}`,
                gameId,
                balanceBefore: result.balanceBefore,
                balanceAfter: result.balanceAfter
            });
            await transaction.save();

            return { wallet: result.wallet, transaction };
        } catch (error) {
            console.error('Error processing game bet:', error);
            throw error;
        }
    }

    // Process game win
    static async processGameWin(userId, amount, gameId) {
        try {
            const result = await this.updateBalance(userId, {
                balance: amount,
                gamesWon: 1
            });

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'game_win',
                amount,
                description: `Game win: ETB ${amount}`,
                gameId,
                balanceBefore: result.balanceBefore,
                balanceAfter: result.balanceAfter
            });
            await transaction.save();

            return { wallet: result.wallet, transaction };
        } catch (error) {
            console.error('Error processing game win:', error);
            throw error;
        }
    }

    // Get transaction history
    static async getTransactionHistory(userId, type = null, limit = 50, skip = 0) {
        try {
            const query = { userId };
            if (type) {
                query.type = type;
            }

            const transactions = await Transaction.find(query)
                .sort({ createdAt: -1 })
                .limit(limit)
                .skip(skip);

            const total = await Transaction.countDocuments({ userId });

            return { transactions, total };
        } catch (error) {
            console.error('Error getting transaction history:', error);
            throw error;
        }
    }

    // Process withdrawal request
    static async processWithdrawal(userId, amount, destination) {
        try {
            const wallet = await this.getWallet(userId);

            if (wallet.balance < amount) {
                return { success: false, error: 'INSUFFICIENT_FUNDS' };
            }

            // Create pending withdrawal transaction
            const transaction = new Transaction({
                userId,
                type: 'withdrawal',
                amount,
                status: 'pending',
                description: `Withdrawal to ${destination}`,
                metadata: { destination }
            });

            await transaction.save();

            return {
                success: true,
                transactionId: transaction._id
            };
        } catch (error) {
            console.error('Error processing withdrawal:', error);
            return { success: false, error: 'INTERNAL_ERROR' };
        }
    }

    // Process withdrawal approval (admin)
    static async processWithdrawalApproval(userId, amount) {
        try {
            const wallet = await this.getWallet(userId);

            if (wallet.balance < amount) {
                return { success: false, error: 'INSUFFICIENT_FUNDS' };
            }

            // Deduct from balance
            wallet.balance -= amount;
            await wallet.save();

            return { success: true };
        } catch (error) {
            console.error('Error processing withdrawal approval:', error);
            return { success: false, error: 'INTERNAL_ERROR' };
        }
    }
}

module.exports = WalletService;
