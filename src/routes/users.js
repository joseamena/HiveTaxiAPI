const express = require('express');
const router = express.Router();
const userDb = require('../db/users');
const communitiesDb = require('../db/communities');
const ratingsDb = require('../db/ratings');
const authenticateJWT = require('../middleware/auth');

// GET /api/users/:username/communities - Get all communities for a user
router.get('/:username/communities', async (req, res) => {
  try {
    const { username } = req.params;

    // Check if user exists
    const user = await userDb.getUserByUsername(username);
    if (!user) {
      return res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    // Get all communities for the user
    const communities = await communitiesDb.listUserCommunities(username);

    res.json({
      message: 'User communities retrieved successfully',
      user: {
        username: user.hive_username,
        displayName: user.display_name,
        type: user.type
      },
      communities: communities.map(c => ({
        community: c.community,
        role: c.role,
        joinedAt: c.joined_at
      })),
      count: communities.length
    });

  } catch (error) {
    console.error('Error fetching user communities:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to fetch user communities',
      details: error.message
    });
  }
});

// POST /api/users/fcm-token - Save FCM token for push notifications
router.post('/fcm-token', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.driverId;
    const { fcmToken } = req.body;
    if (!fcmToken) {
      return res.status(400).json({ error: 'FCM token is required' });
    }
    // Save token in database (add fcm_token field to users table if not present)
    await userDb.updateUserById(userId, { fcm_token: fcmToken });
    res.json({ message: 'FCM token saved successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save FCM token', details: error.message });
  }
});

/**
 * @swagger
 * /api/users/{id}/ratings:
 *   get:
 *     summary: Get ratings received by a user
 *     description: Returns paginated ratings that a user (driver or rider) has received from others.
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The user ID
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
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [rider_to_driver, driver_to_rider]
 *         description: Filter by rating type
 *     responses:
 *       200:
 *         description: User ratings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     displayName:
 *                       type: string
 *                     averageRating:
 *                       type: number
 *                 ratings:
 *                   type: array
 *                   items:
 *                     type: object
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *       404:
 *         description: User not found
 */
router.get('/:id/ratings', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0, type } = req.query;

    // Check if user exists
    const user = await userDb.getUserById(parseInt(id, 10));
    if (!user) {
      return res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    // Get ratings
    const result = await ratingsDb.getRatingsReceivedByUser(parseInt(id, 10), {
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      ratingType: type
    });

    res.json({
      user: {
        id: user.id,
        displayName: user.display_name,
        username: user.hive_username,
        averageRating: parseFloat(user.rating) || 0,
        type: user.type
      },
      ratings: result.ratings.map(r => ({
        id: r.id,
        score: r.score,
        comment: r.comment,
        ratingType: r.rating_type,
        raterName: r.rater_name,
        raterUsername: r.rater_username,
        tripRoute: {
          pickup: r.pickup_address,
          dropoff: r.dropoff_address
        },
        createdAt: r.created_at
      })),
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset
      }
    });
  } catch (error) {
    console.error('Error fetching user ratings:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to fetch user ratings',
      details: error.message
    });
  }
});

/**
 * @swagger
 * /api/users/{id}/ratings/stats:
 *   get:
 *     summary: Get rating statistics for a user
 *     description: Returns rating statistics including average, total count, and distribution by star rating.
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The user ID
 *     responses:
 *       200:
 *         description: Rating statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                 stats:
 *                   type: object
 *                   properties:
 *                     totalRatings:
 *                       type: integer
 *                     averageRating:
 *                       type: number
 *                     distribution:
 *                       type: object
 *                       properties:
 *                         5:
 *                           type: integer
 *                         4:
 *                           type: integer
 *                         3:
 *                           type: integer
 *                         2:
 *                           type: integer
 *                         1:
 *                           type: integer
 *       404:
 *         description: User not found
 */
router.get('/:id/ratings/stats', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user exists
    const user = await userDb.getUserById(parseInt(id, 10));
    if (!user) {
      return res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    // Get rating stats
    const stats = await ratingsDb.getUserRatingStats(parseInt(id, 10));

    res.json({
      user: {
        id: user.id,
        displayName: user.display_name,
        username: user.hive_username,
        type: user.type
      },
      stats
    });
  } catch (error) {
    console.error('Error fetching user rating stats:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to fetch user rating stats',
      details: error.message
    });
  }
});

module.exports = router;
