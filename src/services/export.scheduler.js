const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const ExportSchedule = require('../models/ExportSchedule.model');
const ExportJob = require('../models/ExportJob.model');
const excelService = require('./excel.service');
const exportStorage = require('./exportStorage.service');
const { logger } = require('../utils/logger');

const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_LOCK_MS = 30 * 60 * 1000;

/**
 * Executes a background scheduled export task
 * @param {Object} [options]
 * @param {string} [options.triggeredBy] - 'cron' | 'manual_test'
 * @param {Object} [options.user] - Optional User triggering manual test
 */
const executeScheduledExport = async (options = {}) => {
  const isManual = options.triggeredBy === 'manual_test';
  logger.info(`[ExportScheduler] Starting weekly export task (Trigger: ${isManual ? 'Manual test' : 'Cron 9:00 AM IST'})...`);

  let scheduleConfig = await ExportSchedule.getOrCreateSchedule();
  if (!scheduleConfig.isDaily9AMEnabled && !isManual) {
    logger.info('[ExportScheduler] Weekly export is disabled in settings. Skipping.');
    return null;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - WEEK_IN_MS);
  const claimFilter = {
    _id: scheduleConfig._id,
    $and: [
      { $or: [{ runLockUntil: null }, { runLockUntil: { $lte: now } }] },
      ...(isManual ? [] : [{ $or: [{ lastCompletedAt: null }, { lastCompletedAt: { $lte: cutoff } }] }]),
    ],
  };
  const claimedSchedule = await ExportSchedule.findOneAndUpdate(
    claimFilter,
    { $set: { runLockUntil: new Date(now.getTime() + RUN_LOCK_MS), lastRunAt: now, lastRunStatus: 'running' } },
    { new: true }
  );
  if (!claimedSchedule) {
    logger.info('[ExportScheduler] Weekly export is already running or the 7-day interval has not elapsed. Skipping.');
    return null;
  }
  scheduleConfig = claimedSchedule;

  const dataset = scheduleConfig.dataset || 'pgs';
  const query = excelService.parseExportFilters({ dataset, ...(scheduleConfig.filters || {}) });

  // Update schedule status to running
  // Create tracking job in DB
  let job;
  try {
    job = await ExportJob.create({
      admin: options.user?._id || scheduleConfig.updatedBy || null,
      jobType: isManual ? 'manual_background' : 'daily_9am_schedule',
      dataset,
      status: 'processing',
      progress: 0,
      filters: scheduleConfig.filters || {},
    });
  } catch (error) {
    scheduleConfig.runLockUntil = null;
    scheduleConfig.lastRunStatus = 'failed';
    scheduleConfig.lastRunError = error.message;
    await scheduleConfig.save();
    throw error;
  }

  const tempDir = path.join(__dirname, '../../uploads/exports');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const tempFilePath = path.join(tempDir, `daily_export_${dataset}_${job._id}.xlsx`);

  try {
    const fileStream = fs.createWriteStream(tempFilePath);

    await new Promise((resolve, reject) => {
      fileStream.on('error', reject);
      excelService
        .generateExcelStream({
          dataset,
          query,
          writeStream: fileStream,
          onProgress: async (processed, total) => {
            if (total > 0) {
              const progress = Math.min(Math.round((processed / total) * 98), 98);
              await ExportJob.findByIdAndUpdate(job._id, { progress });
            }
          },
        })
        .then(resolve)
        .catch(reject);
    });

    const uploadResult = await exportStorage.upload(tempFilePath, 'pginfo/exports/scheduled', `scheduled_export_${dataset}_${job._id}.xlsx`);

    const fileSize = fs.existsSync(tempFilePath) ? fs.statSync(tempFilePath).size : 0;

    // Mark job as completed
    await ExportJob.findByIdAndUpdate(job._id, {
      status: 'completed',
      progress: 100,
      filePublicId: uploadResult.public_id,
      fileSize,
      completedAt: new Date(),
    });

    // Update schedule config state
    scheduleConfig.lastRunStatus = 'completed';
    scheduleConfig.lastJobId = job._id;
    scheduleConfig.lastCompletedAt = new Date();
    scheduleConfig.runLockUntil = null;
    scheduleConfig.lastRunError = null;
    await scheduleConfig.save();

    logger.info('[ExportScheduler] Weekly export completed successfully');
    return { jobId: job._id };
  } catch (err) {
    logger.error(`[ExportScheduler] ✗ Daily export failed: ${err.message}`);

    await ExportJob.findByIdAndUpdate(job._id, {
      status: 'failed',
      error: 'Scheduled export generation failed. See server logs for the job reference.',
    });

    scheduleConfig.lastRunStatus = 'failed';
    scheduleConfig.lastRunError = err.message;
    scheduleConfig.runLockUntil = null;
    await scheduleConfig.save();
    throw err;
  } finally {
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        logger.warn(`[ExportScheduler] Temp file cleanup error: ${e.message}`);
      }
    }
  }
};

/**
 * Initializes cron schedule on server startup
 */
const startExportScheduler = () => {
  logger.info('[ExportScheduler] Initializing Weekly 9:00 AM IST Auto-Export Cron...');

  // '0 9 * * *' = 9:00 AM every day
  cron.schedule(
    '0 9 * * *',
    async () => {
      try {
        await executeScheduledExport({ triggeredBy: 'cron' });
      } catch (err) {
        logger.error(`[ExportScheduler] Cron execution exception: ${err.message}`);
      }
    },
    {
      timezone: 'Asia/Kolkata',
    }
  );

  logger.info('[ExportScheduler] Weekly 9:00 AM IST Auto-Export registered ✓');
};

module.exports = {
  startExportScheduler,
  executeScheduledExport,
};
