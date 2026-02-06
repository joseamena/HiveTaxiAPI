// src/db/rideRequests.js
const pool = require('./index');

/**
 * Create a new ride request
 */
async function createRideRequest({
  passengerId,
  passengerName,
  passengerPhone,
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
      passenger_id, passenger_name, passenger_phone,
      pickup_lat, pickup_lng, pickup_address,
      dropoff_lat, dropoff_lng, dropoff_address,
      estimated_distance, estimated_duration, proposed_fare,
      priority, request_time, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING *`,
    [
      passengerId,
      passengerName,
      passengerPhone,
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
 * Get the active ride request for a driver
 * NOTE: Driver assignments are stored in Redis, not in the ride_requests table.
 * This function is deprecated - use Redis key `ride:request:${requestId}:driver` instead.
 * @deprecated
 */
async function getActiveRideRequestForDriver(driverId) {
  console.warn('[DEPRECATED] getActiveRideRequestForDriver: driver_id is stored in Redis, not PostgreSQL');
  // This query won't work as driver_id column doesn't exist
  // Keeping for backwards compatibility but it will return undefined
  return undefined;
}

module.exports = {
  createRideRequest,
  getRideRequestById,
  updateRideRequestStatus,
  getActiveRideRequestForDriver
};
