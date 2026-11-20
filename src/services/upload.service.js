const { uploadToCloudinary, deleteFromCloudinary } = require('../config/cloudinary');

/**
 * Upload multiple images to Cloudinary
 * @param {Express.Multer.File[]} files
 * @param {string} folder
 * @returns {Promise<Array>}
 */
const uploadImages = async (files, folder = 'pginfo/pg-photos') => {
  const uploads = files.map(async (file) => {
    const result = await uploadToCloudinary(file.buffer, folder, 'image');
    return {
      url: result.secure_url,
      publicId: result.public_id,
      isMain: false,
    };
  });

  const results = await Promise.allSettled(uploads);
  const failed = results.find((result) => result.status === 'rejected');
  const completed = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (failed) {
    await Promise.allSettled(completed.map(({ publicId }) => deleteFromCloudinary(publicId, 'image')));
    throw failed.reason;
  }
  return completed;
};

/**
 * Upload a single video to Cloudinary
 */
const uploadVideo = async (file, folder = 'pginfo/pg-videos') => {
  const result = await uploadToCloudinary(file.buffer, folder, 'video');
  return {
    url: result.secure_url,
    publicId: result.public_id,
  };
};

/**
 * Delete multiple assets from Cloudinary by publicIds
 */
const deleteAssets = async (publicIds, resourceType = 'image') => {
  const deletes = publicIds.map((id) => deleteFromCloudinary(id, resourceType));
  return Promise.all(deletes);
};

module.exports = { uploadImages, uploadVideo, deleteAssets };
