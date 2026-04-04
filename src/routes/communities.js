const express = require('express');
const router = express.Router();
const userDb = require('../db/users');
const communitiesDb = require('../db/communities');
const authenticateJWT = require('../middleware/auth');
const { authenticateAPIKey, requireScope } = require('../middleware/apiKeyAuth');

// Helper: format a community row for API responses
function formatCommunity(c) {
  return {
    id: c.id,
    hiveTag: c.hive_tag,
    hiveAccount: `@${c.hive_tag}`,
    name: c.name,
    description: c.description || null,
    requirements: c.requirements || null,
    rating: c.rating != null ? parseFloat(c.rating) : null,
    activeDriverCount: c.active_driver_count != null ? parseInt(c.active_driver_count, 10) : 0,
    latitude: c.latitude != null ? parseFloat(c.latitude) : null,
    longitude: c.longitude != null ? parseFloat(c.longitude) : null
  };
}

/**
 * @swagger
 * /api/communities:
 *   get:
 *     summary: Get all communities
 *     description: >
 *       Retrieves registered Hive communities. Supports text search (?search=) and
 *       geo-proximity sort (?lat=&lng=). When lat/lng are supplied the response splits
 *       into nearbyResults (within 50 km) and allResults (the rest).
 *     tags: [Communities]
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Filter by community name or hiveTag (case-insensitive)
 *       - in: query
 *         name: lat
 *         schema: { type: number }
 *         description: Caller latitude for proximity sort
 *       - in: query
 *         name: lng
 *         schema: { type: number }
 *         description: Caller longitude for proximity sort
 *     responses:
 *       200:
 *         description: Communities retrieved successfully
 *       500:
 *         description: Internal server error
 */
router.get('/', async (req, res) => {
  try {
    const { search, lat, lng } = req.query;
    const data = await communitiesDb.getCommunities({ search, lat, lng });

    if (data.nearbyResults !== undefined) {
      return res.json({
        message: 'Communities retrieved successfully',
        nearbyResults: data.nearbyResults.map(formatCommunity),
        allResults: data.allResults.map(formatCommunity)
      });
    }

    res.json({
      message: 'Communities retrieved successfully',
      communities: data.communities.map(formatCommunity)
    });
  } catch (error) {
    console.error('Error fetching communities:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch communities', details: error.message });
  }
});

/**
 * @swagger
 * /api/communities/{identifier}:
 *   get:
 *     summary: Get a specific community
 *     description: Retrieves a community by ID or hiveTag. Includes callerMembershipStatus when authenticated.
 *     tags: [Communities]
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Community retrieved successfully
 *       404:
 *         description: Community not found
 *       500:
 *         description: Internal server error
 */
router.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const pool = require('../db');

    // Resolve community
    let result;
    if (!isNaN(identifier)) {
      result = await pool.query(
        `SELECT c.*,
           COUNT(uc.user_id) FILTER (WHERE uc.role = 'Driver' AND uc.status = 'approved') AS active_driver_count
         FROM communities c
         LEFT JOIN user_communities uc ON uc.community_id = c.id
         WHERE c.id = $1
         GROUP BY c.id`,
        [parseInt(identifier)]
      );
    } else {
      result = await pool.query(
        `SELECT c.*,
           COUNT(uc.user_id) FILTER (WHERE uc.role = 'Driver' AND uc.status = 'approved') AS active_driver_count
         FROM communities c
         LEFT JOIN user_communities uc ON uc.community_id = c.id
         WHERE c.hive_tag = $1
         GROUP BY c.id`,
        [identifier]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'COMMUNITY_NOT_FOUND', message: 'Community not found' });
    }

    const community = result.rows[0];
    const formatted = formatCommunity(community);

    // Attach caller membership status if authenticated
    formatted.callerMembershipStatus = null;
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      try {
        const jwt = require('jsonwebtoken');
        const token = authHeader.replace('Bearer ', '');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret');
        const callerUser = await userDb.getUserByUsername(decoded.username);
        if (callerUser) {
          const membershipRes = await pool.query(
            `SELECT status FROM user_communities WHERE user_id = $1 AND community_id = $2`,
            [callerUser.id, community.id]
          );
          formatted.callerMembershipStatus = membershipRes.rows[0]?.status || null;
        }
      } catch (_) {
        // Not authenticated — callerMembershipStatus stays null
      }
    }

    res.json({ message: 'Community retrieved successfully', community: formatted });
  } catch (error) {
    console.error('Error fetching community:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch community', details: error.message });
  }
});

/**
 * @swagger
 * /api/communities/{id}/join:
 *   post:
 *     summary: Request to join a community
 *     description: Creates a pending membership for the authenticated driver. Guards against double-join.
 *     tags: [Communities]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       201:
 *         description: Join request created
 *       409:
 *         description: Membership already exists
 *       404:
 *         description: Community not found
 *       500:
 *         description: Internal server error
 */
router.post('/:id/join', authenticateJWT, async (req, res) => {
  try {
    const communityId = parseInt(req.params.id);
    if (isNaN(communityId)) {
      return res.status(400).json({ error: 'INVALID_ID', message: 'Community ID must be an integer' });
    }

    const pool = require('../db');
    const communityRes = await pool.query('SELECT id, name, hive_tag FROM communities WHERE id = $1', [communityId]);
    if (communityRes.rows.length === 0) {
      return res.status(404).json({ error: 'COMMUNITY_NOT_FOUND', message: 'Community not found' });
    }

    const user = await userDb.getUserByUsername(req.user.username);
    // Riders are auto-approved — community membership for riders is a dispatch preference,
    // not an operational relationship requiring vetting. Only drivers go through pending/approval.
    const membership = await communitiesDb.joinCommunity(user.id, communityId, user.type === 'rider');

    res.status(201).json({
      message: user.type === 'rider' ? 'Community joined' : 'Join request submitted',
      membership: {
        communityId: communityId,
        communityName: communityRes.rows[0].name,
        hiveTag: communityRes.rows[0].hive_tag,
        status: membership.status,
        joinedAt: membership.joined_at
      }
    });
  } catch (error) {
    if (error.code === 'ALREADY_MEMBER') {
      return res.status(409).json({
        error: 'ALREADY_MEMBER',
        message: 'You already have a membership for this community',
        existingStatus: error.existingStatus
      });
    }
    console.error('Error joining community:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to submit join request', details: error.message });
  }
});

/**
 * @swagger
 * /api/communities/{id}/join:
 *   delete:
 *     summary: Withdraw a pending join request
 *     description: Sets the membership status to 'withdrawn'. Only works on pending requests.
 *     tags: [Communities]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Join request withdrawn
 *       404:
 *         description: No pending request found
 *       500:
 *         description: Internal server error
 */
router.delete('/:id/join', authenticateJWT, async (req, res) => {
  try {
    const communityId = parseInt(req.params.id);
    if (isNaN(communityId)) {
      return res.status(400).json({ error: 'INVALID_ID', message: 'Community ID must be an integer' });
    }

    const user = await userDb.getUserByUsername(req.user.username);
    const membership = await communitiesDb.withdrawJoinRequest(user.id, communityId);

    if (!membership) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No pending join request found for this community' });
    }

    res.json({ message: 'Join request withdrawn', communityId, status: membership.status });
  } catch (error) {
    console.error('Error withdrawing join request:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to withdraw join request', details: error.message });
  }
});

/**
 * @swagger
 * /api/communities/{id}/membership:
 *   delete:
 *     summary: Leave an approved community
 *     description: Sets the membership status to 'left'. Clears active_community_id if this was the driver's active community.
 *     tags: [Communities]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Community left successfully
 *       404:
 *         description: No approved membership found
 *       500:
 *         description: Internal server error
 */
router.delete('/:id/membership', authenticateJWT, async (req, res) => {
  try {
    const communityId = parseInt(req.params.id);
    if (isNaN(communityId)) {
      return res.status(400).json({ error: 'INVALID_ID', message: 'Community ID must be an integer' });
    }

    const user = await userDb.getUserByUsername(req.user.username);
    const membership = await communitiesDb.leaveCommunity(user.id, communityId);

    if (!membership) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No approved membership found for this community' });
    }

    // Clear active community if driver was active in the one they just left
    const pool = require('../db');
    await pool.query(
      `UPDATE users SET active_community_id = NULL WHERE id = $1 AND active_community_id = $2`,
      [user.id, communityId]
    );

    res.json({ message: 'Community left successfully', communityId, status: membership.status });
  } catch (error) {
    console.error('Error leaving community:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to leave community', details: error.message });
  }
});

/**
 * @swagger
 * /api/communities/{identifier}/members:
 *   get:
 *     summary: Get all members of a community
 *     description: Retrieves members of a community with optional role filtering. Admin/API-key use.
 *     tags: [Communities]
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [Driver, Rider, Admin, Moderator]
 *     responses:
 *       200:
 *         description: Community members retrieved successfully
 *       404:
 *         description: Community not found
 *       500:
 *         description: Internal server error
 */
router.get('/:identifier/members', async (req, res) => {
  try {
    const { identifier } = req.params;
    const { role } = req.query;
    const pool = require('../db');
    let community;

    if (!isNaN(identifier)) {
      const result = await pool.query('SELECT * FROM communities WHERE id = $1', [parseInt(identifier)]);
      community = result.rows[0];
    } else {
      const result = await pool.query('SELECT * FROM communities WHERE hive_tag = $1', [identifier]);
      community = result.rows[0];
    }

    if (!community) {
      return res.status(404).json({ error: 'COMMUNITY_NOT_FOUND', message: 'Community not found' });
    }

    const members = await communitiesDb.listCommunityMembers(community.hive_tag, role);

    res.json({
      message: 'Community members retrieved successfully',
      community: { id: community.id, hiveTag: community.hive_tag, name: community.name },
      members: members.map(m => ({ username: m.hive_username, role: m.role, joinedAt: m.joined_at })),
      count: members.length
    });
  } catch (error) {
    console.error('Error fetching community members:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch community members', details: error.message });
  }
});

/**
 * @swagger
 * /api/communities/register:
 *   post:
 *     summary: Create or update a community
 *     description: Registers a new Hive community or updates existing one. Requires API key with 'communities:write' scope.
 *     tags: [Communities]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [hiveTag]
 *             properties:
 *               hiveTag: { type: string }
 *               name: { type: string }
 *               latitude: { type: number }
 *               longitude: { type: number }
 *               description: { type: string }
 *               requirements: { type: string }
 *     responses:
 *       201:
 *         description: Community created/updated successfully
 *       400:
 *         description: Missing or invalid parameters
 *       401:
 *         description: Invalid API key or insufficient scope
 *       500:
 *         description: Internal server error
 */
router.post('/register', authenticateAPIKey, requireScope('communities:write'), async (req, res) => {
  try {
    const { hiveTag, name, latitude, longitude, description, requirements } = req.body;

    if (!hiveTag) {
      return res.status(400).json({ error: 'MISSING_PARAMETER', message: 'hiveTag is required' });
    }
    if (!hiveTag.startsWith('hive-')) {
      return res.status(400).json({ error: 'INVALID_FORMAT', message: 'hiveTag must start with "hive-"' });
    }
    if (latitude !== undefined && (isNaN(latitude) || latitude < -90 || latitude > 90)) {
      return res.status(400).json({ error: 'INVALID_LATITUDE', message: 'Latitude must be between -90 and 90' });
    }
    if (longitude !== undefined && (isNaN(longitude) || longitude < -180 || longitude > 180)) {
      return res.status(400).json({ error: 'INVALID_LONGITUDE', message: 'Longitude must be between -180 and 180' });
    }

    const community = await communitiesDb.ensureCommunity(hiveTag, name, latitude, longitude, description, requirements);

    res.status(201).json({
      message: 'Community created/updated successfully',
      community: {
        id: community.id,
        hiveTag: community.hive_tag,
        name: community.name,
        latitude: community.latitude,
        longitude: community.longitude,
        description: community.description,
        requirements: community.requirements
      }
    });
  } catch (error) {
    console.error('Community creation error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create community', details: error.message });
  }
});

/**
 * @swagger
 * /api/communities/members:
 *   post:
 *     summary: Add a user to a community
 *     description: Adds a registered user to a community with specified role. Requires API key with 'communities:write' scope.
 *     tags: [Communities]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, hiveTag]
 *             properties:
 *               username: { type: string }
 *               hiveTag: { type: string }
 *               role:
 *                 type: string
 *                 enum: [Driver, Rider, Admin, Moderator]
 *                 default: Driver
 *     responses:
 *       201:
 *         description: User added to community successfully
 *       400:
 *         description: Missing required parameters
 *       401:
 *         description: Invalid API key or insufficient scope
 *       404:
 *         description: User or community not found
 *       500:
 *         description: Internal server error
 */
/**
 * @swagger
 * /api/communities/{id}/sync:
 *   post:
 *     summary: Trigger an on-demand blockchain sync for a community
 *     description: >
 *       Immediately syncs one community's driver memberships against the Hive blockchain.
 *       Useful when a community operator has just approved someone and the driver cannot
 *       wait for the next scheduled sync (default: 10 minutes).
 *       Requires API key with 'communities:write' scope.
 *     tags: [Communities]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Sync completed successfully
 *       404:
 *         description: Community not found
 *       500:
 *         description: Internal server error
 */
router.post('/:id/sync', authenticateAPIKey, requireScope('communities:write'), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id);
    if (isNaN(communityId)) {
      return res.status(400).json({ error: 'INVALID_ID', message: 'Community ID must be an integer' });
    }

    const pool = require('../db');
    const communityRes = await pool.query('SELECT id, hive_tag FROM communities WHERE id = $1', [communityId]);
    if (!communityRes.rows[0]) {
      return res.status(404).json({ error: 'COMMUNITY_NOT_FOUND', message: 'Community not found' });
    }

    const { syncCommunity } = require('../services/communitySync');
    const community = communityRes.rows[0];
    await syncCommunity(community.hive_tag, community.id);

    res.json({ message: 'Community sync completed', communityId, hiveTag: community.hive_tag });
  } catch (error) {
    console.error('Error syncing community:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Sync failed', details: error.message });
  }
});

router.post('/members', authenticateAPIKey, requireScope('communities:write'), async (req, res) => {
  try {
    const { username, hiveTag, role } = req.body;

    if (!username) return res.status(400).json({ error: 'MISSING_PARAMETER', message: 'username is required' });
    if (!hiveTag) return res.status(400).json({ error: 'MISSING_PARAMETER', message: 'hiveTag is required' });

    const user = await userDb.getUserByUsername(username);
    if (!user) {
      return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User must be registered before being added to a community' });
    }

    const community = await communitiesDb.getCommunityByTag(hiveTag);
    if (!community) {
      return res.status(404).json({ error: 'COMMUNITY_NOT_FOUND', message: 'Community does not exist' });
    }

    const userRole = role || 'Driver';
    const membership = await communitiesDb.addUserToCommunity(username, hiveTag, userRole);

    res.status(201).json({
      message: 'User added to community successfully',
      membership: { username: membership.hiveUsername, community: membership.community, role: membership.role }
    });
  } catch (error) {
    console.error('Error adding user to community:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to add user to community', details: error.message });
  }
});

module.exports = router;
