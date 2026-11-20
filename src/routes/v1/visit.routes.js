const express = require('express');
const router = express.Router();
const { createVisit, getMyVisits, getPGVisits, updateVisitStatus, cancelMyVisit } = require('../../controllers/visit.controller');
const { protect, authorize } = require('../../middlewares/auth.middleware');
const validate = require('../../middlewares/validate.middleware');
const { createVisitSchema, updateVisitStatusSchema } = require('../../validators/visit.validator');

router.post('/', protect, authorize('tenant', 'owner', 'pg_owner', 'admin'), validate(createVisitSchema), createVisit);
router.get('/my', protect, authorize('tenant', 'owner', 'pg_owner', 'admin'), getMyVisits);
router.get('/pg/:pgId', protect, authorize('owner', 'pg_owner', 'admin'), getPGVisits);
router.put('/my/:id([0-9a-fA-F]{24})/cancel', protect, cancelMyVisit);
router.put('/:id([0-9a-fA-F]{24})/status', protect, authorize('owner', 'pg_owner', 'admin'), validate(updateVisitStatusSchema), updateVisitStatus);

module.exports = router;
