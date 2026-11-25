const assert = require('node:assert/strict');
const test = require('node:test');
const User = require('../src/models/User.model');
const { updatePropertySchema, createPropertySchema } = require('../src/validators/property.validator');
const { updateVersionSchema } = require('../src/validators/appVersion.validator');
const admin = require('../src/validators/admin.validator');
const notification = require('../src/validators/adminNotification.validator');

test('partial writes preserve omitted property and app-version fields', () => {
  assert.deepEqual(updateVersionSchema.parse({ title: 'Maintenance update' }), { title: 'Maintenance update' });
  assert.deepEqual(updatePropertySchema.parse({ pricing: { expectedPrice: 9200 } }), { pricing: { expectedPrice: 9200 } });
  assert.deepEqual(updatePropertySchema.parse({ pgDetails: { gender: 'any' } }), { pgDetails: { gender: 'any' } });
});

test('a minimal PG write remains valid on Zod 4', () => {
  const parsed = createPropertySchema.parse({
    title: 'Example listing', city: 'Pune', area: 'Baner', address: 'A test road', category: 'pg',
    contactPhone: '9876543210', pricing: { expectedPrice: 8500 }, pgDetails: { roomConfigs: [{ shareType: 'single' }] },
  });
  assert.equal(parsed.pgDetails.roomConfigs.length, 1);
  assert.equal(parsed.purpose, 'rent');
});

test('the directory supports all managed roles without accepting privilege escalation', () => {
  assert.equal(admin.setRoles.safeParse({ roles: ['admin'] }).success, false);
  assert.equal(admin.createUser.safeParse({ name: 'New account', email: 'user@example.test', password: 'temporary', role: 'admin' }).success, false);
  for (const role of ['owner', 'staff', 'property_manager', 'pg_owner', 'meetup_organizer', 'tenant']) {
    const user = new User({ name: 'New account', email: 'user@example.test', role, roles: [role] });
    assert.equal(user.validateSync(), undefined);
    assert.equal(User.primaryRole(user.roles), role);
  }
});

test('targeted notifications require a bounded explicit audience', () => {
  assert.equal(notification.audience.safeParse({ audience: { type: 'city', targetCity: ' ' } }).success, false);
  assert.equal(notification.audience.safeParse({ audience: { type: 'specific', targetUserIds: [] } }).success, false);
  assert.deepEqual(notification.audience.parse({ audience: { type: 'city', targetCity: ' Pune ' } }).audience, { type: 'city', targetCity: 'Pune' });
});
