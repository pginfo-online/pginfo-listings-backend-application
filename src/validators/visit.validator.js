const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Enter a valid property ID');

function getVisitTimestamp(date, time) {
  const match = /^(1[0-2]|[1-9]):([0-5]\d) (AM|PM)$/.exec(time);
  if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const calendarDate = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== date) return NaN;
  const hour = Number(match[1]) % 12 + (match[3] === 'PM' ? 12 : 0);
  return Date.parse(`${date}T${String(hour).padStart(2, '0')}:${match[2]}:00+05:30`);
}

const createVisitSchema = z.object({
  propertyId: objectId.optional(),
  pgId: objectId.optional(),
  scheduledDate: z.string(),
  scheduledTime: z.string().trim().toUpperCase(),
  message: z.string().trim().max(500).optional(),
}).superRefine(({ propertyId, pgId, scheduledDate, scheduledTime }, ctx) => {
  if ((!propertyId && !pgId) || (propertyId && pgId && propertyId !== pgId)) {
    ctx.addIssue({ code: 'custom', path: ['propertyId'], message: 'Choose a property for the visit.' });
  }
  const timestamp = getVisitTimestamp(scheduledDate, scheduledTime);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    ctx.addIssue({ code: 'custom', path: ['scheduledDate'], message: 'Choose a future visit date and time in IST.' });
  }
});

const updateVisitStatusSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'completed']),
  ownerNote: z.string().trim().max(500).optional(),
});

module.exports = { createVisitSchema, updateVisitStatusSchema };
