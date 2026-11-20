const axios = require('axios');
const crypto = require('node:crypto');
const RentalBooking = require('../models/RentalBooking.model');

const paymentsEnabled = () => process.env.ENABLE_RENTAL_PAYMENTS === 'true' &&
  Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET);

const referenceFor = (booking) => `pginfo_${booking._id}`;

function verifyWebhook(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || !secret || !/^[0-9a-f]{64}$/i.test(signature || '')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

function createRazorpayClient() {
  return axios.create({
    baseURL: 'https://api.razorpay.com/v1',
    auth: { username: process.env.RAZORPAY_KEY_ID, password: process.env.RAZORPAY_KEY_SECRET },
    timeout: 5000,
    maxRedirects: 0,
  });
}

function checkCheckoutLink(link, booking) {
  return link.reference_id === referenceFor(booking) &&
    /^plink_[a-zA-Z0-9]+$/.test(link.id) &&
    link.amount === booking.bookingAmountPaise &&
    link.currency === 'INR' &&
    /^https:\/\/rzp\.io\//.test(link.short_url);
}

async function getOrCreatePaymentLink(booking, client = createRazorpayClient()) {
  const reference_id = referenceFor(booking);
  const findExisting = async () => {
    const { data } = await client.get('/payment_links', { params: { reference_id } });
    return data.payment_links?.find((link) => link.reference_id === reference_id);
  };

  let link = await findExisting();
  if (!link) {
    try {
      const response = await client.post('/payment_links', {
        amount: booking.bookingAmountPaise,
        currency: 'INR',
        accept_partial: false,
        reference_id,
        expire_by: Math.floor(booking.payment.expiresAt.getTime() / 1000),
        description: 'PGInfo rental booking amount',
        notify: { sms: false, email: false },
        reminder_enable: false,
      });
      link = response.data;
    } catch (error) {
      link = await findExisting();
      if (!link) throw error;
    }
  }
  if (!checkCheckoutLink(link, booking)) throw new Error('Razorpay returned a mismatched payment link.');
  return link;
}

async function applyPaymentEvent(event) {
  const link = event.payload?.payment_link?.entity;
  const match = /^pginfo_([0-9a-f]{24})$/.exec(link?.reference_id || '');
  if (!match || !/^plink_[a-zA-Z0-9]+$/.test(link.id) || link.currency !== 'INR') return;

  const base = {
    _id: match[1], status: 'accepted', bookingAmountPaise: link.amount,
    'payment.state': 'pending',
    $or: [{ 'payment.providerLinkId': link.id }, { 'payment.providerLinkId': { $exists: false } }],
  };
  if (event.event === 'payment_link.paid') {
    const payment = event.payload?.payment?.entity;
    if (link.status !== 'paid' || link.amount_paid !== link.amount || !Number.isSafeInteger(link.amount) ||
      link.amount <= 0 || payment?.status !== 'captured' || payment?.currency !== 'INR' ||
      payment?.amount !== link.amount || !/^pay_[a-zA-Z0-9]+$/.test(payment.id)) return;
    await RentalBooking.updateOne(base, { $set: {
      'payment.state': 'paid', 'payment.providerLinkId': link.id,
      'payment.providerPaymentId': payment.id, 'payment.paidAt': new Date(),
    } });
  } else if (event.event === 'payment_link.expired' && link.status === 'expired' && link.amount_paid === 0) {
    await RentalBooking.updateOne(base, { $set: {
      'payment.state': 'expired', 'payment.providerLinkId': link.id,
    } });
  }
}

module.exports = { paymentsEnabled, verifyWebhook, getOrCreatePaymentLink, applyPaymentEvent };
