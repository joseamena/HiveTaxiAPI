// src/routes/riders.js
const express = require('express');
const router = express.Router();
const ratingsDb = require('../db/ratings');
const rideRequestsDb = require('../db/rideRequests');
const userDb = require('../db/users');
const authenticateJWT = require('../middleware/auth');
const { verifyReviewPermlink } = require('../utils/hiveValidation');

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

    // Validate the permlink on the blockchain
    // The review should be a reply to the driver's content
    const validation = await verifyReviewPermlink(
      riderUsername,
      permlink,
      driver.hive_username
      // Note: We're not requiring a specific parent permlink for MVP
      // In the future, we could validate against driver's check-in post permlink
    );

    if (!validation.verified) {
      return res.status(422).json({
        error: validation.error,
        message: validation.message
      });
    }

    // Create the rating with permlink
    const newRating = await ratingsDb.createRating({
      rideRequestId: tripId,
      raterId: riderId,
      ratedId: trip.driver_id,
      ratingType: 'rider_to_driver',
      score: rating,
      comment: comment || null,
      permlink: permlink
    });

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

module.exports = router;
