const { getRedisConnection } = require('../config/redis');
const { logger } = require('../utils/logger');

/**
 * redisCache.service.js — Production-Grade Resilient Redis Cache Layer
 *
 * Principles:
 * 1. Redis is an accelerator, NEVER a single point of failure.
 * 2. Every operation is timeout-protected (2500ms max) and fails soft (returns null / false).
 * 3. Automatic in-memory fallback cache when Redis credentials are not configured or Redis is offline.
 * 4. Consistent, deterministic cache key namespacing with REDIS_KEY_PREFIX.
 * 5. Automatic JSON serialization / deserialization.
 * 6. Safe pattern-based invalidation with SCAN (never KEYS in production).
 */

const PREFIX = process.env.REDIS_KEY_PREFIX || 'pgm:';
const TIMEOUT_MS = Number(process.env.REDIS_TIMEOUT_MS) || 2500;

const withTimeout = (promise, ms = TIMEOUT_MS) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis operation timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * In-memory fallback cache with TTL and automatic LRU eviction.
 * Allows the entire application (sessions, token refresh, search caching)
 * to run reliably even if Redis credentials are not provided or during Redis maintenance.
 */
class MemoryFallback {
  constructor(maxSize = 2500) {
    this.store = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.value);
    } catch {
      return entry.value;
    }
  }

  set(key, value, ttlSeconds = 300) {
    if (this.store.size >= this.maxSize) {
      const now = Date.now();
      let evicted = 0;
      for (const [k, v] of this.store.entries()) {
        if (v.expiresAt && now > v.expiresAt) {
          this.store.delete(k);
          evicted++;
        }
      }
      if (evicted < 100) {
        const iter = this.store.keys();
        for (let i = 0; i < 100; i++) {
          const next = iter.next();
          if (next.done) break;
          this.store.delete(next.value);
        }
      }
    }

    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
    });
    return true;
  }

  del(key) {
    return this.store.delete(key);
  }

  delByPattern(pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}`);
    for (const key of this.store.keys()) {
      if (regex.test(key)) {
        this.store.delete(key);
      }
    }
    return true;
  }

  clear() {
    this.store.clear();
  }
}

const memoryFallback = new MemoryFallback();

class RedisCacheService {
  _getClient() {
    try {
      const client = getRedisConnection();
      if (!client || client.status !== 'ready') return null;
      return client;
    } catch (err) {
      logger.warn(`[RedisCache] Could not acquire Redis connection: ${err.message}`);
      return null;
    }
  }

  _formatKey(key) {
    if (key.startsWith(PREFIX)) return key;
    return `${PREFIX}${key}`;
  }

  /**
   * Get cached JSON object by key
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  async get(key) {
    const fullKey = this._formatKey(key);
    try {
      const client = this._getClient();
      if (!client) {
        return memoryFallback.get(fullKey);
      }

      const data = await withTimeout(client.get(fullKey));
      if (!data) return memoryFallback.get(fullKey);

      return JSON.parse(data);
    } catch (err) {
      logger.warn(`[RedisCache] GET error: ${err.message}`);
      return memoryFallback.get(fullKey);
    }
  }

  /**
   * Set cached JSON object with TTL in seconds
   * @param {string} key
   * @param {any} value
   * @param {number} ttlSeconds - Default 300s (5 mins)
   * @returns {Promise<boolean>}
   */
  async set(key, value, ttlSeconds = 300) {
    const fullKey = this._formatKey(key);
    try {
      const client = this._getClient();
      if (!client) {
        return memoryFallback.set(fullKey, value, ttlSeconds);
      }

      const serialized = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await withTimeout(client.set(fullKey, serialized, 'EX', ttlSeconds));
      } else {
        await withTimeout(client.set(fullKey, serialized));
      }
      return true;
    } catch (err) {
      logger.warn(`[RedisCache] SET error: ${err.message}`);
      return memoryFallback.set(fullKey, value, ttlSeconds);
    }
  }

  /**
   * Delete specific key
   * @param {string} key
   */
  async del(key) {
    const fullKey = this._formatKey(key);
    memoryFallback.del(fullKey);
    try {
      const client = this._getClient();
      if (!client) return true;

      await withTimeout(client.del(fullKey));
      return true;
    } catch (err) {
      logger.warn(`[RedisCache] DEL error: ${err.message}`);
      return false;
    }
  }

  /**
   * Delete keys by pattern using SCAN (production-safe, non-blocking)
   * @param {string} pattern - e.g. 'search:properties:*'
   */
  async delByPattern(pattern) {
    const fullPattern = this._formatKey(pattern);
    memoryFallback.delByPattern(fullPattern);
    try {
      const client = this._getClient();
      if (!client) return true;

      let cursor = '0';
      do {
        const [nextCursor, keys] = await withTimeout(client.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100));
        cursor = nextCursor;
        if (keys && keys.length > 0) {
          await withTimeout(client.del(...keys));
        }
      } while (cursor !== '0');

      return true;
    } catch (err) {
      logger.warn(`[RedisCache] delByPattern error for "${pattern}": ${err.message}`);
      return false;
    }
  }

  /**
   * Helper to inspect memory fallback store for diagnostics / testing
   */
  get memoryStore() {
    return memoryFallback;
  }
}

module.exports = new RedisCacheService();
