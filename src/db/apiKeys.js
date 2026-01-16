const crypto = require('crypto');
const pool = require('./index');

/**
 * Generate a new API key
 * Format: htx_live_xxxxxxxxxxxxx (32 random chars after prefix)
 */
function generateAPIKey(environment = 'live') {
  const prefix = `htx_${environment}_`;
  const randomPart = crypto.randomBytes(16).toString('hex');
  return prefix + randomPart;
}

/**
 * Create a new API key
 */
async function createAPIKey(name, description, scopes = [], expiresInDays = null) {
  const apiKey = generateAPIKey();
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const keyPrefix = apiKey.substring(0, 12);
  
  let expiresAt = null;
  if (expiresInDays) {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + expiresInDays);
    expiresAt = expiryDate;
  }

  const result = await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, name, description, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, description, scopes, created_at, expires_at`,
    [keyHash, keyPrefix, name, description, scopes, expiresAt]
  );

  return {
    ...result.rows[0],
    api_key: apiKey // Only return the plain key once during creation
  };
}

/**
 * List all API keys (without the actual key values)
 */
async function listAPIKeys() {
  const result = await pool.query(
    `SELECT id, key_prefix, name, description, scopes, is_active, 
            created_at, last_used_at, expires_at
     FROM api_keys
     ORDER BY created_at DESC`
  );
  return result.rows;
}

/**
 * Revoke/deactivate an API key
 */
async function revokeAPIKey(keyId) {
  const result = await pool.query(
    `UPDATE api_keys SET is_active = false WHERE id = $1 RETURNING *`,
    [keyId]
  );
  return result.rows[0];
}

module.exports = {
  generateAPIKey,
  createAPIKey,
  listAPIKeys,
  revokeAPIKey
};
