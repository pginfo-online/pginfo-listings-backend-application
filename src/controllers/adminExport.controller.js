const fs = require('fs');
const path = require('path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const asyncHandler = require('../utils/asyncHandler');
const { successResponse, errorResponse, paginatedResponse } = require('../utils/apiResponse');
const Property = require('../models/Property.model');
const User = require('../models/User.model');
const Lead = require('../models/Lead.model');
const ExportJob = require('../models/ExportJob.model');
const ExportSchedule = require('../models/ExportSchedule.model');
const excelService = require('../services/excel.service');
const { executeScheduledExport } = require('../services/export.scheduler');
const exportStorage = require('../services/exportStorage.service');
const { logger } = require('../utils/logger');

/**
 * Runs the background export job: streams database rows into a temp file,
 * uploads to Cloudinary, updates progress, and cleans up temp files.
 */
const runBackgroundExport = async (jobId, dataset, query) => {
  await ExportJob.findByIdAndUpdate(jobId, { status: 'processing', progress: 0 });

  const tempDir = path.join(__dirname, '../../uploads/exports');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const tempFilePath = path.join(tempDir, `export_${dataset}_${jobId}.xlsx`);

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
              await ExportJob.findByIdAndUpdate(jobId, { progress });
            }
          },
        })
        .then(resolve)
        .catch(reject);
    });

    const uploadResult = await exportStorage.upload(tempFilePath, 'pginfo/exports', `export_${dataset}_${jobId}.xlsx`);

    const fileSize = fs.existsSync(tempFilePath) ? fs.statSync(tempFilePath).size : 0;

    await ExportJob.findByIdAndUpdate(jobId, {
      status: 'completed',
      progress: 100,
      filePublicId: uploadResult.public_id,
      fileSize,
      completedAt: new Date(),
    });

    logger.info(`Completed export job: ${jobId} (${dataset})`);
  } catch (err) {
    logger.error(`Error in runBackgroundExport for job ${jobId}: ${err.stack}`);
    await ExportJob.findByIdAndUpdate(jobId, {
      status: 'failed',
      error: 'Export generation failed. See server logs for the job reference.',
    });
  } finally {
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (unlinkErr) {
        logger.error(`Failed to delete temp file ${tempFilePath}: ${unlinkErr.message}`);
      }
    }
  }
};

/**
 * @route GET /api/v1/admin/pgs/export
 * @desc  Direct stream export file to browser
 */
const directExportPGs = asyncHandler(async (req, res) => {
  const dataset = req.query.dataset || 'pgs';
  const query = excelService.parseExportFilters(req.query);

  const timestamp = new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
  const filename = `${dataset}_export_${timestamp}.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  try {
    await excelService.generateExcelStream({ dataset, query, writeStream: res });
  } catch (err) {
    logger.error(`Direct export failed: ${err.stack}`);
    if (!res.headersSent) {
      return errorResponse(res, 'Failed to generate Excel export file', 500);
    }
    res.destroy(err);
  }
});

/**
 * @route POST /api/v1/admin/pgs/export/job
 * @desc  Start an asynchronous background export job
 */
const initiateExportJob = asyncHandler(async (req, res) => {
  const dataset = req.body.dataset || 'pgs';
  const query = excelService.parseExportFilters(req.body);

  let totalDocs = 0;
  if (dataset === 'users') totalDocs = await User.countDocuments(query);
  else if (dataset === 'leads') totalDocs = await Lead.countDocuments(query);
  else totalDocs = await Property.countDocuments({ ...query, category: 'pg' });

  if (totalDocs === 0) {
    return errorResponse(res, `No records found in dataset '${dataset}' matching specified filters`, 400);
  }

  const job = await ExportJob.create({
    admin: req.user._id,
    jobType: 'manual_background',
    dataset,
    status: 'pending',
    progress: 0,
    filters: req.body,
  });

  setImmediate(() => {
    runBackgroundExport(job._id, dataset, query).catch((err) => {
      logger.error(`Export job runner crash for ${job._id}: ${err.message}`);
    });
  });

  return successResponse(res, 'Export job initiated successfully', { job }, 202);
});

/**
 * @route GET /api/v1/admin/pgs/export/jobs
 * @desc  Retrieve list of export jobs
 */
const getExportJobs = asyncHandler(async (req, res) => {
  const page = Math.min(10000, Math.max(1, parseInt(req.query.page, 10) || 1));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 15));
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.dataset && req.query.dataset !== 'all') {
    filter.dataset = req.query.dataset;
  }
  if (req.query.jobType && req.query.jobType !== 'all') {
    filter.jobType = req.query.jobType;
  }

  const [jobs, total] = await Promise.all([
    ExportJob.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('admin', 'name email')
      .lean(),
    ExportJob.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limit);

  return paginatedResponse(res, 'Export jobs retrieved successfully', jobs, {
    total,
    page,
    limit,
    totalPages,
    hasNext: page * limit < total,
    hasPrev: page > 1,
  });
});

/**
 * @route GET /api/v1/admin/pgs/export/jobs/:id
 */
const getExportJobStatus = asyncHandler(async (req, res) => {
  const job = await ExportJob.findById(req.params.id).select('+filePublicId').populate('admin', 'name email').lean();
  if (!job) {
    return res.status(404).json({ success: false, message: 'Export job not found' });
  }
  const { filePublicId, ...details } = job;
  return successResponse(res, 'Export job status retrieved successfully', { job: { ...details, downloadable: !!filePublicId } });
});

/**
 * @route DELETE /api/v1/admin/pgs/export/jobs/:id
 */
const deleteExportJob = asyncHandler(async (req, res) => {
  const job = await ExportJob.findById(req.params.id).select('+filePublicId');
  if (!job) return errorResponse(res, 'Export job not found', 404);
  if (['pending', 'processing'].includes(job.status)) return errorResponse(res, 'Wait for the export job to finish before deleting it.', 409);
  if (job.filePublicId) await exportStorage.remove(job.filePublicId);
  await job.deleteOne();
  return successResponse(res, 'Export job record deleted successfully');
});

const downloadExportJob = asyncHandler(async (req, res) => {
  const job = await ExportJob.findById(req.params.id).select('+filePublicId').lean();
  if (job?.status !== 'completed' || !job.filePublicId) {
    return errorResponse(res, 'No private file is available for this export. Generate a new export.', 404);
  }
  const abort = new AbortController();
  res.once('close', () => abort.abort());
  const source = await fetch(exportStorage.downloadUrl(job.filePublicId), {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
    redirect: 'error',
  });
  if (!source.ok || !source.body) return errorResponse(res, 'The export file could not be retrieved.', 502);
  res.attachment(`${job.dataset}_export_${job._id}.xlsx`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await pipeline(Readable.fromWeb(source.body), res).catch((error) => {
    if (!abort.signal.aborted && !res.headersSent) throw error;
  });
});

/**
 * @route GET /api/v1/admin/pgs/export/schedule
 * @desc  Get the persistent weekly 9:00 AM server-side schedule config & status
 */
const getExportScheduleConfig = asyncHandler(async (req, res) => {
  const schedule = await ExportSchedule.getOrCreateSchedule();

  const day = 86400000;
  const interval = 7 * day;
  const offset = 19800000;
  const start = Math.max(Date.now(), schedule.lastCompletedAt ? schedule.lastCompletedAt.getTime() + interval : 0);
  const boundary = Math.floor((start + offset) / day) * day - offset + 9 * 3600000;
  const nextRun = schedule.isDaily9AMEnabled && process.env.ENABLE_EXPORT_SCHEDULER === 'true'
    ? new Date(boundary < start ? boundary + day : boundary) : null;

  return successResponse(res, 'Export schedule retrieved successfully', {
    schedule: {
      ...schedule.toObject(),
      computedNextRunAt: nextRun,
    },
  });
});

/**
 * @route PUT /api/v1/admin/pgs/export/schedule
 * @desc  Update schedule settings (enable/disable, dataset, default filters)
 */
const updateExportScheduleConfig = asyncHandler(async (req, res) => {
  const schedule = await ExportSchedule.getOrCreateSchedule();

  if (typeof req.body.isDaily9AMEnabled === 'boolean') {
    schedule.isDaily9AMEnabled = req.body.isDaily9AMEnabled;
  }
  if (req.body.dataset) {
    schedule.dataset = req.body.dataset;
  }
  if (req.body.filters) {
    schedule.filters = req.body.filters;
  }
  schedule.updatedBy = req.user._id;

  await schedule.save();
  return successResponse(res, 'Export schedule configuration updated successfully', { schedule });
});

/**
 * @route POST /api/v1/admin/pgs/export/schedule/trigger
 * @desc  Manually trigger the 9:00 AM scheduled export task immediately (test run)
 */
const triggerScheduledExportNow = asyncHandler(async (req, res) => {
  const result = await executeScheduledExport({
    triggeredBy: 'manual_test',
    user: req.user,
  });

  if (!result) return errorResponse(res, 'An export is already running.', 409);
  return successResponse(res, 'Scheduled export task executed successfully', result);
});

module.exports = {
  directExportPGs,
  initiateExportJob,
  getExportJobs,
  getExportJobStatus,
  deleteExportJob,
  downloadExportJob,
  getExportScheduleConfig,
  updateExportScheduleConfig,
  triggerScheduledExportNow,
};
