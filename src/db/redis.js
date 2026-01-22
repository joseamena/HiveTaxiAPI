const redis = require('redis');

// Ensure dotenv is loaded
require('dotenv').config();

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';

const redisUrl = REDIS_PASSWORD 
  ? `redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}`
  : `redis://${REDIS_HOST}:${REDIS_PORT}`;

const redisClient = redis.createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 5) {
        console.error('❌ Redis connection failed after 5 retries');
        return false;
      }
      return Math.min(retries * 100, 3000);
    }
  }
});

redisClient.on('connect', () => {
  console.log('✅ Redis client connected');
});

redisClient.on('error', (err) => {
  console.error('❌ Redis client error:', err.message);
});

// Connect asynchronously without blocking
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('⚠️  Redis connection failed:', err.message);
  }
})();

module.exports = redisClient;