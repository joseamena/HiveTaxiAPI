// src/db/communities.js
// Data access helpers for communities and user memberships
const pool = require('./index');

/** Ensure a community exists (idempotent). Returns row. */
async function ensureCommunity(hiveTag, name, latitude, longitude, description, requirements) {
  const result = await pool.query(
    `INSERT INTO communities (hive_tag, name, latitude, longitude, description, requirements)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (hive_tag) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, communities.name),
       latitude = COALESCE(EXCLUDED.latitude, communities.latitude),
       longitude = COALESCE(EXCLUDED.longitude, communities.longitude),
       description = COALESCE(EXCLUDED.description, communities.description),
       requirements = COALESCE(EXCLUDED.requirements, communities.requirements)
     RETURNING *`,
    [hiveTag, name || null, latitude || null, longitude || null, description || null, requirements || null]
  );
  return result.rows[0];
}

async function getCommunityByTag(hiveTag) {
  const result = await pool.query(`SELECT * FROM communities WHERE hive_tag = $1`, [hiveTag]);
  return result.rows[0] || null;
}

/** Add or update a user's membership + role in a community (admin use; sets status=approved) */
async function addUserToCommunity(hiveUsername, hiveTag, role = 'Driver') {
  // Fetch user id
  const userRes = await pool.query(`SELECT id FROM users WHERE hive_username = $1`, [hiveUsername]);
  if (!userRes.rows[0]) throw new Error('User not found');
  const userId = userRes.rows[0].id;
  // Ensure community
  const community = await ensureCommunity(hiveTag);
  // Upsert membership
  await pool.query(
    `INSERT INTO user_communities (user_id, community_id, role, status)
     VALUES ($1, $2, $3, 'approved')
     ON CONFLICT (user_id, community_id) DO UPDATE SET role = EXCLUDED.role, status = 'approved'`,
    [userId, community.id, role]
  );
  return { userId, hiveUsername, community: community.hive_tag, role };
}

/**
 * Create a join request for a user.
 * Drivers get status='pending' (require community approval).
 * Riders get status='approved' immediately — community membership is a dispatch preference, not a gate.
 * Throws with code 'ALREADY_MEMBER' if a non-withdrawn/non-left membership already exists.
 * @param {number} userId
 * @param {number} communityId
 * @param {boolean} autoApprove - Pass true for riders
 */
async function joinCommunity(userId, communityId, autoApprove = false) {
  const initialStatus = autoApprove ? 'approved' : 'pending';
  const role = autoApprove ? 'Rider' : 'Driver';

  // Guard: no active or pending membership
  const existing = await pool.query(
    `SELECT status FROM user_communities
     WHERE user_id = $1 AND community_id = $2`,
    [userId, communityId]
  );
  if (existing.rows.length > 0) {
    const { status } = existing.rows[0];
    if (!['withdrawn', 'left', 'revoked'].includes(status)) {
      const err = new Error('Membership already exists');
      err.code = 'ALREADY_MEMBER';
      err.existingStatus = status;
      throw err;
    }
    // Re-apply: reset status
    const result = await pool.query(
      `UPDATE user_communities
       SET status = $3, decline_reason = NULL, joined_at = NOW()
       WHERE user_id = $1 AND community_id = $2
       RETURNING *`,
      [userId, communityId, initialStatus]
    );
    return result.rows[0];
  }
  const result = await pool.query(
    `INSERT INTO user_communities (user_id, community_id, role, status)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, communityId, role, initialStatus]
  );
  return result.rows[0];
}

/**
 * Withdraw a pending join request (sets status = 'withdrawn').
 * Returns null if no pending membership found.
 */
async function withdrawJoinRequest(userId, communityId) {
  const result = await pool.query(
    `UPDATE user_communities
     SET status = 'withdrawn'
     WHERE user_id = $1 AND community_id = $2 AND status = 'pending'
     RETURNING *`,
    [userId, communityId]
  );
  return result.rows[0] || null;
}

/**
 * Leave an approved community (sets status = 'left').
 * Returns null if no approved membership found.
 */
async function leaveCommunity(userId, communityId) {
  const result = await pool.query(
    `UPDATE user_communities
     SET status = 'left'
     WHERE user_id = $1 AND community_id = $2 AND status = 'approved'
     RETURNING *`,
    [userId, communityId]
  );
  return result.rows[0] || null;
}

/**
 * Get all communities for a driver with membership status and active community info.
 * @param {number} userId
 * @returns {{ communities: Array, activeCommunityId: number|null }}
 */
async function getDriverCommunities(userId) {
  const result = await pool.query(
    `SELECT
       c.id,
       c.hive_tag,
       c.name,
       c.description,
       c.requirements,
       c.rating,
       uc.status,
       uc.role,
       uc.joined_at,
       uc.decline_reason
     FROM user_communities uc
     JOIN communities c ON c.id = uc.community_id
     WHERE uc.user_id = $1
     ORDER BY uc.joined_at DESC`,
    [userId]
  );

  const userRes = await pool.query(
    `SELECT active_community_id FROM users WHERE id = $1`,
    [userId]
  );

  return {
    communities: result.rows,
    activeCommunityId: userRes.rows[0]?.active_community_id || null
  };
}

/**
 * Set a driver's active community. Requires status = 'approved'.
 * @param {number} userId
 * @param {number} communityId
 * @returns {Object} The community row
 */
async function setActiveCommunity(userId, communityId) {
  // Verify approved membership
  const membership = await pool.query(
    `SELECT status FROM user_communities
     WHERE user_id = $1 AND community_id = $2`,
    [userId, communityId]
  );
  if (!membership.rows[0] || membership.rows[0].status !== 'approved') {
    const err = new Error('Driver does not have an approved membership in this community');
    err.code = 'NOT_APPROVED';
    throw err;
  }
  await pool.query(
    `UPDATE users SET active_community_id = $1 WHERE id = $2`,
    [communityId, userId]
  );
  const communityRes = await pool.query(`SELECT * FROM communities WHERE id = $1`, [communityId]);
  return communityRes.rows[0];
}

/**
 * Get all communities with optional text search and geo-proximity sort.
 * Returns { nearbyResults, allResults } when lat/lng provided, else flat { communities }.
 */
async function getCommunities({ search, lat, lng } = {}) {
  const params = [];
  let whereClause = '';

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    whereClause = `WHERE LOWER(c.name) LIKE $${params.length} OR LOWER(c.hive_tag) LIKE $${params.length}`;
  }

  const result = await pool.query(
    `SELECT
       c.id,
       c.hive_tag,
       c.name,
       c.description,
       c.requirements,
       c.rating,
       c.latitude,
       c.longitude,
       COUNT(uc.user_id) FILTER (WHERE uc.role = 'Driver' AND uc.status = 'approved') AS active_driver_count
     FROM communities c
     LEFT JOIN user_communities uc ON uc.community_id = c.id
     ${whereClause}
     GROUP BY c.id
     ORDER BY c.name`,
    params
  );

  const rows = result.rows;

  if (lat != null && lng != null) {
    const latF = parseFloat(lat);
    const lngF = parseFloat(lng);
    const NEARBY_KM = 50;

    const withDistance = rows.map(r => {
      if (r.latitude == null || r.longitude == null) return { ...r, distanceKm: null };
      const dLat = (r.latitude - latF) * (Math.PI / 180);
      const dLng = (r.longitude - lngF) * (Math.PI / 180);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(latF * Math.PI / 180) * Math.cos(r.latitude * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
      const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return { ...r, distanceKm };
    });

    const nearbyResults = withDistance
      .filter(r => r.distanceKm != null && r.distanceKm <= NEARBY_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    const nearbyIds = new Set(nearbyResults.map(r => r.id));
    const allResults = withDistance.filter(r => !nearbyIds.has(r.id));

    return { nearbyResults, allResults };
  }

  return { communities: rows };
}

/** Get user's role for a specific community tag */
async function getUserCommunityRole(hiveUsername, hiveTag) {
  const result = await pool.query(
    `SELECT uc.role
     FROM users u
     JOIN user_communities uc ON uc.user_id = u.id
     JOIN communities c ON c.id = uc.community_id
     WHERE u.hive_username = $1 AND c.hive_tag = $2`,
    [hiveUsername, hiveTag]
  );
  return result.rows[0] || null;
}

/** List all communities (tag + role) for a user */
async function listUserCommunities(hiveUsername) {
  const result = await pool.query(
    `SELECT c.hive_tag AS community, uc.role, uc.joined_at
     FROM users u
     JOIN user_communities uc ON uc.user_id = u.id
     JOIN communities c ON c.id = uc.community_id
     WHERE u.hive_username = $1
     ORDER BY c.hive_tag`,
    [hiveUsername]
  );
  return result.rows;
}

/** List members of a community, optional role filter */
async function listCommunityMembers(hiveTag, role) {
  const params = [hiveTag];
  let roleClause = '';
  if (role) {
    params.push(role);
    roleClause = ' AND uc.role = $2';
  }
  const result = await pool.query(
    `SELECT u.hive_username, uc.role, uc.joined_at
     FROM communities c
     JOIN user_communities uc ON uc.community_id = c.id
     JOIN users u ON u.id = uc.user_id
     WHERE c.hive_tag = $1${roleClause}
     ORDER BY u.hive_username`,
    params
  );
  return result.rows;
}

/**
 * Approve a driver's community membership (blockchain confirmed member role).
 * @param {number} userId
 * @param {number} communityId
 * @returns {Object|null}
 */
async function approveMembership(userId, communityId) {
  const result = await pool.query(
    `UPDATE user_communities
     SET status = 'approved'
     WHERE user_id = $1 AND community_id = $2 AND status = 'pending'
     RETURNING *`,
    [userId, communityId]
  );
  return result.rows[0] || null;
}

/**
 * Revoke a driver's community membership (blockchain role dropped below member).
 * Also clears active_community_id if this was their active community.
 * @param {number} userId
 * @param {number} communityId
 * @returns {Object|null}
 */
async function revokeMembership(userId, communityId) {
  const result = await pool.query(
    `UPDATE user_communities
     SET status = 'revoked'
     WHERE user_id = $1 AND community_id = $2 AND status = 'approved'
     RETURNING *`,
    [userId, communityId]
  );
  if (result.rows[0]) {
    // Clear active community if this was the driver's active one
    await pool.query(
      `UPDATE users SET active_community_id = NULL
       WHERE id = $1 AND active_community_id = $2`,
      [userId, communityId]
    );
  }
  return result.rows[0] || null;
}

/**
 * Get the integer user IDs of all drivers who share at least one community with the given rider.
 * Returns an empty array if the rider belongs to no communities.
 * @param {number} riderUserId - The rider's integer user ID
 * @returns {Promise<number[]>}
 */
async function getDriverIdsInRiderCommunities(riderUserId) {
  // Rider community membership is a preference — no approval required on the rider side.
  // Only drivers must be 'approved' by the community before they can be dispatched under it.
  const result = await pool.query(
    `SELECT DISTINCT uc_driver.user_id
     FROM user_communities uc_rider
     JOIN user_communities uc_driver ON uc_driver.community_id = uc_rider.community_id
     WHERE uc_rider.user_id = $1
       AND uc_driver.user_id != $1
       AND uc_driver.role = 'Driver'
       AND uc_driver.status = 'approved'`,
    [riderUserId]
  );
  return result.rows.map(row => row.user_id);
}

module.exports = {
  ensureCommunity,
  getCommunityByTag,
  addUserToCommunity,
  getUserCommunityRole,
  listUserCommunities,
  listCommunityMembers,
  getDriverIdsInRiderCommunities,
  joinCommunity,
  withdrawJoinRequest,
  leaveCommunity,
  getDriverCommunities,
  setActiveCommunity,
  getCommunities,
  approveMembership,
  revokeMembership
};
