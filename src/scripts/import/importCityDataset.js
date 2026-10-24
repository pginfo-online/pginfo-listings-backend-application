/**
 * Universal Production-Grade City Dataset Import Tool
 *
 * Imports PG / Property listings from JSON files for ANY city (Pune, Mumbai, Bangalore, etc.)
 * into the unified 'properties' collection with complete idempotency, validation,
 * owner creation, and area resolution.
 *
 * Usage:
 *   # For Pune (including 21.json to 100.json when populated):
 *   node src/scripts/import/importCityDataset.js --city=Pune --dir=data/Pune --dry-run
 *   node src/scripts/import/importCityDataset.js --city=Pune --dir=data/Pune --apply
 *
 *   # For any other city (e.g. Mumbai, Bengaluru, Delhi, Hyderabad):
 *   node src/scripts/import/importCityDataset.js --city=Mumbai --dir=data/Mumbai --dry-run
 *   node src/scripts/import/importCityDataset.js --city=Mumbai --dir=data/Mumbai --apply
 */

const fs = require('fs');
const path = require('path');
const backendRoot = path.join(__dirname, '../../..');
require('dotenv').config({ path: path.join(backendRoot, '.env') });
const mongoose = require('mongoose');
const slugUtil = require('../../common/utils/slug.util');
const {
  areaNameKey,
  areaSlugKey,
  getLocalityName,
  getAreaFromMap,
  resolveAreaCandidates,
} = require('./areaResolution');

// Normalize Indian phone numbers: strip non-digits, strip country code if 91
function normalizeIndianPhone(raw) {
  if (!raw) return null;
  const digits = raw.toString().trim().replace(/[^0-9]/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) return digits;
  return null;
}

// Normalize email
function normalizeEmail(raw) {
  if (!raw) return null;
  const email = raw.toString().trim().toLowerCase();
  if (/^\S+@\S+\.\S+$/.test(email)) return email;
  return null;
}

// Map room type string to schema enum
function mapShareType(rawType) {
  if (!rawType) return 'double';
  const lower = rawType.toLowerCase().trim();
  if (lower.includes('single')) return 'single';
  if (lower.includes('double')) return 'double';
  if (lower.includes('triple')) return 'triple';
  if (lower.includes('four')) return 'four';
  if (lower.includes('studio')) return 'studio';
  if (lower.includes('dorm')) return 'dormitory';
  return 'dormitory';
}

function getBedsForShareType(shareType) {
  switch (shareType) {
    case 'single': return 1;
    case 'double': return 2;
    case 'triple': return 3;
    case 'four': return 4;
    default: return 1;
  }
}

function mapGender(availableFor) {
  if (!availableFor) return 'any';
  const lower = availableFor.toLowerCase().trim();
  if (lower.includes('boy') || lower === 'male') return 'male';
  if (lower.includes('girl') || lower === 'female') return 'female';
  return 'any';
}

function calculateQualityScore(item, photos, roomConfigs) {
  let score = 1;
  if (photos.length >= 3) score += 1;
  if (roomConfigs.length >= 1) score += 1;
  if (item.description && item.description.trim().length > 20) score += 1;
  if (item.availableAmenities && item.availableAmenities.length >= 3) score += 1;
  return Math.min(5, Math.max(1, score));
}

async function runCityImport() {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const dryRun = !isApply;

  const batchSizeArg = args.find(a => a.startsWith('--batch-size='));
  const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 100;

  const cityArg = args.find(a => a.startsWith('--city='));
  const targetCityName = cityArg ? cityArg.split('=')[1].trim() : 'Pune';

  const customDirArg = args.find(a => a.startsWith('--dir='));
  const jsonDir = customDirArg ? path.resolve(customDirArg.split('=')[1]) : path.join(backendRoot, `data/${targetCityName}`);

  const startTime = Date.now();
  console.log('============================================================');
  console.log(`🌐 UNIVERSAL CITY DATASET IMPORT PIPELINE`);
  console.log(`   Target City: ${targetCityName}`);
  console.log(`   Mode       : ${dryRun ? '🔍 DRY RUN (Simulated, no writes)' : '⚡ LIVE APPLY (Writing to DB)'}`);
  console.log(`   Batch Size : ${BATCH_SIZE}`);
  console.log(`   Source Dir : ${jsonDir}`);
  console.log('============================================================\n');

  if (!fs.existsSync(jsonDir)) {
    throw new Error(`Data directory not found: ${jsonDir}. Please make sure the folder exists and contains JSON files.`);
  }

  // 1. Scan and parse all JSON files
  const allFiles = fs.readdirSync(jsonDir)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return numA - numB;
    });

  console.log(`Found ${allFiles.length} JSON candidate files in ${jsonDir}.`);

  const validFiles = [];
  const emptyFiles = [];
  const malformedFiles = [];
  const rawItems = [];

  for (const file of allFiles) {
    const fullPath = path.join(jsonDir, file);
    const stats = fs.statSync(fullPath);
    if (stats.size === 0) {
      emptyFiles.push(file);
      continue;
    }

    try {
      const rawContent = fs.readFileSync(fullPath, 'utf8');
      if (!rawContent.trim()) {
        emptyFiles.push(file);
        continue;
      }
      const parsed = JSON.parse(rawContent);

      // Support both envelope shapes: { data: [{ data: [...] }] } or direct array [...] or { properties: [...] }
      let items = [];
      if (Array.isArray(parsed)) {
        items = parsed;
      } else if (Array.isArray(parsed.data?.[0]?.data)) {
        items = parsed.data[0].data;
      } else if (Array.isArray(parsed.data)) {
        items = parsed.data;
      } else if (Array.isArray(parsed.properties)) {
        items = parsed.properties;
      } else {
        malformedFiles.push({ file, reason: 'Unrecognized JSON structure (expected data array)' });
        continue;
      }

      validFiles.push(file);
      items.forEach(it => {
        it._sourceFile = file;
        rawItems.push(it);
      });
    } catch (err) {
      malformedFiles.push({ file, reason: err.message });
    }
  }

  console.log(`📁 Files breakdown:`);
  console.log(`   - Valid data files   : ${validFiles.length}`);
  console.log(`   - Empty files (skip) : ${emptyFiles.length}`);
  console.log(`   - Malformed files    : ${malformedFiles.length}`);
  console.log(`   - Total raw listings : ${rawItems.length}\n`);

  if (rawItems.length === 0) {
    console.log(`ℹ️  No data records found to import in ${jsonDir}. (Files may be empty placeholders). Exiting safely.`);
    return { rawItemsCount: 0 };
  }

  // 2. Connect to Database
  console.log('🔄 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // 3. Resolve City in DB
  const cityDoc = await db.collection('cities').findOne({
    name: { $regex: new RegExp(`^${targetCityName}$`, 'i') }
  });

  if (!cityDoc) {
    throw new Error(`Critical Error: City '${targetCityName}' not found in 'cities' collection! Please verify city name spelling.`);
  }

  const cityId = cityDoc._id;
  const canonicalCityName = cityDoc.name;
  const cityState = cityDoc.state || 'Maharashtra';
  console.log(`✅ Resolved City: "${canonicalCityName}" (${cityId}) in State: "${cityState}"`);

  // 4. Resolve Areas / Localities for this City
  console.log(`🔄 Resolving and standardizing ${canonicalCityName} Areas...`);
  const existingAreas = await db.collection('areas').find({ city: cityId }).toArray();

  const distinctLocalities = new Set();
  rawItems.forEach(it => {
    const loc = getLocalityName(it.locality, it.area, canonicalCityName);
    if (loc) distinctLocalities.add(loc);
  });

  const initialAreaResolution = resolveAreaCandidates(
    existingAreas,
    distinctLocalities,
    locName => ({
      _id: new mongoose.Types.ObjectId(),
      city: cityId,
      cityName: canonicalCityName,
      name: locName,
      slug: slugUtil.slugify(locName),
      description: `Area in ${canonicalCityName}: ${locName}`,
      isActive: true,
      order: 99,
      isAutoCreated: true,
      source: 'admin',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );
  let { areaMap } = initialAreaResolution;
  const { areasToCreate } = initialAreaResolution;

  console.log(`   - Existing ${canonicalCityName} areas : ${existingAreas.length}`);
  console.log(`   - Distinct localities in dataset: ${distinctLocalities.size}`);
  console.log(`   - New areas to auto-create      : ${areasToCreate.length}`);

  if (isApply && areasToCreate.length > 0) {
    const areaOps = areasToCreate.map(a => ({
      updateOne: {
        filter: { city: cityId, slug: a.slug },
        update: { $setOnInsert: a },
        upsert: true,
      }
    }));
    try {
      const areaWriteRes = await db.collection('areas').bulkWrite(areaOps, { ordered: false });
      console.log(`   ✅ Areas written to DB (upserted: ${areaWriteRes.upsertedCount}, matched: ${areaWriteRes.matchedCount})`);
    } catch (err) {
      const hasDuplicateKeyError = err.code === 11000
        || err.writeErrors?.some(writeError => writeError.code === 11000);
      if (!hasDuplicateKeyError) throw err;

      const concurrentlyResolvedAreas = await db.collection('areas')
        .find({
          city: cityId,
          $or: [
            { name: { $in: areasToCreate.map(area => area.name) } },
            { slug: { $in: areasToCreate.map(area => area.slug) } },
          ],
        })
        .toArray();
      const resolvedKeys = new Set();
      concurrentlyResolvedAreas.forEach(area => {
        resolvedKeys.add(areaNameKey(area.name));
        resolvedKeys.add(areaSlugKey(area.name));
        if (area.slug) resolvedKeys.add(`slug:${area.slug}`);
      });
      const unresolvedAreas = areasToCreate.filter(area =>
        !resolvedKeys.has(areaNameKey(area.name)) && !resolvedKeys.has(`slug:${area.slug}`)
      );
      if (unresolvedAreas.length > 0) throw err;

      console.log(`   ✅ Areas written to DB; duplicate-key races resolved against ${concurrentlyResolvedAreas.length} existing area(s).`);
    }

    const persistedAreas = await db.collection('areas').find({ city: cityId }).toArray();
    const persistedAreaResolution = resolveAreaCandidates(
      persistedAreas,
      distinctLocalities,
      locName => {
        throw new Error(`Area '${locName}' was not persisted for ${canonicalCityName}.`);
      }
    );
    areaMap = persistedAreaResolution.areaMap;
  }

  // 5. Resolve Owners / Users (Collision-Safe with Phone & Email Aliasing)
  console.log('\n🔄 Resolving Owner User records (collision-safe)...');
  const candidateIds = [];
  const candidatePhones = new Set();
  const candidateEmails = new Set();
  const rawOwners = [];

  rawItems.forEach(item => {
    const owner = (item.owner && (Array.isArray(item.owner) ? item.owner[0] : item.owner)) || {};
    const rawOwnerId = (item.userId || owner._id)?.toString();
    if (!rawOwnerId || !mongoose.Types.ObjectId.isValid(rawOwnerId)) return;

    const phone = normalizeIndianPhone(owner.phone || item.contactNumber);
    const email = normalizeEmail(owner.email || item.contactEmail);
    const name = (owner.name || item.postBy || `${canonicalCityName} PG Owner`).trim();
    const createdAt = owner.createdAt ? new Date(owner.createdAt) : new Date();

    rawOwners.push({ rawOwnerId, phone, email, name, createdAt, file: item._sourceFile });
    candidateIds.push(new mongoose.Types.ObjectId(rawOwnerId));
    if (phone) candidatePhones.add(phone);
    if (email) candidateEmails.add(email);
  });

  const queryClauses = [];
  if (candidateIds.length > 0) queryClauses.push({ _id: { $in: candidateIds } });
  if (candidatePhones.size > 0) queryClauses.push({ phone: { $in: Array.from(candidatePhones) } });
  if (candidateEmails.size > 0) queryClauses.push({ email: { $in: Array.from(candidateEmails) } });

  const existingUsersInDb = queryClauses.length > 0
    ? await db.collection('users').find({ $or: queryClauses }).toArray()
    : [];

  const userById = new Map();
  const userByPhone = new Map();
  const userByEmail = new Map();

  for (const u of existingUsersInDb) {
    userById.set(u._id.toString(), u);
    if (u.phone) userByPhone.set(u.phone, u);
    if (u.email) userByEmail.set(u.email, u);
  }

  const ownerIdToCanonicalUserIdMap = new Map();
  const pendingNewUsers = [];
  const seenNewPhones = new Set();
  const seenNewEmails = new Set();
  const seenNewIds = new Set();

  let matchedByIdCount = 0;
  let aliasedByPhoneCount = 0;
  let aliasedByEmailCount = 0;
  let linkedToBatchCount = 0;

  for (const o of rawOwners) {
    const { rawOwnerId, phone, email, name, createdAt, file } = o;
    if (ownerIdToCanonicalUserIdMap.has(rawOwnerId)) continue;

    // 1. Direct match by _id in DB
    if (userById.has(rawOwnerId)) {
      ownerIdToCanonicalUserIdMap.set(rawOwnerId, userById.get(rawOwnerId)._id);
      matchedByIdCount++;
      continue;
    }

    // 2. Match by unique phone in DB (alias owner reference to existing DB user)
    if (phone && userByPhone.has(phone)) {
      const canonicalUser = userByPhone.get(phone);
      ownerIdToCanonicalUserIdMap.set(rawOwnerId, canonicalUser._id);
      aliasedByPhoneCount++;
      continue;
    }

    // 3. Match by unique email in DB (alias owner reference to existing DB user)
    if (email && userByEmail.has(email)) {
      const canonicalUser = userByEmail.get(email);
      ownerIdToCanonicalUserIdMap.set(rawOwnerId, canonicalUser._id);
      aliasedByEmailCount++;
      continue;
    }

    // 4. Match against pending new users in current batch
    if (phone && seenNewPhones.has(phone)) {
      const existingPending = pendingNewUsers.find(u => u.phone === phone);
      if (existingPending) {
        ownerIdToCanonicalUserIdMap.set(rawOwnerId, existingPending._id);
        linkedToBatchCount++;
        continue;
      }
    }

    if (email && seenNewEmails.has(email)) {
      const existingPending = pendingNewUsers.find(u => u.email === email);
      if (existingPending) {
        ownerIdToCanonicalUserIdMap.set(rawOwnerId, existingPending._id);
        linkedToBatchCount++;
        continue;
      }
    }

    // 5. Truly new user (guaranteed no phone, email, or _id collision)
    if (seenNewIds.has(rawOwnerId)) continue;

    const newUserDoc = {
      _id: new mongoose.Types.ObjectId(rawOwnerId),
      name: name || 'PG Owner',
      phoneVerified: Boolean(phone),
      emailVerified: Boolean(email),
      role: 'owner',
      roles: ['owner', 'pg_owner'],
      isActive: true,
      createdAt,
      updatedAt: new Date(),
    };
    if (phone) newUserDoc.phone = phone;
    if (email) newUserDoc.email = email;

    pendingNewUsers.push(newUserDoc);
    seenNewIds.add(rawOwnerId);
    if (phone) seenNewPhones.add(phone);
    if (email) seenNewEmails.add(email);
    userById.set(rawOwnerId, newUserDoc);
    if (phone) userByPhone.set(phone, newUserDoc);
    if (email) userByEmail.set(email, newUserDoc);

    ownerIdToCanonicalUserIdMap.set(rawOwnerId, newUserDoc._id);
  }

  console.log(`   - Existing users matched by ID   : ${matchedByIdCount}`);
  console.log(`   - Aliased by Phone to existing DB: ${aliasedByPhoneCount}`);
  console.log(`   - Aliased by Email to existing DB: ${aliasedByEmailCount}`);
  console.log(`   - Linked to batch pending owners : ${linkedToBatchCount}`);
  console.log(`   - New unique owners to create    : ${pendingNewUsers.length}`);

  if (isApply && pendingNewUsers.length > 0) {
    const userOps = pendingNewUsers.map(u => ({
      updateOne: {
        filter: { _id: u._id },
        update: { $setOnInsert: u },
        upsert: true,
      }
    }));
    const userWriteRes = await db.collection('users').bulkWrite(userOps, { ordered: false });
    console.log(`   ✅ Users written to DB (upserted: ${userWriteRes.upsertedCount}, matched: ${userWriteRes.matchedCount})`);
  }

  // 6. Transform and Validate Listings into unified Property Model
  console.log('\n🔄 Transforming and validating listings into Property schema...');
  const propertyOperations = [];
  const validationFailures = [];

  let totalPhotosProcessed = 0;
  let totalRoomsProcessed = 0;

  for (let idx = 0; idx < rawItems.length; idx++) {
    const item = rawItems[idx];

    // Validation: _id
    if (!item._id || !mongoose.Types.ObjectId.isValid(item._id)) {
      validationFailures.push({ id: item._id || `idx_${idx}`, file: item._sourceFile, reason: 'Invalid or missing _id' });
      continue;
    }
    const propId = new mongoose.Types.ObjectId(item._id);

    // Validation: Owner (using canonical aliased mapping)
    const rawOwnerId = item.userId || (Array.isArray(item.owner) ? item.owner[0]?._id : item.owner?._id);
    if (!rawOwnerId || !mongoose.Types.ObjectId.isValid(rawOwnerId)) {
      validationFailures.push({ id: item._id, file: item._sourceFile, reason: 'Invalid or missing owner userId' });
      continue;
    }
    const propOwnerId = ownerIdToCanonicalUserIdMap.get(rawOwnerId.toString()) || new mongoose.Types.ObjectId(rawOwnerId);

    // Coordinates: default to city center coordinates if missing
    let coordinates = [cityDoc.longitude || 73.8567, cityDoc.latitude || 18.5204];
    if (item.location?.coordinates && Array.isArray(item.location.coordinates) && item.location.coordinates.length === 2) {
      const [lng, lat] = item.location.coordinates;
      if (typeof lng === 'number' && typeof lat === 'number' && !(lng === 0 && lat === 0)) {
        coordinates = [lng, lat];
      }
    }

    // Resolve Area
    const requestedLocality = getLocalityName(item.locality, item.area, canonicalCityName);
    const areaDoc = getAreaFromMap(areaMap, requestedLocality)
      || getAreaFromMap(areaMap, canonicalCityName)
      || { _id: new mongoose.Types.ObjectId(), name: requestedLocality };
    const localityName = areaDoc.name;
    const areaId = areaDoc._id;

    const title = (item.name || item.title || 'PG Accommodation').trim();
    const slug = slugUtil.generatePropertySlug({
      title,
      area: localityName,
      city: canonicalCityName,
      id: item._id,
      category: 'pg'
    });

    // Room Configurations
    const roomConfigs = [];
    if (Array.isArray(item.pgRooms) && item.pgRooms.length > 0) {
      item.pgRooms.forEach((r) => {
        const shareType = mapShareType(r.roomType);
        const rent = Number(r.monthlyRent) || Number(item.minMonthlyRent) || 5000;
        const depositAmount = Number(r.expectedDeposit) || Number(item.expectedDeposit) || 0;
        const beds = getBedsForShareType(shareType);

        roomConfigs.push({
          shareType,
          rent,
          depositAmount,
          totalBeds: beds,
          availableBeds: beds,
          roomSize: '',
          furnitureIncluded: true,
          acIncluded: false,
          bathroomType: 'shared',
          amenities: [],
        });
      });
    } else {
      const fallbackRent = Number(item.minMonthlyRent) || 5000;
      roomConfigs.push({
        shareType: 'double',
        rent: fallbackRent,
        depositAmount: Number(item.expectedDeposit) || 0,
        totalBeds: 2,
        availableBeds: 2,
        furnitureIncluded: true,
        bathroomType: 'shared',
        amenities: [],
      });
    }
    totalRoomsProcessed += roomConfigs.length;

    // Pricing
    const validRents = roomConfigs.map(r => r.rent).filter(r => r > 0);
    const expectedPrice = validRents.length > 0 ? Math.min(...validRents) : (Number(item.minMonthlyRent) || 5000);
    const validDeposits = roomConfigs.map(r => r.depositAmount).filter(d => d > 0);
    const securityDeposit = validDeposits.length > 0 ? Math.min(...validDeposits) : 0;
    const maintenanceCharges = item.maintenanceAmountValue ? parseFloat(item.maintenanceAmountValue) || 0 : 0;

    // Photos
    const photos = [];
    const mediaArray = item.propertyMedia || item.photos || [];
    if (Array.isArray(mediaArray)) {
      mediaArray.slice(0, 20).forEach((m, mIdx) => {
        const url = typeof m === 'string' ? m : (m.mediaUrl || m.url);
        if (url) {
          photos.push({
            url,
            publicId: m.mediaTitle || m._id?.toString() || `${canonicalCityName.toLowerCase()}_pg_${item._id}_${mIdx}`,
            caption: m.mediaTitle || m.caption || '',
            isMain: Boolean(m.default || m.isMain) || mIdx === 0,
            order: mIdx,
          });
        }
      });
    }
    totalPhotosProcessed += photos.length;

    // Amenities
    const amenitiesSet = new Set();
    if (Array.isArray(item.availableAmenities)) item.availableAmenities.forEach(a => a && amenitiesSet.add(a.trim()));
    if (Array.isArray(item.roomAmenities)) item.roomAmenities.forEach(a => a && amenitiesSet.add(a.trim()));
    if (Array.isArray(item.amenities)) item.amenities.forEach(a => a && amenitiesSet.add(a.trim()));
    const amenities = Array.from(amenitiesSet);

    const contactPhone = normalizeIndianPhone(item.contactNumber || item.owner?.[0]?.phone || item.contactPhone) || '9890000000';
    const contactEmail = normalizeEmail(item.contactEmail || item.owner?.[0]?.email) || undefined;

    const foodIncluded = Boolean(item.foodIncluded);
    const qualityScore = calculateQualityScore(item, photos, roomConfigs);

    const addressParts = [item.house_no, item.street, localityName, canonicalCityName, item.state || cityState].filter(Boolean);
    const fullAddress = addressParts.join(', ');

    const propertyDoc = {
      _id: propId,
      owner: propOwnerId,
      listedBy: 'owner',
      brokerage: { type: 'zero', amount: 0 },
      category: 'pg',
      purpose: 'rent',
      title,
      slug,
      description: (item.description || '').trim(),
      city: canonicalCityName,
      cityId,
      area: localityName,
      areaId,
      address: (item.address || localityName || canonicalCityName).trim(),
      fullAddress,
      landmark: (item.street || item.landmark || '').trim(),
      district: canonicalCityName,
      state: item.state || cityState,
      country: 'India',
      postalCode: item.postalCode || '',
      latitude: coordinates[1],
      longitude: coordinates[0],
      isApproximateLocation: false,
      location: {
        type: 'Point',
        coordinates,
      },
      pricing: {
        expectedPrice,
        pricePerSqFt: null,
        securityDeposit,
        depositMonths: null,
        maintenanceCharges,
        maintenanceType: item.maintenanceAmount ? 'monthly_fixed' : 'included',
        bookingAmount: 0,
        pricingNegotiable: false,
        taxGstApplicable: Boolean(item.gst),
      },
      photos,
      videos: [],
      documents: [],
      amenities,
      contactPhone,
      contactEmail,
      contactWhatsapp: contactPhone,
      status: 'approved',
      moderationNotes: `Imported and verified from ${canonicalCityName} dataset`,
      rejectionReason: null,
      reviewedBy: null,
      reviewedAt: item.adminApprovalDate ? new Date(item.adminApprovalDate) : new Date(item.createdAt || Date.now()),
      isVerified: Boolean(item.verified || item.adminApproved),
      verifiedAt: item.adminApprovalDate ? new Date(item.adminApprovalDate) : null,
      dataQualityScore: qualityScore,
      statusHistory: [
        {
          status: 'approved',
          changedAt: item.adminApprovalDate ? new Date(item.adminApprovalDate) : new Date(item.createdAt || Date.now()),
          reason: `Auto-verified from ${canonicalCityName} dataset source import`,
        }
      ],
      views: item.views || 0,
      inquiries: 0,
      wishlistCount: item.favoriteCount || 0,
      isFeatured: Boolean(item.isUpgradedListing || item.subscriptionRank > 0),
      pgDetails: {
        propertySubtype: 'PG',
        roomConfigs,
        floors: 1,
        totalRooms: item.numberOfRooms || roomConfigs.length,
        propertyAge: 0,
        gender: mapGender(item.availableFor),
        preferredTenants: ['student', 'working_professional'],
        food: foodIncluded ? 'both' : 'none',
        foodIncluded,
        foodInfo: {
          provided: foodIncluded,
          type: 'both',
          includedInRent: foodIncluded,
          mealCostPerMonth: 0,
          monthlyFoodCharge: 0,
          mealsPerDay: item.includedMeals?.length || (foodIncluded ? 3 : 0),
          mealTimings: {
            breakfast: { provided: foodIncluded, from: '07:30', to: '09:30' },
            lunch: { provided: foodIncluded, from: '12:30', to: '14:30' },
            dinner: { provided: foodIncluded, from: '19:30', to: '21:30' },
          },
          kitchenAccess: false,
          kitchenAccessForTenants: false,
          messType: foodIncluded ? 'in-house' : undefined,
        },
        ac: amenities.some(a => a.toLowerCase().includes('ac')),
        rules: {
          smokingAllowed: false,
          alcoholAllowed: false,
          petsAllowed: false,
          guestsAllowed: !item.pgHostelRule?.includes('No guardians stay'),
          visitorPolicy: 'lobby_only',
          curfewTime: item.gateClosingTime || (item.gateClosing ? '22:00' : ''),
          cookingAllowed: false,
          nonVegAllowed: true,
          customRules: Array.isArray(item.pgHostelRule) ? item.pgHostelRule : [],
        },
        noticePeriod: item.noticePeriodDuration || 30,
        minStay: 1,
        maxStay: null,
        isAvailable: item.active !== false,
        availableRooms: roomConfigs.length,
      },
      residentialDetails: null,
      commercialDetails: null,
      createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
      updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
    };

    propertyOperations.push({
      updateOne: {
        filter: { _id: propId },
        update: { $set: propertyDoc },
        upsert: true,
      }
    });
  }

  console.log(`\n📊 Transformation summary:`);
  console.log(`   - Valid listings ready to import : ${propertyOperations.length}`);
  console.log(`   - Validation failures            : ${validationFailures.length}`);
  console.log(`   - Room configurations mapped    : ${totalRoomsProcessed}`);
  console.log(`   - Photos mapped                 : ${totalPhotosProcessed}`);

  // 7. Execute Batched Writes
  let propertiesImported = 0;
  if (isApply) {
    console.log(`\n⚡ Executing Batched Writes (Batch Size: ${BATCH_SIZE})...`);
    for (let i = 0; i < propertyOperations.length; i += BATCH_SIZE) {
      const chunk = propertyOperations.slice(i, i + BATCH_SIZE);
      const res = await db.collection('properties').bulkWrite(chunk, { ordered: false });
      propertiesImported += (res.upsertedCount + res.modifiedCount);
      console.log(`   - Properties batch [${i + 1}..${Math.min(i + BATCH_SIZE, propertyOperations.length)}] (Upserted: ${res.upsertedCount}, Modified: ${res.modifiedCount})`);
    }
    console.log(`\n✅ Database writes completed successfully!`);
  } else {
    console.log(`\nℹ️  DRY RUN complete! No changes were made to MongoDB.`);
    console.log(`   To execute live import, re-run with '--apply':`);
    console.log(`   node src/scripts/import/importCityDataset.js --city=${canonicalCityName} --dir=${jsonDir} --apply\n`);
  }

  // 8. Generate Report
  const durationMs = Date.now() - startTime;
  const reportsDir = path.join(backendRoot, 'data/reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const reportDate = new Date().toISOString();
  const reportFilename = `${canonicalCityName.toLowerCase()}_import_report_${reportDate.replace(/[:.]/g, '-')}.md`;
  const reportPath = path.join(reportsDir, reportFilename);

  const reportContent = `# ${canonicalCityName} Dataset Import Report
**Date:** ${reportDate}  
**City:** ${canonicalCityName} (\`${cityId}\`)  
**Mode:** ${isApply ? 'LIVE APPLY' : 'DRY RUN'}  
**Duration:** ${(durationMs / 1000).toFixed(2)}s  

---

## 1. Summary
- **Files Scanned:** ${allFiles.length} JSON files (${validFiles.length} valid data files, ${emptyFiles.length} empty placeholder files, ${malformedFiles.length} malformed)
- **Total Listings in Source:** ${rawItems.length}
- **Successfully Transformed:** ${propertyOperations.length}
- **Validation Failures:** ${validationFailures.length}
- **Properties Written:** ${isApply ? propertiesImported : 'Simulated (' + propertyOperations.length + ')'}
- **Owners Resolved/Created:** ${ownerIdToCanonicalUserIdMap.size} (New: ${pendingNewUsers.length}, Matched by ID: ${matchedByIdCount}, Aliased by Phone: ${aliasedByPhoneCount}, Aliased by Email: ${aliasedByEmailCount})
- **Areas Resolved/Created:** ${distinctLocalities.size} distinct localities (New: ${areasToCreate.length}, Matched: ${distinctLocalities.size - areasToCreate.length})
- **Room Configurations:** ${totalRoomsProcessed}
- **Photos Mapped:** ${totalPhotosProcessed}

---

## 2. Validation & Errors
${validationFailures.length === 0 ? '_Zero validation failures encountered. 100% of records passed strict checks._' : validationFailures.map(f => `- **${f.id}** (${f.file}): ${f.reason}`).join('\n')}
`;

  fs.writeFileSync(reportPath, reportContent, 'utf8');
  console.log(`📄 Detailed import report saved to: ${reportPath}`);

  await mongoose.disconnect();
  return {
    city: canonicalCityName,
    validFilesCount: validFiles.length,
    rawItemsCount: rawItems.length,
    transformedCount: propertyOperations.length,
    validationFailuresCount: validationFailures.length,
    ownersCount: ownerIdToCanonicalUserIdMap.size,
    newOwnersCount: pendingNewUsers.length,
    newAreasCount: areasToCreate.length,
    reportPath,
  };
}

if (require.main === module) {
  runCityImport()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Universal import error:', err);
      process.exit(1);
    });
}

module.exports = runCityImport;
