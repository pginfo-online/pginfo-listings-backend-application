const assert = require('assert');
const express = require('express');
const v1Routes = require('../src/routes/v1/index');
const { exportQuerySchema } = require('../src/validators/adminExport.validator');
const { NOTIFICATION_TYPES } = require('../src/services/notification/notification.types');
const notificationTriggers = require('../src/services/notification/notification.trigger');
const User = require('../src/models/User.model');
const { buildPropertySearchQuery } = require('../src/services/propertySearch.service');
const { Types } = require('mongoose');
const Property = require('../src/models/Property.model');
const PropertyUpdateRequest = require('../src/models/PropertyUpdateRequest.model');
const { updateProperty, getOwnerListingAnalytics } = require('../src/services/property.service');
const { updatePropertySchema, createPropertySchema } = require('../src/validators/property.validator');

async function testRentalListings() {
  const owner = new Types.ObjectId();
  const id = new Types.ObjectId();
  const payload = {
    title: 'Oakwood apartment', city: 'Pune', area: 'Kharadi', address: '12 Oakwood Lane',
    pricing: { expectedPrice: 25000 }, contactPhone: '9000000000',
  };
  assert(createPropertySchema.safeParse({
    ...payload, category: 'residential_rental',
    residentialDetails: { bhk: '2BHK', bedrooms: 2, bathrooms: 2, carpetAreaSqFt: 800 },
  }).success);
  assert(createPropertySchema.safeParse({
    ...payload, category: 'commercial',
    commercialDetails: { commercialSubtype: 'office_space', carpetAreaSqFt: 800 },
  }).success);

  const original = {
    findOne: Property.findOne,
    update: Property.findByIdAndUpdate,
    aggregate: Property.aggregate,
    cancel: PropertyUpdateRequest.updateMany,
    save: PropertyUpdateRequest.prototype.save,
  };
  let status = 'submitted';
  const stored = {
    _id: id, owner, category: 'commercial', purpose: 'rent',
    pricing: { expectedPrice: 25000, maintenanceCharges: 1500 },
    commercialDetails: { commercialSubtype: 'office_space', carpetAreaSqFt: 800 },
    toObject() { return { ...this, status }; },
  };
  try {
    Property.findOne = async (filter) => {
      assert.deepStrictEqual(filter, { _id: id, owner });
      return { ...stored, status };
    };
    Property.findByIdAndUpdate = async (_id, update) => update.$set;
    Property.aggregate = async ([scope]) => {
      assert.deepStrictEqual(scope, { $match: { owner } });
      return [];
    };
    PropertyUpdateRequest.updateMany = async (scope) => {
      assert.deepStrictEqual(scope.property, id);
    };
    PropertyUpdateRequest.prototype.save = async function () {
      assert.strictEqual(this.proposedChanges.status, undefined);
      assert.strictEqual(this.proposedChanges.pricing.maintenanceCharges, 1500);
      return this;
    };
    const patch = updatePropertySchema.parse({
      pricing: { expectedPrice: 30000 },
      commercialDetails: { fitoutStatus: 'warm_shell' },
      owner: new Types.ObjectId(), status: 'approved', isVerified: true,
    });
    const result = await updateProperty(id, owner, structuredClone(patch));
    assert.strictEqual(result.requestCreated, false);
    assert.strictEqual(result.property.status, undefined);
    assert.strictEqual(result.property.owner, undefined);
    assert.strictEqual(result.property.pricing.maintenanceCharges, 1500);
    assert.strictEqual(result.property.commercialDetails.carpetAreaSqFt, 800);
    status = 'approved';
    assert.strictEqual((await updateProperty(id, owner, structuredClone(patch))).requestCreated, true);
    await getOwnerListingAnalytics(owner);
  } finally {
    Property.findOne = original.findOne;
    Property.findByIdAndUpdate = original.update;
    Property.aggregate = original.aggregate;
    PropertyUpdateRequest.updateMany = original.cancel;
    PropertyUpdateRequest.prototype.save = original.save;
  }
}


async function testPaymentsAndVisitInput() {
  const { createHmac } = require('node:crypto');
  const { verifyWebhook, getOrCreatePaymentLink, applyPaymentEvent } = require('../src/services/rentalPayment.service');
  const Booking = require('../src/models/RentalBooking.model');
  const { createVisitSchema } = require('../src/validators/visit.validator');
  const id = String(new Types.ObjectId());
  const link = {
    id: 'plink_fixture', reference_id: 'pginfo_' + id, amount: 40000, currency: 'INR',
    short_url: 'https://rzp.io/i/test', status: 'created',
  };
  const booking = { _id: id, bookingAmountPaise: link.amount, payment: { expiresAt: new Date(Date.now() + 60000) } };
  let providerReads = 0;
  const recovered = await getOrCreatePaymentLink(booking, {
    async get(_route, { params }) {
      assert.strictEqual(params.reference_id, link.reference_id);
      providerReads += 1;
      return { data: { payment_links: providerReads === 1 ? [] : [link] } };
    },
    async post(_route, payload) {
      assert.strictEqual(payload.accept_partial, false);
      assert.strictEqual(payload.amount, link.amount);
      throw new Error('Provider response lost');
    },
  });
  assert.strictEqual(recovered.id, link.id);

  const event = {
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { ...link, status: 'paid', amount_paid: link.amount } },
      payment: { entity: { id: 'pay_fixture', status: 'captured', currency: 'INR', amount: link.amount } },
    },
  };
  const raw = Buffer.from(JSON.stringify(event));
  const secret = 'local-fixture-signing-secret';
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  assert(verifyWebhook(raw, signature, secret));
  assert(!verifyWebhook(Buffer.concat([raw, Buffer.from(' ')]), signature, secret));

  const originalUpdate = Booking.updateOne;
  let writes = 0;
  try {
    Booking.updateOne = async (query, change) => {
      writes += 1;
      assert.strictEqual(query._id, id);
      assert.strictEqual(query.bookingAmountPaise, link.amount);
      assert.strictEqual(query['payment.state'], 'pending');
      assert.strictEqual(change.$set['payment.state'], 'paid');
    };
    await applyPaymentEvent(event);
    await applyPaymentEvent({ ...event, payload: {
      ...event.payload,
      payment: { entity: { ...event.payload.payment.entity, amount: 1 } },
    } });
    assert.strictEqual(writes, 1);
  } finally {
    Booking.updateOne = originalUpdate;
  }

  const visit = { propertyId: id, scheduledDate: '2099-02-28', scheduledTime: '6:30 PM' };
  assert(createVisitSchema.safeParse(visit).success);
  assert(!createVisitSchema.safeParse({ ...visit, scheduledDate: '2099-02-29' }).success);
  assert(!createVisitSchema.safeParse({ ...visit, scheduledDate: '2020-01-01' }).success);
  assert(!createVisitSchema.safeParse({ ...visit, scheduledTime: '13:30 PM' }).success);
}

async function testSavedSearchWorker() {
  const SavedSearch = require('../src/models/SavedSearch.model');
  const Inbox = require('../src/models/NotificationInbox.model');
  const { processSavedSearchAlerts } = require('../src/services/notification/savedSearch.scheduler');
  const search = {
    _id: new Types.ObjectId(), user: new Types.ObjectId(), label: 'Pune PGs',
    checkedAt: new Date('2020-01-01T00:00:00Z'),
    filters: { city: 'Pune', category: 'pg' },
  };
  const patches = [
    [SavedSearch, 'findOneAndUpdate'],
    [SavedSearch, 'updateOne'],
    [Property, 'find'],
    [User, 'exists'],
    [Inbox, 'updateOne'],
  ].map(([model, name]) => [model, name, model[name]]);
  const delivered = new Set();
  let claims = 0;
  try {
    SavedSearch.findOneAndUpdate = () => ({ lean: async () => claims++ % 2 === 0 ? search : null });
    User.exists = async ({ _id }) => String(_id) === String(search.user);
    Property.find = (query) => {
      assert.strictEqual(query.status, 'approved');
      assert.strictEqual(query.category, 'pg');
      assert.strictEqual(query.statusHistory.$elemMatch.changedAt.$gt, search.checkedAt);
      assert.strictEqual(String(query.owner.$ne), String(search.user));
      return { select: () => ({ limit: () => ({ maxTimeMS: () => ({ lean: async () => [{ _id: search._id }] }) }) }) };
    };
    Inbox.updateOne = async (query, change, options) => {
      assert.strictEqual(change.$setOnInsert.type, 'SAVED_SEARCH_MATCH');
      assert.strictEqual(options.upsert, true);
      delivered.add(String(query._id));
    };
    SavedSearch.updateOne = async (_query, change) => {
      assert(change.$set.nextCheckAt > change.$set.checkedAt);
    };
    await processSavedSearchAlerts();
    await processSavedSearchAlerts();
    assert.strictEqual(delivered.size, 1);
  } finally {
    patches.forEach(([model, name, original]) => { model[name] = original; });
  }
}

async function main() {
  await testRentalListings();
  await testPaymentsAndVisitInput();
  await testSavedSearchWorker();
  for (const status of ['draft', 'rejected', 'suspended', 'all']) {
    assert.strictEqual(buildPropertySearchQuery({ status }).status, 'approved');
  }

  const unprivileged = new User({ name: 'Account', email: 'admin@pginfo.online' });
  await unprivileged.validate();
  assert.strictEqual(unprivileged.hasRole('admin'), false);

  const legacyHotelOwner = new User({
    name: 'Legacy hotel owner',
    email: 'legacy-hotel-owner@example.com',
    role: 'hotel_owner',
    roles: ['hotel_owner'],
    isHotelOwner: true,
  });
  await legacyHotelOwner.validate();
  assert.deepStrictEqual(legacyHotelOwner.roles, ['tenant']);
  assert.strictEqual(legacyHotelOwner.role, 'tenant');

  const legacyDealPartner = new User({
    name: 'Legacy deal partner',
    email: 'legacy-deal-partner@example.com',
    roles: ['hot_deals_partner'],
  });
  await legacyDealPartner.validate();
  assert.deepStrictEqual(legacyDealPartner.roles, ['tenant']);

  const app = express();
  app.use('/api/v1', v1Routes);
  app.use((req, res) => res.status(404).json({ success: false }));

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
    for (const endpoint of ['/saved-searches', '/rental-bookings/mine', '/rental-bookings/admin/unsettled']) {
      assert.strictEqual((await fetch(baseUrl + endpoint)).status, 401);
    }
    const response = await fetch(`${baseUrl}/manage/jobs/public`);
    assert.strictEqual(response.status, 404);
    const buffetResponse = await fetch(`${baseUrl}/buffet/discover`);
    assert.strictEqual(buffetResponse.status, 404);
    const chatbotResponse = await fetch(`${baseUrl}/pg/chat/active`);
    assert.strictEqual(chatbotResponse.status, 404);
    const aiSearchResponse = await fetch(`${baseUrl}/pg/ai-search`);
    assert.strictEqual(aiSearchResponse.status, 404);
    const hotDealsResponse = await fetch(`${baseUrl}/hot-deals/discover`);
    assert.strictEqual(hotDealsResponse.status, 404);
    const hotDealCategoriesResponse = await fetch(`${baseUrl}/hot-deal-categories`);
    assert.strictEqual(hotDealCategoriesResponse.status, 404);

    const apiInfoResponse = await fetch(`${baseUrl}/`);
    const apiInfo = await apiInfoResponse.json();
    assert.strictEqual(apiInfo.success, true);
    assert(!apiInfo.endpoints.includes('/manage'));
    assert(!apiInfo.endpoints.includes('/buffet'));
    assert(!apiInfo.endpoints.includes('/hot-deals'));
    assert(!apiInfo.endpoints.includes('/hot-deal-categories'));
    assert.throws(() => exportQuerySchema.parse({ dataset: 'rent' }));
    assert.strictEqual(exportQuerySchema.parse({ dataset: 'pgs' }).dataset, 'pgs');
    assert(!('JOB_POSTED' in NOTIFICATION_TYPES));
    assert('PG_APPROVED' in NOTIFICATION_TYPES);
    assert('MEETUP_CREATED' in NOTIFICATION_TYPES);
    assert(!('BUFFET_LIVE' in NOTIFICATION_TYPES));
    assert(!('hot_deals_partner' in User.schema.path('roles').caster.enumValues));
    assert.strictEqual(typeof notificationTriggers.onPGApproved, 'function');
    assert.strictEqual(typeof notificationTriggers.onVisitBooked, 'function');

    console.log('Buffet/hotel, chatbot/LLM, hot-deal, and management features are removed.');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
