const express = require('express');
const router = express.Router();
const { addLead, getMyLeads, getPGLeads } = require('../../controllers/lead.controller');
const { protect, authorize } = require('../../middlewares/auth.middleware');

router.post('/', protect, authorize('tenant', 'owner', 'pg_owner', 'admin'), addLead);
router.get('/my', protect, authorize('tenant', 'owner', 'pg_owner', 'admin'), getMyLeads);
router.get('/pg/:pgId', protect, authorize('owner', 'pg_owner', 'admin'), getPGLeads);

module.exports = router;
