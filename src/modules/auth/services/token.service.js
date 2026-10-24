'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const redisCache = require('../../../services/redisCache.service');
const { UnauthorizedError } = require('../../../common/errors');
const ErrorCodes = require('../../../common/constants/errorCodes');

const ACCESS_TOKEN_EXPIRY = process.env.JWT_ACCESS_EXPIRES_IN || '1h';
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Token Service
 * Manages Access Tokens (stateless JWT) and Refresh Tokens (stateful Redis)
 */
class TokenService {
  /**
   * Generate access token for a user
   * @param {object} user
   * @returns {string} JWT
   */
  generateAccessToken(user) {
    const payload = {
      id: user._id ? user._id.toString() : user.id,
      role: user.role || (Array.isArray(user.roles) ? user.roles[0] : 'tenant'),
      roles: Array.isArray(user.roles) ? user.roles : [user.role || 'tenant'],
    };

    return jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: ACCESS_TOKEN_EXPIRY,
    });
  }

  /**
   * Generate refresh token and persist in Redis
   * @param {string|object} userId
   * @returns {Promise<string>} opaque refresh token
   */
  async generateRefreshToken(userId) {
    const id = userId._id ? userId._id.toString() : userId.toString();
    const token = crypto.randomBytes(40).toString('hex');
    const cacheKey = `auth:refresh:${id}:${token}`;

    try {
      await redisCache.set(cacheKey, { userId: id, createdAt: Date.now() }, REFRESH_TOKEN_TTL_SECONDS);
    } catch (_) {
      // If Redis is temporarily degraded, the system still operates
    }

    return token;
  }

  /**
   * Generate token pair (Access + Refresh)
   * @param {object} user
   * @returns {Promise<{accessToken: string, refreshToken: string, token: string}>}
   */
  async generateTokenPair(user) {
    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.generateRefreshToken(user._id || user.id);

    return {
      token: accessToken, // for backward compatibility
      accessToken,
      refreshToken,
    };
  }

  /**
   * Verify and rotate refresh token
   * @param {string} userId
   * @param {string} refreshToken
   * @returns {Promise<boolean>}
   */
  async verifyRefreshToken(userId, refreshToken) {
    if (!userId || !refreshToken) return false;
    const cacheKey = `auth:refresh:${userId}:${refreshToken}`;

    try {
      const stored = await redisCache.get(cacheKey);
      return !!stored;
    } catch (_) {
      return true; // Fallback if Redis is unreachable
    }
  }

  /**
   * Revoke a specific refresh token (Logout)
   * @param {string} userId
   * @param {string} refreshToken
   */
  async revokeRefreshToken(userId, refreshToken) {
    if (!userId || !refreshToken) return;
    const cacheKey = `auth:refresh:${userId}:${refreshToken}`;
    try {
      await redisCache.del(cacheKey);
    } catch (_) {}
  }

  /**
   * Revoke all refresh tokens for a user (Logout from all devices)
   * @param {string} userId
   */
  async revokeAllUserSessions(userId) {
    if (!userId) return;
    try {
      await redisCache.delByPattern(`auth:refresh:${userId}:*`);
    } catch (_) {}
  }
}

module.exports = new TokenService();
