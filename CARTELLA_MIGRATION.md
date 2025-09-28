# Cartella Selections Database Migration

## Overview

The cartella selection system has been migrated from in-memory storage to MongoDB database for better persistence, scalability, and data integrity.

## Changes Made

### 1. New Database Model
- **File**: `Bingo-Back/models/CartellaSelection.js`
- **Purpose**: Stores cartella selections with full transaction history
- **Fields**:
  - `cartellaNumber`: The selected cartella number (1-100)
  - `playerId`: Reference to User model
  - `playerName`: Player's display name
  - `stake`: Amount wagered
  - `gameId`: Associated game ID
  - `status`: 'selected', 'confirmed', 'cancelled'
  - `selectedAt`, `confirmedAt`, `cancelledAt`: Timestamps
  - `timestamps`: Created/updated timestamps

### 2. New Service Layer
- **File**: `Bingo-Back/services/cartellaService.js`
- **Purpose**: Business logic for cartella operations
- **Methods**:
  - `getActiveSelections()`: Get current active selections
  - `getRecentSelections()`: Get recent selection history
  - `selectCartella()`: Select a new cartella
  - `confirmCartellaSelection()`: Confirm selection and deduct stake
  - `cancelCartellaSelection()`: Cancel a selection
  - `resetAllSelections()`: Admin function to reset all selections
  - `getSelectionStats()`: Get statistics
  - `getPlayerSelections()`: Get player's selection history

### 3. Updated API Endpoints
- **File**: `Bingo-Back/routes/general.js`
- **Updated Endpoints**:
  - `GET /api/game/status`: Now uses database for player count and selections
  - `POST /api/cartellas/select`: Uses CartellaService for selection logic
  - `GET /api/cartellas/taken`: Gets data from database
  - `POST /api/cartellas/reset`: Uses CartellaService for reset
- **New Endpoints**:
  - `POST /api/cartellas/confirm`: Confirm selection and deduct stake
  - `POST /api/cartellas/cancel`: Cancel a selection
  - `GET /api/cartellas/stats`: Get selection statistics
  - `GET /api/cartellas/player/:playerId`: Get player's selections

### 4. Migration Script
- **File**: `Bingo-Back/scripts/migrateCartellaSelections.js`
- **Purpose**: Help migrate from in-memory to database
- **Usage**: `node scripts/migrateCartellaSelections.js`

## Benefits of Database Storage

### 1. **Persistence**
- Selections survive server restarts
- No data loss during maintenance
- Historical data preserved

### 2. **Scalability**
- Can handle multiple server instances
- Database handles concurrent access
- Better performance with indexes

### 3. **Data Integrity**
- Unique constraints prevent duplicate selections
- Referential integrity with User model
- Transaction support for complex operations

### 4. **Analytics**
- Historical selection data
- Player behavior analysis
- Game statistics and reporting

### 5. **Admin Features**
- Complete audit trail
- Player selection history
- Selection statistics
- Better error handling

## Database Schema

```javascript
{
  cartellaNumber: Number,     // 1-100
  playerId: ObjectId,        // Reference to User
  playerName: String,        // Display name
  stake: Number,             // Wagered amount
  gameId: String,            // Game identifier
  status: String,            // 'selected', 'confirmed', 'cancelled'
  selectedAt: Date,          // Selection timestamp
  confirmedAt: Date,          // Confirmation timestamp
  cancelledAt: Date,         // Cancellation timestamp
  createdAt: Date,           // Record creation
  updatedAt: Date            // Last update
}
```

## Indexes for Performance

```javascript
// Single field indexes
{ cartellaNumber: 1, status: 1 }
{ playerId: 1, status: 1 }
{ gameId: 1 }
{ selectedAt: -1 }
{ status: 1, selectedAt: -1 }

// Compound unique index
{ cartellaNumber: 1, gameId: 1, status: 1 }
```

## API Usage Examples

### Select a Cartella
```bash
POST /api/cartellas/select
{
  "cartellaNumber": 5,
  "playerId": "user_id_here",
  "playerName": "John Doe",
  "stake": 10,
  "gameId": "game_123"
}
```

### Confirm Selection (Deduct Stake)
```bash
POST /api/cartellas/confirm
{
  "cartellaNumber": 5,
  "playerId": "user_id_here"
}
```

### Cancel Selection
```bash
POST /api/cartellas/cancel
{
  "cartellaNumber": 5,
  "playerId": "user_id_here"
}
```

### Get Player Selections
```bash
GET /api/cartellas/player/user_id_here
```

### Get Statistics
```bash
GET /api/cartellas/stats
```

## Migration Steps

### 1. **Backup Current Data** (if any)
```bash
# If you have important in-memory data, export it first
```

### 2. **Run Migration Script**
```bash
cd Bingo-Back
node scripts/migrateCartellaSelections.js
```

### 3. **Test the System**
```bash
# Test cartella selection
curl -X POST http://localhost:3001/api/cartellas/select \
  -H "Content-Type: application/json" \
  -d '{"cartellaNumber": 1, "playerId": "test", "playerName": "Test Player", "stake": 10}'

# Test getting selections
curl http://localhost:3001/api/cartellas/taken

# Test statistics
curl http://localhost:3001/api/cartellas/stats
```

### 4. **Update Frontend** (if needed)
- Frontend should work without changes
- API responses maintain same format
- Additional endpoints available for enhanced features

## Error Handling

The new system provides better error handling:

- **Duplicate Selection**: Returns 409 with details
- **Insufficient Balance**: Returns 400 with balance info
- **Invalid Cartella**: Returns 400 with valid range
- **Database Errors**: Returns 500 with error details

## Performance Considerations

- **Indexes**: Optimized for common queries
- **Pagination**: Built-in for large datasets
- **Caching**: Can be added for frequently accessed data
- **Connection Pooling**: MongoDB handles connections efficiently

## Monitoring

Monitor these metrics:
- Selection success rate
- Average response time
- Database connection count
- Error rates
- Active selections count

## Future Enhancements

1. **Redis Caching**: Cache frequently accessed data
2. **Real-time Updates**: WebSocket for live updates
3. **Advanced Analytics**: Player behavior analysis
4. **Game Integration**: Better game state management
5. **Admin Dashboard**: Enhanced admin interface

## Troubleshooting

### Common Issues:
1. **Database Connection**: Check MongoDB URI
2. **Index Creation**: Ensure proper permissions
3. **Duplicate Selections**: Check unique constraints
4. **Performance**: Monitor query execution times

### Debug Commands:
```bash
# Check database connection
mongosh "mongodb://localhost:27017/love-bingo"

# Check cartella selections
db.cartellaselections.find().sort({selectedAt: -1}).limit(10)

# Check indexes
db.cartellaselections.getIndexes()

# Check statistics
db.cartellaselections.aggregate([
  {$group: {_id: "$status", count: {$sum: 1}}}
])
```

This migration provides a solid foundation for scaling the cartella selection system while maintaining data integrity and providing better admin capabilities.
