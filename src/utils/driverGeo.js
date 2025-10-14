// src/utils/driverGeo.js
// Utility for finding nearby drivers and filtering out stale ones using Redis GEO

const redisClient = require('../db/redis');

/**
 * Find nearby drivers using Redis GEO and filter out stale drivers
 * @param {Object} params
 * @param {number} params.lat - Latitude
 * @param {number} params.lng - Longitude
 * @param {number} [params.radius=5] - Radius in km
 * @param {number} [params.count=10] - Max number of drivers
 * @returns {Promise<Array>} Array of fresh driver objects
 */
async function findFreshNearbyDrivers({ lat, lng, radius = 5, count = 10 }) {
  let nearbyDrivers = [];
  try {
    const drivers = await redisClient.sendCommand([
      'GEORADIUS',
      'drivers:online',
      lng.toString(),
      lat.toString(),
      radius.toString(),
      'km',
      'WITHDIST',
      'WITHCOORD',
      'COUNT',
      count.toString(),
      'ASC'
    ]);
    nearbyDrivers = drivers.map(([member, distance, [lng, lat]]) => ({
      driverId: member.replace('driver:', ''),
      distance: parseFloat(distance),
      latitude: parseFloat(lat),
      longitude: parseFloat(lng)
    }));
  } catch (err) {
    console.error('Redis georadius error:', err);
  }
  // Filter out stale drivers (those without a valid last-seen key in Redis)
  const freshDrivers = [];
  for (const driver of nearbyDrivers) {
    const lastSeenKey = `driver:last_seen:${driver.driverId}`;
    const lastSeen = await redisClient.sendCommand(['GET', lastSeenKey]);
    if (lastSeen) {
      freshDrivers.push(driver);
    } else {
      // Remove stale driver from Redis GEO set
      await redisClient.sendCommand(['ZREM', 'drivers:online', `driver:${driver.driverId}`]);
    }
  }
  return freshDrivers;
}

module.exports = {
  findFreshNearbyDrivers
};
