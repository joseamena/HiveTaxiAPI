// src/services/communitySync.js
// Background job that keeps community membership statuses in sync with the Hive blockchain.
// The blockchain is the source of truth: a mod/admin/owner granting 'member' role = approved.
const pool = require('../db');
const { getCommunityRoles, MEMBER_ROLES } = require('../utils/hiveClient');
const communitiesDb = require('../db/communities');
const notificationService = require('./notificationService');

const SYNC_INTERVAL_MS = parseInt(process.env.COMMUNITY_SYNC_INTERVAL_MS, 10) || 10 * 60 * 1000;

/**
 * Sync one community's driver memberships against current Hive blockchain roles.
 * - DB pending  + on-chain member/mod/admin → approve + FCM
 * - DB approved + on-chain guest/absent      → revoke  + FCM
 * - On-chain member/mod/admin + no DB record → insert approved (bootstrap)
 * @param {string} hiveTag
 * @param {number} communityId
 */
async function syncCommunity(hiveTag, communityId) {
  console.log(`[CommunitySync] Syncing ${hiveTag} (id=${communityId})`);

  let blockchainRoles;
  try {
    const rawRoles = await getCommunityRoles(hiveTag);
    // rawRoles: array of [username, role, title, reputation]
    blockchainRoles = new Map(rawRoles.map(r => [r[0], r[1]]));
  } catch (err) {
    console.error(`[CommunitySync] Failed to fetch roles for ${hiveTag}:`, err.message);
    return;
  }

  // All non-terminated driver memberships for this community
  const { rows } = await pool.query(
    `SELECT uc.user_id, uc.status, u.hive_username
     FROM user_communities uc
     JOIN users u ON u.id = uc.user_id
     WHERE uc.community_id = $1
       AND uc.role = 'Driver'
       AND uc.status NOT IN ('left', 'withdrawn')`,
    [communityId]
  );

  const dbUsernames = new Set(rows.map(r => r.hive_username));

  for (const { user_id, status, hive_username } of rows) {
    const onChainRole = blockchainRoles.get(hive_username);
    const isApprovedOnChain = !!(onChainRole && MEMBER_ROLES.has(onChainRole));

    if (status === 'pending' && isApprovedOnChain) {
      await communitiesDb.approveMembership(user_id, communityId);
      console.log(`[CommunitySync] Approved ${hive_username} in ${hiveTag}`);
      notificationService.sendCommunityStatusUpdate(user_id, { communityId, hiveTag, status: 'approved' })
        .catch(e => console.error(`[CommunitySync] FCM error for ${hive_username}:`, e.message));

    } else if (status === 'approved' && !isApprovedOnChain) {
      await communitiesDb.revokeMembership(user_id, communityId);
      console.log(`[CommunitySync] Revoked ${hive_username} in ${hiveTag}`);
      notificationService.sendCommunityStatusUpdate(user_id, { communityId, hiveTag, status: 'revoked' })
        .catch(e => console.error(`[CommunitySync] FCM error for ${hive_username}:`, e.message));
    }
  }

  // Bootstrap: on-chain members who are registered drivers but have no DB record at all
  const onChainMembers = [...blockchainRoles.entries()]
    .filter(([, role]) => MEMBER_ROLES.has(role))
    .map(([username]) => username)
    .filter(username => !dbUsernames.has(username));

  if (onChainMembers.length > 0) {
    // Find which of these are registered drivers in our system
    const { rows: driverRows } = await pool.query(
      `SELECT id, hive_username FROM users
       WHERE hive_username = ANY($1) AND type = 'driver'`,
      [onChainMembers]
    );

    for (const { id: userId, hive_username } of driverRows) {
      await pool.query(
        `INSERT INTO user_communities (user_id, community_id, role, status)
         VALUES ($1, $2, 'Driver', 'approved')
         ON CONFLICT (user_id, community_id) DO NOTHING`,
        [userId, communityId]
      );
      console.log(`[CommunitySync] Bootstrapped approved membership for ${hive_username} in ${hiveTag}`);
      notificationService.sendCommunityStatusUpdate(userId, { communityId, hiveTag, status: 'approved' })
        .catch(e => console.error(`[CommunitySync] FCM error for ${hive_username}:`, e.message));
    }
  }

  console.log(`[CommunitySync] Done syncing ${hiveTag}`);
}

/**
 * Sync all registered communities sequentially.
 */
async function syncAllCommunities() {
  const { rows } = await pool.query('SELECT id, hive_tag FROM communities');
  for (const { id, hive_tag } of rows) {
    await syncCommunity(hive_tag, id);
  }
}

/**
 * Start the periodic background sync. Called once on server boot.
 */
function startSyncJob() {
  console.log(`[CommunitySync] Sync job started (interval: ${SYNC_INTERVAL_MS / 1000}s)`);
  setInterval(async () => {
    try {
      await syncAllCommunities();
    } catch (err) {
      console.error('[CommunitySync] Unexpected sync error:', err.message);
    }
  }, SYNC_INTERVAL_MS);
}

module.exports = { syncCommunity, syncAllCommunities, startSyncJob };
