const crypto = require('node:crypto');
const { Types } = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const { successResponse } = require('../utils/apiResponse');
const VisitRequest = require('../models/VisitRequest.model');
const Property = require('../models/Property.model');

/**
 * @route POST /api/v1/visit
 */
const createVisit = asyncHandler(async (req, res) => {
  const { pgId, propertyId, scheduledDate, scheduledTime, message } = req.body;
  const targetId = propertyId || pgId;

  const property = await Property.findOne({ _id: targetId, status: 'approved' }).select('owner category');
  if (!property?.owner) {
    return res.status(404).json({ success: false, message: 'Property not found or not available' });
  }

  if (String(property.owner) === String(req.user._id)) {
    return res.status(400).json({ success: false, message: 'You cannot request a visit to your own listing' });
  }

  const id = new Types.ObjectId(crypto.createHash('sha256')
    .update(JSON.stringify([String(req.user._id), String(property._id), scheduledDate, scheduledTime]))
    .digest('hex').slice(0, 24));
  const visit = await VisitRequest.findOneAndUpdate({ _id: id, tenant: req.user._id }, {
    $setOnInsert: {
      property: property._id,
      pg: property._id,
      category: property.category || 'pg',
      tenant: req.user._id,
      owner: property.owner,
      scheduledDate: new Date(scheduledDate),
      scheduledTime,
      message,
    },
  }, { upsert: true, new: true, runValidators: true });

  if (visit.status === 'cancelled') {
    return res.status(409).json({ success: false, message: 'That visit was cancelled. Choose another time.' });
  }

  await visit.populate([
    { path: 'property', select: 'title name area city' },
    { path: 'tenant', select: 'name phone' },
  ]);

  successResponse(res, 'Visit request sent successfully', { visit }, 201);
});

/**
 * @route GET /api/v1/visit/my
 */
const getMyVisits = asyncHandler(async (req, res) => {
  const visits = await VisitRequest.find({ tenant: req.user._id })
    .populate('property', 'title name area city photos')
    .populate('pg', 'title name area city photos')
    .populate('owner', 'name phone')
    .sort({ scheduledDate: -1 })
    .lean();

  successResponse(res, 'Visit requests retrieved', { visits });
});

/**
 * @route GET /api/v1/visit/pg/:pgId
 */
const getPGVisits = asyncHandler(async (req, res) => {
  const targetId = req.params.pgId || req.params.propertyId;
  const property = await Property.findOne({ _id: targetId, owner: req.user._id });
  if (!property) {
    return res.status(403).json({ success: false, message: 'Not authorized' });
  }

  const visits = await VisitRequest.find({ pg: req.params.pgId })
    .populate('tenant', 'name email phone')
    .sort({ scheduledDate: 1 })
    .lean();

  successResponse(res, 'Visit requests for PG retrieved', { visits });
});

/**
 * @route PUT /api/v1/visit/:id/status
 */
const allowedPrevious = {
  confirmed: ['pending'],
  cancelled: ['pending', 'confirmed'],
  completed: ['confirmed'],
};

const updateVisitStatus = asyncHandler(async (req, res) => {
  const { status, ownerNote } = req.body;
  const scope = { _id: req.params.id, owner: req.user._id };
  const visit = await VisitRequest.findOneAndUpdate({
    ...scope, status: { $in: [...allowedPrevious[status], status] },
  }, {
    $set: { status, ...(ownerNote !== undefined ? { ownerNote } : {}) },
  }, { new: true, runValidators: true });

  if (!visit) {
    const exists = await VisitRequest.exists(scope);
    return res.status(exists ? 409 : 404).json({
      success: false, message: exists ? 'This visit cannot move to the requested status.' : 'Visit request not found.',
    });
  }

  successResponse(res, `Visit request ${status}`, { visit });
});

const cancelMyVisit = asyncHandler(async (req, res) => {
  const scope = { _id: req.params.id, tenant: req.user._id };
  const visit = await VisitRequest.findOneAndUpdate({
    ...scope, status: { $in: ['pending', 'confirmed', 'cancelled'] },
  }, { $set: { status: 'cancelled' } }, { new: true });
  if (!visit) {
    const exists = await VisitRequest.exists(scope);
    return res.status(exists ? 409 : 404).json({
      success: false, message: exists ? 'This visit can no longer be cancelled.' : 'Visit request not found.',
    });
  }
  successResponse(res, 'Visit cancelled', { visit });
});

module.exports = { createVisit, getMyVisits, getPGVisits, updateVisitStatus, cancelMyVisit };
