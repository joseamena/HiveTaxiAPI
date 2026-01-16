const express = require('express');
const router = express.Router();
const apiKeysDb = require('../db/apiKeys');
const authenticateJWT = require('../middleware/auth');

// POST /api/admin/api-keys - Create a new API key (admin only)
router.post('/api-keys', authenticateJWT, async (req, res) => {
  try {
    // TODO: Add admin role check here if you implement roles
    // if (req.user.role !== 'admin') {
    //   return res.status(403).json({
    //     error: 'FORBIDDEN',
    //     message: 'Admin access required'
    //   });
    // }

    const { name, description, scopes, expiresInDays } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'MISSING_PARAMETER',
        message: 'name is required'
      });
    }

    const apiKey = await apiKeysDb.createAPIKey(
      name,
      description,
      scopes || ['*'],
      expiresInDays
    );

    res.status(201).json({
      message: 'API key created successfully',
      warning: 'Save this API key now - it will not be shown again!',
      api_key: apiKey.api_key,
      details: {
        id: apiKey.id,
        name: apiKey.name,
        description: apiKey.description,
        scopes: apiKey.scopes,
        created_at: apiKey.created_at,
        expires_at: apiKey.expires_at
      }
    });

  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create API key',
      details: error.message
    });
  }
});

// GET /api/admin/api-keys - List all API keys
router.get('/api-keys', authenticateJWT, async (req, res) => {
  try {
    const apiKeys = await apiKeysDb.listAPIKeys();
    res.json({
      message: 'API keys retrieved successfully',
      api_keys: apiKeys
    });
  } catch (error) {
    console.error('Error listing API keys:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list API keys'
    });
  }
});

// DELETE /api/admin/api-keys/:id - Revoke an API key
router.delete('/api-keys/:id', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const revokedKey = await apiKeysDb.revokeAPIKey(id);

    if (!revokedKey) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'API key not found'
      });
    }

    res.json({
      message: 'API key revoked successfully',
      api_key: {
        id: revokedKey.id,
        name: revokedKey.name,
        is_active: revokedKey.is_active
      }
    });
  } catch (error) {
    console.error('Error revoking API key:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to revoke API key'
    });
  }
});

module.exports = router;
