const asyncHandler = require('../utils/asyncHandler');
const { successResponse, paginatedResponse } = require('../utils/apiResponse');
const pgService = require('../services/pg.service');

/**
 * @route GET /api/v1/pg
 */
const getPGs = asyncHandler(async (req, res) => {
  const { pgs, pagination } = await pgService.getPGs(req.query, req.user);
  paginatedResponse(res, 'PG listings retrieved', pgs, pagination);
});

/**
 * @route GET /api/v1/pg/:id
 */
const getPGById = asyncHandler(async (req, res) => {
  const pg = await pgService.getPGById(req.params.id, req.user);
  successResponse(res, 'PG details retrieved', { pg });
});

/**
 * @route POST /api/v1/pg
 */
const createPG = asyncHandler(async (req, res) => {
  const pg = await pgService.createPG(req.user._id, req.body);

  // ─── Auto-upgrade tenant → owner on first PG creation ─────────────────────
  let updatedUser = null;
  if (req.user.role === 'tenant') {
    const User = require('../models/User.model');
    updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { role: 'owner' },
      { new: true, runValidators: true }
    ).select('-password');
  }

  successResponse(
    res,
    'PG listing created and submitted for approval',
    { pg, ...(updatedUser && { user: updatedUser }) },
    201
  );
});

/**
 * @route PUT /api/v1/pg/:id
 */
const updatePG = asyncHandler(async (req, res) => {
  const result = await pgService.updatePG(req.params.id, req.user._id, req.body, req.user.role);
  if (req.user.role === 'admin') {
    successResponse(res, 'PG updated successfully by admin', result);
  } else {
    successResponse(res, 'Changes submitted for admin approval. Your listing will update once approved.', result);
  }
});

/**
 * @route DELETE /api/v1/pg/:id
 */
const deletePG = asyncHandler(async (req, res) => {
  await pgService.deletePG(req.params.id, req.user._id, req.user.role);
  successResponse(res, 'PG listing deleted');
});

/**
 * @route GET /api/v1/pg/my - Owner's own listings
 */
const Property = require('../models/Property.model');

const getMyPGs = asyncHandler(async (req, res) => {
  const pgs = await Property.find({ owner: req.user._id, category: 'pg' }).sort({ createdAt: -1 }).lean();
  successResponse(res, 'Your listings retrieved', { pgs });
});

/**
 * @route GET /api/v1/pg/my/paginated
 * Owner's listings with search & pagination
 */
const getMyPGsPaginated = asyncHandler(async (req, res) => {
  const { q, page: pageStr, limit: limitStr, status } = req.query;

  const page = Math.max(1, parseInt(pageStr, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(limitStr, 10) || 12));
  const skip = (page - 1) * limit;

  const query = { owner: req.user._id };

  if (q && q.trim()) {
    const cleanSearch = q.trim().replace(/\s+/g, ' ');
    const searchTerms = cleanSearch.split(' ').filter(Boolean);
    const safeTerms = searchTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    query.$or = safeTerms.flatMap((term) => [
      { name: new RegExp(term, 'i') },
      { area: new RegExp(term, 'i') },
      { city: new RegExp(term, 'i') },
      { address: new RegExp(term, 'i') },
      { description: new RegExp(term, 'i') },
      { contactPhone: new RegExp(term, 'i') },
    ]);
  }

  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    query.status = status;
  }

  const [pgs, total] = await Promise.all([
    Property.find({ ...query, category: 'pg' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Property.countDocuments({ ...query, category: 'pg' }),
  ]);

  const pagination = {
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  };

  successResponse(res, 'Your listings retrieved', { pgs, pagination });
});

/**
 * @route GET /api/v1/pg/suggestions
 * Gets real-time suggestions for search bar
 */
const getSuggestions = asyncHandler(async (req, res) => {
  const { q, sessiontoken } = req.query;
  const result = await pgService.getSuggestions(q, sessiontoken);
  successResponse(res, 'Suggestions retrieved', result);
});

const pgUpdateRequestController = require('./pgUpdateRequest.controller');
const getMyUpdateRequests = pgUpdateRequestController.getMyUpdateRequests;
const cancelUpdateRequest = pgUpdateRequestController.cancelUpdateRequest;

module.exports = { getPGs, getPGById, createPG, updatePG, deletePG, getMyPGs,getMyPGsPaginated, getSuggestions, getMyUpdateRequests, cancelUpdateRequest };
