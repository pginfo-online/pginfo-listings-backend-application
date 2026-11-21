const Redis = require('ioredis');
const { logger } = require('../utils/logger');

let redisConnection = null;

// Throttle logging to prevent console/log file spamming during outages
const logThrottle = {
  lastErrorLog: 0,
  lastRetryLog: 0,
  lastReconnectingLog: 0,
};

/**
 * Sanitize connection URL for secure logging (mask password and user info)
 * @param {string} url
 * @returns {string}
 */
const sanitizeRedisUrl = (url) => {
  if (!url) return '[empty]';
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '******';
    if (parsed.username && parsed.username !== 'default') parsed.username = '******';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
};

/**
 * Sanitize error message to prevent leaking credentials
 * @param {string} msg
 * @returns {string}
 */
const sanitizeErrorMessage = (msg) => {
  if (!msg || typeof msg !== 'string') return '';
  return msg
    .replace(/rediss?:\/\/[^@]+@/gi, 'rediss://***:***@')
    .replace(/(?:password|token|secret)[:=]\s*([^\s&]+)/gi, '$1=******');
};

const getRedisUrl = () => {
  const url = process.env.REDIS_URL?.trim() || '';
  if (!url) return '';
  // If user passes host:port without scheme (e.g. localhost:6379 or 127.0.0.1:6379), prepend redis://
  if (/^([a-zA-Z0-9.-]+):(\d+)$/.test(url)) {
    return `redis://${url}`;
  }
  return url;
};
const getRedisDb = () => Number(process.env.REDIS_DB !== undefined ? process.env.REDIS_DB : 0);
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'pgm:';

/**
 * Parse connection URL components safely
 * @returns {object|null}
 */
const parseRedisConfig = () => {
  const redisUrl = getRedisUrl();
  if (!redisUrl) return null;

  try {
    const parsed = new URL(redisUrl);
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: Number(parsed.port) || 6379,
      username: parsed.username || 'default',
      password: decodeURIComponent(parsed.password || ''),
      isTls: parsed.protocol === 'rediss:',
      db: getRedisDb(),
    };
  } catch (err) {
    logger.error(`[Redis] Failed to parse REDIS_URL: ${sanitizeErrorMessage(err.message)}`);
    return null;
  }
};

/**
 * Validate Redis configuration against production requirements
 * @returns {boolean}
 */
const validateRedisConfig = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const redisUrl = getRedisUrl();
  const isRedisDisabled = process.env.REDIS_ENABLED === 'false';

  if (isRedisDisabled || !redisUrl) {
    const msg = '[Redis] REDIS_URL environment variable is not configured. Backend running in resilient mode (in-memory caching & direct DB fallback).';
    if (process.env.REDIS_REQUIRED === 'true') {
      logger.error(`❌ ${msg}`);
      throw new Error(msg);
    }
    logger.warn(`⚠️ ${msg}`);
    return false;
  }

  let parsed;
  try {
    parsed = new URL(redisUrl);
  } catch (err) {
    const msg = `[Redis] Invalid REDIS_URL format: ${err.message}`;
    if (process.env.REDIS_REQUIRED === 'true' || process.env.REDIS_STRICT === 'true') {
      logger.error(`❌ ${msg}`);
      throw new Error(msg);
    }
    logger.warn(`⚠️ ${msg}. Backend will fall back to in-memory mode.`);
    return false;
  }

  const isLocalhost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1';

  // Remote production Redis over public internet should ideally use TLS (rediss://)
  if (isProduction && !isLocalhost && parsed.protocol !== 'rediss:') {
    const msg = `[Redis] Non-TLS protocol "${parsed.protocol}" in remote REDIS_URL. Strict mode requires TLS ("rediss://").`;
    if (process.env.REDIS_STRICT === 'true') {
      logger.error(`❌ ${msg}`);
      throw new Error(msg);
    }
    logger.warn(`⚠️ [Redis] Non-TLS protocol "${parsed.protocol}" for remote Redis. Consider using TLS ("rediss://") for external cloud Redis.`);
  }

  return true;
};

/**
 * Build production-grade ioredis options for Redis or Valkey
 * @param {object} customOptions
 * @returns {object}
 */
const createClientOptions = (customOptions = {}) => {
  const parsed = parseRedisConfig();
  const hostname = parsed?.hostname;

  return {
    // TLS settings with Server Name Indication (SNI) only when TLS is used
    tls: parsed?.isTls
      ? {
          servername: hostname,
          rejectUnauthorized: process.env.REDIS_REJECT_UNAUTHORIZED !== 'false',
        }
      : undefined,

    db: getRedisDb(),
    connectTimeout: 10000,
    keepAlive: 10000,
    lazyConnect: true,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(100 * 2 ** Math.min(times - 1, 6), 5000) + Math.floor(Math.random() * 100),

    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'];
      return targetErrors.some((error) => (err?.message || '').includes(error));
    },

    ...customOptions,
  };
};

/**
 * Attach lifecycle event listeners to an ioredis client
 * @param {Redis} client
 * @param {string} label
 */
const attachEventHandlers = (client, label = 'Redis') => {
  client.on('connect', () => {
    logger.info(`✅ [${label}] TCP/TLS connection established`);
  });

  client.on('ready', () => {
    logger.info(`✅ [${label}] Ready to accept commands`);
  });

  client.on('reconnecting', (delay) => {
    const now = Date.now();
    if (!logThrottle.lastReconnectingLog || now - logThrottle.lastReconnectingLog > 20000) {
      logThrottle.lastReconnectingLog = now;
      logger.warn(`⚠️ [${label}] Reconnecting in ${delay}ms...`);
    }
  });

  client.on('error', (err) => {
    const sanitized = sanitizeErrorMessage(err?.message || 'Unknown error');
    const now = Date.now();
    if (!logThrottle.lastErrorLog || now - logThrottle.lastErrorLog > 20000) {
      logThrottle.lastErrorLog = now;
      logger.error(`[${label}] ${sanitized}`);
    }
  });

  client.on('close', () => {
    logger.warn(`⚠️ [${label}] Connection closed`);
  });

  client.on('end', () => {
    logger.warn(`⚠️ [${label}] Connection ended`);
  });
};

/**
 * Get or initialize the singleton Redis client
 * @returns {Redis|null}
 */
const getRedisConnection = () => {
  if (redisConnection) {
    return redisConnection;
  }

  const redisUrl = getRedisUrl();
  if (!redisUrl || process.env.REDIS_ENABLED === 'false') {
    return null;
  }

  try {
    const options = createClientOptions();
    redisConnection = new Redis(redisUrl, options);

    attachEventHandlers(redisConnection, 'Redis');

    if (options.lazyConnect && redisConnection.status === 'wait') {
      redisConnection.connect().catch((err) => {
        const sanitized = sanitizeErrorMessage(err?.message);
        logger.warn(`⚠️ [Redis] Background connection attempt: ${sanitized}`);
      });
    }

    return redisConnection;
  } catch (err) {
    logger.warn(`⚠️ [Redis] Client initialization error: ${sanitizeErrorMessage(err.message)}`);
    return null;
  }
};

/**
 * Gracefully disconnect the singleton Redis connection
 * @param {number} timeoutMs
 */
const disconnectRedis = async (timeoutMs = 3000) => {
  const closeTasks = [];

  if (redisConnection && redisConnection.status !== 'end') {
    const client = redisConnection;
    closeTasks.push(
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { client.disconnect(); } catch (_) {}
          resolve();
        }, timeoutMs);

        client
          .quit()
          .catch(() => {
            try { client.disconnect(); } catch (_) {}
          })
          .finally(() => {
            clearTimeout(timer);
            resolve();
          });
      })
    );
  }

  try {
    await Promise.allSettled(closeTasks);
    logger.info('👋 Redis disconnected gracefully');
  } catch (err) {
    logger.error(`❌ Redis disconnect error: ${sanitizeErrorMessage(err.message)}`);
  } finally {
    redisConnection = null;
  }
};

/**
 * Fast health check via PING -> PONG
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
const isRedisHealthy = async (timeoutMs = 3000) => {
  try {
    const redis = getRedisConnection();
    if (!redis) return false;

    let timer;
    let onReady;
    const ping = async () => {
      if (redis.status !== 'ready') {
        await new Promise((resolve) => {
          onReady = resolve;
          redis.once('ready', onReady);
        });
      }
      return redis.ping();
    };
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });

    const result = await Promise.race([ping(), timeoutPromise]).finally(() => {
      clearTimeout(timer);
      if (onReady) redis.removeListener('ready', onReady);
    });

    return result === 'PONG';
  } catch {
    return false;
  }
};

module.exports = {
  getRedisConnection,
  disconnectRedis,
  isRedisHealthy,
  validateRedisConfig,
  parseRedisConfig,
  sanitizeRedisUrl,
  sanitizeErrorMessage,
  createClientOptions,
  REDIS_KEY_PREFIX,
  get REDIS_CONFIG() {
    return createClientOptions();
  },
};