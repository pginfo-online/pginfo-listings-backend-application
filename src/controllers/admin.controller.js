const asyncHandler = require('../utils/asyncHandler');
const { successResponse, paginatedResponse } = require('../utils/apiResponse');
const Property = require('../models/Property.model');
const PG = Property;
const User = require('../models/User.model');
const Lead = require('../models/Lead.model');
const VisitRequest = require('../models/VisitRequest.model');
const notificationTrigger = require('../services/notification/notification.trigger');

// /**
//  * @route GET /api/v1/admin/pgs working on new module
//  */
// const getAllPGs = asyncHandler(async (req, res) => {
//   const { status, page = 1, limit = 20 } = req.query;
//   const query = status ? { status } : {};
//   const skip = (page - 1) * limit;

//   const [pgs, total] = await Promise.all([
//     PG.find(query)
//       .populate('owner', 'name email phone')
//       .sort({ createdAt: -1 })
//       .skip(skip)
//       .limit(Number(limit))
//       .lean(),
//     PG.countDocuments(query),
//   ]);

//   successResponse(res, 'All PG listings', { pgs, total, page: Number(page), totalPages: Math.ceil(total / limit) });
// });


/**
 * @route GET /api/v1/admin/pgs
 * @desc  Get all PG listings with high-signal search, status filter, and pagination
 */
const getAllPGs = asyncHandler(async (req, res) => {
  const cleanStatus = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const cleanSearch = typeof req.query.search === 'string' ? req.query.search.trim().replace(/\s+/g, ' ') : '';

  const page = Number.isFinite(Number(req.query.page)) && Number(req.query.page) > 0 ? Number(req.query.page) : 1;
  const limit = Number.isFinite(Number(req.query.limit)) && Number(req.query.limit) > 0
    ? Math.min(Number(req.query.limit), 50)
    : 20;

  const query = {};

  if (cleanStatus && cleanStatus !== 'all') {
    query.status = cleanStatus;
  }

  // Filter params
  const { city, area, gender, propertyType, isVerified, quality } = req.query;

  if (city && typeof city === 'string' && city.trim()) {
    query.city = new RegExp(city.trim(), 'i');
  }

  if (area && typeof area === 'string' && area.trim()) {
    query.area = new RegExp(area.trim(), 'i');
  }

  if (gender && gender !== 'all') {
    query.gender = gender;
  }

  if (propertyType && propertyType !== 'all') {
    query.propertyType = propertyType;
  }

  if (isVerified !== undefined && isVerified !== '' && isVerified !== 'all') {
    query.isVerified = isVerified === 'true' || isVerified === true;
  }

  if (quality && quality !== 'all') {
    if (quality === 'low') {
      query.dataQualityScore = { $lte: 2 };
    } else if (quality === 'good') {
      query.dataQualityScore = 3;
    } else if (quality === 'high') {
      query.dataQualityScore = { $gte: 4 };
    } else if (!isNaN(Number(quality))) {
      query.dataQualityScore = Number(quality);
    }
  }

  if (cleanSearch) {
    const searchTerms = cleanSearch.split(' ').filter(Boolean);
    const escapedTerms = searchTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    // Find matching owner IDs to allow searching by owner name / email / phone
    const User = require('../models/User.model');
    const matchingOwners = await User.find({
      $or: escapedTerms.flatMap((term) => [
        { name: new RegExp(term, 'i') },
        { email: new RegExp(term, 'i') },
        { phone: new RegExp(term, 'i') }
      ])
    }).select('_id').lean();

    const ownerIds = matchingOwners.map(o => o._id);

    query.$or = [
      ...escapedTerms.flatMap((term) => [
        { name: new RegExp(term, 'i') },
        { area: new RegExp(term, 'i') },
        { city: new RegExp(term, 'i') },
        { address: new RegExp(term, 'i') },
        { description: new RegExp(term, 'i') },
        { contactPhone: new RegExp(term, 'i') },
      ]),
      ...(ownerIds.length > 0 ? [{ owner: { $in: ownerIds } }] : [])
    ];
  }

  const skip = (page - 1) * limit;

  const [pgs, total] = await Promise.all([
    PG.find(query)
      .populate('owner', 'name email phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PG.countDocuments(query),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  paginatedResponse(res, 'All PG listings', pgs, {
    total,
    page,
    limit,
    totalPages,
    hasNext: page * limit < total,
    hasPrev: page > 1,
  });
});


/**
 * @route PUT /api/v1/admin/pgs/:id/approve
 */
const approvePG = asyncHandler(async (req, res) => {
  const pg = await PG.findByIdAndUpdate(
    req.params.id,
    { status: 'approved', rejectionReason: null },
    { new: true }
  ).populate('owner', 'name email');

  if (!pg) return res.status(404).json({ success: false, message: 'PG not found' });
  notificationTrigger.onPGApproved(pg).catch(() => { });
  successResponse(res, 'PG approved successfully', { pg });
});

/**
 * @route PUT /api/v1/admin/pgs/:id/reject
 */
const rejectPG = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const pg = await PG.findByIdAndUpdate(
    req.params.id,
    { status: 'rejected', rejectionReason: reason || 'Does not meet listing requirements' },
    { new: true }
  );
  if (!pg) return res.status(404).json({ success: false, message: 'PG not found' });
  notificationTrigger.onPGRejected(pg, reason).catch(() => { });
  successResponse(res, 'PG rejected', { pg });
});

/**
 * @route PUT /api/v1/admin/pgs/:id/verify
 */
const toggleVerify = asyncHandler(async (req, res) => {
  const pg = await PG.findById(req.params.id);
  if (!pg) return res.status(404).json({ success: false, message: 'PG not found' });

  pg.isVerified = !pg.isVerified;
  await pg.save();
  successResponse(res, `PG ${pg.isVerified ? 'verified' : 'unverified'}`, { pg });
});

/**
 * @route DELETE /api/v1/admin/pgs/:id
 */
const removePG = asyncHandler(async (req, res) => {
  const pg = await PG.findByIdAndDelete(req.params.id);
  if (!pg) return res.status(404).json({ success: false, message: 'PG not found' });
  successResponse(res, 'PG listing removed');
});

/**
 * @route GET /api/v1/admin/analytics
 */
const getAnalytics = asyncHandler(async (req, res) => {
  const [
    totalPGs, approvedPGs, pendingPGs, rejectedPGs, verifiedPGs,
    totalUsers, totalTenants, totalOwners,
    totalLeads, totalVisits,
  ] = await Promise.all([
    Property.countDocuments(),
    Property.countDocuments({ status: 'approved' }),
    Property.countDocuments({ status: { $in: ['pending', 'submitted', 'pending_review'] } }),
    Property.countDocuments({ status: 'rejected' }),
    Property.countDocuments({ isVerified: true }),
    User.countDocuments({ role: { $ne: 'admin' } }),
    User.countDocuments({ role: 'tenant' }),
    User.countDocuments({ role: 'owner' }),
    Lead.countDocuments(),
    VisitRequest.countDocuments(),
  ]);

  const cityStats = await Property.aggregate([
    { $match: { status: 'approved', city: { $type: 'string' } } },
    {
      $lookup: {
        from: 'cities',
        localField: 'cityId',
        foreignField: '_id',
        as: 'cityRecord',
      },
    },
    {
      $project: {
        cityName: {
          $ifNull: [
            { $arrayElemAt: ['$cityRecord.name', 0] },
            { $trim: { input: '$city' } },
          ],
        },
      },
    },
    { $set: { cityKey: { $toLower: '$cityName' } } },
    { $match: { cityKey: { $ne: '' } } },
    {
      $group: {
        _id: '$cityKey',
        cityName: { $first: '$cityName' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, cityName: 1 } },
    { $project: { _id: '$cityName', count: 1 } },
  ]);

  successResponse(res, 'Analytics retrieved', {
    pgs: { total: totalPGs, approved: approvedPGs, pending: pendingPGs, rejected: rejectedPGs, verified: verifiedPGs },
    users: { total: totalUsers, tenants: totalTenants, owners: totalOwners },
    activity: { leads: totalLeads, visits: totalVisits },
    cityStats,
  });
});

/**
 * @route PUT /api/v1/admin/pgs/:id
 * @desc  Admin direct edit for any PG listing
 */
const updatePGByAdmin = asyncHandler(async (req, res) => {
  const PG = Property;
  const pg = await PG.findById(req.params.id);

  if (!pg) {
    return res.status(404).json({ success: false, message: 'PG listing not found' });
  }

  const updateData = { ...req.body };
  if (updateData.address || updateData.area || updateData.city) {
    try {
      const { geocodeAddress } = require('../utils/geocoder');
      const fullAddress = `${updateData.address || pg.address}, ${updateData.area || pg.area}, ${updateData.city || pg.city}`;
      const coords = await geocodeAddress(fullAddress);
      if (coords) {
        updateData.latitude = coords.latitude;
        updateData.longitude = coords.longitude;
        updateData.location = {
          type: 'Point',
          coordinates: [coords.longitude, coords.latitude]
        };
        if (coords.fullAddress) updateData.fullAddress = coords.fullAddress;
        if (coords.postalCode) updateData.postalCode = coords.postalCode;
        if (coords.country) updateData.country = coords.country;
        if (coords.state) updateData.state = coords.state;
        if (coords.district) updateData.district = coords.district;
        if (coords.placeId) updateData.googlePlaceId = coords.placeId;
      }
    } catch (err) {
      console.error('Geocoding error in admin updatePG:', err);
    }
  }

  const updatedPG = await PG.findByIdAndUpdate(
    req.params.id,
    { $set: updateData },
    { new: true, runValidators: true }
  ).populate('owner', 'name email phone');

  successResponse(res, 'PG listing updated successfully by Admin', { pg: updatedPG });
});

const getTrends = asyncHandler(async (req, res) => {
  const days = Number(req.query.days ?? 30);
  if (![7, 30, 90].includes(days)) return res.status(400).json({ success: false, message: 'Choose 7, 30, or 90 days' });
  const dayMs = 86400000;
  const offset = 19800000;
  const today = Math.floor((Date.now() + offset) / dayMs) * dayMs - offset;
  const since = new Date(today - (days - 1) * dayMs);
  const until = new Date(today + dayMs);
  const group = (model) => model.aggregate([
    { $match: { createdAt: { $gte: since, $lt: until } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, count: { $sum: 1 } } },
  ]);
  const [properties, leads, visits] = await Promise.all([group(Property), group(Lead), group(VisitRequest)]);
  const byDate = (rows) => new Map(rows.map((row) => [row._id, row.count]));
  const counts = [properties, leads, visits].map(byDate);
  const points = Array.from({ length: days }, (_, index) => {
    const date = new Date(since.getTime() + offset + index * dayMs).toISOString().slice(0, 10);
    return { date, properties: counts[0].get(date) || 0, leads: counts[1].get(date) || 0, visits: counts[2].get(date) || 0 };
  });
  successResponse(res, 'Activity trends retrieved', { timezone: 'Asia/Kolkata', points });
});

module.exports = { getAllPGs, approvePG, rejectPG, toggleVerify, removePG, getAnalytics, getTrends, updatePGByAdmin };
