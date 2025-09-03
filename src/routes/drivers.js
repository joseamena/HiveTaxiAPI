const express = require('express');
const router = express.Router();
const userDb = require('../db/users'); // updated import
const redisClient = require('../db/redis');
const authenticateJWT = require('../middleware/auth');


// Driver management routes

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

// PUT /api/drivers/online-status - Set driver online status
router.put('/online-status', authenticateJWT, async (req, res) => {
  try {
    const driverId = req.user.driverId;

    const { isOnline } = req.body;
    
    if (typeof isOnline !== 'boolean') {
      return res.status(400).json({
        error: 'isOnline must be a boolean value'
      });
    }

    // Update online status in database
    try {
      await userDb.updateUserById(driverId, { is_online: isOnline });
    } catch (dbError) {
      console.error('Database update error:', dbError);
      return res.status(500).json({ error: 'Status update failed', details: dbError.message });
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
    // Use Redis GEOSEARCH (or GEORADIUS for older Redis)
    // Note: redisClient.geoRadius or geoSearch depending on your redis client version
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
    // Format response
    const result = drivers.map(([member, distance, [lng, lat]]) => ({
      driverId: member.replace('driver:', ''),
      distance: parseFloat(distance),
      latitude: parseFloat(lat),
      longitude: parseFloat(lng)
    }));
    res.json({
      drivers: result,
      count: result.length,
      search: { latitude: parseFloat(latitude), longitude: parseFloat(longitude), radius: parseFloat(radius), unit, limit: parseInt(limit) }
    });
  } catch (error) {
    console.error('Nearby drivers route error:', error);
    res.status(500).json({ error: 'Failed to fetch nearby drivers' });
  }
});

module.exports = router;
