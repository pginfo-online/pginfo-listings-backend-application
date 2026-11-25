const { z } = require('zod');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid record ID');
const page = z.coerce.number().int().min(1).max(10000).default(1);
const limit = z.coerce.number().int().min(1).max(50).default(20);
const search = z.string().trim().max(150).optional();
const roles = ['admin', 'owner', 'tenant', 'staff', 'property_manager', 'pg_owner', 'meetup_organizer'];
const managedRole = z.enum(roles.slice(1));
const password = z.string().min(6).refine((value) => Buffer.byteLength(value) <= 72, 'Password must be at most 72 bytes');
const contact = {
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().regex(/^[6-9]\d{9}$/).or(z.literal('')),
};
const area = z.object({
  cityId: objectId,
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(300).optional(),
  isActive: z.boolean().optional(),
  order: z.number().int().min(0).optional(),
});

module.exports = {
  objectId,
  idParams: z.object({ id: objectId }),
  userQuery: z.object({ page, limit, search, role: z.enum(roles).optional(), isActive: z.enum(['true', 'false']).optional() }),
  createUser: z.object({ ...contact, phone: contact.phone.optional(), password, role: managedRole.default('owner') }),
  updateUser: z.object({ ...contact, role: managedRole, roles: z.array(managedRole).min(1).max(roles.length) }).partial()
    .refine(({ role, roles }) => !(role && roles), 'Provide either role or roles'),
  setRoles: z.object({ roles: z.array(managedRole).min(1).max(roles.length) }),
  roleParams: z.object({ id: objectId, role: managedRole }),
  resetPassword: z.object({ password }),
  accountStatus: z.object({ isActive: z.boolean().optional() }).default({}),
  areaQuery: z.object({ page, limit, search, cityId: objectId.optional(), isActive: z.enum(['true', 'false']).optional() }),
  createArea: area,
  updateArea: area.omit({ cityId: true }).partial(),
  auditQuery: z.object({ page, limit }),
  verification: z.object({ isVerified: z.boolean().optional() }).default({}),
  leadQuery: z.object({
    page, limit, propertyId: objectId.optional(), type: z.enum(['inquiry', 'wishlist']).optional(),
    isRead: z.enum(['true', 'false']).optional(),
  }),
  visitQuery: z.object({
    page, limit, propertyId: objectId.optional(), status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
  }),
  cityQuery: z.object({ page, limit, search, isActive: z.enum(['true', 'false']).optional() }),
  propertyQuery: z.object({
    page, limit, search,
    status: z.enum(['all', 'draft', 'pending', 'submitted', 'pending_review', 'approved', 'rejected', 'correction_required', 'suspended', 'archived']).optional(),
    category: z.enum(['all', 'pg', 'residential_rental', 'commercial']).optional(),
    purpose: z.enum(['all', 'rent', 'sale']).optional(),
    city: search, area: search, cityId: objectId.optional(), areaId: objectId.optional(),
    isVerified: z.enum(['true', 'false', 'all']).optional(),
    quality: z.enum(['all', 'low', 'good', 'high', '1', '2', '3', '4', '5']).optional(),
    sortBy: z.enum(['newest', 'oldest', 'price_asc', 'price_desc', 'quality_desc', 'views_desc']).optional(),
  }),
};
