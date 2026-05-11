/**
 * Redis Cache Layer — Persistent, shared cache for resolver data
 *
 * Performance improvement #4: Redis Cache Layer
 * 
 * Benefits:
 * - Cache survives server restarts
 * - Can share cache across multiple server instances
 * - Instant playback for popular tracks
 */

const redis = require('redis');
const { RESOLVER_CACHE_TTL } = require('./resolver');

let client = null;
let isConnected = false;

/**
 * Initialize Redis client connection
 */
async function init() {
  if (client) return client;

  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    client = redis.createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error('[redis-cache] Too many reconnect attempts, giving up');
            return new Error('Too many reconnect attempts');
          }
          const delay = Math.min(retries * 100, 3000);
          console.log(`[redis-cache] Reconnecting in ${delay}ms...`);
          return delay;
        }
      }
    });

    client.on('error', (err) => {
      console.error('[redis-cache] Client error:', err.message);
      isConnected = false;
    });

    client.on('connect', () => {
      console.log('[redis-cache] Connected to Redis');
      isConnected = true;
    });

    client.on('disconnect', () => {
      console.log('[redis-cache] Disconnected from Redis');
      isConnected = false;
    });

    await client.connect();
    return client;
  } catch (err) {
    console.error('[redis-cache] Failed to connect to Redis:', err.message);
    console.log('[redis-cache] Will continue with in-memory cache only');
    return null;
  }
}

/**
 * Get a cached resolution from Redis
 * @param {string} videoId 
 * @returns {Promise<object|null>}
 */
async function getCachedResolution(videoId) {
  if (!client || !isConnected) return null;

  try {
    const key = `resolve:${videoId}`;
    const cached = await client.get(key);
    
    if (cached) {
      const data = JSON.parse(cached);
      // Check if expired (parse ISO string to timestamp)
      const resolvedTime = new Date(data.resolvedAt).getTime();
      if (Date.now() - resolvedTime < RESOLVER_CACHE_TTL) {
        return data;
      }
      // Delete expired entry
      await client.del(key);
    }
  } catch (err) {
    console.error(`[redis-cache] Get failed for ${videoId}:`, err.message);
  }
  
  return null;
}

/**
 * Cache a resolution in Redis
 * @param {string} videoId 
 * @param {object} data 
 */
async function setCachedResolution(videoId, data) {
  if (!client || !isConnected) return;

  try {
    const key = `resolve:${videoId}`;
    const ttl = Math.floor(RESOLVER_CACHE_TTL / 1000); // Convert to seconds
    await client.setEx(key, ttl, JSON.stringify(data));
    console.log(`[redis-cache] Cached ${videoId} for ${ttl}s`);
  } catch (err) {
    console.error(`[redis-cache] Set failed for ${videoId}:`, err.message);
  }
}

/**
 * Pre-warm cache for top video IDs
 * Useful for startup or scheduled tasks
 * @param {string[]} topVideoIds 
 */
async function preWarmCache(topVideoIds) {
  if (!client || !isConnected) {
    console.log('[redis-cache] Not connected, skipping pre-warm');
    return;
  }

  try {
    console.log(`[redis-cache] Pre-warming cache for ${topVideoIds.length} tracks`);
    
    // Batch get to check what's already cached
    const pipeline = client.multi();
    const keys = topVideoIds.map(id => `resolve:${id}`);
    keys.forEach(key => pipeline.get(key));
    
    const results = await pipeline.exec();
    
    // Resolve missing IDs (where result is null)
    const missingIds = topVideoIds.filter((id, i) => !results[i][1]);
    
    if (missingIds.length > 0) {
      console.log(`[redis-cache] ${missingIds.length} tracks not cached, will resolve on demand`);
      // The resolver will cache them when first accessed
    }
    
    console.log(`[redis-cache] Pre-warm complete: ${topVideoIds.length - missingIds.length} already cached`);
  } catch (err) {
    console.error('[redis-cache] Pre-warm failed:', err.message);
  }
}

/**
 * Get cache statistics
 */
async function getStats() {
  if (!client || !isConnected) {
    return { connected: false };
  }

  try {
    const info = await client.info('stats');
    const dbSize = await client.dbSize();
    
    return {
      connected: true,
      totalKeys: dbSize,
      info: info,
    };
  } catch (err) {
    console.error('[redis-cache] Stats failed:', err.message);
    return { connected: false, error: err.message };
  }
}

/**
 * Clear all resolver cache entries
 */
async function clearCache() {
  if (!client || !isConnected) return;

  try {
    const pattern = 'resolve:*';
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(keys);
      console.log(`[redis-cache] Cleared ${keys.length} cache entries`);
    }
  } catch (err) {
    console.error('[redis-cache] Clear cache failed:', err.message);
  }
}

/**
 * Check if Redis is available
 */
function isAvailable() {
  return client && isConnected;
}

// Auto-initialize on module load (optional)
// Commented out to let server.js control initialization
// init().catch(() => {});

module.exports = {
  init,
  getCachedResolution,
  setCachedResolution,
  preWarmCache,
  getStats,
  clearCache,
  isAvailable,
};