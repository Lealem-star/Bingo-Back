# SMS Forwarder Setup Guide

This guide explains how to set up dual SMS verification for the Love Bingo deposit system.

## Overview

The dual SMS verification system requires:
1. **User SMS**: Customer forwards their payment receipt SMS
2. **Receiver SMS**: Agent forwards their received payment SMS  
3. **Matching Algorithm**: System matches both SMS and verifies the deposit

## Setup Steps

### 1. Environment Variables

Add these to your `.env` file:

```env
# SMS Forwarder Configuration
AGENT_PHONE_NUMBERS=+251911234567,+251912345678
SMS_WEBHOOK_SECRET=your_webhook_secret_here
API_BASE_URL=http://localhost:3001
```

### 2. SMS Forwarder Service Options

#### Option A: Twilio SMS Forwarder
```javascript
// Example Twilio webhook handler
const twilio = require('twilio');
const client = twilio(accountSid, authToken);

// Webhook endpoint: /sms-webhook/webhook
app.post('/sms-webhook/webhook', (req, res) => {
    const { From, To, Body, MessageSid } = req.body;
    
    // Forward to your API
    fetch(`${API_BASE_URL}/sms-webhook/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: From,
            to: To,
            body: Body,
            messageId: MessageSid,
            timestamp: new Date().toISOString()
        })
    });
});
```

#### Option B: AWS SNS SMS Forwarder
```javascript
// Example AWS SNS webhook handler
const AWS = require('aws-sdk');
const sns = new AWS.SNS();

// Webhook endpoint: /sms-webhook/webhook
app.post('/sms-webhook/webhook', (req, res) => {
    const { Message, MessageAttributes } = req.body;
    
    // Forward to your API
    fetch(`${API_BASE_URL}/sms-webhook/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: MessageAttributes.phoneNumber?.Value,
            to: MessageAttributes.destinationNumber?.Value,
            body: Message,
            messageId: MessageAttributes.messageId?.Value,
            timestamp: new Date().toISOString()
        })
    });
});
```

#### Option C: Custom SMS Gateway
```javascript
// Example custom SMS gateway integration
app.post('/sms-webhook/webhook', (req, res) => {
    const { sender, recipient, content, timestamp } = req.body;
    
    // Forward to your API
    fetch(`${API_BASE_URL}/sms-webhook/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: sender,
            to: recipient,
            body: content,
            timestamp: timestamp
        })
    });
});
```

### 3. Agent Phone Number Configuration

Configure which phone numbers are your agent numbers:

```env
# In your .env file
AGENT_PHONE_NUMBERS=+251911234567,+251912345678,+251913456789
```

### 4. Database Models

The system uses these new models:

- **SMSRecord**: Stores incoming SMS messages
- **DepositVerification**: Tracks verification status
- **Transaction**: Updated to include verification data

### 5. API Endpoints

#### SMS Forwarder Endpoints:
- `POST /sms-forwarder/incoming` - Receive SMS from forwarder
- `POST /sms-forwarder/user-sms` - User forwards their SMS
- `GET /sms-forwarder/verifications` - Get pending verifications
- `POST /sms-forwarder/approve/:id` - Approve verification
- `POST /sms-forwarder/reject/:id` - Reject verification

#### SMS Webhook Endpoints:
- `POST /sms-webhook/webhook` - Receive SMS from external service

### 6. Admin Interface

The admin interface includes:
- **Deposit Verifications Tab**: View and manage pending verifications
- **Match Analysis**: See confidence scores and match criteria
- **Approval/Rejection**: Approve or reject deposits with reasons

### 7. Matching Algorithm

The system matches SMS based on:

1. **Amount Match**: Exact amount match required
2. **Reference Match**: Transaction ID/reference match (if available)
3. **Time Match**: Within 5 minutes of each other
4. **Payment Method Match**: Same payment provider

**Confidence Score**: Percentage based on matching criteria
- 80%+ = High confidence (auto-approve)
- 60-79% = Medium confidence (manual review)
- <60% = Low confidence (manual review)

### 8. Testing the System

#### Test User Flow:
1. User initiates deposit via Telegram bot
2. User makes payment to agent
3. User forwards their SMS receipt to bot
4. Agent forwards their SMS receipt to system
5. System matches both SMS automatically
6. Admin reviews and approves/rejects

#### Test API Calls:
```bash
# Test user SMS
curl -X POST http://localhost:3001/sms-forwarder/user-sms \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_id_here",
    "message": "ETB 100.00 received from 0911234567 on 01/01/2024 at 10:30:00",
    "phoneNumber": "+251911234567"
  }'

# Test receiver SMS
curl -X POST http://localhost:3001/sms-webhook/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "from": "+251911234567",
    "to": "+251912345678",
    "body": "ETB 100.00 received from 0911234567 on 01/01/2024 at 10:30:00",
    "timestamp": "2024-01-01T10:30:00Z"
  }'
```

### 9. Security Considerations

1. **Webhook Security**: Use webhook secrets to verify incoming requests
2. **Rate Limiting**: Implement rate limiting on SMS endpoints
3. **Phone Number Validation**: Validate phone number formats
4. **Message Sanitization**: Sanitize SMS content before processing
5. **Admin Authentication**: Secure admin endpoints with proper authentication

### 10. Monitoring and Logging

Monitor these metrics:
- SMS processing rate
- Match success rate
- Verification approval rate
- Processing time
- Error rates

### 11. Troubleshooting

#### Common Issues:
1. **SMS not matching**: Check amount, time, and phone number formats
2. **Webhook not receiving**: Verify webhook URL and authentication
3. **Parsing errors**: Check SMS content format and regex patterns
4. **Database errors**: Ensure MongoDB connection and model schemas

#### Debug Commands:
```bash
# Check SMS records
db.smsrecords.find().sort({timestamp: -1}).limit(10)

# Check verifications
db.depositverifications.find().sort({createdAt: -1}).limit(10)

# Check match rates
db.depositverifications.aggregate([
  {$group: {_id: "$status", count: {$sum: 1}}}
])
```

This dual SMS verification system provides much better security and fraud prevention compared to single SMS verification.
