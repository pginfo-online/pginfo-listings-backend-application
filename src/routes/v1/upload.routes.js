const express = require('express');
const router = express.Router();
const { uploadImages, uploadVideo, deleteImage, deleteVideo } = require('../../controllers/upload.controller');
const { protect, authorize } = require('../../middlewares/auth.middleware');
const { imageUpload, videoUpload } = require('../../middlewares/upload.middleware');

router.post('/images', protect, authorize('owner', 'pg_owner', 'admin', 'tenant'), imageUpload.array('images', 20), uploadImages);
router.post('/video', protect, authorize('owner', 'pg_owner', 'admin', 'tenant'), videoUpload.single('video'), uploadVideo);
router.delete('/image/:pgId', protect, authorize('owner', 'pg_owner', 'admin'), deleteImage);
router.delete('/image/:id', protect, authorize('owner', 'pg_owner', 'admin'), deleteImage);
router.delete('/video/:pgId', protect, authorize('owner', 'pg_owner', 'admin'), deleteVideo);
router.delete('/video/:id', protect, authorize('owner', 'pg_owner', 'admin'), deleteVideo);

module.exports = router;
