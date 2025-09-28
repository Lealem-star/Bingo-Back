const CartellaSelection = require('../models/CartellaSelection');
const WalletService = require('./walletService');

class CartellaService {

    // Get all active cartella selections
    static async getActiveSelections(gameId = null) {
        try {
            const query = { status: { $in: ['selected', 'confirmed'] } };
            if (gameId) {
                query.gameId = gameId;
            }

            const selections = await CartellaSelection.find(query)
                .populate('playerId', 'firstName lastName telegramId')
                .sort({ selectedAt: -1 });

            return selections.map(selection => ({
                cartellaNumber: selection.cartellaNumber,
                playerId: selection.playerId._id,
                playerName: selection.playerName,
                stake: selection.stake,
                gameId: selection.gameId,
                status: selection.status,
                selectedAt: selection.selectedAt,
                confirmedAt: selection.confirmedAt
            }));
        } catch (error) {
            console.error('Error getting active selections:', error);
            throw error;
        }
    }

    // Get recent selections
    static async getRecentSelections(limit = 20) {
        try {
            const selections = await CartellaSelection.find()
                .populate('playerId', 'firstName lastName telegramId')
                .sort({ selectedAt: -1 })
                .limit(limit);

            return selections.map(selection => ({
                cartellaNumber: selection.cartellaNumber,
                playerId: selection.playerId._id,
                playerName: selection.playerName,
                stake: selection.stake,
                gameId: selection.gameId,
                status: selection.status,
                selectedAt: selection.selectedAt,
                timestamp: selection.selectedAt.getTime()
            }));
        } catch (error) {
            console.error('Error getting recent selections:', error);
            throw error;
        }
    }

    // Select a cartella
    static async selectCartella(cartellaNumber, playerId, playerName, stake, gameId = null) {
        try {
            // Check if cartella is already taken
            const existingSelection = await CartellaSelection.findOne({
                cartellaNumber,
                status: { $in: ['selected', 'confirmed'] }
            });

            if (existingSelection) {
                return {
                    success: false,
                    error: 'Cartella already taken',
                    takenBy: existingSelection.playerName
                };
            }

            // Validate player balance
            if (playerId && playerId !== 'anonymous') {
                const userData = await WalletService.getWallet(playerId);

                if (!userData) {
                    return {
                        success: false,
                        error: 'Player wallet not found'
                    };
                }

                const playWalletBalance = userData.play || 0;

                if (playWalletBalance < stake) {
                    return {
                        success: false,
                        error: 'Insufficient balance',
                        required: stake,
                        available: playWalletBalance,
                        shortfall: stake - playWalletBalance
                    };
                }
            }

            // Create new selection
            const selection = new CartellaSelection({
                cartellaNumber,
                playerId: playerId !== 'anonymous' ? playerId : null,
                playerName,
                stake,
                gameId,
                status: 'selected'
            });

            await selection.save();

            // Populate the selection for response
            await selection.populate('playerId', 'firstName lastName telegramId');

            return {
                success: true,
                message: 'Cartella selected successfully',
                cartellaNumber,
                selection: {
                    cartellaNumber: selection.cartellaNumber,
                    playerId: selection.playerId?._id || 'anonymous',
                    playerName: selection.playerName,
                    stake: selection.stake,
                    gameId: selection.gameId,
                    status: selection.status,
                    selectedAt: selection.selectedAt,
                    timestamp: selection.selectedAt.getTime()
                }
            };

        } catch (error) {
            console.error('Error selecting cartella:', error);

            // Handle duplicate key error (cartella already taken)
            if (error.code === 11000) {
                return {
                    success: false,
                    error: 'Cartella already taken'
                };
            }

            return {
                success: false,
                error: 'Failed to select cartella'
            };
        }
    }

    // Confirm a cartella selection (deduct stake from wallet)
    static async confirmCartellaSelection(cartellaNumber, playerId) {
        try {
            const selection = await CartellaSelection.findOne({
                cartellaNumber,
                playerId,
                status: 'selected'
            });

            if (!selection) {
                return {
                    success: false,
                    error: 'Selection not found'
                };
            }

            // Deduct stake from player's wallet
            if (playerId !== 'anonymous') {
                const result = await WalletService.processGameBet(playerId, selection.stake, selection.gameId);

                if (!result) {
                    return {
                        success: false,
                        error: 'Failed to deduct stake from wallet'
                    };
                }
            }

            // Update selection status
            selection.status = 'confirmed';
            selection.confirmedAt = new Date();
            await selection.save();

            return {
                success: true,
                message: 'Cartella confirmed successfully',
                selection: {
                    cartellaNumber: selection.cartellaNumber,
                    playerId: selection.playerId,
                    playerName: selection.playerName,
                    stake: selection.stake,
                    gameId: selection.gameId,
                    status: selection.status,
                    selectedAt: selection.selectedAt,
                    confirmedAt: selection.confirmedAt
                }
            };

        } catch (error) {
            console.error('Error confirming cartella selection:', error);
            return {
                success: false,
                error: 'Failed to confirm cartella selection'
            };
        }
    }

    // Cancel a cartella selection
    static async cancelCartellaSelection(cartellaNumber, playerId) {
        try {
            const selection = await CartellaSelection.findOne({
                cartellaNumber,
                playerId,
                status: 'selected'
            });

            if (!selection) {
                return {
                    success: false,
                    error: 'Selection not found'
                };
            }

            selection.status = 'cancelled';
            selection.cancelledAt = new Date();
            await selection.save();

            return {
                success: true,
                message: 'Cartella selection cancelled',
                selection: {
                    cartellaNumber: selection.cartellaNumber,
                    playerId: selection.playerId,
                    playerName: selection.playerName,
                    stake: selection.stake,
                    gameId: selection.gameId,
                    status: selection.status,
                    selectedAt: selection.selectedAt,
                    cancelledAt: selection.cancelledAt
                }
            };

        } catch (error) {
            console.error('Error cancelling cartella selection:', error);
            return {
                success: false,
                error: 'Failed to cancel cartella selection'
            };
        }
    }

    // Reset all selections (admin function)
    static async resetAllSelections() {
        try {
            await CartellaSelection.updateMany(
                { status: { $in: ['selected', 'confirmed'] } },
                {
                    status: 'cancelled',
                    cancelledAt: new Date()
                }
            );

            return {
                success: true,
                message: 'All cartella selections have been reset'
            };
        } catch (error) {
            console.error('Error resetting cartella selections:', error);
            return {
                success: false,
                error: 'Failed to reset cartella selections'
            };
        }
    }

    // Get selection statistics
    static async getSelectionStats() {
        try {
            const stats = await CartellaSelection.aggregate([
                {
                    $group: {
                        _id: '$status',
                        count: { $sum: 1 },
                        totalStake: { $sum: '$stake' }
                    }
                }
            ]);

            const totalSelections = await CartellaSelection.countDocuments();
            const activeSelections = await CartellaSelection.countDocuments({
                status: { $in: ['selected', 'confirmed'] }
            });

            return {
                success: true,
                stats: {
                    totalSelections,
                    activeSelections,
                    statusBreakdown: stats,
                    totalStake: stats.reduce((sum, stat) => sum + stat.totalStake, 0)
                }
            };
        } catch (error) {
            console.error('Error getting selection stats:', error);
            return {
                success: false,
                error: 'Failed to get selection statistics'
            };
        }
    }

    // Get selections by player
    static async getPlayerSelections(playerId) {
        try {
            const selections = await CartellaSelection.find({ playerId })
                .sort({ selectedAt: -1 });

            return {
                success: true,
                selections: selections.map(selection => ({
                    cartellaNumber: selection.cartellaNumber,
                    playerName: selection.playerName,
                    stake: selection.stake,
                    gameId: selection.gameId,
                    status: selection.status,
                    selectedAt: selection.selectedAt,
                    confirmedAt: selection.confirmedAt,
                    cancelledAt: selection.cancelledAt
                }))
            };
        } catch (error) {
            console.error('Error getting player selections:', error);
            return {
                success: false,
                error: 'Failed to get player selections'
            };
        }
    }
}

module.exports = CartellaService;
