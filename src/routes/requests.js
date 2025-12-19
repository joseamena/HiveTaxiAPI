const express = require('express');
const router = express.Router();
const redisClient = require('../db/redis');
const rideRequestsDb = require('../db/rideRequests');
const notificationService = require('../services/notificationService');
const usersDb = require('../db/users');
const { findFreshNearbyDrivers } = require('../utils/driverGeo');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

// JWT authentication middleware
function authenticateJWT(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or invalid' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Ride request routes for drivers

// GET /api/requests - Get available ride requests
router.get('/', (req, res) => {
  try {
    const { lat, lng, radius = 5 } = req.query;
    
    // TODO: Fetch nearby requests from database based on driver location
    const mockRequests = [
      {
        id: 'req_001',
        passengerId: 'pass_123',
        passengerName: 'Jane Smith',
        passengerRating: 4.9,
        pickup: {
          lat: 40.7128,
          lng: -74.0060,
          address: '123 Main St, New York, NY 10001'
        },
        dropoff: {
          lat: 40.7589,
          lng: -73.9851,
          address: '456 Broadway, New York, NY 10013'
        },
        estimatedDistance: 3.2, // km
        estimatedDuration: 12, // minutes
        estimatedFare: 18.50,
        requestTime: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 minutes ago
        priority: 'normal'
      },
      {
        id: 'req_002',
        passengerId: 'pass_456',
        passengerName: 'Mike Johnson',
        passengerRating: 4.7,
        pickup: {
          lat: 40.7306,
          lng: -73.9866,
          address: '789 Park Ave, New York, NY 10021'
        },
        dropoff: {
          lat: 40.6892,
          lng: -74.0445,
          address: 'JFK Airport, Queens, NY 11430'
        },
        estimatedDistance: 25.8, // km
        estimatedDuration: 35, // minutes
        estimatedFare: 65.00,
        requestTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
        priority: 'high'
      }
    ];

    res.json({
      requests: mockRequests,
      total: mockRequests.length,
      radius: Number(radius),
      driverLocation: lat && lng ? { lat: Number(lat), lng: Number(lng) } : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// GET /api/requests/:id - Get specific request details
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    // TODO: Fetch from database
    if (id === 'req_001') {
      res.json({
        id: 'req_001',
        passengerId: 'pass_123',
        passengerName: 'Jane Smith',
        passengerPhone: '+1234567890',
        passengerRating: 4.9,
        pickup: {
          lat: 40.7128,
          lng: -74.0060,
          address: '123 Main St, New York, NY 10001',
          instructions: 'Blue building, wait by the main entrance'
        },
        dropoff: {
          lat: 40.7589,
          lng: -73.9851,
          address: '456 Broadway, New York, NY 10013'
        },
        estimatedDistance: 3.2,
        estimatedDuration: 12,
        estimatedFare: 18.50,
        requestTime: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        specialRequests: ['Pet friendly'],
        paymentMethod: 'credit_card'
      });
    } else {
      res.status(404).json({ error: 'Request not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch request details' });
  }
});

// POST /api/requests/:id/accept - Accept a ride request
router.post('/:id/accept', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { estimatedArrival } = req.body;
    const driverId = req.user.id || req.user.userId || req.user.driverId;
    if (!driverId) {
      return res.status(400).json({ error: 'Driver ID not found in token' });
    }
    // Handle driver response through notification service
    const accepted = await notificationService.handleDriverResponse(id, String(driverId), 'accept', estimatedArrival);
    if (!accepted) {
      return res.status(400).json({ error: 'Unable to accept request - you may not be the current driver or request may be expired' });
    }

    const rideRequest = await rideRequestsDb.getRideRequestById(id);
    if (!rideRequest) {
      return res.status(404).json({ error: 'Ride request not found' });
    }
    // Update status in database and Redis
    await rideRequestsDb.updateRideRequestStatus(id, 'accepted');
    await redisClient.sendCommand(['SET', `ride:request:${id}:status`, 'accepted']);

    notificationService.sendRideAcceptedToRider(rideRequest.passenger_id, id, driverId, estimatedArrival);

    console.log('Ride request found:', rideRequest);
    // Construct Trip object with camelCase keys
    const trip = {
      passengerPhone: rideRequest.passenger_phone,
      passengerId: rideRequest.passenger_id,
      passengerName: rideRequest.passenger_name,
      pickup: {
        address: rideRequest.pickup_address,
        latitude: rideRequest.pickup_lat,
        longitude: rideRequest.pickup_lng,
        name: rideRequest.pickup_name || ''
      },
      destination: {
        address: rideRequest.dropoff_address,
        latitude: rideRequest.dropoff_lat,
        longitude: rideRequest.dropoff_lng,
        name: rideRequest.dropoff_name || ''
      },
      distance: rideRequest.estimated_distance,
      duration: rideRequest.estimated_duration,
      finalFare: rideRequest.proposed_fare,
      priority: rideRequest.priority,
      requestTime: rideRequest.request_time,
      status: 'accepted',
      id: rideRequest.id
    };
    res.json(trip);
  } catch (error) {
    console.error('Accept request error:', error);
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

// POST /api/requests/:id/decline - Decline a ride request
router.post('/:id/decline', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, driverId } = req.body;
    
    if (!driverId) {
      return res.status(400).json({ error: 'Driver ID is required' });
    }
    
    // Handle driver response through notification service
    const declined = await notificationService.handleDriverResponse(id, driverId, 'decline');
    
    if (!declined) {
      return res.status(400).json({ error: 'Unable to decline request - you may not be the current driver or request may be expired' });
    }
    
    res.json({
      message: 'Ride request declined',
      requestId: id,
      reason: reason || 'Not specified'
    });
  } catch (error) {
    console.error('Decline request error:', error);
    res.status(500).json({ error: 'Failed to decline request' });
  }
});

// GET /api/requests/:id/status - Get request status
router.get('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const status = await notificationService.getRequestStatus(id);
    res.json(status);
  } catch (error) {
    console.error('Get request status error:', error);
    res.status(500).json({ error: 'Failed to get request status' });
  }
});

// GET /api/requests/history - Get driver's request history
router.get('/history', (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    
    // TODO: Fetch from database with pagination
    const mockHistory = [
      {
        id: 'req_100',
        status: 'completed',
        passengerName: 'Alice Brown',
        pickup: '123 Oak St, New York, NY',
        dropoff: '456 Pine Ave, New York, NY',
        fare: 24.50,
        acceptedAt: '2025-07-20T08:30:00Z',
        completedAt: '2025-07-20T09:15:00Z'
      },
      {
        id: 'req_099',
        status: 'cancelled',
        passengerName: 'Bob Wilson',
        pickup: '789 Elm St, New York, NY',
        reason: 'Passenger cancelled',
        acceptedAt: '2025-07-19T14:20:00Z',
        cancelledAt: '2025-07-19T14:25:00Z'
      }
    ];

    res.json({
      requests: mockHistory,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: 156,
        pages: 8
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch request history' });
  }
});

// POST /api/requests - Rider creates a new ride request
router.post('/', authenticateJWT, async (req, res) => {
  console.log("requests", req.body);
  try {
    const {
      passengerId,
      passengerName,
      passengerPhone,
      pickup,
      dropoff,
      estimatedDistance,
      estimatedDuration,
      proposedFare,
      priority
    } = req.body;

    console.log("authenticated user:", req.user);
    // Validate input (basic)
    if (!pickup || !pickup.lat || !pickup.lng) {
      return res.status(400).json({ error: 'Pickup location required' });
    }

    // Save to database
    const newRequest = await rideRequestsDb.createRideRequest({
      passengerId,
      passengerName,
      passengerPhone,
      pickup,
      dropoff,
      estimatedDistance,
      estimatedDuration,
      proposedFare,
      priority
    });

    // Initialize request status in Redis so the frontend and other services
    // can immediately poll for the ride request's status. This allows the app
    // to show "pending" state right after creation, even while driver matching
    // and queue creation are still running in the background.
    await redisClient.sendCommand(['SET', `ride:request:${newRequest.id}:status`, 'pending']);
    await redisClient.sendCommand(['EXPIRE', `ride:request:${newRequest.id}:status`, '600']);

    // Start driver finding and queue creation in the background
    setImmediate(() => {
      findDriversAndCreateQueueForRequest(newRequest, {
        pickup,
        dropoff,
        proposedFare,
        estimatedDistance,
        estimatedDuration,
        passengerName,
        passengerPhone,
        passengerId,
        priority
      });
    });

    // Respond immediately with the created ride request
    res.status(201).json({ rideRequest: newRequest });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create ride request', details: error.message });
  }
});

// Background function to find drivers and create queue for a ride request
async function findDriversAndCreateQueueForRequest(rideRequest, meta) {
  try {
    console.log('[findDriversAndCreateQueueForRequest] Looking for drivers near:', {
      lat: meta.pickup.lat,
      lng: meta.pickup.lng,
      radius: 5,
      count: 10
    });
    findFreshNearbyDrivers({
      lat: meta.pickup.lat,
      lng: meta.pickup.lng,
      radius: 5, // km, can be parameterized
      count: 10
    }).then(async (freshDrivers) => {
      console.log('[findDriversAndCreateQueueForRequest] freshDrivers result:', freshDrivers);
      if (freshDrivers.length > 0) {
        const queueLength = await notificationService.createDriverQueue(rideRequest.id, freshDrivers);
        console.log(`Created driver queue with ${queueLength} drivers for request ${rideRequest.id}`);
        await notificationService.processDriverQueue(rideRequest.id, meta);
      } else {
        // No drivers found, notify the rider
        console.log(`[findDriversAndCreateQueueForRequest] No available drivers found for request ${rideRequest.id}`);
        await notificationService.sendNoDriverFoundToRider(meta.passengerId, rideRequest.id);
      }
    }).catch((err) => {
      console.error('[findDriversAndCreateQueueForRequest] Error in findFreshNearbyDrivers:', err);
    });
  } catch (err) {
    console.error('Error in findDriversAndCreateQueueForRequest:', err);
  }
}

// NOTE: The arrival endpoint has moved to trips.js (POST /api/trips/:id/arrived)

module.exports = router;
