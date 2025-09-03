// src/db/users.js
const pool = require('./index');

/**
 * Create a new user (driver or rider)
 */
async function createUser({ hiveUsername, type, completedTrips = 0, rating = 0, licenseNumber, lastLat, lastLong, phoneNumber, displayName, vehicle, isOnline }) {
  const result = await pool.query(
    `INSERT INTO users (hive_username, type, completed_trips, rating, license_number, last_lat, last_long, phone_number, display_name, vehicle, is_online)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [hiveUsername, type, completedTrips, rating, licenseNumber, lastLat, lastLong, phoneNumber, displayName, vehicle, isOnline]
  );
  return result.rows[0];
}

/**
 * Get a user by hiveUsername
 */
async function getUserByUsername(hiveUsername) {
  const result = await pool.query(
    `SELECT * FROM users WHERE hive_username = $1`,
    [hiveUsername]
  );
  return result.rows[0];
}

/**
 * Update a user's info by hiveUsername
 */
async function updateUser(hiveUsername, updates) {
  // Only allow certain fields to be updated
  const fields = ['completed_trips', 'rating', 'license_number', 'last_lat', 'last_long', 'phone_number', 'display_name', 'vehicle', 'is_online', 'type'];
  const setClauses = [];
  const values = [];
  let idx = 1;
  for (const field of fields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = $${idx}`);
      values.push(updates[field]);
      idx++;
    }
  }
  if (setClauses.length === 0) return null;
  values.push(hiveUsername);
  const result = await pool.query(
    `UPDATE users SET ${setClauses.join(', ')} WHERE hive_username = $${idx} RETURNING *`,
    values
  );
  return result.rows[0];
}

/**
 * Update a user's info by id
 */
async function updateUserById(id, updates) {
  // Only allow certain fields to be updated
  const fields = [
    'display_name', 
    'phone_number', 
    'vehicle', 
    'license_number', 
    'is_online', 
    'type',
    'last_lat',
    'last_long',
    'fcm_token'
  ];
  console.log('[updateUserById] id:', id);
  console.log('[updateUserById] updates:', updates);
  const setClauses = [];
  const values = [];
  let idx = 1;
  for (const field of fields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = $${idx}`);
      values.push(updates[field]);
      console.log(`[updateUserById] Will update field: ${field} with value:`, updates[field]);
      idx++;
    }
  }
  if (setClauses.length === 0) {
    console.warn('[updateUserById] No valid fields to update');
    return null;
  }
  values.push(id);
  console.log('[updateUserById] SQL:', `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`);
  console.log('[updateUserById] SQL values:', values);
  const result = await pool.query(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  console.log('[updateUserById] DB result:', result.rows[0]);
  return result.rows[0];
}

/**
 * Get a user by id
 */
async function getUserById(id) {
  const result = await pool.query(
    `SELECT * FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

/**
 * Delete a user by hiveUsername
 */
async function deleteUser(hiveUsername) {
  await pool.query(`DELETE FROM users WHERE hive_username = $1`, [hiveUsername]);
  return true;
}

/**
 * List all users, optionally filtered by type
 */
async function listUsers(type) {
  let result;
  if (type) {
    result = await pool.query(`SELECT * FROM users WHERE type = $1`, [type]);
  } else {
    result = await pool.query(`SELECT * FROM users`);
  }
  return result.rows;
}

module.exports = {
  createUser,
  getUserByUsername,
  getUserById,
  updateUser,
  updateUserById,
  deleteUser,
  listUsers
};
