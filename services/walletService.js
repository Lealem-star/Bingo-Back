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
                main: 0,
                play: 50,
                coins: 1,
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
                main: wallet.main,
                play: wallet.play,
                coins: wallet.coins
            };

            // Update balances
            if (updates.main !== undefined) wallet.main = Math.max(0, wallet.main + updates.main);
            if (updates.play !== undefined) wallet.play = Math.max(0, wallet.play + updates.play);
            if (updates.coins !== undefined) wallet.coins = Math.max(0, wallet.coins + updates.coins);
            if (updates.gamesWon !== undefined) wallet.gamesWon += updates.gamesWon;

            await wallet.save();

            return {
                wallet,
                balanceBefore,
                balanceAfter: {
                    main: wallet.main,
                    play: wallet.play,
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
            const result = await this.updateBalance(userId, { main: amount });

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'deposit',
                amount,
                description: `Deposit via SMS: ETB ${amount}`,
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

    // Convert coins to play balance
    static async convertCoins(userId, coins) {
        try {
            const wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                throw new Error('Wallet not found');
            }

            if (wallet.coins < coins) {
                throw new Error('Insufficient coins');
            }

            const result = await this.updateBalance(userId, {
                coins: -coins,
                play: coins
            });

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'coin_conversion',
                amount: coins,
                description: `Converted ${coins} coins to play balance`,
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
            const result = await this.updateBalance(userId, { play: -amount });

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
                main: amount,
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
            
            if (wallet.main < amount) {
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
            
            if (wallet.main < amount) {
                return { success: false, error: 'INSUFFICIENT_FUNDS' };
            }

            // Deduct from main wallet
            wallet.main -= amount;
            await wallet.save();

            return { success: true };
        } catch (error) {
            console.error('Error processing withdrawal approval:', error);
            return { success: false, error: 'INTERNAL_ERROR' };
        }
    }
}

module.exports = WalletService;
