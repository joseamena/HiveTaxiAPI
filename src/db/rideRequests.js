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
  estimatedFare,
  priority = 'normal',
  requestTime = new Date().toISOString(),
  status = 'pending'
}) {
  const result = await pool.query(
    `INSERT INTO ride_requests (
      passenger_id, passenger_name, passenger_phone,
      pickup_lat, pickup_lng, pickup_address,
      dropoff_lat, dropoff_lng, dropoff_address,
      estimated_distance, estimated_duration, estimated_fare,
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
      estimatedFare,
      priority,
      requestTime,
      status
    ]
  );
  return result.rows[0];
}

module.exports = {
  createRideRequest
};
