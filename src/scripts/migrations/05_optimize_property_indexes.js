#!/usr/bin/env node
/**
 * Migration 05: Optimize Property Collection Indexes for High Scale
 * 
 * Supports:
 *   --dry-run (default, safe inspection)
 *   --apply   (commits updates to live database)
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  const isApply = process.argv.includes('--apply');
  console.log(`================================================================`);
  console.log(`  MIGRATION 05: OPTIMIZE PROPERTY INDEXES`);
  console.log(`  MODE: ${isApply ? '🚀 APPLYING TO LIVE DATABASE' : '🔍 DRY-RUN (no changes made)'}`);
  console.log(`================================================================\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const propertiesColl = db.collection('properties');

  const currentIndexes = await propertiesColl.indexes();
  console.log(`Current index count: ${currentIndexes.length}`);

  // Indexes to drop (redundant single-field low selectivity indexes)
  const indexesToDrop = [
    'purpose_1',
    'category_1',
  ];

  // Desired high-performance compound indexes
  const desiredIndexes = [
    { key: { cityId: 1, areaId: 1, status: 1 }, name: 'cityId_1_areaId_1_status_1' },
    { key: { cityId: 1, status: 1, 'pricing.expectedPrice': 1 }, name: 'cityId_1_status_1_price_1' },
    { key: { areaId: 1, status: 1 }, name: 'areaId_1_status_1' },
    { key: { slug: 1 }, name: 'slug_unique_idx', unique: true, sparse: true },
  ];

  for (const idxName of indexesToDrop) {
    const exists = currentIndexes.some(i => i.name === idxName);
    if (exists) {
      console.log(`⚠️ Will drop redundant index: "${idxName}"`);
      if (isApply) {
        await propertiesColl.dropIndex(idxName);
        console.log(`  🗑️ Dropped index "${idxName}"`);
      }
    }
  }

  for (const idx of desiredIndexes) {
    const exists = currentIndexes.some(i => i.name === idx.name);
    if (!exists) {
      console.log(`✨ Will create index: "${idx.name}" -> ${JSON.stringify(idx.key)}`);
      if (isApply) {
        const { key, ...options } = idx;
        await propertiesColl.createIndex(key, options);
        console.log(`  ✅ Created index "${idx.name}"`);
      }
    } else {
      console.log(`ℹ️ Index already exists: "${idx.name}"`);
    }
  }

  const finalIndexes = await propertiesColl.indexes();
  console.log(`\nFinal property index count: ${finalIndexes.length}\n`);

  if (!isApply) {
    console.log(`ℹ️ Dry run completed. To commit changes to the live DB, run:`);
    console.log(`   node src/scripts/migrations/05_optimize_property_indexes.js --apply\n`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
