// src/db/rideRequests.js
const pool = require('./index');

/**
 * Create a new ride request
 */
async function createRideRequest({
  passengerId,
  pickup,
  dropoff,
  estimatedDistance,
  estimatedDuration,
  proposedFare,
  priority = 'normal',
  requestTime = new Date().toISOString(),
  status = 'pending'
}) {
  const result = await pool.query(
    `INSERT INTO ride_requests (
      passenger_id,
      pickup_lat, pickup_lng, pickup_address,
      dropoff_lat, dropoff_lng, dropoff_address,
      estimated_distance, estimated_duration, proposed_fare,
      priority, request_time, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *`,
    [
      passengerId,
      pickup.lat,
      pickup.lng,
      pickup.address,
      dropoff.lat,
      dropoff.lng,
      dropoff.address,
      estimatedDistance,
      estimatedDuration,
      proposedFare,
      priority,
      requestTime,
      status
    ]
  );
  return result.rows[0];
}

/**
 * Get a ride request by ID
 */
async function getRideRequestById(id) {
  const result = await pool.query(
    `SELECT * FROM ride_requests WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

/**
 * Update ride request status by ID
 * Sets completed_at timestamp when status is 'completed'
 */
async function updateRideRequestStatus(id, status) {
  // If completing the ride, also set the completed_at timestamp
  if (status === 'completed') {
    const result = await pool.query(
      `UPDATE ride_requests SET status = $1, completed_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return result.rows[0];
  }
  
  const result = await pool.query(
    `UPDATE ride_requests SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return result.rows[0];
}

/**
 * Get the active ride request for a driver.
 * Queries the ride_requests table using the driver_id column (added 2026-02-14).
 * @param {number|string} driverId - The driver's user ID
 * @returns {Promise<Object|null>} The active ride request, or null if none
 */
async function getActiveRideRequestForDriver(driverId) {
  const result = await pool.query(
    `SELECT * FROM ride_requests
     WHERE driver_id = $1
       AND status NOT IN ('completed', 'cancelled', 'interrupted', 'expired')
     ORDER BY request_time DESC
     LIMIT 1`,
    [driverId]
  );
  return result.rows[0] || null;
}

/**
 * Assign a driver to a ride request
 * @param {number|string} requestId - The ride request ID
 * @param {number|string} driverId - The driver's user ID
 * @returns {Promise<Object>} The updated ride request
 */
async function assignDriverToRideRequest(requestId, driverId) {
  const result = await pool.query(
    `UPDATE ride_requests SET driver_id = $1 WHERE id = $2 RETURNING *`,
    [driverId, requestId]
  );
  return result.rows[0];
}

/**
 * Save driver responses from Redis to the database when a trip ends.
 * @param {number|string} rideRequestId
 * @param {Array<{driverId: string, response: string, timestamp: string}>} responses - parsed Redis list entries
 */
async function saveDriverResponses(rideRequestId, responses) {
  if (!responses || responses.length === 0) return;
  const values = responses.map((r, i) =>
    `(${parseInt(rideRequestId)}, ${parseInt(r.driverId)}, '${r.response}', ${i + 1}, '${r.timestamp}')`
  ).join(', ');
  await pool.query(
    `INSERT INTO driver_responses (ride_request_id, driver_id, response, queue_position, responded_at)
     VALUES ${values}
     ON CONFLICT DO NOTHING`
  );
}

module.exports = {
  createRideRequest,
  getRideRequestById,
  updateRideRequestStatus,
  getActiveRideRequestForDriver,
  assignDriverToRideRequest,
  saveDriverResponses
};
