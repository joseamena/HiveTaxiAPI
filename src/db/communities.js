// src/db/communities.js
// Data access helpers for communities and user memberships
const pool = require('./index');

/** Ensure a community exists (idempotent). Returns row. */
async function ensureCommunity(hiveTag, name, latitude, longitude) {
  const result = await pool.query(
    `INSERT INTO communities (hive_tag, name, latitude, longitude)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (hive_tag) DO UPDATE SET 
       name = COALESCE(EXCLUDED.name, communities.name),
       latitude = COALESCE(EXCLUDED.latitude, communities.latitude),
       longitude = COALESCE(EXCLUDED.longitude, communities.longitude)
     RETURNING *`,
    [hiveTag, name || null, latitude || null, longitude || null]
  );
  return result.rows[0];
}

async function getCommunityByTag(hiveTag) {
  const result = await pool.query(`SELECT * FROM communities WHERE hive_tag = $1`, [hiveTag]);
  return result.rows[0] || null;
}

/** Add or update a user's membership + role in a community */
async function addUserToCommunity(hiveUsername, hiveTag, role = 'Driver') {
  // Fetch user id
  const userRes = await pool.query(`SELECT id FROM users WHERE hive_username = $1`, [hiveUsername]);
  if (!userRes.rows[0]) throw new Error('User not found');
  const userId = userRes.rows[0].id;
  // Ensure community
  const community = await ensureCommunity(hiveTag);
  // Upsert membership
  await pool.query(
    `INSERT INTO user_communities (user_id, community_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, community_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, community.id, role]
  );
  return { userId, hiveUsername, community: community.hive_tag, role };
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

module.exports = {
  ensureCommunity,
  getCommunityByTag,
  addUserToCommunity,
  getUserCommunityRole,
  listUserCommunities,
  listCommunityMembers
};
