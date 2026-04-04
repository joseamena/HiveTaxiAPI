// src/services/rideCleanup.js
const pool = require('../db');
const redisClient = require('../db/redis');

const PENDING_TTL_SECONDS = 600; // matches Redis ride:request:{id}:status TTL for pending
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

async function cleanupStaleRides() {
  try {
    await cleanupStalePending();
    await cleanupStaleActiveRides();
  } catch (err) {
    console.error('[rideCleanup] Error during cleanup:', err);
  }
}

async function cleanupStalePending() {
  const result = await pool.query(
    `UPDATE ride_requests SET status = 'expired'
     WHERE status = 'pending'
       AND request_time < NOW() - INTERVAL '${PENDING_TTL_SECONDS} seconds'
     RETURNING id`
  );
  if (result.rowCount > 0) {
    console.log(`[rideCleanup] Expired ${result.rowCount} stale pending ride(s): ${result.rows.map(r => r.id).join(', ')}`);
  }
}

async function cleanupStaleActiveRides() {
  const result = await pool.query(
    `SELECT id, driver_id FROM ride_requests
     WHERE status IN ('accepted', 'in_transit') AND driver_id IS NOT NULL`
  );

  for (const ride of result.rows) {
    const lastSeen = await redisClient.sendCommand(['GET', `driver:last_seen:${ride.driver_id}`]);
    if (!lastSeen) {
      await pool.query(
        `UPDATE ride_requests SET status = 'interrupted' WHERE id = $1`,
        [ride.id]
      );
      console.log(`[rideCleanup] Marked ride ${ride.id} as interrupted (driver ${ride.driver_id} offline)`);
    }
  }
}

function startCleanupJob() {
  console.log('[rideCleanup] Starting ride cleanup job');
  cleanupStaleRides(); // run immediately on startup
  setInterval(cleanupStaleRides, CLEANUP_INTERVAL_MS);
}

module.exports = { startCleanupJob };
