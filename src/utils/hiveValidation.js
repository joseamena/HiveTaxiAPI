// src/utils/hiveValidation.js
const axios = require('axios');

const HIVE_API_URL = 'https://api.hive.blog';

/**
 * Fetch a Hive post/comment by author and permlink
 * @param {string} author - The Hive username of the post author
 * @param {string} permlink - The permlink of the post
 * @returns {Promise<Object|null>} The post content or null if not found
 */
async function getHiveContent(author, permlink) {
  try {
    const response = await axios.post(HIVE_API_URL, {
      jsonrpc: '2.0',
      method: 'condenser_api.get_content',
      params: [author, permlink],
      id: 1
    });

    if (!response.data || !response.data.result) {
      return null;
    }

    const post = response.data.result;
    
    // If post doesn't exist, the API returns an empty object with id = 0
    if (!post.id || post.id === 0) {
      return null;
    }

    return post;
  } catch (error) {
    console.error('Error fetching Hive content:', error.message);
    return null;
  }
}

/**
 * Verify that a review permlink is a valid reply to a driver's check-in post
 * @param {string} reviewAuthor - The Hive username of the reviewer (rider)
 * @param {string} reviewPermlink - The permlink of the review comment
 * @param {string} expectedParentAuthor - The expected parent post author (driver)
 * @param {string} expectedParentPermlink - The expected parent permlink (driver's check-in post) - optional
 * @returns {Promise<Object>} Validation result with verified boolean and details
 */
async function verifyReviewPermlink(reviewAuthor, reviewPermlink, expectedParentAuthor, expectedParentPermlink = null) {
  try {
    const content = await getHiveContent(reviewAuthor, reviewPermlink);

    if (!content) {
      return {
        verified: false,
        error: 'PERMLINK_NOT_FOUND',
        message: 'The review post/comment was not found on the blockchain'
      };
    }

    // Check that the content is authored by the expected reviewer
    if (content.author !== reviewAuthor) {
      return {
        verified: false,
        error: 'AUTHOR_MISMATCH',
        message: 'The post author does not match the reviewer'
      };
    }

    // Check that it's a reply (has parent_author set)
    if (!content.parent_author) {
      return {
        verified: false,
        error: 'NOT_A_REPLY',
        message: 'The permlink is not a reply to another post'
      };
    }

    // Verify the parent author matches the expected driver
    if (content.parent_author !== expectedParentAuthor) {
      return {
        verified: false,
        error: 'WRONG_PARENT_AUTHOR',
        message: `Expected reply to ${expectedParentAuthor}, but found reply to ${content.parent_author}`
      };
    }

    // If a specific parent permlink is expected, verify it
    if (expectedParentPermlink && content.parent_permlink !== expectedParentPermlink) {
      return {
        verified: false,
        error: 'WRONG_PARENT_PERMLINK',
        message: 'The review is not a reply to the expected check-in post'
      };
    }

    return {
      verified: true,
      content: {
        author: content.author,
        permlink: content.permlink,
        parentAuthor: content.parent_author,
        parentPermlink: content.parent_permlink,
        created: content.created,
        body: content.body
      }
    };
  } catch (error) {
    console.error('Error verifying review permlink:', error.message);
    return {
      verified: false,
      error: 'VERIFICATION_FAILED',
      message: 'Failed to verify the review on the blockchain'
    };
  }
}

module.exports = {
  getHiveContent,
  verifyReviewPermlink
};
