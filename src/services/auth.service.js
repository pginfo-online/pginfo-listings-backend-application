'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User.model');
const tokenService = require('../modules/auth/services/token.service');
const { BadRequestError, UnauthorizedError, ConflictError } = require('../common/errors');

// ─────────────────────────────────────────────────────────────────────────────
// Token Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a signed JWT for a user (backward compatibility)
 * @param {string} userId
 * @returns {string} signed JWT
 */
const generateToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

// ─────────────────────────────────────────────────────────────────────────────
// Standard password-based auth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a new user with email + password
 * @param {{ name, email, phone?, password, role? }}
 */
const registerUser = async ({ name, email, phone, password, role }) => {
  const emailLower = email ? email.toLowerCase().trim() : null;
  const phoneNorm = phone ? phone.trim() : null;

  if (emailLower) {
    const existing = await User.findOne({ email: emailLower });
    if (existing) {
      throw new ConflictError('User with this email already exists');
    }
  }

  if (phoneNorm) {
    const existingPhone = await User.findOne({ phone: phoneNorm });
    if (existingPhone) {
      throw new ConflictError('User with this mobile number already exists');
    }
  }

  const assignedRole = role || 'tenant';
  const user = await User.create({
    name,
    email: emailLower || undefined,
    phone: phoneNorm || undefined,
    password,
    role: assignedRole,
    roles: [assignedRole],
  });

  const tokens = await tokenService.generateTokenPair(user);
  return { user: user.toSafeObject(), ...tokens };
};

/**
 * Log in a user with email OR phone number + password
 * @param {{ email: string, password: string }}
 */
const loginUser = async ({ email, password }) => {
  if (!email || !password) {
    throw new BadRequestError('Email/Mobile and password are required');
  }

  const identifier = email.trim();
  const isEmail = /\S+@\S+\.\S+/.test(identifier);
  const digits = identifier.replace(/\D/g, '');
  const isPhone = digits.length >= 10 && /^[6-9]\d{9}$/.test(digits.slice(-10));

  let query;
  if (isEmail) {
    query = { email: identifier.toLowerCase() };
  } else if (isPhone) {
    const phone10 = digits.slice(-10);
    query = { $or: [{ phone: phone10 }, { phone: identifier }] };
  } else {
    query = {
      $or: [
        { email: identifier.toLowerCase() },
        { phone: identifier },
        ...(digits.length >= 10 ? [{ phone: digits.slice(-10) }] : []),
      ],
    };
  }

  const user = await User.findOne(query).select('+password');

  if (!user) {
    throw new UnauthorizedError('Invalid email/mobile or password');
  }
  if (!user.isActive) {
    throw Object.assign(
      new Error('Your account has been suspended. Contact support.'),
      { statusCode: 403 }
    );
  }

  if (!user.password) {
    throw new BadRequestError('This account was created via OTP. Please log in using OTP.');
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw new UnauthorizedError('Invalid email/mobile or password');
  }

  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false });

  const tokens = await tokenService.generateTokenPair(user);
  return { user: user.toSafeObject(), ...tokens };
};

// ─────────────────────────────────────────────────────────────────────────────
// OTP-based auth helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a new user after OTP verification.
 */
const registerUserViaOtp = async ({ name, email, phone }) => {
  const emailNorm = email ? email.toLowerCase().trim() : null;
  const phoneNorm = phone ? phone.trim() : null;

  if (emailNorm) {
    const existingByEmail = await User.findOne({ email: emailNorm });
    if (existingByEmail) {
      existingByEmail.lastLogin = new Date();
      if (!existingByEmail.emailVerified) existingByEmail.emailVerified = true;
      await existingByEmail.save({ validateBeforeSave: false });
      const tokens = await tokenService.generateTokenPair(existingByEmail);
      return { user: existingByEmail.toSafeObject(), ...tokens };
    }
  }

  if (phoneNorm) {
    const existingByPhone = await User.findOne({ phone: phoneNorm });
    if (existingByPhone) {
      existingByPhone.lastLogin = new Date();
      if (!existingByPhone.phoneVerified) existingByPhone.phoneVerified = true;
      await existingByPhone.save({ validateBeforeSave: false });
      const tokens = await tokenService.generateTokenPair(existingByPhone);
      return { user: existingByPhone.toSafeObject(), ...tokens };
    }
  }

  const resolvedName = name && name.trim().length >= 2
    ? name.trim()
    : phoneNorm
      ? `User${phoneNorm.slice(-4)}`
      : 'PGinfo User';

  const randomPassword = crypto.randomBytes(20).toString('hex');

  const user = await User.create({
    name: resolvedName,
    email: emailNorm || undefined,
    phone: phoneNorm || undefined,
    password: randomPassword,
    role: 'tenant',
    roles: ['tenant'],
    emailVerified: !!emailNorm,
    phoneVerified: !!phoneNorm,
  });

  const tokens = await tokenService.generateTokenPair(user);
  return { user: user.toSafeObject(), ...tokens };
};

/**
 * Log in an existing user by email (after OTP verification)
 */
const loginUserViaOtp = async ({ email }) => {
  const emailLower = email.toLowerCase().trim();
  const user = await User.findOne({ email: emailLower });

  if (!user) {
    throw new UnauthorizedError('No account found with this email. Please register first.');
  }
  if (!user.isActive) {
    throw Object.assign(
      new Error('Your account has been suspended. Contact support.'),
      { statusCode: 403 }
    );
  }

  user.lastLogin = new Date();
  if (!user.emailVerified) user.emailVerified = true;
  await user.save({ validateBeforeSave: false });

  const tokens = await tokenService.generateTokenPair(user);
  return { user: user.toSafeObject(), ...tokens };
};

/**
 * Log in an existing user by phone (after OTP verification)
 */
const loginUserViaPhone = async ({ phone }) => {
  const phoneNorm = phone.trim();
  const user = await User.findOne({ phone: phoneNorm });

  if (!user) {
    throw new UnauthorizedError('No account found with this number. Please register first.');
  }
  if (!user.isActive) {
    throw Object.assign(
      new Error('Your account has been suspended. Contact support.'),
      { statusCode: 403 }
    );
  }

  user.lastLogin = new Date();
  if (!user.phoneVerified) user.phoneVerified = true;
  await user.save({ validateBeforeSave: false });

  const tokens = await tokenService.generateTokenPair(user);
  return { user: user.toSafeObject(), ...tokens };
};

/**
 * Update user push notification token
 */
const updatePushToken = async (userId, pushToken) => {
  const user = await User.findById(userId);
  if (!user) throw new UnauthorizedError('User not found');

  user.pushNotificationToken = pushToken || null;
  await user.save({ validateBeforeSave: false });
  return user.toSafeObject();
};

/**
 * Login with full context for web and mobile clients
 */
const loginUserEmailPassword = async ({ email, password }) => {
  const { deriveCapabilities, deriveAvailableModes } = require('../utils/capabilities');
  const { getMembershipSummary } = require('../utils/memberships');

  const result = await loginUser({ email, password });
  const freshUser = await User.findById(result.user._id || result.user.id);

  const capabilities = deriveCapabilities(freshUser);
  const availableModes = deriveAvailableModes(freshUser);

  const userRoles = Array.isArray(freshUser.roles) && freshUser.roles.length > 0
    ? freshUser.roles
    : [freshUser.role || 'tenant'];

  const memberships = await getMembershipSummary(freshUser._id, userRoles);

  return {
    user: result.user,
    token: result.token,
    accessToken: result.accessToken || result.token,
    refreshToken: result.refreshToken,
    capabilities,
    memberships,
    availableModes,
  };
};

/**
 * Refresh access token using refresh token
 */
const refreshAccessToken = async ({ refreshToken, userId }) => {
  if (!refreshToken) {
    throw new BadRequestError('Refresh token is required');
  }

  let targetUserId = userId;
  if (!targetUserId) {
    try {
      const decoded = jwt.decode(refreshToken);
      if (decoded && decoded.id) targetUserId = decoded.id;
    } catch (_) {}
  }

  if (targetUserId) {
    const isValid = await tokenService.verifyRefreshToken(targetUserId, refreshToken);
    if (!isValid) {
      throw new UnauthorizedError('Invalid or revoked refresh token');
    }
  }

  const user = await User.findById(targetUserId);
  if (!user || !user.isActive) {
    throw new UnauthorizedError('User not found or account is deactivated');
  }

  // Revoke old refresh token (rotation)
  if (targetUserId) {
    await tokenService.revokeRefreshToken(targetUserId, refreshToken);
  }

  const tokens = await tokenService.generateTokenPair(user);

  return {
    user: user.toSafeObject(),
    ...tokens,
  };
};

/**
 * Logout user session (revokes refresh token)
 */
const logoutUser = async ({ userId, refreshToken }) => {
  if (userId && refreshToken) {
    await tokenService.revokeRefreshToken(userId, refreshToken);
  }
  return { success: true, message: 'Logged out successfully' };
};

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  generateToken,
  registerUser,
  loginUser,
  loginUserEmailPassword,
  updatePushToken,
  registerUserViaOtp,
  loginUserViaOtp,
  loginUserViaPhone,
  refreshAccessToken,
  logoutUser,
};
