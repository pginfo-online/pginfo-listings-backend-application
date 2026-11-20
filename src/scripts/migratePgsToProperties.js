/**
 * Safe, idempotent, non-destructive migration script:
 * Copies and standardizes existing PG documents into the unified Property collection in batches.
 * Existing PGs in MongoDB are NOT altered or deleted.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const PG = mongoose.model('PG_Raw', new mongoose.Schema({}, { strict: false, collection: 'pgs' }));
const Property = require('../models/Property.model');
const City = require('../models/City.model');
const Area = require('../models/Area.model');
const User = require('../models/User.model');

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactName = (name) => new RegExp('^' + escapeRegex(name.trim()) + '$', 'i');

async function migratePgsToProperties() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI, {
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 5000,
  });
  const pgs = await PG.aggregate([
    { $lookup: { from: Property.collection.name, localField: '_id', foreignField: '_id', as: 'canonical' } },
    { $match: { 'canonical.0': { $exists: false } } },
    { $project: { canonical: 0 } },
  ]).option({ maxTimeMS: 15000 });
  const skipped = [];
  console.log(`${apply ? 'Apply' : 'Dry run'}: ${pgs.length} legacy listings have no matching property ID.`);

  const BATCH_SIZE = 500;
  let processed = 0;

  for (let i = 0; i < pgs.length; i += BATCH_SIZE) {
    const chunk = pgs.slice(i, i + BATCH_SIZE);
    const operations = [];
    for (const pg of chunk) {
      const city = typeof pg.city === 'string' && pg.city.trim()
        ? await City.findOne({ name: exactName(pg.city), isActive: true }).select('_id name').lean()
        : null;
      // Avior's project page and Maharashtra's lift inspection register place Vanalika Wing 1A in Pirangut.
      const isVanalika = String(pg._id) === '6acdae09c376e3e2fc90bbf3' &&
        city?.name === 'Pune' && exactName('Vanalika Apartment Block-1a').test(pg.area) &&
        /\bpirangut\b/i.test(pg.address || '');
      const locality = isVanalika ? 'Pirangut' : pg.area;
      const area = city && typeof locality === 'string' && locality.trim()
        ? await Area.findOne({ city: city._id, name: exactName(locality), isActive: true }).select('_id name').lean()
        : null;
      const owner = pg.owner ? await User.exists({ _id: pg.owner, isActive: true }) : null;
      if (!city || !area || !owner) {
        skipped.push({
          id: String(pg._id),
          fields: [...(!city ? ['cityId'] : []), ...(!area ? ['areaId'] : []), ...(!owner ? ['owner'] : [])],
        });
        continue;
      }
      let minRent = pg.monthlyPricing || 0;
      if (Array.isArray(pg.roomConfigs) && pg.roomConfigs.length > 0) {
        const rents = pg.roomConfigs.map((rc) => Number(rc.rent)).filter((r) => !isNaN(r) && r > 0);
        if (rents.length > 0) minRent = Math.min(...rents);
      }

      const propertyDoc = {
        _id: pg._id,
        owner: pg.owner,
        listedBy: 'owner',
        brokerage: { type: 'zero', amount: 0 },
        category: 'pg',
        purpose: 'rent',
        title: pg.name || 'PG Accommodation',
        description: pg.description || '',
        city: city.name,
        cityId: city._id,
        area: area.name,
        areaId: area._id,
        address: pg.address || '',
        fullAddress: pg.fullAddress || '',
        landmark: pg.landmark || '',
        district: pg.district || '',
        state: pg.state || '',
        country: pg.country || 'India',
        postalCode: pg.postalCode || '',
        googlePlaceId: pg.googlePlaceId || '',
        latitude: pg.latitude,
        longitude: pg.longitude,
        mapsLink: pg.mapsLink || '',
        location: pg.location?.coordinates?.some(Boolean) ? pg.location : undefined,
        pricing: {
          expectedPrice: minRent || 0,
          pricePerSqFt: null,
          securityDeposit: pg.securityDeposit || 0,
          depositMonths: null,
          maintenanceCharges: 0,
          maintenanceType: 'included',
          bookingAmount: 0,
          pricingNegotiable: false,
          camChargesPerSqFt: null,
          dgBackupCharges: null,
          taxGstApplicable: false,
        },
        photos: (pg.photos || []).map((p, idx) => ({
          url: p.url,
          publicId: p.publicId,
          caption: p.caption,
          isMain: p.isMain || idx === 0,
          order: p.order || idx,
          _id: p._id,
        })),
        videos: (pg.videos || []).map((v, idx) => ({
          url: v.url,
          publicId: v.publicId,
          thumbnailUrl: v.thumbnailUrl,
          title: v.title,
          duration: v.duration,
          order: v.order || idx,
          _id: v._id,
        })),
        documents: [],
        amenities: Array.isArray(pg.facilities) ? pg.facilities : [],
        contactPhone: pg.contactPhone,
        contactWhatsapp: pg.contactWhatsapp || '',
        contactEmail: '',
        preferredContactHours: '',
        nearbyPlaces: Array.isArray(pg.nearbyPlaces) ? pg.nearbyPlaces : [],
        status: ['pending', 'submitted', 'pending_review'].includes(pg.status) ? 'submitted' : 'draft',
        moderationNotes: null,
        rejectionReason: pg.rejectionReason || null,
        reviewedBy: null,
        reviewedAt: pg.updatedAt,
        isVerified: pg.isVerified || false,
        dataQualityScore: pg.dataQualityScore || 1,
        views: pg.views || 0,
        inquiries: pg.inquiries || 0,
        wishlistCount: 0,
        isFeatured: false,
        pgDetails: {
          propertySubtype: pg.propertyType || 'PG',
          roomConfigs: Array.isArray(pg.roomConfigs) ? pg.roomConfigs : [],
          floors: pg.floors || 1,
          totalRooms: pg.totalRooms || 1,
          propertyAge: pg.propertyAge || 0,
          gender: pg.gender || 'any',
          preferredTenants: Array.isArray(pg.preferredTenants) ? pg.preferredTenants : ['any'],
          food: pg.food || 'none',
          foodIncluded: pg.foodIncluded || false,
          foodInfo: pg.foodInfo || {},
          ac: pg.ac || false,
          rules: pg.rules || {},
          noticePeriod: pg.noticePeriod || 30,
          minStay: pg.minStay || 1,
          maxStay: pg.maxStay || null,
          isAvailable: pg.isAvailable !== false,
          availableRooms: pg.availableRooms || 0,
        },
        residentialDetails: null,
        commercialDetails: null,
        createdAt: pg.createdAt || new Date(),
        updatedAt: pg.updatedAt || new Date(),
      };

      const candidate = new Property(propertyDoc);
      const error = candidate.validateSync();
      if (error) {
        skipped.push({ id: String(pg._id), fields: Object.keys(error.errors) });
        continue;
      }
      operations.push({
        updateOne: {
          filter: { _id: pg._id },
          update: { $setOnInsert: candidate.toObject({ virtuals: false }) },
          timestamps: false,
          upsert: true,
        },
      });
    }

    if (apply && operations.length) {
      const result = await Property.bulkWrite(operations, { ordered: false });
      processed += result.upsertedCount;
    } else {
      processed += operations.length;
    }
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', eligibleOrInserted: processed, skipped }, null, 2));
  await mongoose.disconnect();
}

if (require.main === module) {
  migratePgsToProperties()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = migratePgsToProperties;
