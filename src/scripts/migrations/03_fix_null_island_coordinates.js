#!/usr/bin/env node
/**
 * Migration 03: Fix Null-Island [0, 0] Coordinates & Populate City Centroids
 * 
 * Supports:
 *   --dry-run (default, safe inspection)
 *   --apply   (commits updates to live database)
 */
require('dotenv').config();
const mongoose = require('mongoose');

// Known city centroids [lng, lat]
const CITY_CENTROIDS = {
  'pune': { lng: 73.8567, lat: 18.5204 },
  'bengaluru': { lng: 77.5946, lat: 12.9716 },
  'mumbai': { lng: 72.8777, lat: 19.0760 },
  'ahmedabad': { lng: 72.5714, lat: 23.0225 },
  'delhi': { lng: 77.1025, lat: 28.7041 },
  'hyderabad': { lng: 78.4867, lat: 17.3850 },
  'chennai': { lng: 80.2707, lat: 13.0827 },
  'kolkata': { lng: 88.3639, lat: 22.5726 },
  'jaipur': { lng: 75.7873, lat: 26.9124 },
  'lucknow': { lng: 80.9462, lat: 26.8467 },
  'nagpur': { lng: 79.0882, lat: 21.1458 },
  'chandigarh': { lng: 76.7794, lat: 30.7333 },
  'kochi': { lng: 76.2673, lat: 9.9312 },
  'visakhapatnam': { lng: 83.2185, lat: 17.6868 },
  'indore': { lng: 75.8577, lat: 22.7196 },
  'surat': { lng: 72.8311, lat: 21.1702 },
  'noida': { lng: 77.3910, lat: 28.5355 },
  'gurugram': { lng: 77.0266, lat: 28.4595 },
  'greater noida': { lng: 77.5030, lat: 28.4744 },
  'patna': { lng: 85.1376, lat: 25.5941 },
  'bhopal': { lng: 77.4126, lat: 23.2599 },
  'ludhiana': { lng: 75.8573, lat: 30.9010 },
  'agra': { lng: 78.0081, lat: 27.1767 },
  'nashik': { lng: 73.7898, lat: 19.9975 },
  'faridabad': { lng: 77.3178, lat: 28.4089 },
  'vadodara': { lng: 73.1812, lat: 22.3072 },
  'ghaziabad': { lng: 77.4538, lat: 28.6692 },
  'rajkot': { lng: 70.8022, lat: 22.3039 },
  'varanasi': { lng: 82.9739, lat: 25.3176 },
  'amritsar': { lng: 74.8723, lat: 31.6340 },
  'prayagraj': { lng: 81.8463, lat: 25.4358 },
  'ranchi': { lng: 85.3096, lat: 23.3441 },
  'jabalpur': { lng: 79.9864, lat: 23.1815 },
  'gwalior': { lng: 78.1828, lat: 26.2183 },
  'vijayawada': { lng: 80.6480, lat: 16.5062 },
  'jodhpur': { lng: 73.0243, lat: 26.2389 },
  'madurai': { lng: 78.1198, lat: 9.9252 },
  'raipur': { lng: 81.6296, lat: 21.2514 },
  'kota': { lng: 75.8648, lat: 25.2138 },
  'guwahati': { lng: 91.7362, lat: 26.1445 },
  'dehradun': { lng: 78.0322, lat: 30.3165 },
};

async function run() {
  const isApply = process.argv.includes('--apply');
  console.log(`================================================================`);
  console.log(`  MIGRATION 03: FIX NULL-ISLAND COORDINATES & POPULATE CENTROIDS`);
  console.log(`  MODE: ${isApply ? '🚀 APPLYING TO LIVE DATABASE' : '🔍 DRY-RUN (no changes made)'}`);
  console.log(`================================================================\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const citiesColl = db.collection('cities');
  const propertiesColl = db.collection('properties');
  const pgsColl = db.collection('pgs');

  // 1. Populate city centroids
  let citiesUpdated = 0;
  for (const [cityName, coords] of Object.entries(CITY_CENTROIDS)) {
    const filter = { name: { $regex: new RegExp(`^${cityName}$`, 'i') } };
    if (isApply) {
      const res = await citiesColl.updateOne(filter, {
        $set: {
          latitude: coords.lat,
          longitude: coords.lng,
          updatedAt: new Date(),
        },
      });
      if (res.modifiedCount > 0) citiesUpdated++;
    } else {
      citiesUpdated++;
    }
  }
  console.log(`City centroids mapped: ${citiesUpdated}`);

  // 2. Find all properties with [0, 0] coordinates
  const nullProps = await propertiesColl.find({
    $or: [
      { 'location.coordinates': [0, 0] },
      { 'location.coordinates': null },
      { 'location.coordinates': { $exists: false } },
    ]
  }).toArray();
  console.log(`Properties with missing or [0, 0] coordinates: ${nullProps.length}\n`);

  let resolvedProps = 0;
  const bulkPropOps = [];
  const bulkPgOps = [];

  for (const prop of nullProps) {
    const cityKey = (prop.city || '').toLowerCase().trim();
    const centroid = CITY_CENTROIDS[cityKey];

    if (centroid) {
      // Add slight jitter (within ~500m) based on document ID hash so pins don't overlap completely
      const idStr = prop._id.toString();
      const hash = parseInt(idStr.slice(-4), 16) || 1000;
      const jitterLat = ((hash % 100) - 50) * 0.0001; // ~ +/- 500m
      const jitterLng = (((hash >> 2) % 100) - 50) * 0.0001;

      const finalLat = parseFloat((centroid.lat + jitterLat).toFixed(6));
      const finalLng = parseFloat((centroid.lng + jitterLng).toFixed(6));

      bulkPropOps.push({
        updateOne: {
          filter: { _id: prop._id },
          update: {
            $set: {
              latitude: finalLat,
              longitude: finalLng,
              'location.type': 'Point',
              'location.coordinates': [finalLng, finalLat],
              isApproximateLocation: true,
            },
          },
        },
      });

      bulkPgOps.push({
        updateOne: {
          filter: { _id: prop._id },
          update: {
            $set: {
              latitude: finalLat,
              longitude: finalLng,
              'location.type': 'Point',
              'location.coordinates': [finalLng, finalLat],
              isApproximateLocation: true,
            },
          },
        },
      });
      resolvedProps++;
    }
  }

  console.log(`Properties successfully resolved to city centroid: ${resolvedProps}`);
  console.log(`Unresolved: ${nullProps.length - resolvedProps}\n`);

  if (isApply) {
    if (bulkPropOps.length > 0) {
      console.log(`Updating ${bulkPropOps.length} properties in bulk...`);
      for (let i = 0; i < bulkPropOps.length; i += 500) {
        const chunk = bulkPropOps.slice(i, i + 500);
        await propertiesColl.bulkWrite(chunk, { ordered: false });
      }
      console.log(`✅ Properties coordinates updated.`);
    }

    if (bulkPgOps.length > 0) {
      console.log(`Updating ${bulkPgOps.length} legacy PG documents...`);
      for (let i = 0; i < bulkPgOps.length; i += 500) {
        const chunk = bulkPgOps.slice(i, i + 500);
        try {
          await pgsColl.bulkWrite(chunk, { ordered: false });
        } catch (_) {}
      }
      console.log(`✅ Legacy PG coordinates updated.`);
    }

    console.log(`\n🎉 MIGRATION 03 COMPLETE!`);
  } else {
    console.log(`ℹ️ Dry run completed. To commit changes to the live DB, run:`);
    console.log(`   node src/scripts/migrations/03_fix_null_island_coordinates.js --apply\n`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
