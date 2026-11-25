const User = require('../models/User.model');
const City = require('../models/City.model');
const Area = require('../models/Area.model');
const Property = require('../models/Property.model');
const PropertyAudit = require('../modules/properties/models/PropertyAudit.model');
const asyncHandler = require('../utils/asyncHandler');
const { successResponse, errorResponse, paginatedResponse } = require('../utils/apiResponse');
const tokenService = require('../modules/auth/services/token.service');
const redis = require('../services/redisCache.service');
const { invalidateAreaCache } = require('./area.controller');

const literal = (value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const userFields = 'name email phone roles role isActive createdAt updatedAt lastLogin';
const safeUser = (user) => ({
  _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role,
  roles: user.roles, isActive: user.isActive, createdAt: user.createdAt, updatedAt: user.updatedAt, lastLogin: user.lastLogin,
});
const account = (handler, { write = true } = {}) => asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select(userFields);
  if (!user) return errorResponse(res, 'User not found', 404);
  if (write && user.hasRole('admin')) return errorResponse(res, 'Administrator accounts are managed through the deployment process.', 403);
  return handler(req, res, user);
});
const applyRoles = (user, roles) => {
  user.roles = [...new Set(roles.length ? roles : ['tenant'])];
  user.role = User.primaryRole(user.roles);
};
const updateResponse = async (res, user, message = 'User updated') => {
  await user.save();
  return successResponse(res, message, { user: safeUser(user) });
};

exports.session = (req, res) => successResponse(res, 'Admin session verified', {
  user: { _id: req.user._id, name: req.user.name, email: req.user.email },
});

exports.users = asyncHandler(async (req, res) => {
  const { page, limit, search, role, isActive } = req.query;
  const query = role
    ? { $or: [{ roles: role }, { role }] }
    : { roles: { $ne: 'admin' }, role: { $ne: 'admin' } };
  if (isActive) query.isActive = isActive === 'true';
  if (search) query.$and = [{ $or: ['name', 'email', 'phone'].map((field) => ({ [field]: literal(search) })) }];
  const [users, total] = await Promise.all([
    User.find(query).select(userFields).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    User.countDocuments(query),
  ]);
  return successResponse(res, 'Users retrieved', { users: users.map(safeUser), total, page, totalPages: Math.ceil(total / limit) });
});

exports.user = account((req, res, user) => successResponse(res, 'User retrieved', { user: safeUser(user) }), { write: false });
exports.createUser = asyncHandler(async (req, res) => {
  const { role, phone, ...values } = req.body;
  const user = new User({ ...values, phone: phone || undefined });
  applyRoles(user, [role]);
  await user.save();
  return successResponse(res, 'User created', { user: safeUser(user) }, 201);
});
exports.updateUser = account(async (req, res, user) => {
  const { name, email, phone, role, roles } = req.body;
  if (name !== undefined) user.name = name;
  if (email !== undefined && email !== user.email) {
    user.email = email;
    user.emailVerified = false;
  }
  if (phone !== undefined && phone !== user.phone) {
    user.phone = phone || undefined;
    user.phoneVerified = false;
  }
  if (roles || role) applyRoles(user, roles || [...user.roles, role]);
  return updateResponse(res, user);
});
exports.setRoles = account((req, res, user) => {
  applyRoles(user, req.body.roles);
  return updateResponse(res, user);
});
exports.addRole = account((req, res, user) => {
  applyRoles(user, [...user.roles, req.params.role]);
  return updateResponse(res, user);
});
exports.removeRole = account((req, res, user) => {
  applyRoles(user, user.roles.filter((role) => role !== req.params.role));
  return updateResponse(res, user);
});
exports.status = account(async (req, res, user) => {
  user.isActive = req.body.isActive ?? !user.isActive;
  if (!user.isActive) user.authTokensInvalidBefore = new Date();
  await user.save();
  if (!user.isActive) await tokenService.revokeAllUserSessions(String(user._id));
  return successResponse(res, user.isActive ? 'User activated' : 'User suspended', { user: safeUser(user) });
});
exports.resetPassword = account(async (req, res, user) => {
  user.password = req.body.password;
  user.authTokensInvalidBefore = new Date();
  await user.save();
  await tokenService.revokeAllUserSessions(String(user._id));
  return successResponse(res, 'Password reset', { user: safeUser(user) });
});
exports.deleteUser = account(async (req, res, user) => {
  const Meetup = require('../models/Meetup.model');
  const refs = await Promise.all([
    Property.exists({ owner: user._id }),
    Meetup.exists({ createdBy: user._id }),
    require('../models/Lead.model').exists({ tenant: user._id }),
    require('../models/VisitRequest.model').exists({ $or: [{ tenant: user._id }, { owner: user._id }] }),
    require('../models/RentalBooking.model').exists({ $or: [{ renter: user._id }, { owner: user._id }] }),
    require('../models/MeetupParticipant.model').exists({ user: user._id }),
  ]);
  if (refs.some(Boolean)) return errorResponse(res, 'This account has operational records. Suspend the account to preserve those records.', 409);
  await user.deleteOne();
  await tokenService.revokeAllUserSessions(String(user._id));
  return successResponse(res, 'User deleted');
});

exports.cities = asyncHandler(async (req, res) => {
  const { page, limit, search, isActive } = req.query;
  const query = {};
  if (isActive) query.isActive = isActive === 'true';
  if (search) query.$or = [{ name: literal(search) }, { state: literal(search) }];
  const [items, total] = await Promise.all([
    City.find(query).sort({ order: 1, name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    City.countDocuments(query),
  ]);
  return paginatedResponse(res, 'Cities retrieved', items, { page, limit, total, totalPages: Math.ceil(total / limit) });
});

const activityList = (Model, message, fields) => asyncHandler(async (req, res) => {
  const { page, limit, propertyId, ...filters } = req.query;
  const query = { ...filters };
  if (query.isRead) query.isRead = query.isRead === 'true';
  if (propertyId) query.$or = [{ property: propertyId }, { pg: propertyId }];
  const [items, total] = await Promise.all([
    Model.find(query).select(fields).populate('property pg', 'title city area').populate('tenant', 'name email phone')
      .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Model.countDocuments(query),
  ]);
  const records = items.map(({ property, pg, ...item }) => ({ ...item, property: property || pg }));
  return paginatedResponse(res, message, records, { page, limit, total, totalPages: Math.ceil(total / limit) });
});

exports.leads = activityList(require('../models/Lead.model'), 'Leads retrieved', 'property pg tenant type message isRead createdAt');
exports.visits = activityList(require('../models/VisitRequest.model'), 'Visits retrieved', 'property pg tenant status scheduledDate scheduledTime message ownerNote createdAt');

exports.areas = asyncHandler(async (req, res) => {
  const { page, limit, cityId, isActive, search } = req.query;
  const query = {};
  if (cityId) query.city = cityId;
  if (isActive) query.isActive = isActive === 'true';
  if (search) query.$or = [{ name: literal(search) }, { cityName: literal(search) }];
  const [items, total] = await Promise.all([
    Area.find(query).sort({ cityName: 1, order: 1, name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Area.countDocuments(query),
  ]);
  return paginatedResponse(res, 'Areas retrieved', items, { page, limit, total, totalPages: Math.ceil(total / limit) });
});
const invalidateArea = (cityId) => {
  invalidateAreaCache(cityId);
  for (const pattern of ['search:properties:*', 'search:suggest:*']) redis.delByPattern(pattern).catch(() => {});
};
exports.createArea = asyncHandler(async (req, res) => {
  const { cityId, ...values } = req.body;
  const city = await City.findById(cityId).select('name');
  if (!city) return errorResponse(res, 'City not found', 404);
  if (await Area.exists({ city: cityId, name: literalExact(values.name) })) return errorResponse(res, 'Area already exists in this city', 409);
  const area = await Area.create({ ...values, city: cityId, cityName: city.name });
  invalidateArea(area.city);
  return successResponse(res, 'Area created', { area }, 201);
});
const literalExact = (value) => new RegExp(`^${literal(value).source}$`, 'i');
exports.updateArea = asyncHandler(async (req, res) => {
  const area = await Area.findById(req.params.id);
  if (!area) return errorResponse(res, 'Area not found', 404);
  if (req.body.name && await Area.exists({ city: area.city, _id: { $ne: area._id }, name: literalExact(req.body.name) })) {
    return errorResponse(res, 'Area already exists in this city', 409);
  }
  area.set(req.body);
  await area.save();
  invalidateArea(area.city);
  return successResponse(res, 'Area updated', { area });
});

exports.propertyAudits = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const query = { propertyId: req.params.id };
  const [items, total] = await Promise.all([
    PropertyAudit.find(query).select('action previousStatus newStatus actor actorRole reason createdAt')
      .populate('actor', 'name').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    PropertyAudit.countDocuments(query),
  ]);
  return paginatedResponse(res, 'Property activity retrieved', items, { page, limit, total, totalPages: Math.ceil(total / limit) });
});

exports.createProperty = asyncHandler(async (req, res) => {
  const ownerId = req.adminPropertyOwner || req.user._id;
  if (req.adminPropertyOwner && !await User.exists({ _id: ownerId, isActive: true, roles: { $ne: 'admin' }, role: { $ne: 'admin' } })) {
    return errorResponse(res, 'Select an active non-administrator account.', 422);
  }
  const property = await require('../services/property.service').createProperty(ownerId, req.body, req.user._id);
  return successResponse(res, 'Property created and submitted for review', { property }, 201);
});
