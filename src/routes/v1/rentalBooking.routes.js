const express = require('express');
const crypto = require('node:crypto');
const { Types } = require('mongoose');
const { z } = require('zod');
const RentalBooking = require('../../models/RentalBooking.model');
const Property = require('../../models/Property.model');
const { protect, authorize } = require('../../middlewares/auth.middleware');
const validate = require('../../middlewares/validate.middleware');
const asyncHandler = require('../../utils/asyncHandler');
const { successResponse, errorResponse } = require('../../utils/apiResponse');

const { createCheckout, recordSettlement } = require('../../controllers/rentalPayment.controller');
const { paymentsEnabled } = require('../../services/rentalPayment.service');
const router = express.Router();
const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const requestBooking = z.object({
  propertyId: objectId,
  moveInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value &&
      value >= dateFormat.format(new Date());
  }, 'Choose a valid move-in date today or later in IST.'),
  message: z.string().trim().max(500).optional(),
});
const pagination = z.object({
  before: z.string().datetime().optional(),
  id: objectId.optional(),
}).refine(({ before, id }) => Boolean(before) === Boolean(id));

router.use(protect);

router.post('/', validate(requestBooking), asyncHandler(async (req, res) => {
  const { propertyId, moveInDate, message } = req.body;
  const renter = req.user._id;
  const property = await Property.findOne({ _id: propertyId, status: 'approved', purpose: 'rent' })
    .select('owner title name pricing.bookingAmount pricing.expectedPrice').lean();
  if (!property?.owner) return errorResponse(res, 'This listing is unavailable for rental requests.', 404);
  if (String(property.owner) === String(renter)) return errorResponse(res, 'You cannot request your own listing.', 400);

  const id = new Types.ObjectId(crypto.createHash('sha256')
    .update(JSON.stringify([String(renter), String(property._id), moveInDate]))
    .digest('hex').slice(0, 24));
  const requestedAmount = property.pricing?.bookingAmount ?? 0;
  const paise = Math.round(requestedAmount * 100);
  const bookingAmountPaise = (paise === 0 || paise >= 100) && Number.isSafeInteger(paise) &&
    requestedAmount <= property.pricing?.expectedPrice ? paise : 0;
  const booking = await RentalBooking.findOneAndUpdate({ _id: id, renter }, {
    $setOnInsert: {
      renter, owner: property.owner, property: property._id,
      bookingAmountPaise,
      listingTitle: property.title || property.name || 'Rental property', moveInDate, message,
    },
  }, { upsert: true, new: true, runValidators: true }).lean();
  if (booking.status === 'declined' || booking.status === 'withdrawn') {
    return errorResponse(res, 'A previous request for this date is closed. Choose another date.', 409);
  }
  successResponse(res, 'Rental request submitted', { booking }, 201);
}));

const list = (role) => asyncHandler(async (req, res) => {
  const query = { [role]: req.user._id };
  if (req.query.before && req.query.id) {
    const timestamp = new Date(req.query.before);
    query.$or = [{ createdAt: { $lt: timestamp } }, { createdAt: timestamp, _id: { $lt: req.query.id } }];
  }
  const bookings = await RentalBooking.find(query).sort({ createdAt: -1, _id: -1 }).select('-payment.providerLinkId -payment.providerPaymentId -payment.settledBy -payment.settlementReference').limit(21).lean();
  const page = bookings.slice(0, 20);
  const last = page[page.length - 1];
  const next = bookings.length > 20 ? { before: last.createdAt.toISOString(), id: String(last._id) } : null;
  successResponse(res, 'Rental requests retrieved', { bookings: page, next, paymentsEnabled: paymentsEnabled() });
});

router.get('/mine', validate(pagination, 'query'), list('renter'));
router.get('/incoming', authorize('owner', 'pg_owner', 'admin'), validate(pagination, 'query'), list('owner'));

function transition(role, statuses) {
  return [
    validate(z.object({ status: z.enum(statuses) })),
    asyncHandler(async (req, res) => {
      const scope = { _id: req.params.id, [role]: req.user._id };
      const { status } = req.body;
      const from = status === 'withdrawn' ? ['requested', 'accepted', status] : ['requested', status];
      const paymentScope = status === 'withdrawn' ? { 'payment.state': { $nin: ['pending', 'paid'] } } : {};
      const booking = await RentalBooking.findOneAndUpdate({ ...scope, ...paymentScope, status: { $in: from } }, {
        $set: { status },
      }, { new: true, runValidators: true }).lean();
      if (!booking) {
        const exists = await RentalBooking.exists(scope);
        return errorResponse(res, exists ? 'This request can no longer change status.' : 'Rental request not found.', exists ? 409 : 404);
      }
      successResponse(res, 'Rental request updated', { booking });
    }),
  ];
}

router.patch('/mine/:id([a-fA-F0-9]{24})', ...transition('renter', ['withdrawn']));
router.patch('/incoming/:id([a-fA-F0-9]{24})', authorize('owner', 'pg_owner', 'admin'), ...transition('owner', ['accepted', 'declined']));

router.post('/mine/:id([a-fA-F0-9]{24})/checkout', createCheckout);
router.get('/admin/unsettled', authorize('admin'), asyncHandler(async (_req, res) => {
  const bookings = await RentalBooking.find({
    'payment.state': 'paid', 'payment.settledAt': { $exists: false },
  }).select('owner property listingTitle bookingAmountPaise payment.paidAt payment.providerPaymentId')
    .sort({ 'payment.paidAt': 1 }).limit(100).lean();
  successResponse(res, 'Unsettled booking payments retrieved', { bookings });
}));
router.post('/admin/:id([a-fA-F0-9]{24})/settlement', authorize('admin'),
  validate(z.object({
    reference: z.string().trim().toUpperCase().min(3).max(120),
    amountPaise: z.number().int().min(100).max(Number.MAX_SAFE_INTEGER),
  })), recordSettlement);

module.exports = router;
