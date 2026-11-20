const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
  renter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  listingTitle: { type: String, required: true },
  moveInDate: { type: String, required: true },
  message: { type: String, maxlength: 500, default: '' },
  bookingAmountPaise: { type: Number, min: 0, default: 0 },
  payment: {
    state: { type: String, enum: ['pending', 'paid', 'expired'] },
    expiresAt: Date,
    providerLinkId: String,
    providerPaymentId: String,
    paidAt: Date,
    settledAt: Date,
    settlementAmountPaise: Number,
    settledBy: mongoose.Schema.Types.ObjectId,
    settlementReference: { type: String, maxlength: 120 },
  },
  status: { type: String, enum: ['requested', 'accepted', 'declined', 'withdrawn'], default: 'requested' },
}, { timestamps: true });

bookingSchema.index({ renter: 1, createdAt: -1, _id: -1 });
bookingSchema.index({ owner: 1, createdAt: -1, _id: -1 });

bookingSchema.index({ 'payment.state': 1, 'payment.settledAt': 1, 'payment.paidAt': 1 });
bookingSchema.index({ 'payment.settlementReference': 1 }, {
  unique: true,
  partialFilterExpression: { 'payment.settlementReference': { $type: 'string' } },
});

module.exports = mongoose.model('RentalBooking', bookingSchema);
