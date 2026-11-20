const multer = require('multer');

const storage = multer.memoryStorage();
const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
const videoTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];

function createUpload(allowedTypes, fileSize, files) {
  return multer({
    storage,
    limits: { fileSize, files, fields: 30, fieldSize: 32768, parts: files + 30 },
    fileFilter(_req, file, callback) {
      if (allowedTypes.includes(file.mimetype)) return callback(null, true);
      return callback(Object.assign(new Error('Unsupported media file type.'), { statusCode: 415 }));
    },
  });
}

module.exports = {
  imageUpload: createUpload(imageTypes, 8 * 1024 * 1024, 20),
  videoUpload: createUpload(videoTypes, 50 * 1024 * 1024, 1),
};
