/**
 * Geospatial Utility
 */

/**
 * Checks whether coordinates represent valid non-null coordinates
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {boolean}
 */
const isValidCoordinates = (lng, lat) => {
  if (typeof lng !== 'number' || typeof lat !== 'number') return false;
  if (isNaN(lng) || isNaN(lat)) return false;
  if (lng < -180 || lng > 180) return false;
  if (lat < -90 || lat > 90) return false;
  // Check if exactly at Null Island [0, 0]
  if (lng === 0 && lat === 0) return false;
  return true;
};

/**
 * Build GeoJSON Point safely. Returns undefined if coordinates are invalid or [0, 0]
 * @param {number|string} lng
 * @param {number|string} lat
 * @returns {{type: 'Point', coordinates: [number, number]}|undefined}
 */
const buildGeoPoint = (lng, lat) => {
  const numLng = parseFloat(lng);
  const numLat = parseFloat(lat);

  if (isValidCoordinates(numLng, numLat)) {
    return {
      type: 'Point',
      coordinates: [numLng, numLat],
    };
  }
  return undefined;
};

module.exports = {
  isValidCoordinates,
  buildGeoPoint,
};
