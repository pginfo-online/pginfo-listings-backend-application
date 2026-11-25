const { cloudinary } = require('../config/cloudinary');

const assetOptions = { resource_type: 'raw', type: 'authenticated' };

function upload(file, folder, publicId) {
  return cloudinary.uploader.upload(file, {
    ...assetOptions,
    folder,
    public_id: publicId,
    overwrite: false,
    timeout: 120000,
  });
}

function downloadUrl(publicId) {
  return cloudinary.utils.private_download_url(publicId, null, {
    ...assetOptions,
    expires_at: Math.floor(Date.now() / 1000) + 120,
  });
}

function remove(publicId) {
  return cloudinary.uploader.destroy(publicId, { ...assetOptions, invalidate: true });
}

module.exports = { upload, downloadUrl, remove };
