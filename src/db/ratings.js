// src/db/ratings.js
const pool = require('./index');

/**
 * Create a new rating for a completed ride
 * @param {Object} params - Rating parameters
 * @param {number} params.rideRequestId - The ride request ID
 * @param {number} params.raterId - The user ID of the person giving the rating
 * @param {number} params.ratedId - The user ID of the person being rated
 * @param {string} params.ratingType - Either 'rider_to_driver' or 'driver_to_rider'
 * @param {number} params.score - Rating score from 1-5
 * @param {string} [params.comment] - Optional comment/review
 * @param {string} [params.permlink] - Optional Hive blockchain permlink for the review
 * @param {string} [params.parentPermlink] - Optional Hive blockchain permlink of the parent post being replied to
 * @param {string} [params.status] - Rating status: 'pending', 'awaiting_reply', or 'completed'
 * @returns {Promise<Object>} The created rating
 */
async function createRating({ rideRequestId, raterId, ratedId, ratingType, score, comment, permlink, parentPermlink, status = 'completed' }) {
  const result = await pool.query(
    `INSERT INTO ratings (ride_request_id, rater_id, rated_id, rating_type, score, comment, permlink, parent_permlink, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [rideRequestId, raterId, ratedId, ratingType, score || null, comment || null, permlink || null, parentPermlink || null, status]
  );
  
  // Only update aggregate rating if score is provided (not pending)
  if (score) {
    await updateUserAggregateRating(ratedId);
  }
  
  return result.rows[0];
}

/**
 * Create a pending rating entry (no score yet, awaiting blockchain submission)
 * @param {Object} params - Pending rating parameters
 * @param {number} params.rideRequestId - The ride request ID
 * @param {number} params.raterId - The user ID of the person who will give the rating
 * @param {number} params.ratedId - The user ID of the person who will be rated
 * @param {string} params.ratingType - Either 'rider_to_driver' or 'driver_to_rider'
 * @param {string} params.parentPermlink - The Hive permlink the rater should reply to
 * @returns {Promise<Object>} The created pending rating
 */
async function createPendingRating({ rideRequestId, raterId, ratedId, ratingType, parentPermlink }) {
  const result = await pool.query(
    `INSERT INTO ratings (ride_request_id, rater_id, rated_id, rating_type, parent_permlink, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING *`,
    [rideRequestId, raterId, ratedId, ratingType, parentPermlink]
  );
  return result.rows[0];
}

/**
 * Update a pending rating with the submitted review details
 * @param {number} ratingId - The rating ID
 * @param {Object} params - Update parameters
 * @param {number} params.score - Rating score from 1-5
 * @param {string} [params.comment] - Optional comment/review
 * @param {string} params.permlink - The Hive permlink of the submitted review
 * @param {string} [params.status] - New status (default: 'awaiting_reply')
 * @returns {Promise<Object>} The updated rating
 */
async function updateRatingWithReply({ ratingId, score, comment, permlink, status = 'awaiting_reply' }) {
  const result = await pool.query(
    `UPDATE ratings 
     SET score = $1, comment = $2, permlink = $3, status = $4
     WHERE id = $5
     RETURNING *`,
    [score, comment || null, permlink, status, ratingId]
  );
  
  // Update the rated user's aggregate rating now that score is set
  if (result.rows[0] && score) {
    await updateUserAggregateRating(result.rows[0].rated_id);
  }
  
  return result.rows[0];
}

/**
 * Get pending ratings for a user (ratings they need to submit)
 * @param {number} userId - The user ID
 * @param {string} [ratingType] - Filter by rating type ('rider_to_driver' or 'driver_to_rider')
 * @returns {Promise<Array>} Array of pending ratings
 */
async function getPendingRatingsForUser(userId, ratingType = null) {
  let query = `
    SELECT r.*, 
           rq.pickup_address, rq.dropoff_address, rq.completed_at, rq.proposed_fare,
           rated.display_name as rated_name, rated.hive_username as rated_username
    FROM ratings r
    JOIN ride_requests rq ON r.ride_request_id = rq.id
    JOIN users rated ON r.rated_id = rated.id
    WHERE r.rater_id = $1 AND r.status = 'pending'
  `;
  const params = [userId];
  
  if (ratingType) {
    query += ` AND r.rating_type = $2`;
    params.push(ratingType);
  }
  
  query += ` ORDER BY r.created_at DESC`;
  
  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get a pending rating by ride request ID and rating type
 * @param {number} rideRequestId - The ride request ID
 * @param {string} ratingType - Either 'rider_to_driver' or 'driver_to_rider'
 * @returns {Promise<Object|null>} The pending rating or null
 */
async function getPendingRatingByRideAndType(rideRequestId, ratingType) {
  const result = await pool.query(
    `SELECT * FROM ratings 
     WHERE ride_request_id = $1 AND rating_type = $2 AND status = 'pending'`,
    [rideRequestId, ratingType]
  );
  return result.rows[0] || null;
}

/**
 * Update rating status
 * @param {number} ratingId - The rating ID
 * @param {string} status - New status
 * @returns {Promise<Object>} The updated rating
 */
async function updateRatingStatus(ratingId, status) {
  const result = await pool.query(
    `UPDATE ratings SET status = $1 WHERE id = $2 RETURNING *`,
    [status, ratingId]
  );
  return result.rows[0];
}

/**
 * Update parent permlink for a pending rating
 * @param {number} ratingId - The rating ID
 * @param {string} parentPermlink - The parent permlink to set
 * @returns {Promise<Object>} The updated rating
 */
async function updateRatingParentPermlink(ratingId, parentPermlink) {
  const result = await pool.query(
    `UPDATE ratings SET parent_permlink = $1 WHERE id = $2 RETURNING *`,
    [parentPermlink, ratingId]
  );
  return result.rows[0];
}

/**
 * Delete a completed rating (since it now lives on the blockchain)
 * @param {number} ratingId - The rating ID to delete
 * @returns {Promise<Object|null>} The deleted rating or null
 */
async function deleteRating(ratingId) {
  const result = await pool.query(
    `DELETE FROM ratings WHERE id = $1 RETURNING *`,
    [ratingId]
  );
  return result.rows[0] || null;
}

/**
 * Delete ratings by ride request ID only if both parties have completed
 * @param {number} rideRequestId - The ride request ID
 * @returns {Promise<number>} Number of deleted ratings (0 if not both completed)
 */
async function deleteRatingsByRide(rideRequestId) {
  // First check if both ratings exist and are completed
  const checkResult = await pool.query(
    `SELECT rating_type, status 
     FROM ratings 
     WHERE ride_request_id = $1`,
    [rideRequestId]
  );
  
  const ratings = checkResult.rows;
  
  // Check if we have both types and both are completed
  const hasRiderToDriver = ratings.some(r => r.rating_type === 'rider_to_driver' && r.status === 'completed');
  const hasDriverToRider = ratings.some(r => r.rating_type === 'driver_to_rider' && r.status === 'completed');
  
  if (!hasRiderToDriver || !hasDriverToRider) {
    // Not both completed yet, don't delete
    return 0;
  }
  
  // Both are completed, safe to delete
  const result = await pool.query(
    `DELETE FROM ratings WHERE ride_request_id = $1`,
    [rideRequestId]
  );
  return result.rowCount;
}

/**
 * Get a specific rating by ride request ID and type
 * @param {number} rideRequestId - The ride request ID
 * @param {string} ratingType - Either 'rider_to_driver' or 'driver_to_rider'
 * @returns {Promise<Object|null>} The rating or null if not found
 */
async function getRatingByRideAndType(rideRequestId, ratingType) {
  const result = await pool.query(
    `SELECT r.*, 
            rater.display_name as rater_name, rater.hive_username as rater_username,
            rated.display_name as rated_name, rated.hive_username as rated_username
     FROM ratings r
     JOIN users rater ON r.rater_id = rater.id
     JOIN users rated ON r.rated_id = rated.id
     WHERE r.ride_request_id = $1 AND r.rating_type = $2`,
    [rideRequestId, ratingType]
  );
  return result.rows[0] || null;
}

/**
 * Get all ratings for a specific ride
 * @param {number} rideRequestId - The ride request ID
 * @returns {Promise<Array>} Array of ratings for the ride
 */
async function getRatingsForRide(rideRequestId) {
  const result = await pool.query(
    `SELECT r.*, 
            rater.display_name as rater_name, rater.hive_username as rater_username,
            rated.display_name as rated_name, rated.hive_username as rated_username
     FROM ratings r
     JOIN users rater ON r.rater_id = rater.id
     JOIN users rated ON r.rated_id = rated.id
     WHERE r.ride_request_id = $1
     ORDER BY r.created_at DESC`,
    [rideRequestId]
  );
  return result.rows;
}

/**
 * Get ratings received by a user (ratings where they are the rated party)
 * @param {number} userId - The user ID
 * @param {Object} [options] - Query options
 * @param {number} [options.limit=20] - Maximum number of results
 * @param {number} [options.offset=0] - Offset for pagination
 * @param {string} [options.ratingType] - Filter by rating type
 * @returns {Promise<Object>} Object with ratings array and total count
 */
async function getRatingsReceivedByUser(userId, { limit = 20, offset = 0, ratingType } = {}) {
  let whereClause = 'WHERE r.rated_id = $1';
  const params = [userId];
  let paramIndex = 2;
  
  if (ratingType) {
    whereClause += ` AND r.rating_type = $${paramIndex}`;
    params.push(ratingType);
    paramIndex++;
  }
  
  // Get total count
  const countResult = await pool.query(
    `SELECT COUNT(*) as total FROM ratings r ${whereClause}`,
    params
  );
  
  // Get paginated results
  const result = await pool.query(
    `SELECT r.*, 
            rater.display_name as rater_name, rater.hive_username as rater_username,
            rq.pickup_address, rq.dropoff_address
     FROM ratings r
     JOIN users rater ON r.rater_id = rater.id
     JOIN ride_requests rq ON r.ride_request_id = rq.id
     ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );
  
  return {
    ratings: result.rows,
    total: parseInt(countResult.rows[0].total, 10),
    limit,
    offset
  };
}

/**
 * Get ratings given by a user (ratings where they are the rater)
 * @param {number} userId - The user ID
 * @param {Object} [options] - Query options
 * @param {number} [options.limit=20] - Maximum number of results
 * @param {number} [options.offset=0] - Offset for pagination
 * @returns {Promise<Object>} Object with ratings array and total count
 */
async function getRatingsGivenByUser(userId, { limit = 20, offset = 0 } = {}) {
  const countResult = await pool.query(
    `SELECT COUNT(*) as total FROM ratings WHERE rater_id = $1`,
    [userId]
  );
  
  const result = await pool.query(
    `SELECT r.*, 
            rated.display_name as rated_name, rated.hive_username as rated_username,
            rq.pickup_address, rq.dropoff_address
     FROM ratings r
     JOIN users rated ON r.rated_id = rated.id
     JOIN ride_requests rq ON r.ride_request_id = rq.id
     WHERE r.rater_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  
  return {
    ratings: result.rows,
    total: parseInt(countResult.rows[0].total, 10),
    limit,
    offset
  };
}

/**
 * Calculate and update a user's aggregate rating based on all their received ratings
 * @param {number} userId - The user ID to update
 * @returns {Promise<Object>} The updated user record
 */
async function updateUserAggregateRating(userId) {
  // Calculate average rating from all ratings received
  const avgResult = await pool.query(
    `SELECT AVG(score)::numeric(3,2) as avg_rating, COUNT(*) as rating_count
     FROM ratings
     WHERE rated_id = $1`,
    [userId]
  );
  
  const avgRating = avgResult.rows[0].avg_rating || 0;
  const ratingCount = parseInt(avgResult.rows[0].rating_count, 10);
  
  // Update the user's aggregate rating
  const result = await pool.query(
    `UPDATE users SET rating = $1 WHERE id = $2 RETURNING *`,
    [avgRating, userId]
  );
  
  console.log(`[updateUserAggregateRating] User ${userId} new rating: ${avgRating} (from ${ratingCount} ratings)`);
  
  return result.rows[0];
}

/**
 * Get rating statistics for a user
 * @param {number} userId - The user ID
 * @returns {Promise<Object>} Rating statistics
 */
async function getUserRatingStats(userId) {
  const result = await pool.query(
    `SELECT 
       COUNT(*) as total_ratings,
       AVG(score)::numeric(3,2) as average_rating,
       COUNT(CASE WHEN score = 5 THEN 1 END) as five_star,
       COUNT(CASE WHEN score = 4 THEN 1 END) as four_star,
       COUNT(CASE WHEN score = 3 THEN 1 END) as three_star,
       COUNT(CASE WHEN score = 2 THEN 1 END) as two_star,
       COUNT(CASE WHEN score = 1 THEN 1 END) as one_star
     FROM ratings
     WHERE rated_id = $1`,
    [userId]
  );
  
  const stats = result.rows[0];
  return {
    totalRatings: parseInt(stats.total_ratings, 10),
    averageRating: parseFloat(stats.average_rating) || 0,
    distribution: {
      5: parseInt(stats.five_star, 10),
      4: parseInt(stats.four_star, 10),
      3: parseInt(stats.three_star, 10),
      2: parseInt(stats.two_star, 10),
      1: parseInt(stats.one_star, 10)
    }
  };
}

/**
 * Check if a rating already exists for a ride and type
 * @param {number} rideRequestId - The ride request ID
 * @param {string} ratingType - Either 'rider_to_driver' or 'driver_to_rider'
 * @returns {Promise<boolean>} True if rating exists
 */
async function ratingExists(rideRequestId, ratingType) {
  const result = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM ratings WHERE ride_request_id = $1 AND rating_type = $2 AND status != 'pending') as exists`,
    [rideRequestId, ratingType]
  );
  return result.rows[0].exists;
}

/**
 * Check if the rating window has expired (48 hours after trip completion)
 * @param {number} rideRequestId - The ride request ID
 * @returns {Promise<boolean>} True if rating window has expired
 */
async function isRatingWindowExpired(rideRequestId) {
  const result = await pool.query(
    `SELECT 
       CASE 
         WHEN completed_at IS NULL THEN false
         WHEN completed_at < NOW() - INTERVAL '48 hours' THEN true
         ELSE false
       END as expired
     FROM ride_requests
     WHERE id = $1`,
    [rideRequestId]
  );
  
  if (result.rows.length === 0) {
    return true; // Ride doesn't exist, treat as expired
  }
  
  return result.rows[0].expired;
}

/**
 * Get pending reviews for a rider (completed rides where rider hasn't rated the driver yet)
 * @param {number} riderId - The rider's user ID
 * @param {Object} [options] - Query options
 * @param {number} [options.limit=20] - Maximum number of results
 * @param {number} [options.offset=0] - Offset for pagination
 * @returns {Promise<Object>} Object with pending reviews array and total count
 */
async function getPendingReviewsForRider(riderId, { limit = 20, offset = 0 } = {}) {
  // Get completed rides where the rider hasn't submitted a rating yet
  // and the rating window hasn't expired (48 hours)
  const countResult = await pool.query(
    `SELECT COUNT(*) as total
     FROM ride_requests rq
     WHERE rq.passenger_id = $1::text
       AND rq.status = 'completed'
       AND rq.completed_at >= NOW() - INTERVAL '48 hours'
       AND NOT EXISTS (
         SELECT 1 FROM ratings r 
         WHERE r.ride_request_id = rq.id 
           AND r.rating_type = 'rider_to_driver'
           AND r.status != 'pending'
       )`,
    [riderId]
  );

  const result = await pool.query(
    `SELECT 
       rq.id as ride_request_id,
       rq.driver_id,
       rq.pickup_address,
       rq.dropoff_address,
       rq.completed_at,
       rq.proposed_fare,
       rq.estimated_distance,
       rq.estimated_duration,
       u.display_name as driver_display_name,
       u.hive_username as driver_hive_username,
       u.rating as driver_rating,
       COALESCE(u.last_checkin_permlink, pr.parent_permlink) as parent_permlink,
       EXTRACT(EPOCH FROM (NOW() - rq.completed_at)) / 3600 as hours_since_completion,
       48 - EXTRACT(EPOCH FROM (NOW() - rq.completed_at)) / 3600 as hours_remaining
     FROM ride_requests rq
     JOIN users u ON rq.driver_id = u.id
     LEFT JOIN ratings pr ON pr.ride_request_id = rq.id AND pr.rating_type = 'rider_to_driver' AND pr.status = 'pending'
     WHERE rq.passenger_id = $1::text
       AND rq.status = 'completed'
       AND rq.completed_at >= NOW() - INTERVAL '48 hours'
       AND NOT EXISTS (
         SELECT 1 FROM ratings r 
         WHERE r.ride_request_id = rq.id 
           AND r.rating_type = 'rider_to_driver'
           AND r.status != 'pending'
       )
     ORDER BY rq.completed_at DESC
     LIMIT $2 OFFSET $3`,
    [riderId, limit, offset]
  );

  return {
    pendingReviews: result.rows.map(row => ({
      tripId: row.ride_request_id,
      driver: {
        id: row.driver_id,
        username: row.driver_hive_username,
        displayName: row.driver_display_name,
        rating: parseFloat(row.driver_rating) || 0
      },
      tripSummary: {
        pickup: row.pickup_address,
        dropoff: row.dropoff_address,
        distance: row.estimated_distance,
        duration: row.estimated_duration,
        cost: row.proposed_fare
      },
      tripDate: row.completed_at,
      parentPermlink: row.parent_permlink || null,
      expiresAt: new Date(new Date(row.completed_at).getTime() + 48 * 60 * 60 * 1000).toISOString(),
      reviewWindow: {
        hoursSinceCompletion: parseFloat(row.hours_since_completion).toFixed(1),
        hoursRemaining: Math.max(0, parseFloat(row.hours_remaining)).toFixed(1)
      }
    })),
    totalPending: parseInt(countResult.rows[0].total, 10),
    limit,
    offset
  };
}

/**
 * Get pending reviews for a driver (completed rides where driver hasn't rated the rider yet)
 * @param {number} driverId - The driver's user ID
 * @param {Object} [options] - Query options
 * @param {number} [options.limit=20] - Maximum number of results
 * @param {number} [options.offset=0] - Offset for pagination
 * @returns {Promise<Object>} Object with pending reviews array and total count
 */
async function getPendingReviewsForDriver(driverId, { limit = 20, offset = 0 } = {}) {
  // Get completed rides where the driver hasn't submitted a rating yet
  // and the rating window hasn't expired (48 hours)
  const countResult = await pool.query(
    `SELECT COUNT(*) as total
     FROM ride_requests rq
     WHERE rq.driver_id = $1
       AND rq.status = 'completed'
       AND rq.completed_at >= NOW() - INTERVAL '48 hours'
       AND NOT EXISTS (
         SELECT 1 FROM ratings r 
         WHERE r.ride_request_id = rq.id 
           AND r.rating_type = 'driver_to_rider'
           AND r.status != 'pending'
       )`,
    [driverId]
  );

  const result = await pool.query(
    `SELECT 
       rq.id as ride_request_id,
       rq.passenger_id,
       rq.passenger_name,
       rq.pickup_address,
       rq.dropoff_address,
       rq.completed_at,
       rq.proposed_fare,
       u.id as rider_id,
       u.display_name as rider_display_name,
       u.hive_username as rider_hive_username,
       pr.parent_permlink,
       EXTRACT(EPOCH FROM (NOW() - rq.completed_at)) / 3600 as hours_since_completion,
       48 - EXTRACT(EPOCH FROM (NOW() - rq.completed_at)) / 3600 as hours_remaining
     FROM ride_requests rq
     LEFT JOIN users u ON rq.passenger_id = u.hive_username
     LEFT JOIN ratings pr ON pr.ride_request_id = rq.id AND pr.rating_type = 'driver_to_rider' AND pr.status = 'pending'
     WHERE rq.driver_id = $1
       AND rq.status = 'completed'
       AND rq.completed_at >= NOW() - INTERVAL '48 hours'
       AND NOT EXISTS (
         SELECT 1 FROM ratings r 
         WHERE r.ride_request_id = rq.id 
           AND r.rating_type = 'driver_to_rider'
           AND r.status != 'pending'
       )
     ORDER BY rq.completed_at DESC
     LIMIT $2 OFFSET $3`,
    [driverId, limit, offset]
  );

  return {
    pendingReviews: result.rows.map(row => ({
      rideRequestId: row.ride_request_id,
      rider: {
        id: row.rider_id || null,
        name: row.rider_display_name || row.passenger_name,
        hiveUsername: row.rider_hive_username || row.passenger_id
      },
      trip: {
        pickupAddress: row.pickup_address,
        dropoffAddress: row.dropoff_address,
        completedAt: row.completed_at,
        fare: row.proposed_fare
      },
      parentPermlink: row.parent_permlink || null,
      reviewWindow: {
        hoursSinceCompletion: parseFloat(row.hours_since_completion).toFixed(1),
        hoursRemaining: Math.max(0, parseFloat(row.hours_remaining)).toFixed(1)
      }
    })),
    total: parseInt(countResult.rows[0].total, 10),
    limit,
    offset
  };
}

module.exports = {
  createRating,
  createPendingRating,
  updateRatingWithReply,
  getPendingRatingsForUser,
  getPendingRatingByRideAndType,
  updateRatingStatus,
  updateRatingParentPermlink,
  deleteRating,
  deleteRatingsByRide,
  getRatingByRideAndType,
  getRatingsForRide,
  getRatingsReceivedByUser,
  getRatingsGivenByUser,
  updateUserAggregateRating,
  getUserRatingStats,
  ratingExists,
  isRatingWindowExpired,
  getPendingReviewsForDriver,
  getPendingReviewsForRider
};
