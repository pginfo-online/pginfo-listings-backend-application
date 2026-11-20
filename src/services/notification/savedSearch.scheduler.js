const crypto = require('node:crypto');
const mongoose = require('mongoose');
const cron = require('node-cron');
const SavedSearch = require('../../models/SavedSearch.model');
const User = require('../../models/User.model');
const Property = require('../../models/Property.model');
const NotificationInbox = require('../../models/NotificationInbox.model');
const { buildPropertySearchQuery } = require('../propertySearch.service');
const { logger } = require('../../utils/logger');

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;

async function processSavedSearchAlerts() {
  const cutoff = new Date();

  for (let index = 0; index < 100; index += 1) {
    const nextCheckAt = new Date(Date.now() + 60 * MINUTE);
    const search = await SavedSearch.findOneAndUpdate({ nextCheckAt: { $lte: cutoff } }, {
      $set: { nextCheckAt },
    }, { sort: { nextCheckAt: 1 }, new: true }).lean();
    if (!search) break;

    try {
      const active = await User.exists({ _id: search.user, isActive: true });
      const matches = active ? await Property.find({
        ...buildPropertySearchQuery(search.filters),
        statusHistory: { $elemMatch: { status: 'approved', changedAt: { $gt: search.checkedAt, $lte: cutoff } } },
        owner: { $ne: search.user },
      }).select('_id').limit(21).maxTimeMS(3000).lean() : [];

      if (matches.length) {
        const id = new mongoose.Types.ObjectId(crypto.createHash('sha256')
          .update(`${search._id}:${search.checkedAt.toISOString()}`)
          .digest('hex').slice(0, 24));
        const count = matches.length > 20 ? '20+' : String(matches.length);
        await NotificationInbox.updateOne({ _id: id, user: search.user }, {
          $setOnInsert: {
            user: search.user,
            title: 'New listings match your search',
            body: `${count} new ${matches.length === 1 ? 'listing matches' : 'listings match'} ${search.label}.`,
            type: 'SAVED_SEARCH_MATCH',
            data: { deepLink: 'pginfo://saved-searches', entityType: 'SavedSearch', entityId: String(search._id) },
          },
        }, { upsert: true });
      }

      await SavedSearch.updateOne({ _id: search._id, nextCheckAt }, {
        $set: { checkedAt: cutoff, nextCheckAt: new Date(cutoff.getTime() + DAY) },
      });
    } catch (error) {
      logger.error(`[SavedSearch] Alert check failed: ${error.message}`);
    }
  }
}

function startSavedSearchAlerts() {
  return cron.schedule('*/5 * * * *', () => processSavedSearchAlerts().catch((error) => {
    logger.error(`[SavedSearch] Worker failed: ${error.message}`);
  }), { noOverlap: true });
}

module.exports = { startSavedSearchAlerts, processSavedSearchAlerts };
