// src/utils/hiveClient.js
// Shared Hive blockchain RPC helpers
const axios = require('axios');

const HIVE_API_URL = 'https://api.hive.blog';

// Roles that count as "approved member" for community dispatch
const MEMBER_ROLES = new Set(['member', 'mod', 'admin']);

/**
 * Get all explicit role assignments for a Hive community.
 * Returns raw array of [username, role, title, reputation] tuples.
 * Throws on network/API failure.
 * @param {string} hiveTag - e.g. 'hive-123456'
 * @returns {Promise<Array>}
 */
async function getCommunityRoles(hiveTag) {
  const response = await axios.post(HIVE_API_URL, {
    jsonrpc: '2.0',
    method: 'bridge.list_community_roles',
    params: { community: hiveTag },
    id: 1
  });
  if (!response.data || !response.data.result) {
    throw new Error(`No results from Hive blockchain for community ${hiveTag}`);
  }
  return response.data.result;
}

/**
 * Check whether a specific user has a member-or-above role in a Hive community.
 * Does NOT throw — returns { verified: false, error } on any failure.
 * @param {string} username
 * @param {string} hiveTag
 * @returns {Promise<{ verified: boolean, role?: string, error?: string }>}
 */
async function verifyUserInCommunity(username, hiveTag) {
  try {
    const roles = await getCommunityRoles(hiveTag);
    const entry = roles.find(r => r[0] === username);
    if (!entry) {
      return { verified: false, error: 'USER_NOT_IN_COMMUNITY' };
    }
    const role = entry[1];
    if (!MEMBER_ROLES.has(role)) {
      return { verified: false, error: 'INVALID_BLOCKCHAIN_ROLE' };
    }
    return { verified: true, role };
  } catch (error) {
    console.error('[hiveClient] verifyUserInCommunity error:', error.message);
    return { verified: false, error: 'BLOCKCHAIN_REQUEST_FAILED' };
  }
}

module.exports = { getCommunityRoles, verifyUserInCommunity, MEMBER_ROLES };
