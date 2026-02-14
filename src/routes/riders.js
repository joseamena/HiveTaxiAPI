// src/routes/riders.js
const express = require('express');
const router = express.Router();
const ratingsDb = require('../db/ratings');
const rideRequestsDb = require('../db/rideRequests');
const userDb = require('../db/users');
const authenticateJWT = require('../middleware/auth');
const { verifyReviewPermlink } = require('../utils/hiveValidation');
const notificationService = require('../services/notificationService');

/**
 * @swagger
 * /api/riders/pending-reviews:
 *   get:
 *     summary: Get pending reviews for the authenticated rider
 *     description: Returns completed rides where the rider hasn't submitted a rating yet (within 48-hour window)
 *     tags: [Riders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Maximum number of results to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip for pagination
 *     responses:
 *       200:
 *         description: List of pending reviews
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pendingReviews:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       tripId:
 *                         type: integer
 *                       driver:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           username:
 *                             type: string
 *                           displayName:
 *                             type: string
 *                           rating:
 *                             type: number
 *                           profileImage:
 *                             type: string
 *                       tripSummary:
 *                         type: object
 *                         properties:
 *                           pickup:
 *                             type: string
 *                           dropoff:
 *                             type: string
 *                           distance:
 *                             type: string
 *                           duration:
 *                             type: string
 *                           cost:
 *                             type: number
 *                       tripDate:
 *                         type: string
 *                         format: date-time
 *                       expiresAt:
 *                         type: string
 *                         format: date-time
 *                       reviewWindow:
 *                         type: object
 *                         properties:
 *                           hoursSinceCompletion:
 *                             type: string
 *                           hoursRemaining:
 *                             type: string
 *                 totalPending:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
// GET /api/riders/pending-reviews - Get pending reviews for rider
router.get('/pending-reviews', authenticateJWT, async (req, res) => {
  try {
    const riderId = req.user.id || req.user.driverId;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    const result = await ratingsDb.getPendingReviewsForRider(riderId, { limit, offset });

    res.json(result);
  } catch (error) {
    console.error('Error fetching pending reviews for rider:', error);
    res.status(500).json({
      error: 'Failed to fetch pending reviews',
      details: error.message
    });
  }
});

/**
 * @swagger
 * /api/riders/pending-reviews/{tripId}/complete:
 *   post:
 *     summary: Complete a pending review for a trip
 *     description: Submit a rating and blockchain permlink to complete a review. Validates the permlink on the Hive blockchain.
 *     tags: [Riders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema:
 *           type: integer
 *         description: The trip/ride request ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - rating
 *               - permlink
 *             properties:
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *                 description: Rating score from 1 to 5
 *               permlink:
 *                 type: string
 *                 description: The Hive blockchain permlink for the review comment
 *               comment:
 *                 type: string
 *                 description: Optional review comment text
 *     responses:
 *       200:
 *         description: Review completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 rating:
 *                   type: object
 *                 userProfile:
 *                   type: object
 *       400:
 *         description: Invalid request (missing fields, invalid rating, etc.)
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Not authorized to review this trip
 *       404:
 *         description: Trip not found
 *       409:
 *         description: Rating already exists or window expired
 *       422:
 *         description: Permlink validation failed
 *       500:
 *         description: Internal server error
 */
// POST /api/riders/pending-reviews/:tripId/complete - Complete a review with blockchain validation
router.post('/pending-reviews/:tripId/complete', authenticateJWT, async (req, res) => {
  try {
    const tripId = parseInt(req.params.tripId);
    const riderId = req.user.id || req.user.driverId;
    const riderUsername = req.user.hiveUsername || req.user.username;
    const { rating, permlink, comment } = req.body;

    // Validate required fields
    if (!rating || !permlink) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'Rating and permlink are required'
      });
    }

    // Validate rating value
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({
        error: 'INVALID_RATING',
        message: 'Rating must be an integer between 1 and 5'
      });
    }

    // Get the trip/ride request
    const trip = await rideRequestsDb.getRideRequestById(tripId);

    if (!trip) {
      return res.status(404).json({
        error: 'TRIP_NOT_FOUND',
        message: 'Trip not found'
      });
    }

    // Verify the rider is the passenger of this trip
    if (trip.passenger_id !== riderId) {
      return res.status(403).json({
        error: 'NOT_AUTHORIZED',
        message: 'You are not authorized to review this trip'
      });
    }

    // Check trip is completed
    if (trip.status !== 'completed') {
      return res.status(400).json({
        error: 'TRIP_NOT_COMPLETED',
        message: 'Cannot review a trip that is not completed'
      });
    }

    // Check if rating already exists
    const existingRating = await ratingsDb.ratingExists(tripId, 'rider_to_driver');
    if (existingRating) {
      return res.status(409).json({
        error: 'RATING_EXISTS',
        message: 'You have already reviewed this trip'
      });
    }

    // Check if rating window has expired
    const windowExpired = await ratingsDb.isRatingWindowExpired(tripId);
    if (windowExpired) {
      return res.status(409).json({
        error: 'WINDOW_EXPIRED',
        message: 'The 48-hour review window has expired for this trip'
      });
    }

    // Get driver info for blockchain validation
    const driver = await userDb.getUserById(trip.driver_id);
    if (!driver) {
      return res.status(500).json({
        error: 'DRIVER_NOT_FOUND',
        message: 'Driver information not found'
      });
    }

    // Check if there's a pending rating entry for this trip (created on trip completion)
    const pendingRating = await ratingsDb.getPendingRatingByRideAndType(tripId, 'rider_to_driver');
    
    // Validate the permlink on the blockchain
    // The review should be a reply to the driver's check-in post
    const expectedParentPermlink = pendingRating ? pendingRating.parent_permlink : null;
    const validation = await verifyReviewPermlink(
      riderUsername,
      permlink,
      driver.hive_username,
      expectedParentPermlink  // Validate against driver's check-in permlink
    );

    if (!validation.verified) {
      return res.status(422).json({
        error: validation.error,
        message: validation.message
      });
    }

    let newRating;
    
    if (pendingRating) {
      // Update the existing pending rating with the submitted review
      newRating = await ratingsDb.updateRatingWithReply({
        ratingId: pendingRating.id,
        score: rating,
        comment: comment || null,
        permlink: permlink,
        status: 'awaiting_response'  // Awaiting driver's counter-review
      });
      console.log('[riders.complete] Updated pending rating with rider review');
    } else {
      // Legacy flow: Create a new rating (for trips without pending rating entry)
      newRating = await ratingsDb.createRating({
        rideRequestId: tripId,
        raterId: riderId,
        ratedId: trip.driver_id,
        ratingType: 'rider_to_driver',
        score: rating,
        comment: comment || null,
        permlink: permlink,
        status: 'awaiting_response'
      });
      console.log('[riders.complete] Created new rating (legacy flow)');
    }

    // Create pending rating for driver to submit their counter-review
    // Driver will reply to rider's review on Hive blockchain
    try {
      await ratingsDb.createPendingRating({
        rideRequestId: tripId,
        raterId: trip.driver_id,       // Driver will give the rating
        ratedId: riderId,              // Rider will be rated
        ratingType: 'driver_to_rider',
        parentPermlink: permlink        // Driver replies to rider's review
      });
      console.log('[riders.complete] Created pending rating for driver to review rider');
      
      // Send FCM notification to driver about pending review
      const rider = await userDb.getUserById(riderId);
      const riderName = rider?.display_name || rider?.hive_username || 'Rider';
      
      await notificationService.sendDriverRatingPrompt(
        trip.driver_id,
        tripId,
        riderName
      );
      
      // Also send a custom notification with the permlink info
      await notificationService._sendNotification(
        trip.driver_id,
        'New review received!',
        `${riderName} has left a review for your ride. Reply on Hive to complete the rating.`,
        {
          type: 'pending_review',
          requestId: String(tripId),
          parentPermlink: permlink,
          riderUsername: rider?.hive_username || ''
        }
      );
    } catch (pendingError) {
      // Log but don't fail if pending rating creation fails
      console.error('[riders.complete] Failed to create driver pending rating:', pendingError.message);
    }

    // Get updated user profile
    const updatedUser = await userDb.getUserById(riderId);

    res.json({
      success: true,
      message: 'Review submitted successfully',
      rating: {
        id: newRating.id,
        score: newRating.score,
        comment: newRating.comment,
        permlink: permlink,
        blockchainVerified: true,
        createdAt: newRating.created_at
      },
      userProfile: {
        id: updatedUser.id,
        username: updatedUser.hive_username,
        displayName: updatedUser.display_name,
        rating: updatedUser.rating
      }
    });
  } catch (error) {
    console.error('Error completing review:', error);
    res.status(500).json({
      error: 'Failed to complete review',
      details: error.message
    });
  }
});

/**
 * @swagger
 * /api/riders/pending-ratings:
 *   get:
 *     summary: Get pending ratings that need blockchain submission
 *     description: Returns pending rating entries where the rider needs to submit their review on the Hive blockchain
 *     tags: [Riders]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of pending ratings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pendingRatings:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       rideRequestId:
 *                         type: integer
 *                       ratedName:
 *                         type: string
 *                       ratedUsername:
 *                         type: string
 *                       parentPermlink:
 *                         type: string
 *                         description: The Hive permlink to reply to (driver's check-in post)
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
// GET /api/riders/pending-ratings - Get pending ratings needing blockchain submission
router.get('/pending-ratings', authenticateJWT, async (req, res) => {
  try {
    const riderId = req.user.id || req.user.driverId;
    if (!riderId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const pendingRatings = await ratingsDb.getPendingRatingsForUser(riderId, 'rider_to_driver');

    res.json({
      pendingRatings: pendingRatings.map(r => ({
        id: r.id,
        rideRequestId: r.ride_request_id,
        ratedName: r.rated_name,
        ratedUsername: r.rated_username,
        parentPermlink: r.parent_permlink,
        tripPickup: r.pickup_address,
        tripDropoff: r.dropoff_address,
        tripFare: r.proposed_fare,
        tripCompletedAt: r.completed_at,
        createdAt: r.created_at
      }))
    });
  } catch (error) {
    console.error('Error fetching pending ratings:', error);
    res.status(500).json({
      error: 'Failed to fetch pending ratings',
      details: error.message
    });
  }
});

module.exports = router;
