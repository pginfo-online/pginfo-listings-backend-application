#!/usr/bin/env node
/**
 * Production-Grade City PG Data Export Script
 *
 * Exports all PG (Paying Guest) listings and owner contact details for a given city
 * (default: Pune) from the live MongoDB database into a professionally structured,
 * multi-worksheet Excel (.xlsx) file for marketing, tele-calling, and operations.
 *
 * Safety & Design Principles:
 *  - 100% Read-Only: Zero write, update, delete, or mutation operations on the database.
 *  - Comprehensive Coverage: Retrieves from unified 'properties' and seamlessly incorporates
 *    any non-migrated records from legacy 'pgs' collection with deduplication.
 *  - Boundary & Outlier Detection: Captures misclassified records via geo-bounding box,
 *    pincode matching, and cityId references so no valid PG record is excluded.
 *  - Credential Protection: Safe handling of MONGODB_URI via .env; zero leakage in logs.
 *  - Executive-Grade Excel: 3 worksheets (Listings & Contacts, Area Breakdown, Metadata),
 *    frozen headers, auto-filters, zebra striping, currency/phone text formatting.
 *
 * Usage:
 *   node src/scripts/exportCityPgData.js
 *   node src/scripts/exportCityPgData.js --city=Pune
 *   node src/scripts/exportCityPgData.js --city=Mumbai
 *   node src/scripts/exportCityPgData.js --city=Pune --output=data/custom_pune.xlsx
 *   node src/scripts/exportCityPgData.js --city=Pune --status=approved
 *   node src/scripts/exportCityPgData.js --city=Pune --area=Kharadi
 *   node src/scripts/exportCityPgData.js --help
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');

// Resolve project root and load environment variables safely
const BACKEND_ROOT = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

const { connectDB, disconnectDB } = require('../config/db');

// ─── Known City Geo-Bounding Boxes & Postal Code Patterns ─────────────────────
// Enables robust detection of misclassified records (e.g. Pune PGs mislabeled with another city)
const CITY_GEO_PROFILES = {
  pune: {
    name: 'Pune',
    aliases: ['poona', 'pcmc', 'pimpri-chinchwad', 'pimpri', 'chinchwad'],
    latRange: [18.35, 18.78],
    lngRange: [73.65, 74.08],
    pincodePrefixes: ['411', '412'],
  },
  mumbai: {
    name: 'Mumbai',
    aliases: ['bombay', 'navi mumbai', 'thane', 'mumbai suburban'],
    latRange: [18.85, 19.35],
    lngRange: [72.75, 73.10],
    pincodePrefixes: ['400'],
  },
  bengaluru: {
    name: 'Bengaluru',
    aliases: ['bangalore'],
    latRange: [12.75, 13.20],
    lngRange: [77.40, 77.85],
    pincodePrefixes: ['560', '562'],
  },
  delhi: {
    name: 'Delhi',
    aliases: ['new delhi', 'ncr'],
    latRange: [28.40, 28.90],
    lngRange: [76.80, 77.40],
    pincodePrefixes: ['110'],
  },
};

// ─── Formatting Helpers ───────────────────────────────────────────────────────

/**
 * Normalizes Indian mobile numbers into clean 10-digit text strings.
 * Preserves string format so Excel will not format as scientific notation.
 */
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = raw.toString().trim().replace(/[^0-9]/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) return digits;
  if (digits.length > 0) return digits; // Fallback to raw digits if non-standard
  return '';
}

/**
 * Formats gender enum into human-readable label
 */
function formatGender(gender) {
  if (!gender) return 'Any / Co-ed';
  const lower = gender.toLowerCase().trim();
  if (lower === 'male' || lower.includes('boy')) return 'Boys';
  if (lower === 'female' || lower.includes('girl')) return 'Girls';
  if (lower === 'any' || lower === 'co-ed' || lower === 'unisex') return 'Any / Co-ed';
  return gender;
}

/**
 * Formats tenant preferences array
 */
function formatTenants(tenants) {
  if (!Array.isArray(tenants) || tenants.length === 0) return 'Any';
  const mapped = tenants.map((t) => {
    const l = String(t).toLowerCase();
    if (l === 'student') return 'Students';
    if (l === 'working_professional') return 'Working Professionals';
    if (l === 'family') return 'Families';
    if (l === 'any') return 'Any';
    return t;
  });
  return mapped.join(', ');
}

/**
 * Formats food option
 */
function formatFood(food) {
  if (!food) return 'None';
  const lower = food.toLowerCase().trim();
  if (lower === 'veg') return 'Pure Veg';
  if (lower === 'nonveg') return 'Non-Veg';
  if (lower === 'both') return 'Veg & Non-Veg';
  if (lower === 'none') return 'No Food / Self-Cook';
  return food;
}

/**
 * Extracts comma-separated amenities
 */
function formatAmenities(doc) {
  const set = new Set();
  const rawList = doc.amenities || doc.facilities || [];
  if (Array.isArray(rawList)) {
    rawList.forEach((a) => {
      if (a && typeof a === 'string') set.add(a.trim());
    });
  }
  return Array.from(set).join(', ');
}

/**
 * Extracts and formats ISO date string
 */
function formatDate(val) {
  if (!val) return '';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '';
  }
}

/**
 * Resolves room configurations from doc (supports unified pgDetails and legacy roomConfigs)
 */
function getRoomConfigs(doc) {
  return doc.pgDetails?.roomConfigs || doc.roomConfigs || [];
}

/**
 * Calculates minimum starting rent
 */
function calculateMinRent(doc) {
  const configs = getRoomConfigs(doc);
  const rents = configs
    .map((r) => Number(r.rent || r.monthlyRent))
    .filter((n) => !isNaN(n) && n > 0);
  if (rents.length > 0) return Math.min(...rents);
  const fallback = Number(doc.pricing?.expectedPrice || doc.expectedPrice || doc.minMonthlyRent);
  return !isNaN(fallback) && fallback > 0 ? fallback : null;
}

/**
 * Calculates maximum rent
 */
function calculateMaxRent(doc) {
  const configs = getRoomConfigs(doc);
  const rents = configs
    .map((r) => Number(r.rent || r.monthlyRent))
    .filter((n) => !isNaN(n) && n > 0);
  if (rents.length > 0) return Math.max(...rents);
  const fallback = Number(doc.pricing?.expectedPrice || doc.expectedPrice || doc.minMonthlyRent);
  return !isNaN(fallback) && fallback > 0 ? fallback : null;
}

/**
 * Resolves rent for a specific sharing type
 */
function getRentForShare(doc, targetTypes) {
  const configs = getRoomConfigs(doc);
  const types = Array.isArray(targetTypes) ? targetTypes : [targetTypes];
  const match = configs.find((r) => types.includes(String(r.shareType).toLowerCase()));
  if (match) {
    const val = Number(match.rent || match.monthlyRent);
    return !isNaN(val) && val > 0 ? val : null;
  }
  return null;
}

/**
 * Calculates security deposit
 */
function calculateDeposit(doc) {
  if (doc.pricing?.securityDeposit !== undefined && doc.pricing.securityDeposit !== null) {
    const val = Number(doc.pricing.securityDeposit);
    if (!isNaN(val) && val > 0) return val;
  }
  if (doc.securityDeposit !== undefined && doc.securityDeposit !== null) {
    const val = Number(doc.securityDeposit);
    if (!isNaN(val) && val > 0) return val;
  }
  const configs = getRoomConfigs(doc);
  const deposits = configs
    .map((r) => Number(r.depositAmount || r.deposit || r.expectedDeposit))
    .filter((n) => !isNaN(n) && n > 0);
  if (deposits.length > 0) return Math.min(...deposits);
  return null;
}

/**
 * Computes bed counts
 */
function calculateBeds(doc, type) {
  const configs = getRoomConfigs(doc);
  if (configs.length === 0) return null;
  if (type === 'total') {
    const sum = configs.reduce((acc, r) => acc + (Number(r.totalBeds) || 0), 0);
    return sum > 0 ? sum : null;
  }
  if (type === 'available') {
    const sum = configs.reduce((acc, r) => acc + (Number(r.availableBeds) || 0), 0);
    return sum >= 0 ? sum : null;
  }
  return null;
}

// ─── Column Schema for Excel Worksheets ────────────────────────────────────────

const MAIN_COLUMNS = [
  { header: 'PG / Property Name', key: 'name', width: 32 },
  { header: 'Primary Calling Phone', key: 'primaryCallingPhone', width: 20 },
  { header: 'Owner Full Name', key: 'ownerName', width: 24 },
  { header: 'Owner Phone', key: 'ownerPhone', width: 16 },
  { header: 'Owner Alternate Phone', key: 'ownerAltPhone', width: 20 },
  { header: 'Owner Email', key: 'ownerEmail', width: 26 },
  { header: 'Property Contact Phone', key: 'propertyContactPhone', width: 22 },
  { header: 'Property WhatsApp', key: 'propertyWhatsapp', width: 18 },
  { header: 'Property Contact Email', key: 'propertyContactEmail', width: 24 },
  { header: 'Preferred Calling Hours', key: 'preferredContactHours', width: 22 },
  { header: 'Area / Locality', key: 'area', width: 22 },
  { header: 'City', key: 'city', width: 16 },
  { header: 'District', key: 'district', width: 16 },
  { header: 'PIN Code', key: 'postalCode', width: 12 },
  { header: 'Full Address', key: 'fullAddress', width: 45 },
  { header: 'Landmark', key: 'landmark', width: 24 },
  { header: 'Google Maps Link', key: 'mapsLink', width: 35 },
  { header: 'Latitude', key: 'latitude', width: 14 },
  { header: 'Longitude', key: 'longitude', width: 14 },
  { header: 'Property Subtype', key: 'propertySubtype', width: 16 },
  { header: 'Gender Allowed', key: 'gender', width: 16 },
  { header: 'Preferred Tenants', key: 'preferredTenants', width: 22 },
  { header: 'Starting Rent (₹/mo)', key: 'minRent', width: 20 },
  { header: 'Max Rent (₹/mo)', key: 'maxRent', width: 18 },
  { header: 'Rent - Single (₹)', key: 'rentSingle', width: 18 },
  { header: 'Rent - Double (₹)', key: 'rentDouble', width: 18 },
  { header: 'Rent - Triple (₹)', key: 'rentTriple', width: 18 },
  { header: 'Rent - 4+ Sharing (₹)', key: 'rentFourPlus', width: 20 },
  { header: 'Security Deposit (₹)', key: 'securityDeposit', width: 18 },
  { header: 'Food Facility', key: 'foodOption', width: 18 },
  { header: 'Food Included in Rent', key: 'foodIncluded', width: 20 },
  { header: 'AC Available', key: 'ac', width: 14 },
  { header: 'Total Beds', key: 'totalBeds', width: 12 },
  { header: 'Available Beds', key: 'availableBeds', width: 14 },
  { header: 'Total Rooms', key: 'totalRooms', width: 12 },
  { header: 'Available Rooms', key: 'availableRooms', width: 14 },
  { header: 'Amenities', key: 'amenities', width: 38 },
  { header: 'Curfew / Gate Closing', key: 'curfewTime', width: 20 },
  { header: 'Notice Period (Days)', key: 'noticePeriod', width: 18 },
  { header: 'Min Stay (Months)', key: 'minStay', width: 16 },
  { header: 'Listing Status', key: 'status', width: 14 },
  { header: 'Verified Listing', key: 'isVerified', width: 14 },
  { header: 'Quality Score (1-5)', key: 'dataQualityScore', width: 18 },
  { header: 'Views Count', key: 'views', width: 14 },
  { header: 'Inquiries Count', key: 'inquiries', width: 14 },
  { header: 'Listing Date', key: 'createdAt', width: 20 },
  { header: 'Database Source', key: 'sourceCollection', width: 18 },
  { header: 'Property ID', key: 'id', width: 28 },
];

const CURRENCY_KEYS = ['minRent', 'maxRent', 'rentSingle', 'rentDouble', 'rentTriple', 'rentFourPlus', 'securityDeposit'];
const NUMBER_KEYS = ['totalBeds', 'availableBeds', 'totalRooms', 'availableRooms', 'views', 'inquiries', 'dataQualityScore', 'noticePeriod', 'minStay'];
const PHONE_KEYS = ['primaryCallingPhone', 'ownerPhone', 'ownerAltPhone', 'propertyContactPhone', 'propertyWhatsapp'];

// ─── Header Styling ───────────────────────────────────────────────────────────

function applyHeaderStyle(row, bgColorHex = 'FF1E1B4B') {
  row.height = 32;
  row.eachCell((cell) => {
    cell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: bgColorHex },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'medium', color: { argb: 'FF0F172A' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    };
  });
}

// ─── Main Export Function ─────────────────────────────────────────────────────

/**
 * Core export logic — can be invoked programmatically or via CLI.
 */
async function exportCityPgData(options = {}) {
  const cityName = (options.city || 'Pune').trim();
  const cityKey = cityName.toLowerCase();
  const statusFilter = (options.status || 'all').trim().toLowerCase();
  const areaFilter = (options.area || '').trim();
  const includeLegacy = options.includeLegacy !== false;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultFileName = `${cityName.replace(/\s+/g, '_')}_PG_Data_Export_${timestamp}.xlsx`;
  const canonicalFileName = `${cityName.replace(/\s+/g, '_')}_PG_Data_Export.xlsx`;

  const outputDir = options.output
    ? path.dirname(path.resolve(options.output))
    : path.join(BACKEND_ROOT, 'data');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(outputDir, defaultFileName);

  const canonicalPath = path.join(outputDir, canonicalFileName);

  console.log('================================================================');
  console.log('📊 PRODUCTION PG DATA EXPORT TO EXCEL');
  console.log(`   Target City      : ${cityName}`);
  console.log(`   Status Filter    : ${statusFilter}`);
  console.log(`   Area Filter      : ${areaFilter || '(All Areas)'}`);
  console.log(`   Include Legacy   : ${includeLegacy ? 'Yes (Combined Properties + PGs)' : 'No'}`);
  console.log(`   Output File Path : ${outputPath}`);
  console.log('================================================================\n');

  const startTime = Date.now();

  // 1. Connect to Live MongoDB
  console.log('🔄 Connecting to MongoDB live database...');
  await connectDB();
  const db = mongoose.connection.db;

  try {
    // 2. Resolve City Entity & Profile
    console.log(`🔍 Resolving city record for "${cityName}"...`);
    const cityDoc = await db.collection('cities').findOne({
      $or: [
        { name: { $regex: new RegExp(`^${cityName}$`, 'i') } },
        { aliases: { $regex: new RegExp(`^${cityName}$`, 'i') } },
      ],
    });

    if (cityDoc) {
      console.log(`   ✅ Matched city in DB: "${cityDoc.name}" [ID: ${cityDoc._id}]`);
    } else {
      console.log(`   ℹ️ No explicit document in 'cities' collection for "${cityName}". Using regex matching.`);
    }

    const geoProfile = CITY_GEO_PROFILES[cityKey];

    // 3. Build Safe, Indexed Primary Query for Unified Properties Collection
    const primaryOrClauses = [
      { city: { $regex: new RegExp(`^${cityName}$`, 'i') } },
    ];

    if (cityDoc) {
      orClausesPrimary: primaryOrClauses.push({ cityId: cityDoc._id });
    }

    // Include known aliases if present
    if (geoProfile?.aliases?.length > 0) {
      geoProfile.aliases.forEach((alias) => {
        primaryOrClauses.push({ city: { $regex: new RegExp(`^${alias}$`, 'i') } });
      });
    }

    // Include district matching for the city
    primaryOrClauses.push({ district: { $regex: new RegExp(`^${cityName}$`, 'i') } });

    const propertyQuery = {
      category: 'pg',
      $or: primaryOrClauses,
    };

    if (statusFilter && statusFilter !== 'all') {
      propertyQuery.status = statusFilter;
    }

    if (areaFilter) {
      propertyQuery.area = { $regex: new RegExp(areaFilter, 'i') };
    }

    console.log('🔄 Fetching PG properties from unified "properties" collection...');
    const properties = await db.collection('properties').find(propertyQuery).toArray();

    // Check for edge cases / misclassified boundary records (e.g. Pune coords or postal code but city mislabeled)
    if (geoProfile?.latRange && geoProfile?.lngRange) {
      const existingPropObjIds = properties.map((p) => p._id);
      const boundaryOrClauses = [
        {
          'location.coordinates.0': { $gte: geoProfile.lngRange[0], $lte: geoProfile.lngRange[1] },
          'location.coordinates.1': { $gte: geoProfile.latRange[0], $lte: geoProfile.latRange[1] },
        },
      ];
      if (geoProfile.pincodePrefixes?.length > 0) {
        const pinRegex = new RegExp(`^(${geoProfile.pincodePrefixes.join('|')})`);
        boundaryOrClauses.push({ postalCode: pinRegex });
      }

      const boundaryQuery = {
        category: 'pg',
        _id: { $nin: existingPropObjIds },
        $or: boundaryOrClauses,
      };
      if (statusFilter && statusFilter !== 'all') boundaryQuery.status = statusFilter;
      if (areaFilter) boundaryQuery.area = { $regex: new RegExp(areaFilter, 'i') };

      const edgeProperties = await db.collection('properties').find(boundaryQuery).toArray();
      if (edgeProperties.length > 0) {
        console.log(`   ℹ️ Incorporated ${edgeProperties.length} boundary-detected properties (coordinates/pincode).`);
        properties.push(...edgeProperties);
      }
    }

    console.log(`   ✅ Retrieved ${properties.length} PG properties.`);

    // 4. Fetch Legacy PGs Collection (Seamless Backfill & Deduplication)
    let legacyPgs = [];
    if (includeLegacy) {
      console.log('🔄 Checking legacy "pgs" collection for unmigrated records...');
      const existingPropIdSet = new Set(properties.map((p) => p._id.toString()));

      const legacyPrimaryOrClauses = [
        { city: { $regex: new RegExp(`^${cityName}$`, 'i') } },
      ];

      if (geoProfile?.aliases?.length > 0) {
        geoProfile.aliases.forEach((alias) => {
          legacyPrimaryOrClauses.push({ city: { $regex: new RegExp(`^${alias}$`, 'i') } });
        });
      }

      const legacyQuery = { $or: legacyPrimaryOrClauses };
      if (statusFilter && statusFilter !== 'all') legacyQuery.status = statusFilter;
      if (areaFilter) legacyQuery.area = { $regex: new RegExp(areaFilter, 'i') };

      const primaryLegacy = await db.collection('pgs').find(legacyQuery).toArray();
      primaryLegacy.forEach((p) => {
        if (!existingPropIdSet.has(p._id.toString())) {
          legacyPgs.push(p);
          existingPropIdSet.add(p._id.toString());
        }
      });

      // Legacy boundary check
      if (geoProfile?.latRange && geoProfile?.lngRange) {
        const legacyBoundaryQuery = {
          _id: { $nin: Array.from(existingPropIdSet).map((id) => new mongoose.Types.ObjectId(id)) },
          'location.coordinates.0': { $gte: geoProfile.lngRange[0], $lte: geoProfile.lngRange[1] },
          'location.coordinates.1': { $gte: geoProfile.latRange[0], $lte: geoProfile.latRange[1] },
        };
        if (statusFilter && statusFilter !== 'all') legacyBoundaryQuery.status = statusFilter;
        if (areaFilter) legacyBoundaryQuery.area = { $regex: new RegExp(areaFilter, 'i') };

        const edgeLegacy = await db.collection('pgs').find(legacyBoundaryQuery).toArray();
        edgeLegacy.forEach((p) => {
          if (!existingPropIdSet.has(p._id.toString())) {
            legacyPgs.push(p);
            existingPropIdSet.add(p._id.toString());
          }
        });
      }

      console.log(`   ✅ Found ${legacyPgs.length} unique unmigrated legacy records to incorporate.`);
    }

    const totalRawCount = properties.length + legacyPgs.length;
    if (totalRawCount === 0) {
      console.warn(`⚠️ Warning: No PG records found for city "${cityName}". Please check spelling.`);
      return { totalExported: 0, outputPath };
    }

    // 5. Batch-Resolve Owners / Users from 'users' collection
    console.log('🔄 Resolving owner profiles from "users" collection...');
    const allOwnerIds = [
      ...properties.map((p) => p.owner),
      ...legacyPgs.map((p) => p.owner),
    ].filter(Boolean);

    const uniqueOwnerObjIds = Array.from(new Set(allOwnerIds.map((id) => id.toString())))
      .filter((idStr) => mongoose.Types.ObjectId.isValid(idStr))
      .map((idStr) => new mongoose.Types.ObjectId(idStr));

    const userDocs = await db.collection('users').find({
      _id: { $in: uniqueOwnerObjIds },
    }).project({
      name: 1,
      phone: 1,
      altPhone: 1,
      email: 1,
      role: 1,
      roles: 1,
      isActive: 1,
      phoneVerified: 1,
      emailVerified: 1,
    }).toArray();

    const userMap = new Map();
    userDocs.forEach((u) => userMap.set(u._id.toString(), u));
    console.log(`   ✅ Resolved ${userMap.size} unique owner profiles.`);

    // 6. Map and Normalize All Records
    console.log('🔄 Normalizing records and formatting contact details...');
    const formattedRows = [];
    let phoneCoverageCount = 0;
    const areaStatsMap = new Map();

    const processDoc = (doc, source) => {
      const ownerIdStr = doc.owner ? doc.owner.toString() : '';
      const ownerDoc = userMap.get(ownerIdStr) || null;

      const propPhone = normalizePhone(doc.contactPhone);
      const ownerPhone = normalizePhone(ownerDoc?.phone);
      const ownerAltPhone = normalizePhone(ownerDoc?.altPhone);

      // Best Calling Contact: Property contact number preferred, then owner phone, then alt phone
      const primaryCallingPhone = propPhone || ownerPhone || ownerAltPhone || '';
      if (primaryCallingPhone) phoneCoverageCount++;

      // Maps link: use existing or synthesize from coordinates
      let mapsLink = doc.mapsLink || '';
      const coords = doc.location?.coordinates;
      const lat = doc.latitude || (coords && coords.length === 2 ? coords[1] : '');
      const lng = doc.longitude || (coords && coords.length === 2 ? coords[0] : '');
      if (!mapsLink && lat && lng) {
        mapsLink = `https://www.google.com/maps?q=${lat},${lng}`;
      }

      const areaName = (doc.area || 'Unknown Area').trim();

      const minRent = calculateMinRent(doc);
      const maxRent = calculateMaxRent(doc);

      const row = {
        name: doc.title || doc.name || 'PG Accommodation',
        primaryCallingPhone,
        ownerName: ownerDoc?.name || 'N/A',
        ownerPhone,
        ownerAltPhone,
        ownerEmail: ownerDoc?.email || '',
        propertyContactPhone: propPhone,
        propertyWhatsapp: normalizePhone(doc.contactWhatsapp) || propPhone,
        propertyContactEmail: doc.contactEmail || '',
        preferredContactHours: doc.preferredContactHours || 'Anytime',
        area: areaName,
        city: doc.city || cityName,
        district: doc.district || '',
        postalCode: doc.postalCode || '',
        fullAddress: doc.fullAddress || doc.address || '',
        landmark: doc.landmark || '',
        mapsLink,
        latitude: lat || '',
        longitude: lng || '',
        propertySubtype: doc.pgDetails?.propertySubtype || doc.propertyType || 'PG',
        gender: formatGender(doc.pgDetails?.gender || doc.gender),
        preferredTenants: formatTenants(doc.pgDetails?.preferredTenants || doc.preferredTenants),
        minRent,
        maxRent,
        rentSingle: getRentForShare(doc, 'single'),
        rentDouble: getRentForShare(doc, 'double'),
        rentTriple: getRentForShare(doc, 'triple'),
        rentFourPlus: getRentForShare(doc, ['four', 'dormitory', 'studio']),
        securityDeposit: calculateDeposit(doc),
        foodOption: formatFood(doc.pgDetails?.food || doc.food),
        foodIncluded: (doc.pgDetails?.foodIncluded ?? doc.foodIncluded) ? 'Yes' : 'No',
        ac: (doc.pgDetails?.ac ?? doc.ac) ? 'Yes' : 'No',
        totalBeds: calculateBeds(doc, 'total'),
        availableBeds: calculateBeds(doc, 'available'),
        totalRooms: doc.pgDetails?.totalRooms || doc.totalRooms || '',
        availableRooms: doc.pgDetails?.availableRooms || doc.availableRooms || '',
        amenities: formatAmenities(doc),
        curfewTime: doc.pgDetails?.rules?.curfewTime || doc.rules?.curfewTime || 'None',
        noticePeriod: doc.pgDetails?.noticePeriod ?? doc.noticePeriod ?? '',
        minStay: doc.pgDetails?.minStay ?? doc.minStay ?? '',
        status: doc.status || 'submitted',
        isVerified: doc.isVerified ? 'Yes' : 'No',
        dataQualityScore: doc.dataQualityScore || 1,
        views: doc.views || 0,
        inquiries: doc.inquiries || 0,
        createdAt: formatDate(doc.createdAt),
        sourceCollection: source,
        id: doc._id ? doc._id.toString() : '',
      };

      formattedRows.push(row);

      // Track area statistics for Area Breakdown sheet
      const areaKey = areaName.toLowerCase();
      if (!areaStatsMap.has(areaKey)) {
        areaStatsMap.set(areaKey, {
          areaName,
          totalPgs: 0,
          withPhone: 0,
          verified: 0,
          rents: [],
        });
      }
      const aStat = areaStatsMap.get(areaKey);
      aStat.totalPgs++;
      if (primaryCallingPhone) aStat.withPhone++;
      if (doc.isVerified) aStat.verified++;
      if (minRent) aStat.rents.push(minRent);
    };

    properties.forEach((p) => processDoc(p, 'properties'));
    legacyPgs.forEach((p) => processDoc(p, 'legacy_pgs'));

    // Sort rows alphabetically by Area, then by Name
    formattedRows.sort((a, b) => {
      const areaComp = (a.area || '').localeCompare(b.area || '');
      if (areaComp !== 0) return areaComp;
      return (a.name || '').localeCompare(b.name || '');
    });

    console.log(`   ✅ Processed ${formattedRows.length} total rows.`);
    console.log(`   📞 Primary Calling Phone Coverage: ${phoneCoverageCount} / ${formattedRows.length} (${((phoneCoverageCount / formattedRows.length) * 100).toFixed(1)}%)`);

    // 7. Build Professional Multi-Sheet Excel Workbook
    console.log('🔄 Generating Excel workbook with ExcelJS...');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PGinfo.online';
    workbook.lastModifiedBy = 'PGinfo Data Export Service';
    workbook.created = new Date();
    workbook.modified = new Date();

    // ─── Sheet 1: Main PG Listings & Contacts ───
    const sheet1 = workbook.addWorksheet(`${cityName} PG Contacts`, {
      views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],
      pageSetup: { fitToPage: true, orientation: 'landscape' },
    });

    sheet1.columns = MAIN_COLUMNS;
    const header1 = sheet1.getRow(1);
    applyHeaderStyle(header1, 'FF1E1B4B'); // Deep Indigo

    // Add data rows with specific formatting
    formattedRows.forEach((item, rowIdx) => {
      const row = sheet1.addRow(item);
      const isEven = rowIdx % 2 === 0;

      // Zebra striping
      const rowBgColor = isEven ? 'FFFFFFFF' : 'FFF8FAFC';

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const colDef = MAIN_COLUMNS[colNumber - 1];
        if (!colDef) return;

        cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF1E293B' } };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: rowBgColor },
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        };

        // Alignments and number formats
        if (CURRENCY_KEYS.includes(colDef.key)) {
          if (cell.value !== '' && cell.value !== null && cell.value !== undefined) {
            cell.numFmt = '₹#,##0';
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
          }
        } else if (NUMBER_KEYS.includes(colDef.key)) {
          if (cell.value !== '' && cell.value !== null && cell.value !== undefined) {
            cell.numFmt = '#,##0';
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
          }
        } else if (PHONE_KEYS.includes(colDef.key)) {
          // Explicit text format for phone numbers to prevent scientific notation
          cell.numFmt = '@';
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          if (cell.value) {
            cell.value = String(cell.value);
          }
        } else if (['gender', 'status', 'isVerified', 'foodIncluded', 'ac'].includes(colDef.key)) {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else if (colDef.key === 'mapsLink' && cell.value) {
          cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF2563EB' }, underline: true };
          cell.alignment = { vertical: 'middle' };
        } else {
          cell.alignment = { vertical: 'middle' };
        }
      });
    });

    // Enable Excel auto-filter across all columns
    sheet1.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: MAIN_COLUMNS.length },
    };

    // ─── Sheet 2: Area Breakdown & Marketing Segmentation ───
    const sheet2 = workbook.addWorksheet('Area Breakdown & Summary', {
      views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],
    });

    const AREA_COLUMNS = [
      { header: 'Area / Locality Name', key: 'areaName', width: 28 },
      { header: 'Total PGs', key: 'totalPgs', width: 14 },
      { header: 'PGs with Phone', key: 'withPhone', width: 16 },
      { header: 'Phone Coverage (%)', key: 'phoneCoverage', width: 20 },
      { header: 'Avg Starting Rent (₹)', key: 'avgRent', width: 22 },
      { header: 'Min Rent in Area (₹)', key: 'minRent', width: 22 },
      { header: 'Max Rent in Area (₹)', key: 'maxRent', width: 22 },
      { header: 'Verified PGs', key: 'verified', width: 16 },
    ];

    sheet2.columns = AREA_COLUMNS;
    const header2 = sheet2.getRow(1);
    applyHeaderStyle(header2, 'FF065F46'); // Deep Emerald Green

    // Convert area stats to array and sort descending by total PGs
    const sortedAreas = Array.from(areaStatsMap.values()).sort((a, b) => b.totalPgs - a.totalPgs);

    sortedAreas.forEach((stat, idx) => {
      const avg = stat.rents.length > 0 ? Math.round(stat.rents.reduce((a, b) => a + b, 0) / stat.rents.length) : null;
      const min = stat.rents.length > 0 ? Math.min(...stat.rents) : null;
      const max = stat.rents.length > 0 ? Math.max(...stat.rents) : null;
      const coverage = stat.totalPgs > 0 ? ((stat.withPhone / stat.totalPgs) * 100).toFixed(1) + '%' : '0%';

      const row = sheet2.addRow({
        areaName: stat.areaName,
        totalPgs: stat.totalPgs,
        withPhone: stat.withPhone,
        phoneCoverage: coverage,
        avgRent: avg,
        minRent: min,
        maxRent: max,
        verified: stat.verified,
      });

      const isEven = idx % 2 === 0;
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = { name: 'Segoe UI', size: 10 };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: isEven ? 'FFFFFFFF' : 'FFF0FDF4' },
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        };

        if ([2, 3, 8].includes(colNumber)) {
          cell.numFmt = '#,##0';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
        } else if ([5, 6, 7].includes(colNumber)) {
          if (cell.value) cell.numFmt = '₹#,##0';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
        } else if (colNumber === 4) {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else {
          cell.alignment = { vertical: 'middle' };
        }
      });
    });

    sheet2.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: AREA_COLUMNS.length },
    };

    // ─── Sheet 3: Export Metadata & Summary ───
    const sheet3 = workbook.addWorksheet('Export Information');
    sheet3.columns = [
      { header: 'Property / Metric', key: 'metric', width: 35 },
      { header: 'Value', key: 'value', width: 45 },
    ];
    const header3 = sheet3.getRow(1);
    applyHeaderStyle(header3, 'FF0F172A'); // Slate 900

    const metaRows = [
      { metric: 'Target City', value: cityName },
      { metric: 'Export Timestamp (UTC)', value: new Date().toISOString() },
      { metric: 'Export Timestamp (Local)', value: new Date().toLocaleString() },
      { metric: 'Total Unique PG Listings Exported', value: formattedRows.length },
      { metric: 'Listings from Unified Properties Collection', value: properties.length },
      { metric: 'Listings from Legacy PGs Collection', value: legacyPgs.length },
      { metric: 'Total Unique Owners Resolved', value: userMap.size },
      { metric: 'Total Distinct Localities / Areas', value: areaStatsMap.size },
      { metric: 'Listings with Calling Phone', value: phoneCoverageCount },
      { metric: 'Phone Coverage Rate', value: `${((phoneCoverageCount / formattedRows.length) * 100).toFixed(2)}%` },
      { metric: 'Status Filter Applied', value: statusFilter },
      { metric: 'Area Filter Applied', value: areaFilter || 'None (All Areas)' },
      { metric: 'Database Environment', value: 'Live MongoDB Production' },
      { metric: 'Application Version', value: 'PGinfo backend v1.0.0' },
      { metric: 'Script File', value: 'src/scripts/exportCityPgData.js' },
    ];

    metaRows.forEach((m, idx) => {
      const row = sheet3.addRow(m);
      const isEven = idx % 2 === 0;
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = { name: 'Segoe UI', size: 10, bold: colNumber === 1 };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: isEven ? 'FFFFFFFF' : 'FFF8FAFC' },
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        };
        cell.alignment = { vertical: 'middle' };
      });
    });

    // 8. Write Workbook to Disk
    console.log(`💾 Writing Excel file to: ${outputPath}...`);
    await workbook.xlsx.writeFile(outputPath);

    // Also write or copy to canonical filename for simple reference
    if (outputPath !== canonicalPath) {
      fs.copyFileSync(outputPath, canonicalPath);
      console.log(`📋 Canonical file updated: ${canonicalPath}`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n================================================================');
    console.log('✅ EXPORT COMPLETED SUCCESSFULLY!');
    console.log(`   City Exported        : ${cityName}`);
    console.log(`   Total Records Saved  : ${formattedRows.length}`);
    console.log(`   Calling Phone Count  : ${phoneCoverageCount} (100% of properties with valid contact)`);
    console.log(`   Distinct Areas       : ${areaStatsMap.size}`);
    console.log(`   Execution Time       : ${duration}s`);
    console.log(`   Excel File (Timestamped): ${outputPath}`);
    console.log(`   Excel File (Canonical)  : ${canonicalPath}`);
    console.log('================================================================\n');

    return {
      success: true,
      city: cityName,
      totalExported: formattedRows.length,
      propertiesCount: properties.length,
      legacyPgsCount: legacyPgs.length,
      uniqueOwnersCount: userMap.size,
      areasCount: areaStatsMap.size,
      phoneCoverageCount,
      outputPath,
      canonicalPath,
      durationSeconds: duration,
    };
  } finally {
    // 9. Graceful Resource Cleanup
    console.log('🔄 Disconnecting from MongoDB...');
    await disconnectDB();
  }
}

// ─── CLI Entrypoint ───────────────────────────────────────────────────────────

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    city: 'Pune',
    status: 'all',
    area: '',
    includeLegacy: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: node src/scripts/exportCityPgData.js [options]

Options:
  --city=<name>        Target city name (e.g. Pune, Mumbai, Bengaluru, Delhi). Default: Pune
  --output=<path>      Custom path for the generated Excel file.
  --status=<status>    Filter by property status (all, approved, pending, submitted). Default: all
  --area=<name>        Filter by specific area / locality within the city (case-insensitive substring)
  --no-legacy          Exclude legacy 'pgs' collection; export only from unified 'properties'
  --help, -h           Show this help message and exit

Examples:
  node src/scripts/exportCityPgData.js
  node src/scripts/exportCityPgData.js --city=Pune
  node src/scripts/exportCityPgData.js --city=Mumbai
  node src/scripts/exportCityPgData.js --city=Pune --area=Kharadi
  node src/scripts/exportCityPgData.js --city=Pune --status=approved --output=data/pune_approved.xlsx
`);
      process.exit(0);
    } else if (arg.startsWith('--city=')) {
      options.city = arg.split('=')[1];
    } else if (arg === '--city' && args[i + 1]) {
      options.city = args[++i];
    } else if (arg.startsWith('--output=')) {
      options.output = arg.split('=')[1];
    } else if (arg === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (arg.startsWith('--status=')) {
      options.status = arg.split('=')[1];
    } else if (arg === '--status' && args[i + 1]) {
      options.status = args[++i];
    } else if (arg.startsWith('--area=')) {
      options.area = arg.split('=')[1];
    } else if (arg === '--area' && args[i + 1]) {
      options.area = args[++i];
    } else if (arg === '--no-legacy') {
      options.includeLegacy = false;
    }
  }

  return options;
}

if (require.main === module) {
  const options = parseCliArgs();
  exportCityPgData(options)
    .then((result) => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Fatal Export Error:', err.message);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    });
}

module.exports = {
  exportCityPgData,
};
