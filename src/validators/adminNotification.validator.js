const { z } = require('zod');
const { objectId } = require('./admin.validator');
const { NOTIFICATION_TYPES } = require('../services/notification/notification.types');

const type = z.enum(Object.values(NOTIFICATION_TYPES));
const url = z.string().url().max(2000).refine((value) => /^https:\/\//i.test(value), 'Use an HTTPS image URL').nullable().or(z.literal(''));
const audience = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('role'), targetRoles: z.array(z.enum(['admin', 'owner', 'tenant'])).min(1).max(3) }),
  z.object({ type: z.literal('specific'), targetUserIds: z.array(objectId).min(1).max(500) }),
  z.object({ type: z.literal('city'), targetCity: z.string().trim().min(1).max(100) }),
]);
const campaign = z.object({
  type, audience,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(1000),
  imageUrl: url.optional(),
  data: z.object({
    deepLink: z.string().max(2000).nullable().optional(),
    entityType: z.string().max(100).nullable().optional(),
    entityId: z.string().max(150).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  isTransactional: z.boolean().optional(),
  template: objectId.nullable().optional(),
});
const checkSchedule = (value, context) => {
  if (value.scheduledAt && Date.parse(value.scheduledAt) <= Date.now()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduledAt'], message: 'Schedule delivery in the future.' });
  }
  if (value.scheduledAt && (process.env.ENABLE_NOTIFICATION_SCHEDULER !== 'true' || process.env.ENABLE_SCHEDULERS === 'false')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduledAt'], message: 'Scheduled delivery is disabled on the API.' });
  }
};
const template = z.object({
  name: z.string().trim().min(1).max(100),
  type: type.optional(),
  titleTemplate: z.string().trim().min(1).max(200),
  bodyTemplate: z.string().trim().min(1).max(1000),
  imageUrl: url.optional(),
  defaultData: z.record(z.string(), z.unknown()).optional(),
});
module.exports = {
  audience: z.object({ audience }),
  create: campaign.extend({ sendNow: z.boolean().optional() }).superRefine(checkSchedule),
  update: campaign.partial().superRefine(checkSchedule),
  createTemplate: template,
  updateTemplate: template.extend({ isActive: z.boolean().optional() }).partial(),
  list: z.object({
    page: z.coerce.number().int().min(1).max(10000).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled']).optional(),
    type: type.optional(),
    search: z.string().trim().max(150).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }).refine(({ from, to }) => !from || !to || from <= to, { message: 'Choose an end date at or after the start date.', path: ['to'] }),
};
