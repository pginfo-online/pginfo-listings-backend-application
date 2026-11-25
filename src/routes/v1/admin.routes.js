const express = require('express');
const router = express.Router();
const { getAllPGs, approvePG, rejectPG, toggleVerify, removePG, getAnalytics, getTrends, updatePGByAdmin } = require('../../controllers/admin.controller');
const directory = require('../../controllers/adminDirectory.controller');
const schemas = require('../../validators/admin.validator');
const { errorResponse } = require('../../utils/apiResponse');
const { adminGetAllMeetups, adminGetKPIs, adminLifecycleTransition, adminToggleFeature, adminToggleApproval, adminDeleteMeetup } = require('../../controllers/meetup.controller');
const { directExportPGs, initiateExportJob, getExportJobs, getExportJobStatus, deleteExportJob, downloadExportJob, getExportScheduleConfig, updateExportScheduleConfig, triggerScheduledExportNow } = require('../../controllers/adminExport.controller');
const { protect, authorize } = require('../../middlewares/auth.middleware');
const validate = require('../../middlewares/validate.middleware');
const { exportQuerySchema, initiateJobSchema } = require('../../validators/adminExport.validator');
const notificationSchemas = require('../../validators/adminNotification.validator');
const adminNotifCtrl = require('../../controllers/admin.notification.controller');


// All admin routes require admin role
router.use((req, res, next) => /^Bearer \S+$/.test(req.get('authorization') || '')
  ? next()
  : errorResponse(res, 'Admin requests require an authorization header', 401), protect, authorize('admin'));
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});
router.get('/session', directory.session);

// Export PG Listings & Datasets
router.get('/pgs/export', validate(exportQuerySchema, 'query'), directExportPGs);
router.post('/pgs/export/job', validate(initiateJobSchema), initiateExportJob);
router.get('/pgs/export/jobs', getExportJobs);
router.get('/pgs/export/jobs/:id', validate(schemas.idParams, 'params'), getExportJobStatus);
router.get('/pgs/export/jobs/:id/file', validate(schemas.idParams, 'params'), downloadExportJob);
router.delete('/pgs/export/jobs/:id', deleteExportJob);

// Server-side 9:00 AM Export Schedule
router.get('/pgs/export/schedule', getExportScheduleConfig);
router.put('/pgs/export/schedule', validate(require('../../validators/adminExport.validator').scheduleSchema), updateExportScheduleConfig);
router.post('/pgs/export/schedule/trigger', triggerScheduledExportNow);

router.get('/pgs', getAllPGs);
router.put('/pgs/:id', updatePGByAdmin);
router.put('/pgs/:id/approve', approvePG);
router.put('/pgs/:id/reject', rejectPG);
router.put('/pgs/:id/verify', toggleVerify);
router.delete('/pgs/:id', removePG);

// Universal Property Management & Approvals
const propertyCtrl = require('../../controllers/property.controller');
const propUpdateCtrl = require('../../controllers/propertyUpdateRequest.controller');
router.post('/properties', (req, res, next) => {
  const owner = schemas.objectId.optional().safeParse(req.body?.ownerId);
  if (!owner.success) return errorResponse(res, 'Invalid owner ID', 400);
  req.adminPropertyOwner = owner.data;
  next();
}, validate(require('../../validators/property.validator').createPropertySchema), directory.createProperty);
router.get('/properties', validate(schemas.propertyQuery, 'query'), propertyCtrl.getAdminProperties);
router.get('/properties/:id', validate(schemas.idParams, 'params'), propertyCtrl.getPropertyById);
router.get('/properties/:id/audits', validate(schemas.idParams, 'params'), validate(schemas.auditQuery, 'query'), directory.propertyAudits);
router.put('/properties/:id/approve', propertyCtrl.approveProperty);
router.put('/properties/:id/reject', propertyCtrl.rejectProperty);
router.put('/properties/:id/request-correction', propertyCtrl.requestCorrection);
router.put('/properties/:id/verify', validate(schemas.idParams, 'params'), validate(schemas.verification), propertyCtrl.toggleVerify);
router.put('/properties/:id/suspend', propertyCtrl.suspendProperty);
router.get('/property-updates', propUpdateCtrl.getAllUpdateRequests);
router.get('/property-updates/:id', propUpdateCtrl.getUpdateRequestById);
router.put('/property-updates/:id/approve', propUpdateCtrl.approveUpdateRequest);
router.put('/property-updates/:id/reject', propUpdateCtrl.rejectUpdateRequest);
router.put('/property-updates/:id/correction', propUpdateCtrl.requestCorrection);

router.get('/users', validate(schemas.userQuery, 'query'), directory.users);
router.post('/users', validate(schemas.createUser), directory.createUser);
router.get('/users/:id', validate(schemas.idParams, 'params'), directory.user);
router.put('/users/:id', validate(schemas.idParams, 'params'), validate(schemas.updateUser), directory.updateUser);
router.put('/users/:id/reset-password', validate(schemas.idParams, 'params'), validate(schemas.resetPassword), directory.resetPassword);
router.put('/users/:id/suspend', validate(schemas.idParams, 'params'), validate(schemas.accountStatus), directory.status);
router.delete('/users/:id', validate(schemas.idParams, 'params'), directory.deleteUser);
router.put('/users/:id/roles', validate(schemas.idParams, 'params'), validate(schemas.setRoles), directory.setRoles);
router.post('/users/:id/roles/:role', validate(schemas.roleParams, 'params'), directory.addRole);
router.delete('/users/:id/roles/:role', validate(schemas.roleParams, 'params'), directory.removeRole);

router.get('/cities', validate(schemas.cityQuery, 'query'), directory.cities);
router.get('/leads', validate(schemas.leadQuery, 'query'), directory.leads);
router.get('/visits', validate(schemas.visitQuery, 'query'), directory.visits);

router.get('/areas', validate(schemas.areaQuery, 'query'), directory.areas);
router.post('/areas', validate(schemas.createArea), directory.createArea);
router.put('/areas/:id', validate(schemas.idParams, 'params'), validate(schemas.updateArea), directory.updateArea);

router.get('/analytics', getAnalytics);
router.get('/analytics/trends', getTrends);

// Unified Property / PG Update Requests (supporting both /pg-updates and /property-updates)
router.get('/pg-updates', propUpdateCtrl.getAllUpdateRequests);
router.get('/pg-updates/:id', propUpdateCtrl.getUpdateRequestById);
router.put('/pg-updates/:id/approve', propUpdateCtrl.approveUpdateRequest);
router.put('/pg-updates/:id/reject', propUpdateCtrl.rejectUpdateRequest);
router.put('/pg-updates/:id/correction', propUpdateCtrl.requestCorrection);

// Meetups
router.get('/meetups/kpis', adminGetKPIs);
router.get('/meetups', adminGetAllMeetups);
router.put('/meetups/:id/lifecycle', adminLifecycleTransition);
router.put('/meetups/:id/feature', adminToggleFeature);
router.put('/meetups/:id/approve', adminToggleApproval);
router.delete('/meetups/:id', adminDeleteMeetup);

// ─── Notification Management ───────────────────────────────────────────────────
router.get('/notifications/stats',                adminNotifCtrl.getStats);
router.post('/notifications/audience-count',      validate(notificationSchemas.audience), adminNotifCtrl.getAudienceCount);
router.get('/notifications/templates',            adminNotifCtrl.getTemplates);
router.post('/notifications/templates',           validate(notificationSchemas.createTemplate), adminNotifCtrl.createTemplate);
router.put('/notifications/templates/:id',        validate(schemas.idParams, 'params'), validate(notificationSchemas.updateTemplate), adminNotifCtrl.updateTemplate);
router.delete('/notifications/templates/:id',     adminNotifCtrl.deleteTemplate);
router.post('/notifications',                     validate(notificationSchemas.create), adminNotifCtrl.createNotification);
router.get('/notifications',                      validate(notificationSchemas.list, 'query'), adminNotifCtrl.getNotifications);
router.get('/notifications/:id',                  adminNotifCtrl.getNotification);
router.put('/notifications/:id',                  validate(schemas.idParams, 'params'), validate(notificationSchemas.update), adminNotifCtrl.updateNotification);
router.put('/notifications/:id/cancel',           adminNotifCtrl.cancelNotification);
router.post('/notifications/:id/send',            adminNotifCtrl.sendNotification);
router.post('/notifications/:id/retry',           adminNotifCtrl.retryNotification);
router.get('/notifications/:id/receipts',         adminNotifCtrl.getReceipts);

module.exports = router;

