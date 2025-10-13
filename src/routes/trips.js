const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const authenticateJWT = require('../middleware/auth');

const rideRequestsDb = require('../db/rideRequests');

// Trip management routes

// GET /api/trips/active - Get current active trip for authenticated driver
router.get('/active', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.id || req.user.userId || req.user.driverId;
    if (!driverId) {
      return res.status(400).json({ error: 'Driver ID not found in token' });
    }
    // Find active ride request for this driver
    const activeRequest = await rideRequestsDb.getActiveRideRequestForDriver(driverId);
    if (!activeRequest) {
      return res.json({ active: false, trip: null });
    }
    // Construct Trip object
    const trip = {
      requestId: activeRequest.id,
      status: activeRequest.status,
      passenger: {
        id: activeRequest.passenger_id,
        name: activeRequest.passenger_name,
        phone: activeRequest.passenger_phone || ''
      },
      pickup: {
        latitude: activeRequest.pickup_lat,
        longitude: activeRequest.pickup_lng,
        address: activeRequest.pickup_address
      },
      dropoff: {
        latitude: activeRequest.dropoff_lat,
        longitude: activeRequest.dropoff_lng,
        address: activeRequest.dropoff_address
      },
      finalFare: activeRequest.final_fare || activeRequest.proposed_fare || null
    };
    res.json({ active: true, trip });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch active trip' });
  }
});

// POST /api/trips/:id/start - Start a trip (passenger picked up)
router.post('/:id/start', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const driverId = req.user.id || req.user.userId || req.user.driverId;
    
    // Update trip status in database
    await rideRequestsDb.updateRideRequestStatus(id, 'in_transit');
    
    res.json({
      tripId: id,
      status: 'in_transit',
      timestamp: new Date().toISOString(),
      driverId,
      nextAction: 'navigate_to_dropoff'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start trip' });
  }
});

// POST /api/trips/:id/complete - Complete a trip
router.post('/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      finalOdometerReading, 
      actualDistance, 
      waitTime = 0,
      tolls = 0,
      notes 
    } = req.body;
    // Update trip status in database
    await rideRequestsDb.updateRideRequestStatus(id, 'completed');
    // Get ride request from DB to obtain proposedFare
    const rideRequest = await rideRequestsDb.getRideRequestById(id);
    const finalFare = rideRequest ? rideRequest.proposed_fare : null;
    res.json({
      message: 'Trip completed successfully',
      tripId: id,
      status: 'completed',
      completedAt: new Date().toISOString(),
      finalFare,
      distance: actualDistance || 3.2,
      duration: 12, // minutes
      earnings: finalFare ? finalFare * 0.8 : null, // 80% to driver
      notes: notes || null
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to complete trip' });
  }
});

// POST /api/trips/:id/cancel - Cancel a trip
router.post('/:id/cancel', (req, res) => {
  try {
    const { id } = req.params;
    const { reason, cancelledBy = 'driver' } = req.body;
    
    if (!reason) {
      return res.status(400).json({
        error: 'Cancellation reason is required'
      });
    }

    // TODO: Update trip status, handle cancellation fee logic
    let cancellationFee = 0;
    if (cancelledBy === 'passenger' && reason === 'no_show') {
      cancellationFee = 5.00;
    }

    res.json({
      message: 'Trip cancelled',
      tripId: id,
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelledBy,
      reason,
      cancellationFee,
      earnings: cancellationFee * 0.8 // Driver gets 80% of cancellation fee
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to cancel trip' });
  }
});

// GET /api/trips/history - Get trip history
router.get('/history', (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      status, 
      startDate, 
      endDate 
    } = req.query;
    
    // TODO: Fetch from database with filters and pagination
    const mockTrips = [
      {
        id: 'trip_100',
        requestId: 'req_100',
        status: 'completed',
        passenger: {
          name: 'Alice Brown',
          rating: 4.8
        },
        pickup: {
          address: '123 Oak St, New York, NY',
          timestamp: '2025-07-20T08:30:00Z'
        },
        dropoff: {
          address: '456 Pine Ave, New York, NY',
          timestamp: '2025-07-20T09:15:00Z'
        },
        distance: 5.2,
        duration: 45,
        fare: 24.50,
        earnings: 19.60,
        rating: 5
      },
      {
        id: 'trip_099',
        requestId: 'req_099',
        status: 'cancelled',
        passenger: {
          name: 'Bob Wilson',
          rating: 4.2
        },
        pickup: {
          address: '789 Elm St, New York, NY',
          timestamp: '2025-07-19T14:20:00Z'
        },
        cancelledAt: '2025-07-19T14:25:00Z',
        reason: 'Passenger no-show',
        cancellationFee: 5.00,
        earnings: 4.00
      }
    ];

    res.json({
      trips: mockTrips,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: 156,
        pages: 8
      },
      summary: {
        totalTrips: 156,
        completedTrips: 151,
        cancelledTrips: 5,
        totalEarnings: 3240.75,
        averageRating: 4.8
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch trip history' });
  }
});

// GET /api/trips/:id - Get specific trip details
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    // TODO: Fetch from database
    if (id === 'trip_100') {
      res.json({
        id: 'trip_100',
        requestId: 'req_100',
        status: 'completed',
        passenger: {
          id: 'pass_456',
          name: 'Alice Brown',
          phone: '+1987654321',
          rating: 4.8
        },
        pickup: {
          lat: 40.7128,
          lng: -74.0060,
          address: '123 Oak St, New York, NY 10001',
          timestamp: '2025-07-20T08:30:00Z'
        },
        dropoff: {
          lat: 40.7589,
          lng: -73.9851,
          address: '456 Pine Ave, New York, NY 10013',
          timestamp: '2025-07-20T09:15:00Z'
        },
        route: {
          distance: 5.2, // km
          duration: 45, // minutes
          waypoints: [
            { lat: 40.7128, lng: -74.0060 },
            { lat: 40.7589, lng: -73.9851 }
          ]
        },
        fareBreakdown: {
          baseFare: 15.00,
          distanceFare: 6.50,
          timeFare: 3.00,
          subtotal: 24.50,
          tip: 0,
          total: 24.50
        },
        earnings: 19.60,
        rating: {
          score: 5,
          comment: 'Great driver, very professional!'
        },
        paymentMethod: 'credit_card'
      });
    } else {
      res.status(404).json({ error: 'Trip not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch trip details' });
  }
});

// POST /api/trips/:id/arrived - Mark arrival at pickup location
router.post('/:id/arrived', authenticateJWT,(req, res) => {
  try {
    const { id } = req.params;
    const { lat, lng } = req.body;
    

    // TODO: Verify location proximity, update trip status
    res.json({
      status: 'arrived_at_pickup',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to confirm arrival' });
  }
});

// POST /api/trips/:id/rate - Rate passenger after trip completion
router.post('/:id/rate', (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;
    
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        error: 'Rating must be between 1 and 5'
      });
    }

    // TODO: Save rating in database
    res.json({
      message: 'Passenger rated successfully',
      tripId: id,
      rating: {
        score: rating,
        comment: comment || null
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to rate passenger' });
  }
});

module.exports = router;
