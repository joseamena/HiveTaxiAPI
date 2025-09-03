# Production-Ready Driver Notification System

## Architecture Overview

The system implements a Redis-based queue for processing driver notifications with the following components:

### 1. NotificationService (`src/services/notificationService.js`)
- **Queue Management**: Creates and manages driver queues in Redis for each ride request
- **FCM Integration**: Sends push notifications to drivers (when Firebase is configured)
- **Timeout Handling**: Automatically moves to the next driver after 60 seconds
- **Response Tracking**: Logs all driver responses for analytics
- **Status Management**: Tracks request status in Redis with proper cleanup

### 2. Updated Routes (`src/routes/requests.js`)
- **POST /api/requests**: Creates ride request and starts driver notification queue
- **POST /api/requests/:id/accept**: Handles driver acceptance with validation
- **POST /api/requests/:id/decline**: Handles driver decline and moves to next driver
- **GET /api/requests/:id/status**: Returns current request status

### 3. Enhanced Database (`src/db/users.js`)
- Added `getUserById()` function for driver lookups
- Support for FCM token storage and retrieval

## Key Features

### Queue Processing
1. **Driver Queue**: Redis list containing driver IDs ordered by distance
2. **Sequential Notification**: Only one driver is notified at a time
3. **Automatic Timeout**: 60-second timeout per driver
4. **Status Tracking**: Real-time status updates in Redis
5. **Cleanup**: Automatic cleanup of Redis keys when request is resolved

### Redis Keys Used
- `ride:request:{id}:queue` - Driver queue (list)
- `ride:request:{id}:status` - Request status (string)
- `ride:request:{id}:current_driver` - Current driver being notified (string)
- `ride:request:{id}:driver` - Accepted driver ID (string)
- `ride:request:{id}:eta` - Estimated arrival time (string)
- `ride:request:{id}:responses` - Response log (list)

### Error Handling
- Network failures automatically move to next driver
- Invalid driver IDs are skipped
- Missing FCM tokens are logged but don't stop processing
- Request expiration prevents stale notifications

## Setup Requirements

### 1. Firebase Configuration
```javascript
// Uncomment and configure in notificationService.js
const serviceAccount = require('../config/firebase-service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
```

### 2. Database Schema
Ensure your users table has the `fcm_token` column:
```sql
ALTER TABLE users ADD COLUMN fcm_token TEXT;
```

### 3. Redis Commands
The system uses Redis for queue management. Ensure Redis is running and accessible.

## Usage Examples

### Create Ride Request
```bash
curl -X POST http://localhost:3000/api/requests \
  -H "Content-Type: application/json" \
  -d '{
    "passengerId": "rider123",
    "passengerName": "John Doe",
    "pickup": {"lat": 40.7128, "lng": -74.0060, "address": "NYC"},
    "dropoff": {"lat": 40.7589, "lng": -73.9851, "address": "Times Square"},
    "estimatedFare": 25.50
  }'
```

### Accept Request (Driver)
```bash
curl -X POST http://localhost:3000/api/requests/123/accept \
  -H "Content-Type: application/json" \
  -d '{
    "driverId": "driver456",
    "estimatedArrival": 5
  }'
```

### Check Status
```bash
curl http://localhost:3000/api/requests/123/status
```

## Monitoring and Analytics

The system logs all driver interactions for analytics:
- Response times
- Accept/decline rates per driver
- Queue processing metrics
- Timeout frequencies

## Scalability

The system is designed for production scale:
- **Horizontal Scaling**: Multiple API instances can process queues
- **Redis Clustering**: Support for Redis cluster deployments
- **Background Processing**: Non-blocking queue processing
- **Timeout Management**: Prevents hung requests
- **Memory Efficiency**: Automatic cleanup of expired data

## Next Steps

1. **Configure Firebase**: Add your Firebase service account key
2. **Testing**: Test with real FCM tokens and mobile devices
3. **Monitoring**: Add metrics collection for queue performance
4. **Database Integration**: Update ride request status in PostgreSQL
5. **Passenger Notifications**: Notify passengers when driver accepts
