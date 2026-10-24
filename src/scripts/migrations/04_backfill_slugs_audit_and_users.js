#!/usr/bin/env node
/**
 * Migration 04: Backfill Slugs, Status Audit Trail, Quality Scores, and User Roles
 * 
 * Supports:
 *   --dry-run (default, safe inspection)
 *   --apply   (commits updates to live database)
 */
require('dotenv').config();
const mongoose = require('mongoose');

const slugify = (text) => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

function calculateQualityScore(prop) {
  let score = 1;
  // 1. Title quality
  if (prop.title && prop.title.trim().length >= 8) score += 1;
  // 2. Photos quality
  if (Array.isArray(prop.photos) && prop.photos.length >= 3) score += 1;
  // 3. Pricing & rooms
  if (prop.pricing && (prop.pricing.expectedPrice > 0 || (prop.pgDetails && Array.isArray(prop.pgDetails.roomConfigs) && prop.pgDetails.roomConfigs.length > 0))) {
    score += 1;
  }
  // 4. Description & amenities
  if ((prop.description && prop.description.trim().length >= 40) || (Array.isArray(prop.amenities) && prop.amenities.length >= 3)) {
    score += 1;
  }
  return Math.min(5, Math.max(1, score));
}

async function run() {
  const isApply = process.argv.includes('--apply');
  console.log(`================================================================`);
  console.log(`  MIGRATION 04: BACKFILL SLUGS, AUDIT TRAIL, QUALITY SCORES & USERS`);
  console.log(`  MODE: ${isApply ? '🚀 APPLYING TO LIVE DATABASE' : '🔍 DRY-RUN (no changes made)'}`);
  console.log(`================================================================\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const propertiesColl = db.collection('properties');
  const pgsColl = db.collection('pgs');
  const usersColl = db.collection('users');

  // 1. Properties
  const properties = await propertiesColl.find({}).toArray();
  console.log(`Processing ${properties.length} properties...`);

  const propOps = [];
  const pgOps = [];
  const usedSlugs = new Set();

  for (const prop of properties) {
    const idSuffix = prop._id.toString().slice(-6);
    const titleSlug = slugify(prop.title || 'property');
    const citySlug = slugify(prop.city || 'city');
    let baseSlug = `${titleSlug}-${citySlug}-${idSuffix}`;

    // Collision check
    let uniqueSlug = baseSlug;
    let counter = 1;
    while (usedSlugs.has(uniqueSlug)) {
      uniqueSlug = `${baseSlug}-${counter++}`;
    }
    usedSlugs.add(uniqueSlug);

    const qualityScore = calculateQualityScore(prop);
    const initialAudit = Array.isArray(prop.statusHistory) && prop.statusHistory.length > 0
      ? prop.statusHistory
      : [
          {
            status: prop.status || 'approved',
            changedAt: prop.updatedAt || prop.createdAt || new Date(),
            reason: 'System status backfill',
          }
        ];

    propOps.push({
      updateOne: {
        filter: { _id: prop._id },
        update: {
          $set: {
            slug: uniqueSlug,
            statusHistory: initialAudit,
            dataQualityScore: qualityScore,
          },
        },
      },
    });

    pgOps.push({
      updateOne: {
        filter: { _id: prop._id },
        update: {
          $set: {
            slug: uniqueSlug,
          },
        },
      },
    });
  }

  // 2. Users
  const users = await usersColl.find({}).toArray();
  console.log(`Processing ${users.length} users for role normalization...`);
  const userOps = [];

  for (const user of users) {
    let roles = Array.isArray(user.roles) ? [...user.roles] : [];
    if (roles.length === 0 && user.role) {
      roles = [user.role];
    }
    if (roles.length === 0) {
      roles = ['tenant'];
    }

    const needsUpdate = !Array.isArray(user.roles) || user.roles.length !== roles.length;
    if (needsUpdate) {
      userOps.push({
        updateOne: {
          filter: { _id: user._id },
          update: {
            $set: {
              roles: Array.from(new Set(roles)),
              role: roles[0],
            },
          },
        },
      });
    }
  }

  console.log(`----------------------------------------------------------------`);
  console.log(`  MIGRATION 04 STATS`);
  console.log(`----------------------------------------------------------------`);
  console.log(`  Properties to update:  ${propOps.length}`);
  console.log(`  Users to update:       ${userOps.length}`);
  console.log(`----------------------------------------------------------------\n`);

  if (isApply) {
    console.log(`Writing property updates...`);
    for (let i = 0; i < propOps.length; i += 500) {
      const chunk = propOps.slice(i, i + 500);
      await propertiesColl.bulkWrite(chunk, { ordered: false });
    }
    console.log(`✅ Properties updated with slugs, statusHistory, qualityScores.`);

    console.log(`Writing legacy PG slug updates...`);
    for (let i = 0; i < pgOps.length; i += 500) {
      const chunk = pgOps.slice(i, i + 500);
      try {
        await pgsColl.bulkWrite(chunk, { ordered: false });
      } catch (_) {}
    }
    console.log(`✅ Legacy PGs updated with slugs.`);

    if (userOps.length > 0) {
      console.log(`Writing user role updates...`);
      await usersColl.bulkWrite(userOps, { ordered: false });
      console.log(`✅ Users normalized with roles array.`);
    }

    console.log(`\n🎉 MIGRATION 04 COMPLETE!`);
  } else {
    console.log(`ℹ️ Dry run completed. To commit changes to the live DB, run:`);
    console.log(`   node src/scripts/migrations/04_backfill_slugs_audit_and_users.js --apply\n`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
