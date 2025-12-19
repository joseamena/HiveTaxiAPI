const express = require('express');
const router = express.Router();
const userDb = require('../db/users');
const communitiesDb = require('../db/communities');
const authenticateJWT = require('../middleware/auth');

// GET /api/communities - Get all communities
router.get('/', async (req, res) => {
  try {
    const pool = require('../db');
    const result = await pool.query('SELECT * FROM communities ORDER BY name');
    
    res.json({
      message: 'Communities retrieved successfully',
      communities: result.rows.map(c => ({
        id: c.id,
        hiveTag: c.hive_tag,
        name: c.name,
        latitude: c.latitude,
        longitude: c.longitude
      }))
    });

  } catch (error) {
    console.error('Error fetching communities:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to fetch communities',
      details: error.message
    });
  }
});

// POST /api/communities/register - Create or update a community
router.post('/register', async (req, res) => {
  try {
    const { hiveTag, name, latitude, longitude } = req.body;

    // Validate required fields
    if (!hiveTag) {
      return res.status(400).json({
        error: 'MISSING_PARAMETER',
        message: 'hiveTag is required'
      });
    }

    // Validate hiveTag format (should be like hive-xxxxx)
    if (!hiveTag.startsWith('hive-')) {
      return res.status(400).json({
        error: 'INVALID_FORMAT',
        message: 'hiveTag must start with "hive-"'
      });
    }

    // Validate latitude and longitude if provided
    if (latitude !== undefined && (isNaN(latitude) || latitude < -90 || latitude > 90)) {
      return res.status(400).json({
        error: 'INVALID_LATITUDE',
        message: 'Latitude must be a number between -90 and 90'
      });
    }

    if (longitude !== undefined && (isNaN(longitude) || longitude < -180 || longitude > 180)) {
      return res.status(400).json({
        error: 'INVALID_LONGITUDE',
        message: 'Longitude must be a number between -180 and 180'
      });
    }

    // Create or ensure community exists
    const community = await communitiesDb.ensureCommunity(hiveTag, name, latitude, longitude);

    res.status(201).json({
      message: 'Community created/updated successfully',
      community: {
        id: community.id,
        hiveTag: community.hive_tag,
        name: community.name,
        latitude: community.latitude,
        longitude: community.longitude
      }
    });

  } catch (error) {
    console.error('Community creation error:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create community',
      details: error.message
    });
  }
});

module.exports = router;
