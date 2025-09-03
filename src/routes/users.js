const express = require('express');
const router = express.Router();
const userDb = require('../db/users');
const authenticateJWT = require('../middleware/auth');

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
