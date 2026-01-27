const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const authenticateJWT = require('../middleware/auth');

const rideRequestsDb = require('../db/rideRequests');
const redisClient = require('../db/redis');
const notificationService = require('../services/notificationService');

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
    
    // Update trip status in database and Redis
    await rideRequestsDb.updateRideRequestStatus(id, 'in_transit');
    await redisClient.sendCommand(['SET', `ride:request:${id}:status`, 'in_transit']);

    // Fetch ride request to get passengerId and notify rider
    const rideRequest = await rideRequestsDb.getRideRequestById(id);
    console.log('[trips.start] Ride request for trip start notification:', rideRequest);
    if (rideRequest && rideRequest.passenger_id) {
      // Notify rider that trip has started
      console.log('[trips.start] Notifying rider that trip has started for request:', id);
      await notificationService.sendRiderNotification(
        rideRequest.passenger_id,
        'Trip started',
        'Your driver has picked you up and the trip is now in progress.',
        { requestId: id, type: 'trip_started' }
      );
    }
    
    res.json({
      tripId: id,
      status: 'in_transit',
      timestamp: new Date().toISOString(),
      driverId,
      nextAction: 'navigate_to_dropoff'
    });
  } catch (error) {
    console.error('[trips.start] Error:', error);
    res.status(500).json({ error: 'Failed to start trip' });
  }
});

// POST /api/trips/:id/complete - Complete a trip
router.post('/:id/complete', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const driverId = req.user.id || req.user.userId || req.user.driverId;
    const { 
      finalOdometerReading, 
      actualDistance, 
      waitTime = 0,
      tolls = 0,
      notes 
    } = req.body;
    
    // Update trip status in database and Redis
    await rideRequestsDb.updateRideRequestStatus(id, 'completed');
    await redisClient.sendCommand(['SET', `ride:request:${id}:status`, 'completed']);
    
    // Get ride request from DB to obtain proposedFare and passenger info
    const rideRequest = await rideRequestsDb.getRideRequestById(id);
    const finalFare = rideRequest ? rideRequest.proposed_fare : null;
    
    // Notify rider that trip has been completed
    if (rideRequest && rideRequest.passenger_id) {
      console.log('[trips.complete] Notifying rider that trip has been completed for request:', id);
      await notificationService.sendRiderNotification(
        rideRequest.passenger_id,
        'Trip completed',
        `Your trip has been completed. Total fare: $${finalFare ? finalFare.toFixed(2) : 'N/A'}. Please rate your driver.`,
        { 
          requestId: id, 
          type: 'trip_completed',
          finalFare,
          completedAt: new Date().toISOString()
        }
      );
    }
    
    res.json({
      message: 'Trip completed successfully',
      tripId: id,
      status: 'completed',
      completedAt: new Date().toISOString(),
      finalFare,
      distance: actualDistance || null,
      duration: 12, // minutes
      earnings: finalFare || null,
      notes: notes || null,
      driverId
    });
  } catch (error) {
    console.error('[trips.complete] Error:', error);
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

// POST /api/trips/:id/arrived - Mark driver arrival at pickup (migrated from requests.js)
router.post('/:id/arrived', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const driverId = req.user.id || req.user.userId || req.user.driverId;
    // Optionally: const { lat, lng } = req.body; // could be used to verify proximity

    // Update status in DB and Redis
    await rideRequestsDb.updateRideRequestStatus(id, 'arrived_at_pickup');
    await redisClient.sendCommand(['SET', `ride:request:${id}:status`, 'arrived_at_pickup']);

    // Fetch ride request to get passengerId
    const rideRequest = await rideRequestsDb.getRideRequestById(id);
    console.log('[trips.arrived] Ride request for arrival notification:', rideRequest);
    if (rideRequest && rideRequest.passenger_id) {
      // Notify rider that driver has arrived
      console.log('[trips.arrived] Notifying rider of driver arrival for request:', id);
      await notificationService.sendRiderNotification(
        rideRequest.passenger_id,
        'Your driver has arrived',
        'Please meet your driver at the pickup location.',
        { requestId: id, type: 'driver_arrived' }
      );
    }

    res.json({
      message: 'Arrival marked successfully',
      requestId: id,
      status: 'arrived_at_pickup',
      arrivedAt: new Date().toISOString(),
      driverId
    });
  } catch (error) {
    console.error('[trips.arrived] Error:', error);
    res.status(500).json({ error: 'Failed to mark arrival' });
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

// Allowed currency codes for payment requests
const ALLOWED_CURRENCIES = ['HBD', 'HIVE'];

/**
 * @swagger
 * /api/trips/{id}/payment-request:
 *   post:
 *     summary: Send payment request to rider via FCM
 *     description: Allows a driver to send a payment request notification to the rider associated with the trip. The rider will receive an FCM push notification with the payment details.
 *     tags: [Trips]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The trip/ride request ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - hiveAccount
 *               - amount
 *               - currencyCode
 *               - invoice
 *             properties:
 *               hiveAccount:
 *                 type: string
 *                 description: Hive account to receive payment
 *                 example: "someaccount"
 *               amount:
 *                 type: string
 *                 description: Payment amount as a positive numeric string
 *                 example: "2.04"
 *               currencyCode:
 *                 type: string
 *                 enum: [HBD, HIVE]
 *                 description: Currency code for the payment
 *                 example: "HBD"
 *               invoice:
 *                 type: string
 *                 description: Invoice number or identifier
 *                 example: "some-invoice-number"
 *     responses:
 *       200:
 *         description: Payment request sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Payment request sent successfully"
 *                 tripId:
 *                   type: string
 *                 paymentRequest:
 *                   type: object
 *                   properties:
 *                     hiveAccount:
 *                       type: string
 *                     amount:
 *                       type: string
 *                     currencyCode:
 *                       type: string
 *                     invoice:
 *                       type: string
 *                 sentTo:
 *                   type: object
 *                   properties:
 *                     riderId:
 *                       type: integer
 *                     riderName:
 *                       type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Validation error (missing fields, invalid currency, or invalid amount)
 *       403:
 *         description: Driver not authorized for this trip
 *       404:
 *         description: Trip not found
 *       500:
 *         description: Internal server error
 */
router.post('/:id/payment-request', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const driverId = req.user.id || req.user.userId || req.user.driverId;
    
    if (!driverId) {
      return res.status(400).json({ error: 'Driver ID not found in token' });
    }

    const { hiveAccount, amount, currencyCode, invoice } = req.body;

    // Validate required fields
    if (!hiveAccount || !amount || !currencyCode || !invoice) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'All fields are required: hiveAccount, amount, currencyCode, invoice'
      });
    }

    // Validate currency code against allowlist
    if (!ALLOWED_CURRENCIES.includes(currencyCode)) {
      return res.status(400).json({
        error: 'INVALID_CURRENCY',
        message: `Invalid currency code. Allowed currencies: ${ALLOWED_CURRENCIES.join(', ')}`
      });
    }

    // Validate amount is a valid positive numeric string
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0 || !/^\d+(\.\d+)?$/.test(amount)) {
      return res.status(400).json({
        error: 'INVALID_AMOUNT',
        message: 'Amount must be a valid positive numeric string (e.g., "2.04")'
      });
    }

    // Fetch the ride request to verify driver ownership and get rider info
    const rideRequest = await rideRequestsDb.getRideRequestById(id);
    
    if (!rideRequest) {
      return res.status(404).json({
        error: 'TRIP_NOT_FOUND',
        message: 'Trip not found'
      });
    }

    // Verify the authenticated driver owns this trip
    if (rideRequest.driver_id !== driverId) {
      return res.status(403).json({
        error: 'UNAUTHORIZED',
        message: 'You are not authorized to request payment for this trip'
      });
    }

    // Check if rider exists
    if (!rideRequest.passenger_id) {
      return res.status(400).json({
        error: 'NO_RIDER',
        message: 'No rider associated with this trip'
      });
    }

    // Get driver name for notification
    const userDb = require('../db/users');
    const driver = await userDb.getUserById(driverId);
    const driverName = driver?.display_name || driver?.hive_username || 'Your driver';

    // Send payment request notification to rider
    await notificationService.sendPaymentRequestToRider(
      rideRequest.passenger_id,
      { hiveAccount, amount, currencyCode, invoice },
      driverName
    );

    console.log(`[trips.payment-request] Payment request sent for trip ${id} to rider ${rideRequest.passenger_id}`);

    res.json({
      message: 'Payment request sent successfully',
      tripId: id,
      paymentRequest: {
        hiveAccount,
        amount,
        currencyCode,
        invoice
      },
      sentTo: {
        riderId: rideRequest.passenger_id,
        riderName: rideRequest.passenger_name
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('[trips.payment-request] Error:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to send payment request',
      details: error.message
    });
  }
});

module.exports = router;
