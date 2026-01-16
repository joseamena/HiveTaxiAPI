const crypto = require('crypto');
const pool = require('../db');

/**
 * Middleware to authenticate requests using API keys
 * Looks for API key in X-API-Key header
 */
async function authenticateAPIKey(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
      return res.status(401).json({
        error: 'MISSING_API_KEY',
        message: 'API key is required in X-API-Key header'
      });
    }

    // API keys format: htx_live_xxxxxxxxxxxxx or htx_test_xxxxxxxxxxxxx
    if (!apiKey.startsWith('htx_')) {
      return res.status(401).json({
        error: 'INVALID_API_KEY_FORMAT',
        message: 'Invalid API key format'
      });
    }

    // Extract prefix (first 12 chars) for quick lookup
    const prefix = apiKey.substring(0, 12);
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    // Look up API key
    const result = await pool.query(
      `SELECT id, name, scopes, is_active, expires_at 
       FROM api_keys 
       WHERE key_prefix = $1 AND key_hash = $2`,
      [prefix, keyHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'INVALID_API_KEY',
        message: 'API key not found or invalid'
      });
    }

    const apiKeyRecord = result.rows[0];

    // Check if key is active
    if (!apiKeyRecord.is_active) {
      return res.status(401).json({
        error: 'API_KEY_INACTIVE',
        message: 'This API key has been deactivated'
      });
    }

    // Check if key has expired
    if (apiKeyRecord.expires_at && new Date(apiKeyRecord.expires_at) < new Date()) {
      return res.status(401).json({
        error: 'API_KEY_EXPIRED',
        message: 'This API key has expired'
      });
    }

    // Update last_used_at (async, don't wait)
    pool.query(
      `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
      [apiKeyRecord.id]
    ).catch(err => console.error('Error updating API key last_used_at:', err));

    // Attach API key info to request
    req.apiKey = {
      id: apiKeyRecord.id,
      name: apiKeyRecord.name,
      scopes: apiKeyRecord.scopes || []
    };

    next();
  } catch (error) {
    console.error('API key authentication error:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to authenticate API key'
    });
  }
}

/**
 * Middleware to check if API key has required scope
 */
function requireScope(requiredScope) {
  return (req, res, next) => {
    if (!req.apiKey) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'API key authentication required'
      });
    }

    const hasScope = req.apiKey.scopes.includes(requiredScope) || 
                     req.apiKey.scopes.includes('*');

    if (!hasScope) {
      return res.status(403).json({
        error: 'INSUFFICIENT_SCOPE',
        message: `This API key does not have the required scope: ${requiredScope}`
      });
    }

    next();
  };
}

module.exports = { authenticateAPIKey, requireScope };
