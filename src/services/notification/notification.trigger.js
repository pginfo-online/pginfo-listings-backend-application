/**
 * Event-driven notification triggers for PG listings, visits, meetups, and accounts.
 * Each function is fire-and-forget and logs failures without affecting its caller.
 */

const { createAndSend } = require('./notification.service');
const { NOTIFICATION_TYPES, buildPayload } = require('./notification.types');
const { logger } = require('../../utils/logger');

function safeTrigger(name, fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      logger.error(`[NotificationTrigger] ${name} failed: ${err.message}`);
    }
  };
}

const onPGApproved = safeTrigger('onPGApproved', async (pg) => {
  if (!pg?.owner) return;

  const payload = buildPayload(NOTIFICATION_TYPES.PG_APPROVED, {
    pgName: pg.name,
    city: pg.city,
    area: pg.area,
  });

  await createAndSend({
    type: NOTIFICATION_TYPES.PG_APPROVED,
    title: payload.title,
    body: payload.body,
    data: {
      deepLink: `pginfo://pg/${pg._id}`,
      entityType: 'PG',
      entityId: pg._id.toString(),
    },
    audience: { type: 'specific', targetUserIds: [pg.owner._id || pg.owner] },
    isTransactional: true,
  });
});

const onPGRejected = safeTrigger('onPGRejected', async (pg, reason) => {
  if (!pg?.owner) return;

  const payload = buildPayload(NOTIFICATION_TYPES.PG_REJECTED, {
    pgName: pg.name,
    reason: reason || 'Does not meet listing requirements',
  });

  await createAndSend({
    type: NOTIFICATION_TYPES.PG_REJECTED,
    title: payload.title,
    body: payload.body,
    data: {
      deepLink: `pginfo://pg/${pg._id}`,
      entityType: 'PG',
      entityId: pg._id.toString(),
    },
    audience: { type: 'specific', targetUserIds: [pg.owner._id || pg.owner] },
    isTransactional: true,
  });
});

const onPGLive = safeTrigger('onPGLive', async (pg) => {
  if (!pg?.city) return;

  const payload = buildPayload(NOTIFICATION_TYPES.PG_LIVE, {
    pgName: pg.name,
    city: pg.city,
    area: pg.area,
  });

  await createAndSend({
    type: NOTIFICATION_TYPES.PG_LIVE,
    title: payload.title,
    body: payload.body,
    imageUrl: pg.photos?.[0]?.url || null,
    data: {
      deepLink: `pginfo://pg/${pg._id}`,
      entityType: 'PG',
      entityId: pg._id.toString(),
    },
    audience: { type: 'role', targetRoles: ['tenant'] },
    isTransactional: false,
  });
});

const onVisitBooked = safeTrigger('onVisitBooked', async (visit, pg) => {
  if (!pg?.owner) return;

  const payload = buildPayload(NOTIFICATION_TYPES.VISIT_BOOKED, {
    name: visit.name || 'A user',
    pgName: pg.name,
    visitDate: visit.preferredDate
      ? new Date(visit.preferredDate).toLocaleDateString('en-IN')
      : 'Soon',
  });

  await createAndSend({
    type: NOTIFICATION_TYPES.VISIT_BOOKED,
    title: payload.title,
    body: payload.body,
    data: {
      deepLink: 'pginfo://visits',
      entityType: 'VisitRequest',
      entityId: visit._id.toString(),
    },
    audience: { type: 'specific', targetUserIds: [pg.owner] },
    isTransactional: false,
  });
});

const onMeetupCreated = safeTrigger('onMeetupCreated', async (meetup) => {
  const payload = buildPayload(NOTIFICATION_TYPES.MEETUP_CREATED, {
    meetupTitle: meetup.title,
    city: meetup.city || '',
    date: meetup.date ? new Date(meetup.date).toLocaleDateString('en-IN') : '',
    venue: meetup.location || meetup.venue || '',
  });

  await createAndSend({
    type: NOTIFICATION_TYPES.MEETUP_CREATED,
    title: payload.title,
    body: payload.body,
    data: {
      deepLink: `pginfo://meetup/${meetup._id}`,
      entityType: 'Meetup',
      entityId: meetup._id.toString(),
    },
    audience: { type: 'all' },
    isTransactional: false,
  });
});

const onWelcome = safeTrigger('onWelcome', async (user) => {
  if (!user?._id) return;

  const payload = buildPayload(NOTIFICATION_TYPES.ACCOUNT_WELCOME, {
    name: user.name?.split(' ')[0] || 'there',
  });

  await createAndSend({
    type: NOTIFICATION_TYPES.ACCOUNT_WELCOME,
    title: payload.title,
    body: payload.body,
    data: { deepLink: 'pginfo://home', entityType: null, entityId: null },
    audience: { type: 'specific', targetUserIds: [user._id] },
    isTransactional: true,
  });
});

const onRoleUpgraded = safeTrigger('onRoleUpgraded', async (user) => {
  if (!user?._id) return;

  const payload = buildPayload(NOTIFICATION_TYPES.ROLE_UPGRADED, {});

  await createAndSend({
    type: NOTIFICATION_TYPES.ROLE_UPGRADED,
    title: payload.title,
    body: payload.body,
    data: { deepLink: 'pginfo://home', entityType: null, entityId: null },
    audience: { type: 'specific', targetUserIds: [user._id] },
    isTransactional: true,
  });
});

module.exports = {
  onPGApproved,
  onPGRejected,
  onPGLive,
  onVisitBooked,
  onMeetupCreated,
  onWelcome,
  onRoleUpgraded,
};
