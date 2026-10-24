const assert = require('assert');
const express = require('express');
const v1Routes = require('../src/routes/v1/index');
const { exportQuerySchema } = require('../src/validators/adminExport.validator');
const { NOTIFICATION_TYPES } = require('../src/services/notification/notification.types');
const notificationTriggers = require('../src/services/notification/notification.trigger');
const User = require('../src/models/User.model');

async function main() {
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
