const express = require('express');
const router = express.Router();
const userDb = require('../db/users');
const communitiesDb = require('../db/communities');
const authenticateJWT = require('../middleware/auth');
const { authenticateAPIKey, requireScope } = require('../middleware/apiKeyAuth');

/**
 * @swagger
 * /api/communities:
 *   get:
 *     summary: Get all communities
 *     description: Retrieves a list of all registered Hive communities
 *     tags: [Communities]
 *     responses:
 *       200:
 *         description: Communities retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 communities:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       hiveTag:
 *                         type: string
 *                       name:
 *                         type: string
 *                       latitude:
 *                         type: number
 *                       longitude:
 *                         type: number
 *       500:
 *         description: Internal server error
 */
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

/**
 * @swagger
 * /api/communities/{identifier}:
 *   get:
 *     summary: Get a specific community
 *     description: Retrieves a community by ID or hiveTag
 *     tags: [Communities]
 *     parameters:
 *       - in: path
 *         name: identifier
 *         schema:
 *           type: string
 *         required: true
 *         description: Community ID (integer) or hiveTag (string)
 *     responses:
 *       200:
 *         description: Community retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 community:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     hiveTag:
 *                       type: string
 *                     name:
 *                       type: string
 *                     latitude:
 *                       type: number
 *                     longitude:
 *                       type: number
 *       404:
 *         description: Community not found
 *       500:
 *         description: Internal server error
 */
// GET /api/communities/:identifier - Get a specific community by ID or hiveTag
router.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const pool = require('../db');
    let result;

    // Check if identifier is numeric (ID) or string (hiveTag)
    if (!isNaN(identifier)) {
      // Search by ID
      result = await pool.query('SELECT * FROM communities WHERE id = $1', [parseInt(identifier)]);
    } else {
      // Search by hiveTag
      result = await pool.query('SELECT * FROM communities WHERE hive_tag = $1', [identifier]);
    }

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'COMMUNITY_NOT_FOUND',
        message: 'Community not found'
      });
    }

    const community = result.rows[0];
    
    res.json({
      message: 'Community retrieved successfully',
      community: {
        id: community.id,
        hiveTag: community.hive_tag,
        name: community.name,
        latitude: community.latitude,
        longitude: community.longitude
      }
    });

  } catch (error) {
    console.error('Error fetching community:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to fetch community',
      details: error.message
    });
  }
});

/**
 * @swagger
 * /api/communities/{identifier}/members:
 *   get:
 *     summary: Get all members of a community
 *     description: Retrieves members of a community with optional role filtering
 *     tags: [Communities]
 *     parameters:
 *       - in: path
 *         name: identifier
 *         schema:
 *           type: string
 *         required: true
 *         description: Community ID (integer) or hiveTag (string)
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [Driver, Rider, Admin, Moderator]
 *         description: Optional role filter
 *     responses:
 *       200:
 *         description: Community members retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 community:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     hiveTag:
 *                       type: string
 *                     name:
 *                       type: string
 *                 members:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       username:
 *                         type: string
 *                       role:
 *                         type: string
 *                       joinedAt:
 *                         type: string
 *                         format: date-time
 *                 count:
 *                   type: integer
 *       404:
 *         description: Community not found
 *       500:
 *         description: Internal server error
 */
// GET /api/communities/:identifier/members - Get all members of a community
router.get('/:identifier/members', async (req, res) => {
  try {
    const { identifier } = req.params;
    const { role } = req.query; // Optional: filter by role
    
    // First, find the community to get its hiveTag
    const pool = require('../db');
    let community;
    
    if (!isNaN(identifier)) {
      // Search by ID
      const result = await pool.query('SELECT * FROM communities WHERE id = $1', [parseInt(identifier)]);
      community = result.rows[0];
    } else {
      // Search by hiveTag
      const result = await pool.query('SELECT * FROM communities WHERE hive_tag = $1', [identifier]);
      community = result.rows[0];
    }

    if (!community) {
      return res.status(404).json({
        error: 'COMMUNITY_NOT_FOUND',
        message: 'Community not found'
      });
    }

    // Get members using the hiveTag
    const members = await communitiesDb.listCommunityMembers(community.hive_tag, role);

    res.json({
      message: 'Community members retrieved successfully',
      community: {
        id: community.id,
        hiveTag: community.hive_tag,
        name: community.name
      },
      members: members.map(m => ({
        username: m.hive_username,
        role: m.role,
        joinedAt: m.joined_at
      })),
      count: members.length
    });

  } catch (error) {
    console.error('Error fetching community members:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to fetch community members',
      details: error.message
    });
  }
});

/**
 * @swagger
 * /api/communities/register:
 *   post:
 *     summary: Create or update a community
 *     description: Registers a new Hive community or updates existing one. Requires API key with 'communities:write' scope
 *     tags: [Communities]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - hiveTag
 *             properties:
 *               hiveTag:
 *                 type: string
 *                 description: Hive community tag (must start with 'hive-')
 *               name:
 *                 type: string
 *                 description: Community display name
 *               latitude:
 *                 type: number
 *                 description: Community latitude (-90 to 90)
 *               longitude:
 *                 type: number
 *                 description: Community longitude (-180 to 180)
 *     responses:
 *       201:
 *         description: Community created/updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 community:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     hiveTag:
 *                       type: string
 *                     name:
 *                       type: string
 *                     latitude:
 *                       type: number
 *                     longitude:
 *                       type: number
 *       400:
 *         description: Missing or invalid parameters
 *       401:
 *         description: Invalid API key or insufficient scope
 *       500:
 *         description: Internal server error
 */
// POST /api/communities/register - Create or update a community
// Requires API key with 'communities:write' scope
router.post('/register', authenticateAPIKey, requireScope('communities:write'), async (req, res) => {
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

/**
 * @swagger
 * /api/communities/members:
 *   post:
 *     summary: Add a user to a community
 *     description: Adds a registered user to a community with specified role. Requires API key with 'communities:write' scope
 *     tags: [Communities]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - hiveTag
 *             properties:
 *               username:
 *                 type: string
 *                 description: Hive username of the user
 *               hiveTag:
 *                 type: string
 *                 description: Hive community tag
 *               role:
 *                 type: string
 *                 enum: [Driver, Rider, Admin, Moderator]
 *                 default: Driver
 *                 description: User role in the community
 *     responses:
 *       201:
 *         description: User added to community successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 membership:
 *                   type: object
 *                   properties:
 *                     username:
 *                       type: string
 *                     community:
 *                       type: string
 *                     role:
 *                       type: string
 *       400:
 *         description: Missing required parameters
 *       401:
 *         description: Invalid API key or insufficient scope
 *       404:
 *         description: User or community not found
 *       500:
 *         description: Internal server error
 */
// POST /api/communities/members - Add a user to a community
// Requires API key with 'communities:write' scope
router.post('/members', authenticateAPIKey, requireScope('communities:write'), async (req, res) => {
  try {
    const { username, hiveTag, role } = req.body;

    // Validate required fields
    if (!username) {
      return res.status(400).json({
        error: 'MISSING_PARAMETER',
        message: 'username is required'
      });
    }

    if (!hiveTag) {
      return res.status(400).json({
        error: 'MISSING_PARAMETER',
        message: 'hiveTag is required'
      });
    }

    // Check if user exists in our backend
    const user = await userDb.getUserByUsername(username);
    if (!user) {
      return res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User must be registered before being added to a community'
      });
    }

    // Check if community exists
    const community = await communitiesDb.getCommunityByTag(hiveTag);
    if (!community) {
      return res.status(404).json({
        error: 'COMMUNITY_NOT_FOUND',
        message: 'Community does not exist'
      });
    }

    // Add user to community with specified role (defaults to 'Driver')
    const userRole = role || 'Driver';
    const membership = await communitiesDb.addUserToCommunity(username, hiveTag, userRole);

    res.status(201).json({
      message: 'User added to community successfully',
      membership: {
        username: membership.hiveUsername,
        community: membership.community,
        role: membership.role
      }
    });

  } catch (error) {
    console.error('Error adding user to community:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to add user to community',
      details: error.message
    });
  }
});

module.exports = router;
