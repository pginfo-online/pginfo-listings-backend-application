const asyncHandler = require('../utils/asyncHandler');
const { successResponse, errorResponse } = require('../utils/apiResponse');
const Property = require('../models/Property.model');
const RentalBooking = require('../models/RentalBooking.model');
const { paymentsEnabled, verifyWebhook, getOrCreatePaymentLink, applyPaymentEvent } = require('../services/rentalPayment.service');

const createCheckout = asyncHandler(async (req, res) => {
  if (!paymentsEnabled()) return errorResponse(res, 'Online booking payments are unavailable.', 503);
  const scope = { _id: req.params.id, renter: req.user._id, status: 'accepted', bookingAmountPaise: { $gte: 100 } };

  let booking = await RentalBooking.findOneAndUpdate({
    ...scope, 'payment.state': { $exists: false },
  }, { $set: {
    'payment.state': 'pending',
    'payment.expiresAt': new Date(Date.now() + 30 * 60000),
  } }, { new: true }).lean();
  if (!booking) booking = await RentalBooking.findOne(scope).lean();
  if (!booking || booking.payment?.state !== 'pending' || booking.payment.expiresAt <= new Date()) {
    return errorResponse(res, 'This request has no payable checkout available.', 409);
  }

  const active = await Property.exists({ _id: booking.property, owner: booking.owner, status: 'approved', purpose: 'rent' });
  if (!active) return errorResponse(res, 'This listing is no longer available for checkout.', 409);

  let link;
  try {
    link = await getOrCreatePaymentLink(booking);
  } catch (_) {
    return errorResponse(res, 'Could not prepare the checkout. Try again shortly.', 502);
  }
  if (link.status !== 'created') return errorResponse(res, 'This payment link is no longer open.', 409);
  await RentalBooking.updateOne({ ...scope, 'payment.state': 'pending' }, { $set: { 'payment.providerLinkId': link.id } });
  successResponse(res, 'Checkout ready', { url: link.short_url });
});

const razorpayWebhook = asyncHandler(async (req, res) => {
  if (!verifyWebhook(req.body, req.get('x-razorpay-signature'), process.env.RAZORPAY_WEBHOOK_SECRET)) {
    return errorResponse(res, 'Invalid webhook signature.', 401);
  }
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (_) {
    return errorResponse(res, 'Invalid webhook payload.', 400);
  }
  await applyPaymentEvent(event || {});
  res.sendStatus(200);
});

const recordSettlement = asyncHandler(async (req, res) => {
  const scope = { _id: req.params.id, 'payment.state': 'paid', bookingAmountPaise: req.body.amountPaise };
  const booking = await RentalBooking.findOneAndUpdate({
    ...scope, 'payment.settledAt': { $exists: false },
  }, { $set: {
    'payment.settledAt': new Date(),
    'payment.settlementAmountPaise': req.body.amountPaise,
    'payment.settledBy': req.user._id,
    'payment.settlementReference': req.body.reference,
  } }, { new: true }).lean();
  if (!booking) {
    const existing = await RentalBooking.findOne({ ...scope, 'payment.settlementReference': req.body.reference }).lean();
    if (!existing) return errorResponse(res, 'Payment missing, amount differs, or settlement already recorded.', 409);
    return successResponse(res, 'Settlement already recorded');
  }
  successResponse(res, 'External settlement recorded');
});

module.exports = { createCheckout, razorpayWebhook, recordSettlement };
