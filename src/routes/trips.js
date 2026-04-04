const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const authenticateJWT = require('../middleware/auth');

const rideRequestsDb = require('../db/rideRequests');
const ratingsDb = require('../db/ratings');
const userDb = require('../db/users');
const redisClient = require('../db/redis');
const notificationService = require('../services/notificationService');

// Trip management routes

// GET /api/trips/active - Get current active trip for authenticated driver
router.get('/active', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.id;
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
        id: activeRequest.passenger_id
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
      finalFare: activeRequest.final_fare || activeRequest.proposed_fare || null,
      memo: activeRequest.memo || null
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
    const driverId = req.user.id;
    
    // Update trip status in database and Redis
    await rideRequestsDb.updateRideRequestStatus(id, 'in_transit');
    await redisClient.sendCommand(['SET', `ride:request:${id}:status`, 'in_transit', 'EX', '86400']);

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
    const driverId = req.user.id;
    const { 
      finalOdometerReading, 
      actualDistance, 
      waitTime = 0,
      tolls = 0,
      notes 
    } = req.body;
    
    // Update trip status in database, then persist driver responses and clean up Redis keys
    await rideRequestsDb.updateRideRequestStatus(id, 'completed');
    const rawResponses = await redisClient.lRange(`ride:request:${id}:responses`, 0, -1);
    const parsedResponses = rawResponses.map(r => JSON.parse(r));
    await rideRequestsDb.saveDriverResponses(id, parsedResponses);
    await redisClient.del(`ride:request:${id}:status`, `ride:request:${id}:responses`);
    
    // Get ride request from DB to obtain proposedFare and passenger info
    const rideRequest = await rideRequestsDb.getRideRequestById(id);
    const finalFare = rideRequest && rideRequest.proposed_fare != null ? parseFloat(rideRequest.proposed_fare) : null;
    
    // Get driver's check-in permlink for the review chain
    let driverCheckin = null;
    if (rideRequest && rideRequest.driver_id) {
      driverCheckin = await userDb.getDriverCheckin(rideRequest.driver_id);
    }
    
    // Create pending rating for rider to submit their review
    // The rider will reply to the driver's check-in post on Hive blockchain
    if (rideRequest && rideRequest.passenger_id && driverCheckin && driverCheckin.permlink) {
      try {
        // passenger_id is a numeric FK — resolve to user record for the ratings FK
        const riderUser = await userDb.getUserById(Number(rideRequest.passenger_id));
        if (!riderUser) {
          console.error('[trips.complete] Could not resolve rider ID:', rideRequest.passenger_id);
        } else {
          await ratingsDb.createPendingRating({
            rideRequestId: parseInt(id),
            raterId: riderUser.id,                    // Rider will give the rating (integer ID)
            ratedId: rideRequest.driver_id,            // Driver will be rated
            ratingType: 'rider_to_driver',
            parentPermlink: driverCheckin.permlink     // Rider replies to driver's check-in post
          });
          console.log('[trips.complete] Created pending rating for rider', riderUser.id, 'to review driver', rideRequest.driver_id, 'parentPermlink:', driverCheckin.permlink);
        }
      } catch (ratingError) {
        // Log but don't fail trip completion if rating creation fails
        console.error('[trips.complete] Failed to create pending rating:', ratingError.message);
      }
    }
    
    // Notify rider that trip has been completed with the check-in permlink for their review
    if (rideRequest && rideRequest.passenger_id) {
      console.log('[trips.complete] Notifying rider that trip has been completed for request:', id);
      
      // Get driver info for the notification
      const driver = await userDb.getUserById(rideRequest.driver_id);
      const driverUsername = driver ? driver.hive_username : '';
      
      await notificationService.sendRiderNotification(
        rideRequest.passenger_id,
        'Trip completed - Leave a review!',
        `Your trip has been completed. Total fare: $${finalFare ? finalFare.toFixed(2) : 'N/A'}. Reply to the driver's check-in post on Hive to leave your review.`,
        { 
          requestId: String(id), 
          type: 'trip_completed',
          finalFare: finalFare != null ? String(finalFare) : '',
          completedAt: new Date().toISOString(),
          // Include check-in permlink so rider knows where to reply
          parentPermlink: driverCheckin ? driverCheckin.permlink : '',
          driverUsername: driverUsername
        }
      );
    }
    
    // Driver will be notified later when rider submits their review
    // (Driver reviews are created after rider submits to avoid driver replying to own post)
    
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
      driverId,
      // Include check-in info for client
      reviewParentPermlink: driverCheckin ? driverCheckin.permlink : null
    });
  } catch (error) {
    console.error('[trips.complete] Error:', error);
    res.status(500).json({ error: 'Failed to complete trip' });
  }
});

// POST /api/trips/:id/cancel - Cancel a trip
router.post('/:id/cancel', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // 1. Validate trip exists
    const rideRequest = await rideRequestsDb.getRideRequestById(id);
    if (!rideRequest) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    // 2. Validate trip is in a cancellable state
    const CANCELLABLE_STATUSES = ['pending', 'accepted', 'arrived_at_pickup', 'in_transit'];
    if (!CANCELLABLE_STATUSES.includes(rideRequest.status)) {
      return res.status(400).json({
        error: `Trip cannot be cancelled — current status is "${rideRequest.status}"`,
        status: rideRequest.status
      });
    }

    // 3. Determine who is cancelling
    const userId = req.user.id;
    const cancelledBy = rideRequest.driver_id && rideRequest.driver_id === userId
      ? 'driver'
      : 'passenger';

    // 4. If passenger is cancelling, verify they own this trip
    if (cancelledBy === 'passenger' && rideRequest.passenger_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: you are not a participant on this trip' });
    }

    console.log('[trips.cancel] Cancel request received:', {
      tripId: id,
      userId,
      cancelledBy,
      reason
    });

    // 5. Update trip status in database, then persist driver responses and clean up Redis keys
    await rideRequestsDb.updateRideRequestStatus(id, 'cancelled');
    const rawResponses = await redisClient.lRange(`ride:request:${id}:responses`, 0, -1);
    const parsedResponses = rawResponses.map(r => JSON.parse(r));
    await rideRequestsDb.saveDriverResponses(id, parsedResponses);
    await redisClient.del(`ride:request:${id}:status`, `ride:request:${id}:responses`);

    // 6. Send FCM notification to the other party
    if (cancelledBy === 'passenger') {
      // Rider cancelled — notify the driver
      if (rideRequest.driver_id) {
        console.log('[trips.cancel] Notifying driver of cancellation by passenger for request:', id);
        const message = reason
          ? `Your passenger has cancelled the trip. Reason: ${reason}`
          : 'Your passenger has cancelled the trip.';
        await notificationService.sendRiderNotification(
          rideRequest.driver_id,
          'Trip Cancelled',
          message,
          { requestId: id, type: 'trip_cancelled', cancelledBy: 'passenger', reason: reason || 'No reason provided' }
        );
      } else {
        console.log('[trips.cancel] Passenger cancelled but no driver assigned yet for request:', id);
      }
    } else {
      // Driver cancelled — notify the passenger
      if (rideRequest.passenger_id) {
        console.log('[trips.cancel] Notifying rider of cancellation by driver for request:', id);
        const message = reason
          ? `Your driver has cancelled the trip. Reason: ${reason}`
          : 'Your driver has cancelled the trip. Please request a new ride.';
        await notificationService.sendRiderNotification(
          rideRequest.passenger_id,
          'Trip Cancelled',
          message,
          { requestId: id, type: 'trip_cancelled_by_driver', tripId: id, cancelledBy: 'driver', reason: reason || 'No reason provided' }
        );
      }
    }

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
      earnings: cancellationFee * 0.8
    });
  } catch (error) {
    console.error('[trips.cancel] Error:', error);
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
    const driverId = req.user.id;
    // Optionally: const { lat, lng } = req.body; // could be used to verify proximity

    // Update status in DB and Redis
    await rideRequestsDb.updateRideRequestStatus(id, 'arrived_at_pickup');
    await redisClient.sendCommand(['SET', `ride:request:${id}:status`, 'arrived_at_pickup', 'EX', '86400']);

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

/**
 * @swagger
 * /api/trips/{id}/rate:
 *   post:
 *     summary: Submit a rating for a completed trip
 *     description: Allows a rider to rate their driver or a driver to rate their rider after trip completion. Ratings are bidirectional and each party can only rate once per trip.
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
 *               - rating
 *             properties:
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *                 description: Rating score from 1 (poor) to 5 (excellent)
 *                 example: 5
 *               comment:
 *                 type: string
 *                 description: Optional review comment
 *                 example: "Great experience, very professional!"
 *     responses:
 *       200:
 *         description: Rating submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Rating submitted successfully"
 *                 rating:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     score:
 *                       type: integer
 *                     comment:
 *                       type: string
 *                     ratingType:
 *                       type: string
 *                       enum: [rider_to_driver, driver_to_rider]
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Invalid request (rating out of range, already rated, or trip not completed)
 *       404:
 *         description: Trip not found
 *       410:
 *         description: Rating window has expired (48 hours after trip completion)
 */
router.post('/:id/rate', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;
    const userId = req.user.id;
    
    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        error: 'INVALID_RATING',
        message: 'Rating must be between 1 and 5'
      });
    }

    // Get the ride request
    const rideRequest = await rideRequestsDb.getRideRequestById(id);
    if (!rideRequest) {
      return res.status(404).json({
        error: 'TRIP_NOT_FOUND',
        message: 'Trip not found'
      });
    }

    // Verify trip is completed
    if (rideRequest.status !== 'completed') {
      return res.status(400).json({
        error: 'TRIP_NOT_COMPLETED',
        message: 'Can only rate completed trips'
      });
    }

    // Check if rating window has expired (48 hours)
    const isExpired = await ratingsDb.isRatingWindowExpired(id);
    if (isExpired) {
      return res.status(410).json({
        error: 'RATING_WINDOW_EXPIRED',
        message: 'Rating window has expired (48 hours after trip completion)'
      });
    }

    // Determine rating type and parties
    let ratingType, raterId, ratedId;
    
    if (userId === rideRequest.passenger_id) {
      // Rider is rating the driver
      ratingType = 'rider_to_driver';
      raterId = rideRequest.passenger_id;
      ratedId = rideRequest.driver_id;
    } else if (userId === rideRequest.driver_id) {
      // Driver is rating the rider
      ratingType = 'driver_to_rider';
      raterId = rideRequest.driver_id;
      ratedId = rideRequest.passenger_id;
    } else {
      return res.status(403).json({
        error: 'NOT_AUTHORIZED',
        message: 'You are not authorized to rate this trip'
      });
    }

    // Check if already rated
    const alreadyRated = await ratingsDb.ratingExists(id, ratingType);
    if (alreadyRated) {
      return res.status(400).json({
        error: 'ALREADY_RATED',
        message: 'You have already rated this trip'
      });
    }

    // Create the rating
    const newRating = await ratingsDb.createRating({
      rideRequestId: parseInt(id, 10),
      raterId,
      ratedId,
      ratingType,
      score: rating,
      comment: comment || null
    });

    console.log(`[trips.rate] ${ratingType} rating created for trip ${id}: ${rating} stars`);

    res.json({
      message: 'Rating submitted successfully',
      rating: {
        id: newRating.id,
        score: newRating.score,
        comment: newRating.comment,
        ratingType: newRating.rating_type,
        createdAt: newRating.created_at
      }
    });
  } catch (error) {
    console.error('[trips.rate] Error:', error);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

/**
 * @swagger
 * /api/trips/{id}/ratings:
 *   get:
 *     summary: Get all ratings for a specific trip
 *     description: Returns both rider-to-driver and driver-to-rider ratings for a completed trip.
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
 *     responses:
 *       200:
 *         description: Ratings for the trip
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tripId:
 *                   type: string
 *                 ratings:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       ratingType:
 *                         type: string
 *                       score:
 *                         type: integer
 *                       comment:
 *                         type: string
 *                       raterName:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *       404:
 *         description: Trip not found
 */
router.get('/:id/ratings', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify trip exists
    const rideRequest = await rideRequestsDb.getRideRequestById(id);
    if (!rideRequest) {
      return res.status(404).json({
        error: 'TRIP_NOT_FOUND',
        message: 'Trip not found'
      });
    }

    const ratings = await ratingsDb.getRatingsForRide(id);
    
    res.json({
      tripId: id,
      ratings: ratings.map(r => ({
        id: r.id,
        ratingType: r.rating_type,
        score: r.score,
        comment: r.comment,
        raterName: r.rater_name,
        raterUsername: r.rater_username,
        createdAt: r.created_at
      }))
    });
  } catch (error) {
    console.error('[trips.getRatings] Error:', error);
    res.status(500).json({ error: 'Failed to fetch ratings' });
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
    const driverId = req.user.id;
    
    console.log(`[trips.payment-request] Request for trip ${id} from token user:`, {
      driverId,
      username: req.user.username
    });

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

    console.log(`[trips.payment-request] Trip ${id} data:`, {
      tripStatus: rideRequest.status,
      passengerId: rideRequest.passenger_id
    });

    // Get the assigned driver from Redis (driver_id is stored there when ride is accepted)
    const redisClient = require('../db/redis');
    const assignedDriverId = await redisClient.sendCommand(['GET', `ride:request:${id}:driver`]);
    
    console.log(`[trips.payment-request] Trip ${id} assigned driver from Redis:`, {
      assignedDriverId,
      assignedDriverIdType: typeof assignedDriverId,
      requestingDriverId: driverId,
      requestingDriverIdType: typeof driverId
    });

    // Verify the authenticated driver owns this trip
    // Compare as strings since Redis stores strings
    if (!assignedDriverId || String(assignedDriverId) !== String(driverId)) {
      console.warn(`[trips.payment-request] 403 UNAUTHORIZED: Trip ${id} assignedDriverId=${assignedDriverId} !== requesting driverId=${driverId}`);
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
        riderId: rideRequest.passenger_id
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

/**
 * @swagger
 * /api/trips/{requestId}/driver-location:
 *   get:
 *     summary: Get driver's current location for an active trip
 *     description: >
 *       Returns the driver's latest GPS position for a given trip.
 *       The authenticated user must be the passenger on the trip.
 *       The client should poll this endpoint on a progressive schedule
 *       (3–15 s depending on distance) after receiving the ride_accepted
 *       FCM message, and stop when driver_arrived is received.
 *     tags: [Trips]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the active trip / ride request
 *     responses:
 *       200:
 *         description: Driver location (or null if not yet available)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 driverLocation:
 *                   oneOf:
 *                     - type: object
 *                       properties:
 *                         latitude:
 *                           type: number
 *                         longitude:
 *                           type: number
 *                         heading:
 *                           type: number
 *                           nullable: true
 *                         speed:
 *                           type: number
 *                           nullable: true
 *                         updatedAt:
 *                           type: string
 *                           format: date-time
 *                     - type: 'null'
 *       401:
 *         description: Missing, invalid, or expired JWT token
 *       403:
 *         description: Authenticated rider is not the passenger on this trip
 *       404:
 *         description: Trip not found
 *       409:
 *         description: Trip is not in an active state (pending, completed, cancelled, etc.)
 */
// GET /api/trips/:requestId/driver-location - Rider polls driver GPS position
router.get('/:requestId/driver-location', authenticateJWT, async (req, res) => {
  try {
    const { requestId } = req.params;
    const riderId = req.user.id;

    // 1. Fetch trip from DB
    const trip = await rideRequestsDb.getRideRequestById(requestId);
    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    // 2. Verify trip is in an active state
    const ACTIVE_STATUSES = ['accepted', 'in_transit'];
    if (!ACTIVE_STATUSES.includes(trip.status)) {
      return res.status(409).json({
        error: 'Trip is not active',
        status: trip.status
      });
    }

    // 3. Verify the authenticated user is the passenger on this trip
    if (trip.passenger_id !== riderId) {
      return res.status(403).json({ error: 'Forbidden: you are not the passenger on this trip' });
    }

    // 4. Resolve driver ID — stored in Redis when driver accepts
    const driverId = await redisClient.sendCommand(['GET', `ride:request:${requestId}:driver`]);
    if (!driverId) {
      // Driver not yet assigned (edge case) — return null location gracefully
      return res.json({ driverLocation: null });
    }

    // 5. Read full location hash written by POST /api/drivers/location
    const raw = await redisClient.sendCommand(['HGETALL', `driver:location:${driverId}`]);

    // HGETALL returns null (node-redis v4+) or empty array when key doesn't exist
    if (!raw || (Array.isArray(raw) && raw.length === 0) || Object.keys(raw).length === 0) {
      return res.json({ driverLocation: null });
    }

    // node-redis v4 returns a plain object from HGETALL
    const loc = Array.isArray(raw)
      ? Object.fromEntries(raw.reduce((acc, val, i) => { if (i % 2 === 0) acc.push([val]); else acc[acc.length - 1].push(val); return acc; }, []))
      : raw;

    return res.json({
      driverLocation: {
        latitude:  parseFloat(loc.latitude),
        longitude: parseFloat(loc.longitude),
        heading:   loc.heading  ? parseFloat(loc.heading)  : null,
        speed:     loc.speed    ? parseFloat(loc.speed)    : null,
        updatedAt: loc.updatedAt || null
      }
    });
  } catch (error) {
    console.error('[trips.driver-location] Error:', error);
    res.status(500).json({ error: 'Failed to fetch driver location' });
  }
});

module.exports = router;
