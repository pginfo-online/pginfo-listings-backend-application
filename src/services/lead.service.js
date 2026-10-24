const Lead = require('../models/Lead.model');
const Property = require('../models/Property.model');

/**
 * Add or toggle a lead (inquiry or wishlist)
 */
const addLead = async (pgId, tenantId, type, message) => {
  // Check property exists
  const property = await Property.findById(pgId);
  if (!property) {
    const err = new Error('Property not found');
    err.statusCode = 404;
    throw err;
  }

  // Upsert lead
  const existing = await Lead.findOne({ pg: pgId, tenant: tenantId, type });

  if (existing) {
    // If wishlist, toggle (remove)
    if (type === 'wishlist') {
      await Lead.deleteOne({ _id: existing._id });
      return { action: 'removed', lead: null };
    }
    return { action: 'exists', lead: existing };
  }

  const lead = await Lead.create({
    property: pgId,
    pg: pgId,
    tenant: tenantId,
    type,
    message,
    category: property.category || 'pg',
  });

  // Increment inquiries count on Property
  if (type === 'inquiry') {
    await Property.findByIdAndUpdate(pgId, { $inc: { inquiries: 1 } });
  }

  return { action: 'created', lead };
};

/**
 * Get tenant's wishlist
 */
const getTenantLeads = async (tenantId, type) => {
  const query = { tenant: tenantId };
  if (type) query.type = type;

  return Lead.find(query)
    .populate('pg', 'title name city area pricing photos isVerified status pgDetails')
    .sort({ createdAt: -1 })
    .lean();
};

/**
 * Get leads for a specific PG / Property (owner view)
 */
const getPGLeads = async (pgId, ownerId) => {
  const property = await Property.findOne({ _id: pgId, owner: ownerId });
  if (!property) {
    const err = new Error('Property not found or not authorized');
    err.statusCode = 403;
    throw err;
  }

  return Lead.find({ pg: pgId })
    .populate('tenant', 'name email phone')
    .sort({ createdAt: -1 })
    .lean();
};

/**
 * Mark leads as read
 */
const markLeadsRead = async (pgId) => {
  return Lead.updateMany({ pg: pgId, isRead: false }, { isRead: true });
};

module.exports = { addLead, getTenantLeads, getPGLeads, markLeadsRead };
