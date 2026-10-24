/**
 * Background cron jobs for scheduled notifications and Expo receipt delivery.
 */

const cron = require('node-cron');
const { logger } = require('../../utils/logger');
const Notification = require('../../models/Notification.model');
const NotificationReceipt = require('../../models/NotificationReceipt.model');
const notificationService = require('./notification.service');
const expoService = require('./expo.service');

const MAX_RETRY = parseInt(process.env.NOTIFICATION_RETRY_MAX, 10) || 3;

async function processScheduledNotifications() {
  try {
    const due = await Notification.find({
      status: 'scheduled',
      scheduledAt: { $lte: new Date() },
    }).limit(20).lean();

    if (due.length === 0) return;

    logger.info(`[Scheduler] Processing ${due.length} scheduled notification(s)`);

    for (const notif of due) {
      const updated = await Notification.findOneAndUpdate(
        { _id: notif._id, status: 'scheduled' },
        { status: 'sending' },
        { new: true }
      );

      if (updated) await notificationService.send(updated);
    }
  } catch (err) {
    logger.error(`[Scheduler] processScheduledNotifications error: ${err.message}`);
  }
}

async function pollExpoReceipts() {
  try {
    const pending = await NotificationReceipt.find({
      status: 'sent',
      expoPushTicketId: { $ne: null },
      sentAt: { $lte: new Date(Date.now() - 2 * 60 * 1000) },
    }).select('_id notification expoPushTicketId device').limit(500).lean();

    if (pending.length === 0) return;

    logger.info(`[Scheduler] Polling receipts for ${pending.length} ticket(s)`);

    const receipts = await expoService.fetchReceipts(pending.map((receipt) => receipt.expoPushTicketId));
    const bulkOps = [];

    for (const receipt of pending) {
      const expoReceipt = receipts[receipt.expoPushTicketId];
      if (!expoReceipt) continue;

      if (expoReceipt.status === 'ok') {
        bulkOps.push({
          updateOne: {
            filter: { _id: receipt._id },
            update: {
              status: 'delivered',
              deliveredAt: new Date(),
              expoReceiptId: receipt.expoPushTicketId,
            },
          },
        });
        await Notification.findByIdAndUpdate(receipt.notification, {
          $inc: { 'stats.delivered': 1 },
        });
      } else if (expoReceipt.status === 'error') {
        const { isInvalid } = expoService.classifyError(expoReceipt);
        bulkOps.push({
          updateOne: {
            filter: { _id: receipt._id },
            update: {
              status: 'failed',
              errorCode: expoReceipt.details?.error || 'ReceiptError',
              errorMessage: expoReceipt.message,
            },
          },
        });

        if (isInvalid && receipt.device) {
          const DeviceToken = require('../../models/DeviceToken.model');
          await DeviceToken.findByIdAndUpdate(receipt.device, {
            isActive: false,
            deactivatedReason: 'DeviceNotRegistered',
          });
        }
      }
    }

    if (bulkOps.length > 0) {
      await NotificationReceipt.bulkWrite(bulkOps, { ordered: false });
    }
  } catch (err) {
    logger.error(`[Scheduler] pollExpoReceipts error: ${err.message}`);
  }
}

async function retryFailedReceipts() {
  try {
    const retryable = await NotificationReceipt.find({
      status: 'failed',
      retryCount: { $lt: MAX_RETRY },
      nextRetryAt: { $lte: new Date() },
    }).populate('notification', 'title body imageUrl data type')
      .populate('device', 'token')
      .limit(100)
      .lean();

    if (retryable.length === 0) return;

    logger.info(`[Scheduler] Retrying ${retryable.length} failed receipt(s)`);

    for (const receipt of retryable) {
      if (!receipt.device?.token || !receipt.notification) continue;

      const notif = receipt.notification;
      const message = expoService.buildMessage(receipt.device.token, {
        title: notif.title,
        body: notif.body,
        imageUrl: notif.imageUrl,
        data: notif.data,
      });

      try {
        const tickets = await expoService.sendBatch([message]);
        const ticket = tickets[0];
        const newRetryCount = receipt.retryCount + 1;
        const maxed = newRetryCount >= MAX_RETRY;

        await NotificationReceipt.findByIdAndUpdate(receipt._id, {
          retryCount: newRetryCount,
          status: ticket.status === 'ok' ? 'sent' : (maxed ? 'failed' : 'failed'),
          expoPushTicketId: ticket.status === 'ok' ? ticket.id : null,
          sentAt: ticket.status === 'ok' ? new Date() : null,
          nextRetryAt: (!maxed && ticket.status !== 'ok')
            ? new Date(Date.now() + (newRetryCount * 10 * 60 * 1000))
            : null,
        });
      } catch (err) {
        logger.error(`[Scheduler] Retry send error for receipt ${receipt._id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[Scheduler] retryFailedReceipts error: ${err.message}`);
  }
}

function startScheduler() {
  logger.info('[Scheduler] Starting notification scheduler...');

  cron.schedule('* * * * *', processScheduledNotifications, {
    timezone: 'Asia/Kolkata',
  });
  cron.schedule('*/5 * * * *', pollExpoReceipts, {
    timezone: 'Asia/Kolkata',
  });
  cron.schedule('*/15 * * * *', retryFailedReceipts, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[Scheduler] Notification jobs registered');
}

module.exports = {
  startScheduler,
  processScheduledNotifications,
  pollExpoReceipts,
  retryFailedReceipts,
};
