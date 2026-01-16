const pool = require('./index');

/**
 * Create a new vehicle
 */
async function createVehicle({ userId, make, model, year, color, plateNumber, vehicleType, seats, isPrimary = false }) {
  // If setting as primary, unset other primary vehicles for this user
  if (isPrimary) {
    await pool.query(
      `UPDATE vehicles SET is_primary = false WHERE user_id = $1`,
      [userId]
    );
  }
  
  const result = await pool.query(
    `INSERT INTO vehicles (user_id, make, model, year, color, plate_number, vehicle_type, seats, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [userId, make, model, year, color, plateNumber, vehicleType, seats, isPrimary]
  );
  return result.rows[0];
}

/**
 * Get all vehicles by user ID
 */
async function getVehiclesByUserId(userId) {
  const result = await pool.query(
    `SELECT * FROM vehicles WHERE user_id = $1 ORDER BY is_primary DESC, created_at ASC`,
    [userId]
  );
  return result.rows;
}

/**
 * Get primary vehicle by user ID
 */
async function getPrimaryVehicle(userId) {
  const result = await pool.query(
    `SELECT * FROM vehicles WHERE user_id = $1 AND is_primary = true`,
    [userId]
  );
  return result.rows[0];
}

/**
 * Get vehicle by ID
 */
async function getVehicleById(vehicleId) {
  const result = await pool.query(
    `SELECT * FROM vehicles WHERE id = $1`,
    [vehicleId]
  );
  return result.rows[0];
}

/**
 * Update vehicle
 */
async function updateVehicle(vehicleId, updates) {
  const fields = ['make', 'model', 'year', 'color', 'plate_number', 'vehicle_type', 'seats', 'is_primary'];
  const setClauses = [];
  const values = [];
  let idx = 1;
  
  // If setting as primary, first get the user_id
  if (updates.is_primary === true) {
    const vehicle = await getVehicleById(vehicleId);
    if (vehicle) {
      await pool.query(
        `UPDATE vehicles SET is_primary = false WHERE user_id = $1 AND id != $2`,
        [vehicle.user_id, vehicleId]
      );
    }
  }
  
  for (const field of fields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = $${idx}`);
      values.push(updates[field]);
      idx++;
    }
  }
  
  if (setClauses.length === 0) return null;
  
  setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(vehicleId);
  
  const result = await pool.query(
    `UPDATE vehicles SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return result.rows[0];
}

/**
 * Delete vehicle
 */
async function deleteVehicle(vehicleId) {
  await pool.query(`DELETE FROM vehicles WHERE id = $1`, [vehicleId]);
  return true;
}

/**
 * Set primary vehicle for a user
 */
async function setPrimaryVehicle(userId, vehicleId) {
  // Unset all primary vehicles for this user
  await pool.query(
    `UPDATE vehicles SET is_primary = false WHERE user_id = $1`,
    [userId]
  );
  
  // Set the specified vehicle as primary
  const result = await pool.query(
    `UPDATE vehicles SET is_primary = true WHERE id = $1 AND user_id = $2 RETURNING *`,
    [vehicleId, userId]
  );
  
  return result.rows[0];
}

module.exports = {
  createVehicle,
  getVehiclesByUserId,
  getPrimaryVehicle,
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  setPrimaryVehicle
};
