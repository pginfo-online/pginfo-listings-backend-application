const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const pgRoutes = require('./pg.routes');
const leadRoutes = require('./lead.routes');
const visitRoutes = require('./visit.routes');
const adminRoutes = require('./admin.routes');
const uploadRoutes = require('./upload.routes');
const meetupRoutes = require('./meetup.routes');
const appVersionRoutes = require('./appVersion.routes');
const notificationRoutes = require('./notification.routes');
const cityRoutes = require('./city.routes');
const areaRoutes = require('./area.routes');
const locationRoutes = require('./location.routes');
const meetupCategoryRoutes = require('./meetupCategory.routes');


const propertyRoutes = require('./property.routes');


router.use('/auth', authRoutes);
router.use('/pg', pgRoutes);
router.use('/properties', propertyRoutes);
router.use('/lead', leadRoutes);
router.use('/visit', visitRoutes);
router.use('/admin', adminRoutes);
router.use('/upload', uploadRoutes);
router.use('/meetups', meetupRoutes);
router.use('/app-version', appVersionRoutes);
router.use('/notifications', notificationRoutes);
router.use('/cities', cityRoutes);
router.use('/areas', areaRoutes);
router.use('/location', locationRoutes);
router.use('/meetup-categories', meetupCategoryRoutes);

// API info
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'PGinfo.online API v1',
    endpoints: ['/auth', '/pg', '/lead', '/visit', '/admin', '/upload', '/meetups', '/notifications', '/cities'],
  });
});

module.exports = router;
