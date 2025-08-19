const express = require('express');
const router = express.Router();

// Trip management routes

// GET /api/trips/active - Get current active trip
router.get('/active', (req, res) => {
  try {
    // TODO: Fetch active trip from database
    const activeTrip = {
      id: 'trip_001',
      requestId: 'req_001',
      status: 'in_progress', // waiting_for_pickup, in_progress, completed
      passenger: {
        id: 'pass_123',
        name: 'Jane Smith',
        phone: '+1234567890',
        rating: 4.9
      },
      pickup: {
        lat: 40.7128,
        lng: -74.0060,
        address: '123 Main St, New York, NY 10001',
        arrivedAt: '2025-07-20T10:30:00Z'
      },
      dropoff: {
        lat: 40.7589,
        lng: -73.9851,
        address: '456 Broadway, New York, NY 10013'
      },
      fare: {
        baseFare: 15.00,
        distance: 3.2,
        duration: 12,
        total: 18.50
      },
      startedAt: '2025-07-20T10:35:00Z',
      estimatedArrival: '2025-07-20T10:47:00Z'
    };

    res.json(activeTrip);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch active trip' });
  }
});

// POST /api/trips/:id/start - Start a trip (passenger picked up)
router.post('/:id/start', (req, res) => {
  try {
    const { id } = req.params;
    const { odometerReading, passengerConfirmed } = req.body;
    
    if (!passengerConfirmed) {
      return res.status(400).json({
        error: 'Passenger confirmation required to start trip'
      });
    }

    // TODO: Update trip status in database
    res.json({
      message: 'Trip started successfully',
      tripId: id,
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      odometerReading: odometerReading || null,
      nextAction: 'navigate_to_dropoff'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start trip' });
  }
});

// POST /api/trips/:id/complete - Complete a trip
router.post('/:id/complete', (req, res) => {
  try {
    const { id } = req.params;
    const { 
      finalOdometerReading, 
      actualDistance, 
      waitTime = 0,
      tolls = 0,
      notes 
    } = req.body;
    
    // TODO: Calculate final fare, update database
    const finalFare = {
      baseFare: 15.00,
      distanceFare: actualDistance * 2.50,
      timeFare: 12 * 0.45,
      waitTime: waitTime * 0.30,
      tolls: tolls,
      subtotal: 18.50,
      tip: 0,
      total: 18.50
    };

    res.json({
      message: 'Trip completed successfully',
      tripId: id,
      status: 'completed',
      completedAt: new Date().toISOString(),
      fareBreakdown: finalFare,
      distance: actualDistance || 3.2,
      duration: 12, // minutes
      earnings: finalFare.total * 0.8, // 80% to driver
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
router.post('/:id/arrived', (req, res) => {
  try {
    const { id } = req.params;
    const { lat, lng } = req.body;
    
    // TODO: Verify location proximity, update trip status
    res.json({
      message: 'Arrival confirmed',
      tripId: id,
      status: 'waiting_for_pickup',
      arrivedAt: new Date().toISOString(),
      location: { lat, lng },
      waitTimeStarted: true
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
