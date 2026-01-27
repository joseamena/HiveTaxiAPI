const express = require('express');
const router = express.Router();
const axios = require('axios');
const userDb = require('../db/users'); // updated import
const vehiclesDb = require('../db/vehicles');
const communitiesDb = require('../db/communities');
const redisClient = require('../db/redis');
const authenticateJWT = require('../middleware/auth');

// Helper function to verify user on Hive blockchain
async function verifyUserOnHiveBlockchain(username, communityTag) {
  try {
    const hiveResponse = await axios.post('https://api.hive.blog', {
      jsonrpc: '2.0',
      method: 'bridge.list_community_roles',
      params: { community: communityTag },
      id: 1
    });

    if (!hiveResponse.data || !hiveResponse.data.result) {
      return { verified: false, error: 'No results from blockchain' };
    }

    const roles = hiveResponse.data.result;
    const userRole = roles.find(r => r[0] === username);
    
    if (!userRole) {
      return { verified: false, error: 'USER_NOT_IN_COMMUNITY' };
    }

    // Check if the role is valid (userRole[1] contains the role)
    const validRoles = ['member', 'mod', 'admin'];
    if (!validRoles.includes(userRole[1])) {
      return { verified: false, error: 'INVALID_BLOCKCHAIN_ROLE' };
    }

    return { verified: true, role: userRole[1] };
  } catch (error) {
    console.error('Hive blockchain verification error:', error.message);
    return { verified: false, error: 'BLOCKCHAIN_REQUEST_FAILED' };
  }
}

// Driver management routes

/**
 * @swagger
 * /api/drivers/hive-info:
 *   get:
 *     summary: Verify driver authorization and Hive community membership
 *     description: Checks if user is a driver and has valid role in Hive community, with blockchain verification
 *     tags: [Drivers]
 *     parameters:
 *       - in: query
 *         name: username
 *         schema:
 *           type: string
 *         required: true
 *         description: The Hive username of the driver
 *     responses:
 *       200:
 *         description: Driver verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 authorized_driver:
 *                   type: boolean
 *                 community:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     role:
 *                       type: string
 *                     blockchain_verified:
 *                       type: boolean
 *                     blockchain_role:
 *                       type: string
 *       400:
 *         description: Missing username parameter
 *       403:
 *         description: User not driver, not member, or invalid role
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
// GET /api/drivers/hive-info - Verify driver authorization and Hive community membership
router.get('/hive-info', async (req, res) => {
  try {
    const { username } = req.query;

    if (!username) {
      return res.status(400).json({
        error: 'MISSING_PARAMETER',
        message: 'Username parameter is required'
      });
    }

    // Check if user exists in our backend
    const user = await userDb.getUserByUsername(username);
    
    if (!user) {
      return res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User is not registered as a driver in the backend.'
      });
    }

    // Check if user is actually a driver
    if (user.type !== 'driver') {
      return res.status(403).json({
        error: 'USER_NOT_DRIVER',
        message: 'User is registered but not as a driver.'
      });
    }

    // Get all communities for the user
    const communities = await communitiesDb.listUserCommunities(username);
    
    if (!communities || communities.length === 0) {
      return res.status(403).json({
        error: 'USER_NOT_MEMBER',
        message: 'User is not part of the Hive Taxi community.'
      });
    }

    // Find a community where the user has the Driver role
    const driverCommunity = communities.find(c => c.role === 'Driver');
    
    if (!driverCommunity) {
      return res.status(403).json({
        error: 'INVALID_ROLE',
        message: "User is a member of the community but does not have the 'Driver' role."
      });
    }

    // Get full community details
    const communityDetails = await communitiesDb.getCommunityByTag(driverCommunity.community);

    // Verify on Hive blockchain
    const blockchainVerification = await verifyUserOnHiveBlockchain(username, driverCommunity.community);

    if (!blockchainVerification.verified) {
      // Handle specific blockchain errors
      if (blockchainVerification.error === 'USER_NOT_IN_COMMUNITY') {
        return res.status(403).json({
          error: 'BLOCKCHAIN_NOT_MEMBER',
          message: 'User is not found in the Hive community on the blockchain.'
        });
      }
      
      if (blockchainVerification.error === 'INVALID_BLOCKCHAIN_ROLE') {
        return res.status(403).json({
          error: 'BLOCKCHAIN_INVALID_ROLE',
          message: 'User does not have a valid role in the Hive community on the blockchain.'
        });
      }

      // For other errors (network issues, etc.), return success with warning
      console.warn('Blockchain verification failed:', blockchainVerification.error);
      return res.json({
        authorized_driver: true,
        community: {
          id: driverCommunity.community,
          name: communityDetails?.name || driverCommunity.community,
          role: driverCommunity.role,
          blockchain_verified: false,
          blockchain_error: 'Unable to verify on Hive blockchain'
        }
      });
    }

    // Return success response with blockchain-verified information
    return res.json({
      authorized_driver: true,
      community: {
        id: driverCommunity.community,
        name: communityDetails?.name || driverCommunity.community,
        role: driverCommunity.role,
        blockchain_verified: true,
        blockchain_role: blockchainVerification.role
      }
    });

  } catch (error) {
    console.error('Error in /api/drivers/hive-info:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to verify driver information'
    });
  }
});

/**
 * @swagger
 * /api/drivers/profile:
 *   get:
 *     summary: Get authenticated driver's profile
 *     tags: [Drivers]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Driver profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: integer
 *                 hiveUsername:
 *                   type: string
 *                 displayName:
 *                   type: string
 *                 phone:
 *                   type: string
 *                 licenseNumber:
 *                   type: string
 *                 status:
 *                   type: string
 *                 rating:
 *                   type: number
 *                 totalTrips:
 *                   type: integer
 *                 vehicles:
 *                   type: array
 *                 primaryVehicle:
 *                   type: object
 *                 location:
 *                   type: object
 *                   properties:
 *                     lat:
 *                       type: number
 *                     lng:
 *                       type: number
 *                 isOnline:
 *                   type: boolean
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Driver not found
 *       500:
 *         description: Internal server error
 */
// GET /api/drivers/profile - Get driver profile
router.get('/profile', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;
    if (!driverId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // Fetch from database by ID
    const user = await userDb.getUserById(driverId, true);
    if(!user) {
      console.warn(`Driver profile not found for ID: ${driverId}`);
      return res.status(404).json({ error: 'Driver not found' });
    }
    if (user.type !== 'driver') {
      console.warn(`User ID: ${driverId} is not a driver`);
      return res.status(404).json({ error: 'User is not a driver' });
    }
    res.json({
      id: user.id,
      hiveUsername: user.hive_username,
      displayName: user.display_name,
      phone: user.phone_number,
      licenseNumber: user.license_number,
      status: user.status || 'active',
      rating: user.rating,
      totalTrips: user.completed_trips,
      vehicles: user.vehicles || [],
      primaryVehicle: user.primaryVehicle || null,
      location: {
        lat: user.last_lat,
        lng: user.last_long
      },
      isOnline: user.is_online
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * @swagger
 * /api/drivers/profile:
 *   put:
 *     summary: Update authenticated driver's profile
 *     tags: [Drivers]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName:
 *                 type: string
 *               phone:
 *                 type: string
 *               licenseNumber:
 *                 type: string
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *       400:
 *         description: No valid fields to update
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
// PUT /api/drivers/profile - Update driver profile
router.put('/profile', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;

    console.log('Profile update request body:', req.body);

    const { displayName, email, phone, licenseNumber } = req.body;
    // TODO: Validate input

    // Update driver in database using driverId
    // We'll assume driverId is the primary key (id) in the drivers table
    // If you use hive_username as the key, adjust accordingly
    // Note: Vehicle updates should now go through /api/drivers/vehicles endpoint
    const updates = {};
    if (displayName !== undefined) updates.display_name = displayName;
    if (phone !== undefined) updates.phone_number = phone;
    if (licenseNumber !== undefined) updates.license_number = licenseNumber;

    
    console.log('Updates object:', updates);
    if (Object.keys(updates).length === 0) {
      console.warn('No valid fields to update');
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    try {
      await userDb.updateUserById(driverId, updates);
    } catch (dbError) {
      console.error('Database update error:', dbError);
      return res.status(500).json({ error: 'Database update failed', details: dbError.message });
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Profile update route error:', error);
    res.status(500).json({ error: 'Profile update failed', details: error.message });
  }
});

/**
 * @swagger
 * /api/drivers/location:
 *   post:
 *     summary: Update driver's current location
 *     description: Updates driver location in Redis GEO set and sets last seen timestamp
 *     tags: [Drivers]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - latitude
 *               - longitude
 *             properties:
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               speed:
 *                 type: number
 *               timestamp:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Location updated successfully
 *       400:
 *         description: Latitude and longitude are required
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
// POST /api/drivers/location - Update driver location
router.post('/location', authenticateJWT, async (req, res) => {
  console.log('POST /api/drivers/location - Request body:', req.body);
  try {
    const driverId = req.user.driverId;
    console.log('Authenticated driverId:', driverId);
    if (!driverId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { latitude, longitude, speed, timestamp } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({
        error: 'Latitude and longitude are required'
      });
    }

    await redisClient.geoAdd('drivers:online', {
      longitude: longitude,
      latitude: latitude,
      member: `driver:${driverId}`
    });
    // Set/update last seen timestamp for this driver (as a separate key with 5 min TTL)
    await redisClient.sendCommand(['SET', `driver:last_seen:${driverId}`, Date.now().toString()]);
    await redisClient.sendCommand(['EXPIRE', `driver:last_seen:${driverId}`, '300']);
    // TODO: Update location in database
    // await userDb.updateUserById(driverId, { last_lat: latitude, last_long: longitude });
    res.json({
      message: 'Location updated',
      location: {
        latitude,
        longitude,
        speed: speed || null,
        timestamp: timestamp
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Location update failed' });
  }
});

/**
 * @swagger
 * /api/drivers/online-status:
 *   put:
 *     summary: Set driver online/offline status
 *     tags: [Drivers]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - isOnline
 *             properties:
 *               isOnline:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Status updated successfully
 *       400:
 *         description: isOnline must be a boolean value
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
// PUT /api/drivers/online-status - Set driver online/offline in Redis only
router.put('/online-status', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;
    const { isOnline } = req.body;
    if (typeof isOnline !== 'boolean') {
      return res.status(400).json({ error: 'isOnline must be a boolean value' });
    }
    if (!isOnline) {
      // Remove driver from Redis GEO set
      await redisClient.zRem('drivers:online', `driver:${driverId}`);
      console.log(`Driver ${driverId} set to offline and removed from Redis.`);
    } else {
      // Do nothing, location updates handle online status
      console.log(`Driver ${driverId} set to online (no Redis action, handled by location updates).`);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error('Online status update error:', error);
    res.status(500).json({ error: 'Status update failed', details: error.message });
  }
});

/**
 * @swagger
 * /api/drivers/earnings:
 *   get:
 *     summary: Get driver earnings
 *     tags: [Drivers]
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [week, month, year]
 *         description: Period for earnings calculation
 *     responses:
 *       200:
 *         description: Earnings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 period:
 *                   type: string
 *                 totalEarnings:
 *                   type: number
 *                 tripCount:
 *                   type: integer
 *                 averagePerTrip:
 *                   type: number
 *                 breakdown:
 *                   type: object
 *                 dateRange:
 *                   type: object
 *       500:
 *         description: Internal server error
 */
// GET /api/drivers/earnings - Get driver earnings
router.get('/earnings', (req, res) => {
  try {
    const { period = 'week' } = req.query; // week, month, year
    
    // TODO: Calculate from database
    res.json({
      period,
      totalEarnings: 1250.50,
      tripCount: 45,
      averagePerTrip: 27.79,
      breakdown: {
        fare: 1100.00,
        tips: 120.50,
        bonuses: 30.00
      },
      dateRange: {
        start: '2025-07-14T00:00:00Z',
        end: '2025-07-20T23:59:59Z'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

/**
 * @swagger
 * /api/drivers/stats:
 *   get:
 *     summary: Get driver statistics
 *     tags: [Drivers]
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalTrips:
 *                   type: integer
 *                 rating:
 *                   type: number
 *                 acceptanceRate:
 *                   type: integer
 *                 cancellationRate:
 *                   type: integer
 *                 completionRate:
 *                   type: integer
 *                 totalDistance:
 *                   type: number
 *                 totalDriveTime:
 *                   type: number
 *                 thisWeek:
 *                   type: object
 *       500:
 *         description: Internal server error
 */
// GET /api/drivers/stats - Get driver statistics
router.get('/stats', (req, res) => {
  try {
    // TODO: Fetch from database
    res.json({
      totalTrips: 156,
      rating: 4.8,
      acceptanceRate: 92,
      cancellationRate: 3,
      completionRate: 97,
      totalDistance: 2847.5, // km
      totalDriveTime: 145.2, // hours
      thisWeek: {
        trips: 12,
        earnings: 340.75,
        hours: 8.5
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * @swagger
 * /api/drivers/documents:
 *   get:
 *     summary: Get driver documents verification status
 *     tags: [Drivers]
 *     responses:
 *       200:
 *         description: Documents status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 driverLicense:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [approved, pending, rejected]
 *                     expiryDate:
 *                       type: string
 *                       format: date
 *                     uploadedAt:
 *                       type: string
 *                       format: date-time
 *                 vehicleRegistration:
 *                   type: object
 *                 insurance:
 *                   type: object
 *                 backgroundCheck:
 *                   type: object
 *       500:
 *         description: Internal server error
 */
// GET /api/drivers/documents - Get driver documents status
router.get('/documents', (req, res) => {
  try {
    // TODO: Fetch from database
    res.json({
      driverLicense: {
        status: 'approved',
        expiryDate: '2027-06-15',
        uploadedAt: '2025-01-15T10:30:00Z'
      },
      vehicleRegistration: {
        status: 'approved',
        expiryDate: '2026-03-20',
        uploadedAt: '2025-01-15T10:35:00Z'
      },
      insurance: {
        status: 'pending',
        expiryDate: '2026-01-01',
        uploadedAt: '2025-07-18T14:20:00Z'
      },
      backgroundCheck: {
        status: 'approved',
        completedAt: '2025-01-20T09:15:00Z'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

/**
 * @swagger
 * /api/drivers/nearby:
 *   get:
 *     summary: Find drivers within a radius
 *     description: Retrieves nearby online drivers based on geographic coordinates
 *     tags: [Drivers]
 *     parameters:
 *       - in: query
 *         name: latitude
 *         schema:
 *           type: number
 *         required: true
 *         description: Search center latitude
 *       - in: query
 *         name: longitude
 *         schema:
 *           type: number
 *         required: true
 *         description: Search center longitude
 *       - in: query
 *         name: radius
 *         schema:
 *           type: number
 *           default: 5
 *         description: Search radius
 *       - in: query
 *         name: unit
 *         schema:
 *           type: string
 *           enum: [m, km, mi, ft]
 *           default: km
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Nearby drivers retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 drivers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       driverId:
 *                         type: string
 *                       distance:
 *                         type: number
 *                       latitude:
 *                         type: number
 *                       longitude:
 *                         type: number
 *                 count:
 *                   type: integer
 *                 search:
 *                   type: object
 *       400:
 *         description: Latitude and longitude are required
 *       500:
 *         description: Internal server error
 */
// GET /api/drivers/nearby - Find drivers within a radius
router.get('/nearby', async (req, res) => {
  try {
    const { latitude, longitude, radius = 5, unit = 'km', limit = 20 } = req.query;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }
    let drivers;
    try {
      drivers = await redisClient.georadius(
        'drivers:online',
        parseFloat(longitude),
        parseFloat(latitude),
        parseFloat(radius),
        unit,
        'WITHDIST',
        'WITHCOORD',
        'COUNT',
        parseInt(limit),
        'ASC'
      );
    } catch (err) {
      console.error('Redis georadius error:', err);
      return res.status(500).json({ error: 'Failed to query nearby drivers' });
    }
    // Filter out drivers with stale last_seen
    const now = Date.now();
    const filtered = [];
    for (const [member, distance, [lng, lat]] of drivers) {
      const driverId = member.replace('driver:', '');
      const lastSeen = await redisClient.sendCommand(['GET', `driver:last_seen:${driverId}`]);
      if (!lastSeen || now - parseInt(lastSeen) > 5 * 60 * 1000) {
        // Remove from Redis GEO set if stale
        await redisClient.zRem('drivers:online', member);
        continue;
      }
      filtered.push({
        driverId,
        distance: parseFloat(distance),
        latitude: parseFloat(lat),
        longitude: parseFloat(lng)
      });
    }
    res.json({
      drivers: filtered,
      count: filtered.length,
      search: { latitude: parseFloat(latitude), longitude: parseFloat(longitude), radius: parseFloat(radius), unit, limit: parseInt(limit) }
    });
  } catch (error) {
    console.error('Nearby drivers route error:', error);
    res.status(500).json({ error: 'Failed to fetch nearby drivers' });
  }
});

module.exports = router;

/**
 * @swagger
 * /api/drivers/verify/{username}:
 *   get:
 *     summary: Verify driver authorization and community membership
 *     description: Checks if user is a driver with valid role in required Hive community
 *     tags: [Drivers]
 *     parameters:
 *       - in: path
 *         name: username
 *         schema:
 *           type: string
 *         required: true
 *         description: The Hive username of the driver
 *     responses:
 *       200:
 *         description: Driver verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 username:
 *                   type: string
 *                 authorized:
 *                   type: boolean
 *                 community:
 *                   type: string
 *                 role:
 *                   type: string
 *       400:
 *         description: Username is required
 *       401:
 *         description: User is not an authorized driver
 *       403:
 *         description: User not member or invalid role
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
// Driver & community verification route (placed after module.exports originally, move above if needed)
// GET /api/drivers/verify/:username
router.get('/verify/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const REQUIRED_COMMUNITY = process.env.REQUIRED_HIVE_COMMUNITY; // e.g. 'hive-xxxxx'
    if (!username) {
      return res.status(400).json({ error: 'Username is required', code: 'USERNAME_REQUIRED' });
    }
    // Fetch user
    const user = await userDb.getUserByUsername(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    // Check driver authorization (type === 'driver')
    const isDriver = user.type === 'driver';
    if (!isDriver) {
      return res.status(401).json({ error: 'User is not an authorized driver', code: 'DRIVER_NOT_AUTHORIZED' });
    }
    if (!REQUIRED_COMMUNITY) {
      return res.status(500).json({ error: 'Required community not configured', code: 'COMMUNITY_ENV_MISSING' });
    }
    // Look up role within required community
    const roleRow = await communitiesDb.getUserCommunityRole(username, REQUIRED_COMMUNITY);
    if (!roleRow) {
      return res.status(403).json({
        error: 'User is not a member of required Hive community',
        expectedCommunity: REQUIRED_COMMUNITY,
        code: 'COMMUNITY_MEMBERSHIP_REQUIRED'
      });
    }
    const role = roleRow.role;
    if (role !== 'Driver') {
      return res.status(403).json({
        error: 'User does not have Driver role in community',
        community: REQUIRED_COMMUNITY,
        role,
        code: 'INVALID_COMMUNITY_ROLE'
      });
    }
    return res.json({
      username,
      authorized: true,
      community: REQUIRED_COMMUNITY,
      role
    });
  } catch (err) {
    console.error('[drivers.verify] Error:', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});
// Vehicle management routes

/**
 * @swagger
 * /api/drivers/vehicles:
 *   get:
 *     summary: Get all vehicles for authenticated driver
 *     tags: [Drivers]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Vehicles retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 vehicles:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       make:
 *                         type: string
 *                       model:
 *                         type: string
 *                       year:
 *                         type: integer
 *                       color:
 *                         type: string
 *                       plateNumber:
 *                         type: string
 *                       vehicleType:
 *                         type: string
 *                       seats:
 *                         type: integer
 *                       isPrimary:
 *                         type: boolean
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                 count:
 *                   type: integer
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
// GET /api/drivers/vehicles - Get all vehicles for the authenticated driver
router.get('/vehicles', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;
    const vehicles = await vehiclesDb.getVehiclesByUserId(driverId);
    
    res.json({
      message: 'Vehicles retrieved successfully',
      vehicles: vehicles.map(v => ({
        id: v.id,
        make: v.make,
        model: v.model,
        year: v.year,
        color: v.color,
        plateNumber: v.plate_number,
        vehicleType: v.vehicle_type,
        seats: v.seats,
        isPrimary: v.is_primary,
        createdAt: v.created_at,
        updatedAt: v.updated_at
      })),
      count: vehicles.length
    });
  } catch (error) {
    console.error('Error fetching vehicles:', error);
    res.status(500).json({ 
      error: 'Failed to fetch vehicles', 
      details: error.message 
    });
  }
});

/**
 * @swagger
 * /api/drivers/vehicles:
 *   post:
 *     summary: Add a new vehicle
 *     tags: [Drivers]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - make
 *               - model
 *             properties:
 *               make:
 *                 type: string
 *               model:
 *                 type: string
 *               year:
 *                 type: integer
 *               color:
 *                 type: string
 *               plateNumber:
 *                 type: string
 *               vehicleType:
 *                 type: string
 *               seats:
 *                 type: integer
 *                 default: 4
 *               isPrimary:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Vehicle added successfully
 *       400:
 *         description: Missing required fields
 *       401:
 *         description: Authentication required
 *       409:
 *         description: Duplicate plate number
 *       500:
 *         description: Internal server error
 */
// POST /api/drivers/vehicles - Add a new vehicle
router.post('/vehicles', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;
    const { make, model, year, color, plateNumber, vehicleType, seats, isPrimary } = req.body;

    // Validation
    if (!make || !model) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'Make and model are required'
      });
    }

    const vehicle = await vehiclesDb.createVehicle({
      userId: driverId,
      make,
      model,
      year: year || null,
      color: color || null,
      plateNumber: plateNumber || null,
      vehicleType: vehicleType || null,
      seats: seats || 4,
      isPrimary: isPrimary || false
    });

    res.status(201).json({
      message: 'Vehicle added successfully',
      vehicle: {
        id: vehicle.id,
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
        color: vehicle.color,
        plateNumber: vehicle.plate_number,
        vehicleType: vehicle.vehicle_type,
        seats: vehicle.seats,
        isPrimary: vehicle.is_primary,
        createdAt: vehicle.created_at
      }
    });
  } catch (error) {
    console.error('Error adding vehicle:', error);
    
    // Handle unique constraint violation for plate number
    if (error.code === '23505' && error.constraint === 'vehicles_plate_number_key') {
      return res.status(409).json({
        error: 'DUPLICATE_PLATE',
        message: 'A vehicle with this plate number already exists'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to add vehicle', 
      details: error.message 
    });
  }
});

/**
 * @swagger
 * /api/drivers/vehicles/{id}:
 *   get:
 *     summary: Get a specific vehicle
 *     tags: [Drivers]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Vehicle ID
 *     responses:
 *       200:
 *         description: Vehicle retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vehicle:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     make:
 *                       type: string
 *                     model:
 *                       type: string
 *                     year:
 *                       type: integer
 *                     color:
 *                       type: string
 *                     plateNumber:
 *                       type: string
 *                     vehicleType:
 *                       type: string
 *                     seats:
 *                       type: integer
 *                     isPrimary:
 *                       type: boolean
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Invalid vehicle ID
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Access denied
 *       404:
 *         description: Vehicle not found
 *       500:
 *         description: Internal server error
 */
// GET /api/drivers/vehicles/:id - Get a specific vehicle
router.get('/vehicles/:id', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;
    const vehicleId = parseInt(req.params.id);

    if (isNaN(vehicleId)) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    const vehicle = await vehiclesDb.getVehicleById(vehicleId);

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    // Verify the vehicle belongs to this driver
    if (vehicle.user_id !== driverId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      vehicle: {
        id: vehicle.id,
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
        color: vehicle.color,
        plateNumber: vehicle.plate_number,
        vehicleType: vehicle.vehicle_type,
        seats: vehicle.seats,
        isPrimary: vehicle.is_primary,
        createdAt: vehicle.created_at,
        updatedAt: vehicle.updated_at
      }
    });
  } catch (error) {
    console.error('Error fetching vehicle:', error);
    res.status(500).json({ 
      error: 'Failed to fetch vehicle', 
      details: error.message 
    });
  }
});

/**
 * @swagger
 * /api/drivers/vehicles/{id}:
 *   put:
 *     summary: Update a vehicle
 *     tags: [Drivers]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Vehicle ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               make:
 *                 type: string
 *               model:
 *                 type: string
 *               year:
 *                 type: integer
 *               color:
 *                 type: string
 *               plateNumber:
 *                 type: string
 *               vehicleType:
 *                 type: string
 *               seats:
 *                 type: integer
 *               isPrimary:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Vehicle updated successfully
 *       400:
 *         description: Invalid vehicle ID or no fields to update
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Access denied
 *       404:
 *         description: Vehicle not found
 *       409:
 *         description: Duplicate plate number
 *       500:
 *         description: Internal server error
 */
// PUT /api/drivers/vehicles/:id - Update a vehicle
router.put('/vehicles/:id', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;
    const vehicleId = parseInt(req.params.id);

    if (isNaN(vehicleId)) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    // Verify the vehicle belongs to this driver
    const existingVehicle = await vehiclesDb.getVehicleById(vehicleId);
    if (!existingVehicle) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    if (existingVehicle.user_id !== driverId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { make, model, year, color, plateNumber, vehicleType, seats, isPrimary } = req.body;

    const updates = {};
    if (make !== undefined) updates.make = make;
    if (model !== undefined) updates.model = model;
    if (year !== undefined) updates.year = year;
    if (color !== undefined) updates.color = color;
    if (plateNumber !== undefined) updates.plate_number = plateNumber;
    if (vehicleType !== undefined) updates.vehicle_type = vehicleType;
    if (seats !== undefined) updates.seats = seats;
    if (isPrimary !== undefined) updates.is_primary = isPrimary;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const updatedVehicle = await vehiclesDb.updateVehicle(vehicleId, updates);

    res.json({
      message: 'Vehicle updated successfully',
      vehicle: {
        id: updatedVehicle.id,
        make: updatedVehicle.make,
        model: updatedVehicle.model,
        year: updatedVehicle.year,
        color: updatedVehicle.color,
        plateNumber: updatedVehicle.plate_number,
        vehicleType: updatedVehicle.vehicle_type,
        seats: updatedVehicle.seats,
        isPrimary: updatedVehicle.is_primary,
        updatedAt: updatedVehicle.updated_at
      }
    });
  } catch (error) {
    console.error('Error updating vehicle:', error);
    
    // Handle unique constraint violation for plate number
    if (error.code === '23505' && error.constraint === 'vehicles_plate_number_key') {
      return res.status(409).json({
        error: 'DUPLICATE_PLATE',
        message: 'A vehicle with this plate number already exists'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to update vehicle', 
      details: error.message 
    });
  }
});

/**
 * @swagger
 * /api/drivers/vehicles/{id}:
 *   delete:
 *     summary: Delete a vehicle
 *     tags: [Drivers]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Vehicle ID
 *     responses:
 *       200:
 *         description: Vehicle deleted successfully
 *       400:
 *         description: Invalid vehicle ID
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Access denied
 *       404:
 *         description: Vehicle not found
 *       500:
 *         description: Internal server error
 */
// DELETE /api/drivers/vehicles/:id - Delete a vehicle
router.delete('/vehicles/:id', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;
    const vehicleId = parseInt(req.params.id);

    if (isNaN(vehicleId)) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    // Verify the vehicle belongs to this driver
    const existingVehicle = await vehiclesDb.getVehicleById(vehicleId);
    if (!existingVehicle) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    if (existingVehicle.user_id !== driverId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await vehiclesDb.deleteVehicle(vehicleId);

    res.json({ message: 'Vehicle deleted successfully' });
  } catch (error) {
    console.error('Error deleting vehicle:', error);
    res.status(500).json({ 
      error: 'Failed to delete vehicle', 
      details: error.message 
    });
  }
});

/**
 * @swagger
 * /api/drivers/vehicles/{id}/primary:
 *   put:
 *     summary: Set a vehicle as primary
 *     tags: [Drivers]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Vehicle ID
 *     responses:
 *       200:
 *         description: Primary vehicle set successfully
 *       400:
 *         description: Invalid vehicle ID
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Access denied
 *       404:
 *         description: Vehicle not found
 *       500:
 *         description: Internal server error
 */
// PUT /api/drivers/vehicles/:id/primary - Set a vehicle as primary
router.put('/vehicles/:id/primary', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;
    const vehicleId = parseInt(req.params.id);

    if (isNaN(vehicleId)) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    // Verify the vehicle belongs to this driver
    const existingVehicle = await vehiclesDb.getVehicleById(vehicleId);
    if (!existingVehicle) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    if (existingVehicle.user_id !== driverId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updatedVehicle = await vehiclesDb.setPrimaryVehicle(driverId, vehicleId);

    res.json({
      message: 'Primary vehicle set successfully',
      vehicle: {
        id: updatedVehicle.id,
        make: updatedVehicle.make,
        model: updatedVehicle.model,
        isPrimary: updatedVehicle.is_primary
      }
    });
  } catch (error) {
    console.error('Error setting primary vehicle:', error);
    res.status(500).json({ 
      error: 'Failed to set primary vehicle', 
      details: error.message 
    });
  }
});