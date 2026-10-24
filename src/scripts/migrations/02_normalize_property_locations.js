#!/usr/bin/env node
/**
 * Migration 02: Normalize Property Locations (cityId & areaId FKs)
 * 
 * Supports:
 *   --dry-run (default, safe inspection)
 *   --apply   (commits updates to live database)
 */
require('dotenv').config();
const mongoose = require('mongoose');

// State-to-cities lookup map for disambiguation of properties labeled as states
const STATE_CITY_MAPPING = {
  rajasthan: [
    'sikar', 'kota', 'udaipur', 'jaipur', 'bikaner', 'jodhpur', 'ajmer', 'alwar',
    'bhilwara', 'sri ganganagar', 'bharatpur', 'pali', 'barmer', 'hanumangarh',
    'chittorgarh', 'jhunjhunu', 'kishangarh', 'churu', 'beawar', 'tonk'
  ],
  punjab: [
    'patiala', 'ludhiana', 'amritsar', 'jalandhar', 'bathinda', 'mohali', 'kharar',
    'hoshiarpur', 'batala', 'pathankot', 'moga', 'abohar', 'malerkotla', 'khanna',
    'phagwara', 'muktsar', 'barnala', 'firozpur', 'kapurthala', 'zirakpur', 'derabassi'
  ],
  presidency: [
    'kolkata', 'howrah', 'bidhannagar', 'saltlake', 'barrackpore', 'dum dum',
    'south dumdum', 'rajarhat', 'new town', 'hooghly', 'kalyani'
  ]
};

// Common city aliases and suburbs mapping directly to parent city
const LOCALITY_TO_CITY = {
  'bangalore': 'bengaluru',
  'gurgaon': 'gurugram',
  'new delhi': 'delhi',
  'ernakulam': 'kochi',
  'kakkanad': 'kochi',
  'alandi': 'pune',
  'alandi rural': 'pune',
  'wagholi': 'pune',
  'pirangut': 'pune',
  'kesnand': 'pune',
  'awhalwadi': 'pune',
  'ashtapur': 'pune',
  'pimpri-chinchwad': 'pune',
  'padur': 'chennai',
  'thoraipakkam': 'chennai',
  'tambaram': 'chennai',
  'sholinganallur': 'chennai',
  'perungudi': 'chennai',
  'chinsurah': 'kolkata',
  'barrackpore': 'kolkata',
  'south dumdum': 'kolkata',
  'bidhannagar': 'kolkata',
  'saltlake': 'kolkata',
  'rushikonda': 'visakhapatnam',
  'gajuwaka': 'visakhapatnam',
  'godhani': 'nagpur',
  'godhani (railway)': 'nagpur',
  'nildoh ct': 'nagpur',
  'bidgaon-tarodi kh.-pandhurna': 'nagpur',
  'matkazari': 'nagpur',
  'ext': 'lucknow',
  'semra': 'lucknow',
  'nijampur malhaur': 'lucknow',
  'vanasthalipuram': 'hyderabad',
  'miyapur': 'hyderabad',
  'nanakramguda': 'hyderabad',
  'gachibowli': 'hyderabad',
  'hitec city': 'hyderabad',
  'bhopani': 'latur',
  'vanugupalle': 'visakhapatnam',
  'noida extension': 'greater noida',
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

/**
 * Extract clean area from messy text (e.g. ", Datta Mandir Rd, Shankar Kalat Nagar, Wakad" -> "Wakad")
 */
function cleanAreaText(rawArea, rawAddress = '') {
  if (!rawArea || typeof rawArea !== 'string') return '';
  let str = rawArea.trim().replace(/^[,.\s-]+|[,.\s-]+$/g, '');

  // If area contains comma-separated segments, often the last or second-to-last segment is the actual locality
  if (str.includes(',')) {
    const parts = str.split(',').map(p => p.trim()).filter(Boolean);
    // If last part is city or pincode or country, pick second-to-last
    let candidate = parts[parts.length - 1];
    if (/^\d{6}$/.test(candidate) || candidate.toLowerCase() === 'india' || candidate.length < 3) {
      candidate = parts[parts.length - 2] || candidate;
    }
    // If candidate looks like a clean area name (< 50 chars, doesn't contain "PG" or "Hostel")
    if (candidate && candidate.length <= 40 && !/pg|hostel|guest|room/i.test(candidate)) {
      str = candidate;
    }
  }

  // Remove common noisy prefixes
  str = str.replace(/^(near|opp|behind|beside|at)\s+/i, '');
  // If still too long (> 50 chars), truncate or use fallback
  if (str.length > 50) {
    str = str.slice(0, 50).trim();
  }
  return str.replace(/^[,.\s-]+|[,.\s-]+$/g, '');
}

/**
 * Resolve which city a property belongs to
 */
function resolveCity(prop, cityLookup) {
  const rawCity = (prop.city || '').toLowerCase().trim();
  const addressText = `${prop.address || ''} ${prop.fullAddress || ''} ${prop.landmark || ''} ${prop.area || ''}`.toLowerCase();

  // 1. Direct locality-to-city map
  if (LOCALITY_TO_CITY[rawCity]) {
    const target = LOCALITY_TO_CITY[rawCity];
    if (cityLookup.has(target)) return cityLookup.get(target);
  }

  // 2. Disambiguate state names
  if (STATE_CITY_MAPPING[rawCity]) {
    const candidateCities = STATE_CITY_MAPPING[rawCity];
    for (const cand of candidateCities) {
      if (addressText.includes(cand)) {
        if (cityLookup.has(cand)) return cityLookup.get(cand);
      }
    }
    // Fallbacks for states
    if (rawCity === 'rajasthan' && cityLookup.has('jaipur')) return cityLookup.get('jaipur');
    if (rawCity === 'punjab' && cityLookup.has('chandigarh')) return cityLookup.get('chandigarh');
    if (rawCity === 'presidency' && cityLookup.has('kolkata')) return cityLookup.get('kolkata');
  }

  // 3. Direct city name match
  if (cityLookup.has(rawCity)) {
    return cityLookup.get(rawCity);
  }

  // 4. Try matching against any city in address text
  for (const [cityName, cityDoc] of cityLookup.entries()) {
    if (cityName.length >= 4 && addressText.includes(cityName)) {
      return cityDoc;
    }
  }

  return null;
}

async function run() {
  const isApply = process.argv.includes('--apply');
  console.log(`================================================================`);
  console.log(`  MIGRATION 02: NORMALIZE PROPERTY LOCATIONS (cityId & areaId)`);
  console.log(`  MODE: ${isApply ? '🚀 APPLYING TO LIVE DATABASE' : '🔍 DRY-RUN (no changes made)'}`);
  console.log(`================================================================\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const citiesColl = db.collection('cities');
  const areasColl = db.collection('areas');
  const propertiesColl = db.collection('properties');
  const pgsColl = db.collection('pgs');

  // Load all active cities
  const allCities = await citiesColl.find({ isActive: true }).toArray();
  console.log(`Found ${allCities.length} active cities in database.`);

  // Build fast city lookup
  const cityLookup = new Map();
  for (const c of allCities) {
    if (c.name) cityLookup.set(c.name.toLowerCase().trim(), c);
    if (c.slug) cityLookup.set(c.slug.toLowerCase().trim(), c);
    if (Array.isArray(c.aliases)) {
      for (const a of c.aliases) {
        if (a) cityLookup.set(a.toLowerCase().trim(), c);
      }
    }
  }

  // Load existing areas
  const allAreas = await areasColl.find({}).toArray();
  console.log(`Found ${allAreas.length} existing areas in database.`);

  // Area lookup by `${cityId}_${lowerAreaName}`
  const areaLookup = new Map();
  for (const a of allAreas) {
    if (a.city && a.name) {
      const key = `${a.city.toString()}_${a.name.toLowerCase().trim()}`;
      areaLookup.set(key, a);
    }
  }

  // Fetch properties
  const properties = await propertiesColl.find({}).toArray();
  console.log(`Total properties to inspect: ${properties.length}\n`);

  let cityResolvedCount = 0;
  let cityUnresolvedCount = 0;
  let areaResolvedCount = 0;
  let areaCreatedCount = 0;
  let alreadyNormalizedCount = 0;

  const bulkPropertyOps = [];
  const bulkPgOps = [];
  const newAreasToInsert = [];

  for (const prop of properties) {
    const resolvedCity = resolveCity(prop, cityLookup);
    if (!resolvedCity) {
      cityUnresolvedCount++;
      continue;
    }
    cityResolvedCount++;

    const cleanArea = cleanAreaText(prop.area, prop.address);
    let resolvedAreaId = prop.areaId || null;

    if (cleanArea) {
      const areaKey = `${resolvedCity._id.toString()}_${cleanArea.toLowerCase()}`;
      let areaDoc = areaLookup.get(areaKey);

      if (!areaDoc) {
        // Prepare to create new area under this city
        const newAreaDoc = {
          _id: new mongoose.Types.ObjectId(),
          city: resolvedCity._id,
          cityName: resolvedCity.name,
          name: cleanArea,
          slug: slugify(cleanArea),
          isActive: true,
          isAutoCreated: true,
          source: 'system_migrated',
          order: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        areaLookup.set(areaKey, newAreaDoc);
        newAreasToInsert.push(newAreaDoc);
        resolvedAreaId = newAreaDoc._id;
        areaCreatedCount++;
      } else {
        resolvedAreaId = areaDoc._id;
        areaResolvedCount++;
      }
    }

    const needsCityUpdate = !prop.cityId || prop.cityId.toString() !== resolvedCity._id.toString() || prop.city !== resolvedCity.name;
    const needsAreaUpdate = cleanArea && (!prop.areaId || (resolvedAreaId && prop.areaId.toString() !== resolvedAreaId.toString()) || prop.area !== cleanArea);

    if (needsCityUpdate || needsAreaUpdate) {
      const updateFields = {
        city: resolvedCity.name,
        cityId: resolvedCity._id,
      };
      if (cleanArea) {
        updateFields.area = cleanArea;
      }
      if (resolvedAreaId) {
        updateFields.areaId = resolvedAreaId;
      }

      bulkPropertyOps.push({
        updateOne: {
          filter: { _id: prop._id },
          update: { $set: updateFields },
        },
      });

      // Also sync PG legacy doc
      bulkPgOps.push({
        updateOne: {
          filter: { _id: prop._id },
          update: { $set: updateFields },
        },
      });
    } else {
      alreadyNormalizedCount++;
    }
  }

  console.log(`----------------------------------------------------------------`);
  console.log(`  MIGRATION 02 RESOLUTION STATS`);
  console.log(`----------------------------------------------------------------`);
  console.log(`  Properties checked:         ${properties.length}`);
  console.log(`  City resolved successfully: ${cityResolvedCount} (${((cityResolvedCount/properties.length)*100).toFixed(1)}%)`);
  console.log(`  City unresolved:            ${cityUnresolvedCount}`);
  console.log(`  Existing areas matched:     ${areaResolvedCount}`);
  console.log(`  New normalized areas:       ${areaCreatedCount}`);
  console.log(`  Properties already clean:   ${alreadyNormalizedCount}`);
  console.log(`  Properties requiring write: ${bulkPropertyOps.length}`);
  console.log(`----------------------------------------------------------------\n`);

  if (isApply) {
    // 1. Insert new areas using upsert bulkWrite
    if (newAreasToInsert.length > 0) {
      console.log(`Upserting ${newAreasToInsert.length} new normalized areas...`);
      const areaOps = newAreasToInsert.map(a => ({
        updateOne: {
          filter: { city: a.city, name: a.name },
          update: { $setOnInsert: a },
          upsert: true,
        }
      }));

      for (let i = 0; i < areaOps.length; i += 500) {
        const chunk = areaOps.slice(i, i + 500);
        try {
          await areasColl.bulkWrite(chunk, { ordered: false });
        } catch (err) {
          // If duplicates occur, ignore duplicate key error
        }
      }
      console.log(`✅ Areas successfully upserted.`);
    }

    // 2. Update properties in bulk
    if (bulkPropertyOps.length > 0) {
      console.log(`Updating ${bulkPropertyOps.length} properties in bulk...`);
      for (let i = 0; i < bulkPropertyOps.length; i += 500) {
        const chunk = bulkPropertyOps.slice(i, i + 500);
        try {
          await propertiesColl.bulkWrite(chunk, { ordered: false });
        } catch (err) {
          console.error(`Warning in properties bulkWrite: ${err.message}`);
        }
      }
      console.log(`✅ Properties normalized successfully.`);
    }

    // 3. Update legacy pgs in bulk
    if (bulkPgOps.length > 0) {
      console.log(`Updating ${bulkPgOps.length} legacy PG documents...`);
      for (let i = 0; i < bulkPgOps.length; i += 500) {
        const chunk = bulkPgOps.slice(i, i + 500);
        try {
          await pgsColl.bulkWrite(chunk, { ordered: false });
        } catch (_) {}
      }
      console.log(`✅ Legacy PGs updated.`);
    }

    console.log(`\n🎉 MIGRATION 02 COMPLETE!`);
  } else {
    console.log(`ℹ️ Dry run completed. To commit changes to the live DB, run:`);
    console.log(`   node src/scripts/migrations/02_normalize_property_locations.js --apply\n`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
