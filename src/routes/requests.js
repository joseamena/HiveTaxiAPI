const express = require('express');
const router = express.Router();

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
router.post('/:id/accept', (req, res) => {
  try {
    const { id } = req.params;
    const { estimatedArrival } = req.body;
    
    // TODO: Update request status in database, notify passenger
    res.json({
      message: 'Ride request accepted',
      requestId: id,
      status: 'accepted',
      estimatedArrival: estimatedArrival || 5, // minutes
      nextAction: 'navigate_to_pickup',
      passenger: {
        name: 'Jane Smith',
        phone: '+1234567890'
      },
      pickup: {
        lat: 40.7128,
        lng: -74.0060,
        address: '123 Main St, New York, NY 10001'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

// POST /api/requests/:id/decline - Decline a ride request
router.post('/:id/decline', (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    // TODO: Update request status, log decline reason
    res.json({
      message: 'Ride request declined',
      requestId: id,
      reason: reason || 'Not specified'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to decline request' });
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

module.exports = router;
