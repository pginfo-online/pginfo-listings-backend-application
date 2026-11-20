const mongoose = require('mongoose');

const savedSearchSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  label: { type: String, required: true, maxlength: 120 },
  filters: { type: mongoose.Schema.Types.Mixed, required: true },
  checkedAt: { type: Date, required: true },
  nextCheckAt: { type: Date, required: true },
}, { timestamps: true });

savedSearchSchema.index({ user: 1, createdAt: -1 });
savedSearchSchema.index({ nextCheckAt: 1 });

module.exports = mongoose.model('SavedSearch', savedSearchSchema);
