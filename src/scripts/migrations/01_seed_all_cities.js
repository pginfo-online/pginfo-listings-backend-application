#!/usr/bin/env node
/**
 * Migration 01: Seed & Sync All Cities from data/cities.json
 * 
 * Supports:
 *   --dry-run (default, safe inspection)
 *   --apply   (commits updates to live database)
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

// Standard aliases for major Indian cities
const KNOWN_ALIASES = {
  'bengaluru': ['Bangalore', 'Bengaluru Urban', 'Bengaluru Rural'],
  'gurugram': ['Gurgaon'],
  'mumbai': ['Bombay'],
  'kolkata': ['Calcutta'],
  'chennai': ['Madras'],
  'delhi': ['New Delhi', 'National Capital Region', 'NCR'],
  'prayagraj': ['Allahabad'],
  'visakhapatnam': ['Vizag', 'Vishakhapatnam'],
  'puducherry': ['Pondicherry'],
  'varanasi': ['Benares', 'Banaras', 'Kashi'],
  'thiruvananthapuram': ['Trivandrum'],
  'kochi': ['Cochin', 'Ernakulam'],
  'kozhikode': ['Calicut'],
  'mysuru': ['Mysore'],
  'mangaluru': ['Mangalore'],
  'belagavi': ['Belgaum'],
  'kalaburagi': ['Gulbarga'],
  'vijayapura': ['Bijapur'],
  'vadodara': ['Baroda'],
  'chhatrapati sambhajinagar': ['Aurangabad'],
  'dharashiv': ['Osmanabad'],
  'noida': ['Gautam Buddha Nagar'],
  'greater noida': ['Noida Extension'],
  'pune': ['Poona', 'Pimpri-Chinchwad'],
  'hyderabad': ['Secunderabad', 'Cyberabad'],
};

// Priority tier-1 / tier-2 cities
const TIER_1_CITIES = new Set([
  'delhi', 'mumbai', 'bengaluru', 'hyderabad', 'chennai', 'kolkata', 'pune', 'gurugram', 'noida', 'ahmedabad'
]);
const TIER_2_CITIES = new Set([
  'jaipur', 'lucknow', 'chandigarh', 'indore', 'nagpur', 'surat', 'bhopal', 'visakhapatnam', 'patna', 'vadodara',
  'ghaziabad', 'ludhiana', 'agra', 'nashik', 'faridabad', 'meerut', 'rajkot', 'varanasi', 'srinagar', 'aurangabad',
  'dhanbad', 'amritsar', 'navi mumbai', 'allahabad', 'ranchi', 'howrah', 'coimbatore', 'jabalpur', 'gwalior', 'vijayawada',
  'jodhpur', 'madurai', 'raipur', 'kota', 'guwahati', 'greater noida', 'kochi', 'dehradun'
]);

// Known state mappings for major cities
const STATE_MAP = {
  'delhi': 'Delhi', 'new delhi': 'Delhi',
  'mumbai': 'Maharashtra', 'pune': 'Maharashtra', 'nagpur': 'Maharashtra', 'nashik': 'Maharashtra', 'navi mumbai': 'Maharashtra', 'thane': 'Maharashtra', 'aurangabad': 'Maharashtra', 'kolhapur': 'Maharashtra', 'solapur': 'Maharashtra', 'amravati': 'Maharashtra',
  'bengaluru': 'Karnataka', 'bangalore': 'Karnataka', 'mysuru': 'Karnataka', 'hubballi': 'Karnataka', 'mangaluru': 'Karnataka', 'belagavi': 'Karnataka',
  'hyderabad': 'Telangana', 'warangal': 'Telangana', 'nizamabad': 'Telangana',
  'chennai': 'Tamil Nadu', 'coimbatore': 'Tamil Nadu', 'madurai': 'Tamil Nadu', 'tiruchirappalli': 'Tamil Nadu', 'salem': 'Tamil Nadu',
  'kolkata': 'West Bengal', 'howrah': 'West Bengal', 'siliguri': 'West Bengal', 'durgapur': 'West Bengal', 'asansol': 'West Bengal',
  'ahmedabad': 'Gujarat', 'surat': 'Gujarat', 'vadodara': 'Gujarat', 'rajkot': 'Gujarat', 'bhavnagar': 'Gujarat', 'jamnagar': 'Gujarat',
  'gurugram': 'Haryana', 'faridabad': 'Haryana', 'panipat': 'Haryana', 'ambala': 'Haryana', 'karnal': 'Haryana', 'rohtak': 'Haryana',
  'noida': 'Uttar Pradesh', 'greater noida': 'Uttar Pradesh', 'lucknow': 'Uttar Pradesh', 'kanpur': 'Uttar Pradesh', 'ghaziabad': 'Uttar Pradesh', 'agra': 'Uttar Pradesh', 'varanasi': 'Uttar Pradesh', 'prayagraj': 'Uttar Pradesh', 'meerut': 'Uttar Pradesh', 'bareilly': 'Uttar Pradesh', 'aligarh': 'Uttar Pradesh', 'moradabad': 'Uttar Pradesh', 'gorakhpur': 'Uttar Pradesh',
  'jaipur': 'Rajasthan', 'jodhpur': 'Rajasthan', 'kota': 'Rajasthan', 'bikaner': 'Rajasthan', 'ajmer': 'Rajasthan', 'udaipur': 'Rajasthan', 'sikar': 'Rajasthan', 'alwar': 'Rajasthan', 'bhilwara': 'Rajasthan',
  'chandigarh': 'Chandigarh',
  'ludhiana': 'Punjab', 'amritsar': 'Punjab', 'jalandhar': 'Punjab', 'patiala': 'Punjab', 'bathinda': 'Punjab', 'mohali': 'Punjab', 'kharar': 'Punjab',
  'indore': 'Madhya Pradesh', 'bhopal': 'Madhya Pradesh', 'jabalpur': 'Madhya Pradesh', 'gwalior': 'Madhya Pradesh', 'ujjain': 'Madhya Pradesh',
  'patna': 'Bihar', 'gaya': 'Bihar', 'bhagalpur': 'Bihar', 'muzaffarpur': 'Bihar',
  'ranchi': 'Jharkhand', 'jamshedpur': 'Jharkhand', 'dhanbad': 'Jharkhand',
  'bhubaneswar': 'Odisha', 'cuttack': 'Odisha', 'rourkela': 'Odisha',
  'visakhapatnam': 'Andhra Pradesh', 'vijayawada': 'Andhra Pradesh', 'guntur': 'Andhra Pradesh', 'nellore': 'Andhra Pradesh', 'tirupati': 'Andhra Pradesh',
  'kochi': 'Kerala', 'thiruvananthapuram': 'Kerala', 'kozhikode': 'Kerala', 'thrissur': 'Kerala', 'kollam': 'Kerala',
  'guwahati': 'Assam',
  'dehradun': 'Uttarakhand', 'haridwar': 'Uttarakhand', 'rishikesh': 'Uttarakhand',
  'shimla': 'Himachal Pradesh', 'dharamshala': 'Himachal Pradesh',
  'goa': 'Goa', 'panaji': 'Goa',
};

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

async function run() {
  const isApply = process.argv.includes('--apply');
  console.log(`================================================================`);
  console.log(`  MIGRATION 01: SEED & SYNC ALL CITIES FROM data/cities.json`);
  console.log(`  MODE: ${isApply ? '🚀 APPLYING TO LIVE DATABASE' : '🔍 DRY-RUN (no changes made)'}`);
  console.log(`================================================================\n`);

  const citiesJsonPath = path.resolve(__dirname, '../../../data/cities.json');
  const rawData = require(citiesJsonPath);
  const jsonCities = rawData.data || [];
  console.log(`Loaded ${jsonCities.length} city entries from ${citiesJsonPath}`);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const citiesColl = db.collection('cities');

  const existingCities = await citiesColl.find({}).toArray();
  console.log(`Current cities in database: ${existingCities.length}\n`);

  // Build lookup maps
  const existingByNameLower = new Map();
  const existingBySlug = new Map();

  for (const c of existingCities) {
    if (c.name) existingByNameLower.set(c.name.toLowerCase().trim(), c);
    if (c.slug) existingBySlug.set(c.slug.toLowerCase().trim(), c);
  }

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let cleanedCount = 0;

  // 1. Clean up bogus test entries
  const bogusNames = ['dsa', 'dsf'];
  for (const bogus of bogusNames) {
    const found = existingByNameLower.get(bogus);
    if (found) {
      console.log(`⚠️ Found bogus test city: "${found.name}" (ID: ${found._id})`);
      if (isApply) {
        await citiesColl.deleteOne({ _id: found._id });
        console.log(`  🗑️ Deleted bogus city "${found.name}"`);
      } else {
        console.log(`  [dry-run] Would delete bogus city "${found.name}"`);
      }
      cleanedCount++;
    }
  }

  // Deactivate state names mistakenly saved as cities
  const stateAsCities = ['rajasthan', 'punjab', 'presidency'];
  for (const st of stateAsCities) {
    const found = existingByNameLower.get(st);
    if (found) {
      console.log(`⚠️ Found state/district stored as city: "${found.name}" (ID: ${found._id})`);
      if (isApply) {
        await citiesColl.updateOne({ _id: found._id }, { $set: { isActive: false, description: 'Deactivated: State/division name, not a city' } });
        console.log(`  🔒 Deactivated pseudo-city "${found.name}"`);
      } else {
        console.log(`  [dry-run] Would deactivate pseudo-city "${found.name}"`);
      }
      cleanedCount++;
    }
  }

  // 2. Process all cities from cities.json
  const processedNames = new Set();

  for (const item of jsonCities) {
    const name = item.name ? item.name.trim() : '';
    if (!name || name.length < 2) continue;

    const lowerName = name.toLowerCase();
    if (processedNames.has(lowerName)) continue;
    processedNames.add(lowerName);

    const slug = slugify(name);
    const existing = existingByNameLower.get(lowerName) || existingBySlug.get(slug);

    const aliases = KNOWN_ALIASES[lowerName] || [];
    const state = STATE_MAP[lowerName] || (existing && existing.state ? existing.state : '');
    const order = TIER_1_CITIES.has(lowerName) ? 1 : TIER_2_CITIES.has(lowerName) ? 10 : 99;

    if (!existing) {
      // Need to create new city
      createdCount++;
      const newCityDoc = {
        name,
        slug,
        state,
        country: 'India',
        isActive: true,
        order,
        aliases,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      if (isApply) {
        try {
          await citiesColl.insertOne(newCityDoc);
        } catch (err) {
          console.error(`  ❌ Failed inserting "${name}": ${err.message}`);
        }
      }
    } else {
      // Existing city: ensure aliases, slug, and active status are up to date
      const mergedAliases = Array.from(new Set([...(existing.aliases || []), ...aliases]));
      const updates = {};

      if (!existing.slug || existing.slug !== slug) updates.slug = slug;
      if (state && (!existing.state || existing.state === 'asdf' || existing.state === 'n/a')) updates.state = state;
      if (!existing.isActive && !stateAsCities.includes(lowerName)) updates.isActive = true;
      if (order < (existing.order || 99)) updates.order = order;
      if (mergedAliases.length > (existing.aliases || []).length) updates.aliases = mergedAliases;

      if (Object.keys(updates).length > 0) {
        updatedCount++;
        updates.updatedAt = new Date();
        if (isApply) {
          await citiesColl.updateOne({ _id: existing._id }, { $set: updates });
        }
      } else {
        skippedCount++;
      }
    }
  }

  console.log(`\n----------------------------------------------------------------`);
  console.log(`  MIGRATION 01 SUMMARY`);
  console.log(`----------------------------------------------------------------`);
  console.log(`  New cities to create:    ${createdCount}`);
  console.log(`  Existing cities updated: ${updatedCount}`);
  console.log(`  Existing cities skipped: ${skippedCount}`);
  console.log(`  Bogus / states cleaned:  ${cleanedCount}`);
  console.log(`  Total cities after:      ${existingCities.length - 2 + createdCount}`);
  console.log(`----------------------------------------------------------------\n`);

  if (!isApply) {
    console.log(`ℹ️ To apply these changes to the live database, run:`);
    console.log(`   node src/scripts/migrations/01_seed_all_cities.js --apply\n`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
