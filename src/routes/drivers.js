const express = require('express');
const router = express.Router();
const axios = require('axios');
const userDb = require('../db/users'); // updated import
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

// GET /api/drivers/profile - Get driver profile
router.get('/profile', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;
    if (!driverId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // Fetch from database
    const user = await userDb.getUserByUsername(req.user.hiveUsername);
    if (!user || user.type !== 'driver') {
      return res.status(404).json({ error: 'Driver not found' });
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
      vehicle: user.vehicle,
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

// PUT /api/drivers/profile - Update driver profile
router.put('/profile', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;

    console.log('Profile update request body:', req.body);

    const { displayName, email, phone, licenseNumber, vehicle } = req.body;
    // TODO: Validate input

    // Update driver in database using driverId
    // We'll assume driverId is the primary key (id) in the drivers table
    // If you use hive_username as the key, adjust accordingly
    // We'll update first_name, last_name, phone_number, and vehicle fields
    const updates = {};
    if (displayName !== undefined) updates.display_name = displayName;
    if (phone !== undefined) updates.phone_number = phone;
    if (vehicle !== undefined) updates.vehicle = vehicle;
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
