const express = require('express');
const router = express.Router();
const userDb = require('../db/users');
const communitiesDb = require('../db/communities');
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

module.exports = router;
