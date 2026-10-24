const Property = require('../models/Property.model');
const PropertyAudit = require('../modules/properties/models/PropertyAudit.model');
const notificationTrigger = require('../services/notification/notification.trigger');
const redisCache = require('./redisCache.service');
const { NotFoundError } = require('../common/errors');

const invalidateSearchCache = () => {
  redisCache.delByPattern('search:properties:*').catch(() => {});
  redisCache.delByPattern('search:suggest:*').catch(() => {});
};

/**
 * Get all properties for Admin with filtering, search, and pagination
 */
const getAllPropertiesForAdmin = async (params = {}) => {
  const cleanStatus = typeof params.status === 'string' ? params.status.trim() : '';
  const cleanSearch = typeof params.search === 'string' ? params.search.trim().replace(/\s+/g, ' ') : '';
  const page = Math.max(1, parseInt(params.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(params.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const query = {};

  if (cleanStatus && cleanStatus !== 'all') {
    if (cleanStatus === 'pending') {
      query.status = { $in: ['pending', 'submitted', 'pending_review'] };
    } else {
      query.status = cleanStatus;
    }
  }

  if (params.category && params.category !== 'all') {
    query.category = params.category;
  }

  if (params.purpose && params.purpose !== 'all') {
    query.purpose = params.purpose;
  }

  if (params.cityId) {
    query.cityId = params.cityId;
  } else if (params.city && params.city.trim()) {
    query.city = new RegExp(params.city.trim(), 'i');
  }

  if (params.areaId) {
    query.areaId = params.areaId;
  } else if (params.area && params.area.trim()) {
    query.area = new RegExp(params.area.trim(), 'i');
  }

  if (params.isVerified !== undefined && params.isVerified !== '' && params.isVerified !== 'all') {
    query.isVerified = params.isVerified === 'true' || params.isVerified === true;
  }

  if (params.quality && params.quality !== 'all') {
    if (params.quality === 'low') query.dataQualityScore = { $lte: 2 };
    else if (params.quality === 'good') query.dataQualityScore = 3;
    else if (params.quality === 'high') query.dataQualityScore = { $gte: 4 };
    else if (!isNaN(Number(params.quality))) query.dataQualityScore = Number(params.quality);
  }

  if (cleanSearch) {
    const terms = cleanSearch.split(' ').filter(Boolean);
    const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    query.$and = (query.$and || []).concat(
      escaped.map((term) => ({
        $or: [
          { title: { $regex: term, $options: 'i' } },
          { city: { $regex: term, $options: 'i' } },
          { area: { $regex: term, $options: 'i' } },
          { address: { $regex: term, $options: 'i' } },
          { fullAddress: { $regex: term, $options: 'i' } },
          { contactPhone: { $regex: term, $options: 'i' } },
        ],
      }))
    );
  }

  const sort = { createdAt: -1 };
  if (params.sortBy) {
    if (params.sortBy === 'oldest') sort.createdAt = 1;
    else if (params.sortBy === 'price_asc') sort['pricing.expectedPrice'] = 1;
    else if (params.sortBy === 'price_desc') sort['pricing.expectedPrice'] = -1;
    else if (params.sortBy === 'quality_desc') sort.dataQualityScore = -1;
    else if (params.sortBy === 'views_desc') sort.views = -1;
  }

  const [properties, total] = await Promise.all([
    Property.find(query)
      .populate('owner', 'name email phone avatar')
      .populate('reviewedBy', 'name email')
      .populate('cityId', 'name slug state')
      .populate('areaId', 'name slug')
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Property.countDocuments(query),
  ]);

  return {
    properties,
    total,
    page,
    totalPages: Math.ceil(total / limit) || 1,
    limit,
  };
};

/**
 * Approve a property listing
 */
const approveProperty = async (propertyId, adminId) => {
  const currentProperty = await Property.findById(propertyId);
  if (!currentProperty) {
    throw new NotFoundError('Property not found');
  }

  const prevStatus = currentProperty.status;
  const auditEntry = {
    status: 'approved',
    changedAt: new Date(),
    changedBy: adminId,
    reason: 'Approved by admin',
  };

  const property = await Property.findByIdAndUpdate(
    propertyId,
    {
      $set: {
        status: 'approved',
        rejectionReason: null,
        correctionComments: null,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
      $push: {
        statusHistory: auditEntry,
      },
    },
    { new: true }
  ).populate('owner', 'name email phone');

  // Record persistent audit log
  PropertyAudit.create({
    propertyId,
    action: 'approved',
    previousStatus: prevStatus,
    newStatus: 'approved',
    actor: adminId,
    actorRole: 'admin',
  }).catch(() => {});



  // Trigger notification
  if (notificationTrigger && notificationTrigger.onPGApproved) {
    notificationTrigger.onPGApproved(property).catch(() => {});
  }

  invalidateSearchCache();
  return property;
};

/**
 * Reject a property listing
 */
const rejectProperty = async (propertyId, adminId, reason) => {
  const currentProperty = await Property.findById(propertyId);
  if (!currentProperty) {
    throw new NotFoundError('Property not found');
  }

  const prevStatus = currentProperty.status;
  const rejectReason = reason || 'Listing does not meet quality guidelines or verification standards';
  const auditEntry = {
    status: 'rejected',
    changedAt: new Date(),
    changedBy: adminId,
    reason: rejectReason,
  };

  const property = await Property.findByIdAndUpdate(
    propertyId,
    {
      $set: {
        status: 'rejected',
        rejectionReason: rejectReason,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
      $push: {
        statusHistory: auditEntry,
      },
    },
    { new: true }
  ).populate('owner', 'name email phone');

  PropertyAudit.create({
    propertyId,
    action: 'rejected',
    previousStatus: prevStatus,
    newStatus: 'rejected',
    actor: adminId,
    actorRole: 'admin',
    reason: rejectReason,
  }).catch(() => {});



  if (notificationTrigger && notificationTrigger.onPGRejected) {
    notificationTrigger.onPGRejected(property, rejectReason).catch(() => {});
  }

  invalidateSearchCache();
  return property;
};

/**
 * Request correction from owner
 */
const requestCorrection = async (propertyId, adminId, comments) => {
  const currentProperty = await Property.findById(propertyId);
  if (!currentProperty) {
    throw new NotFoundError('Property not found');
  }

  const prevStatus = currentProperty.status;
  const commentText = comments || 'Please review and update property details according to guidelines';
  const auditEntry = {
    status: 'correction_required',
    changedAt: new Date(),
    changedBy: adminId,
    reason: commentText,
  };

  const property = await Property.findByIdAndUpdate(
    propertyId,
    {
      $set: {
        status: 'correction_required',
        correctionComments: commentText,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
      $push: {
        statusHistory: auditEntry,
      },
    },
    { new: true }
  ).populate('owner', 'name email phone');

  PropertyAudit.create({
    propertyId,
    action: 'correction_requested',
    previousStatus: prevStatus,
    newStatus: 'correction_required',
    actor: adminId,
    actorRole: 'admin',
    reason: commentText,
  }).catch(() => {});



  return property;
};

/**
 * Suspend a property
 */
const suspendProperty = async (propertyId, adminId, notes) => {
  const currentProperty = await Property.findById(propertyId);
  if (!currentProperty) {
    throw new NotFoundError('Property not found');
  }

  const prevStatus = currentProperty.status;
  const noteText = notes || 'Suspended by admin';
  const auditEntry = {
    status: 'suspended',
    changedAt: new Date(),
    changedBy: adminId,
    reason: noteText,
  };

  const property = await Property.findByIdAndUpdate(
    propertyId,
    {
      $set: {
        status: 'suspended',
        moderationNotes: noteText,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
      $push: {
        statusHistory: auditEntry,
      },
    },
    { new: true }
  );

  PropertyAudit.create({
    propertyId,
    action: 'suspended',
    previousStatus: prevStatus,
    newStatus: 'suspended',
    actor: adminId,
    actorRole: 'admin',
    reason: noteText,
  }).catch(() => {});



  invalidateSearchCache();
  return property;
};

/**
 * Toggle verification badge
 */
const toggleVerify = async (propertyId) => {
  const property = await Property.findById(propertyId);
  if (!property) {
    throw new NotFoundError('Property not found');
  }

  property.isVerified = !property.isVerified;
  property.verifiedAt = property.isVerified ? new Date() : null;
  await property.save();



  invalidateSearchCache();
  return property;
};

/**
 * Get analytics counts for properties moderation
 */
const getPropertyAdminAnalytics = async () => {
  const [
    total, pending, approved, rejected, correction_required,
    pgCount, residentialCount, commercialCount, verifiedCount
  ] = await Promise.all([
    Property.countDocuments(),
    Property.countDocuments({ status: { $in: ['pending', 'submitted', 'pending_review'] } }),
    Property.countDocuments({ status: 'approved' }),
    Property.countDocuments({ status: 'rejected' }),
    Property.countDocuments({ status: 'correction_required' }),
    Property.countDocuments({ category: 'pg' }),
    Property.countDocuments({ category: 'residential_rental' }),
    Property.countDocuments({ category: 'commercial' }),
    Property.countDocuments({ isVerified: true }),
  ]);

  return {
    total,
    pending,
    approved,
    rejected,
    correction_required,
    verified: verifiedCount,
    byCategory: {
      pg: pgCount,
      residential_rental: residentialCount,
      commercial: commercialCount,
    },
  };
};

module.exports = {
  getAllPropertiesForAdmin,
  getPropertyAdminAnalytics,
  approveProperty,
  rejectProperty,
  requestCorrection,
  suspendProperty,
  toggleVerify,
};
