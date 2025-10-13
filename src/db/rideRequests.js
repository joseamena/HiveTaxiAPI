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
 */
async function updateRideRequestStatus(id, status) {
  const result = await pool.query(
    `UPDATE ride_requests SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return result.rows[0];
}

/**
 * Get the active ride request for a driver
 */
async function getActiveRideRequestForDriver(driverId) {
  const result = await pool.query(
    `SELECT * FROM ride_requests WHERE status = 'accepted' AND driver_id = $1 ORDER BY request_time DESC LIMIT 1`,
    [driverId]
  );
  return result.rows[0];
}

module.exports = {
  createRideRequest,
  getRideRequestById,
  updateRideRequestStatus,
  getActiveRideRequestForDriver
};
