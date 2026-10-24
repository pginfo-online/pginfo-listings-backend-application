const mongoose = require('mongoose');

/**
 * PropertyAudit Model
 * Records an immutable audit log of status transitions and moderation events.
 */
const propertyAuditSchema = new mongoose.Schema(
  {
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: ['created', 'updated', 'submitted', 'approved', 'rejected', 'correction_requested', 'suspended', 'archived', 'deleted'],
      required: true,
    },
    previousStatus: {
      type: String,
      default: null,
    },
    newStatus: {
      type: String,
      required: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    actorRole: {
      type: String,
      default: 'system',
    },
    reason: {
      type: String,
      trim: true,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

propertyAuditSchema.index({ propertyId: 1, createdAt: -1 });

module.exports = mongoose.model('PropertyAudit', propertyAuditSchema);
