'use strict';

/**
 * memberships.js
 *
 * Async helper that builds a lightweight membership summary for a user.
 * Used in GET /auth/me to inform the mobile app how many PG listings
 * the user owns — without sending full lists.
 *
 * This uses countDocuments() only — no full document fetch.
 * The full PG list is fetched lazily by its screen.
 */

/**
 * Build membership summary for a user.
 *
 * Returns booleans + counts so the mobile app can decide:
 *  - Whether to offer 'pg_owner' mode
 *  - Whether to show "empty state" vs "dashboard" in owner screens
 *
 * @param {string|ObjectId} userId  - The user's _id
 * @param {string[]} userRoles      - The user's normalized roles[]
 * @returns {Promise<MembershipSummary>}
 *
 * @typedef {Object} MembershipSummary
 * @property {boolean} pgOwner      - User has PG owner role
 * @property {number}  pgCount      - Number of PGs this user owns (active)
 * @property {boolean} hasPGs       - Shorthand: pgCount > 0
 */
const getMembershipSummary = async (userId, userRoles = []) => {
  const isPgOwner = userRoles.includes('owner') || userRoles.includes('pg_owner');
  const isAdmin = userRoles.includes('admin');

  let pgCount = 0;

  // Only query if user actually has the relevant role (or is admin)
  const countsToFetch = [];

  if (isPgOwner || isAdmin) {
    countsToFetch.push(
      (async () => {
        try {
          const Property = require('../models/Property.model');
          pgCount = await Property.countDocuments({ owner: userId, category: 'pg' });
        } catch (_) {
          // Non-critical — if Property model fails, default to 0
          pgCount = 0;
        }
      })()
    );
  }

  // Run in parallel
  if (countsToFetch.length > 0) {
    await Promise.all(countsToFetch);
  }

  return {
    pgOwner: isPgOwner || isAdmin,
    pgCount,
    hasPGs: pgCount > 0,
  };
};

module.exports = { getMembershipSummary };
