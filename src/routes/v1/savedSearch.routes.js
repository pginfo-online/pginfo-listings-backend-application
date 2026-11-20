const express = require('express');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { z } = require('zod');
const SavedSearch = require('../../models/SavedSearch.model');
const { propertyQuerySchema } = require('../../validators/property.validator');
const { protect } = require('../../middlewares/auth.middleware');
const validate = require('../../middlewares/validate.middleware');
const asyncHandler = require('../../utils/asyncHandler');
const { successResponse, errorResponse } = require('../../utils/apiResponse');

const router = express.Router();
const schema = z.object({
  label: z.string().trim().min(1).max(120),
  filters: propertyQuerySchema.refine((query) => Boolean(query.cityId || query.city) && query.lat === undefined, {
    message: 'Choose a city or locality to save this search.',
  }),
});

router.use(protect);

router.get('/', asyncHandler(async (req, res) => {
  const searches = await SavedSearch.find({ user: req.user._id })
    .select('label filters createdAt').sort({ createdAt: -1 }).limit(25).lean();
  successResponse(res, 'Saved searches retrieved', { searches });
}));

router.post('/', validate(schema), asyncHandler(async (req, res) => {
  const { label, filters } = req.body;
  delete filters.page;
  delete filters.limit;
  const user = req.user._id;
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify([String(user), Object.entries(filters).sort()]))
    .digest('hex').slice(0, 24);
  const id = new mongoose.Types.ObjectId(fingerprint);
  const existing = await SavedSearch.findOne({ _id: id, user }).select('label filters createdAt').lean();
  if (existing) return successResponse(res, 'Search already saved', { search: existing });
  if (await SavedSearch.countDocuments({ user }) >= 25) {
    return errorResponse(res, 'Remove an existing saved search before adding another.', 409);
  }
  const now = new Date();
  const search = await SavedSearch.findOneAndUpdate({ _id: id, user }, {
    $setOnInsert: { user, label, filters, checkedAt: now, nextCheckAt: now },
  }, { new: true, upsert: true, runValidators: true }).select('label filters createdAt').lean();
  successResponse(res, 'Search saved. New matches will appear in your notification inbox.', { search }, 201);
}));

router.delete('/:id([0-9a-fA-F]{24})', asyncHandler(async (req, res) => {
  await SavedSearch.deleteOne({ _id: req.params.id, user: req.user._id });
  successResponse(res, 'Saved search removed');
}));

module.exports = router;
