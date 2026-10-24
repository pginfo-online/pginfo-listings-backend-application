/**
 * Slug Generation Utility
 */

/**
 * Convert string into URL-friendly slug
 * @param {string} text 
 * @returns {string}
 */
const slugify = (text) => {
  if (!text || typeof text !== 'string') return '';

  return text
    .toString()
    .toLowerCase()
    .trim()
    .normalize('NFD') // separate accents from letters
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9\s-]/g, '') // remove invalid chars
    .replace(/[\s_-]+/g, '-') // collapse whitespace and underscores to -
    .replace(/^-+|-+$/g, ''); // trim leading/trailing -
};

/**
 * Generate a property listing slug: e.g. "stanza-living-wakad-pune-7b117b"
 * @param {object} params
 * @param {string} params.title
 * @param {string} [params.area]
 * @param {string} [params.city]
 * @param {string} [params.id]
 * @returns {string}
 */
const generatePropertySlug = ({ title, area, city, id, category = 'property' }) => {
  const parts = [];
  const cleanTitleSlug = slugify(title);
  if (cleanTitleSlug) {
    parts.push(cleanTitleSlug);
  } else {
    parts.push(slugify(category) || 'property');
  }
  if (area && area.length < 50) parts.push(slugify(area));
  if (city) parts.push(slugify(city));
  if (id) {
    const idStr = id.toString();
    parts.push(idStr.slice(-6));
  }
  return parts.filter(Boolean).join('-').replace(/^-+|-+$/g, '');
};

module.exports = {
  slugify,
  generatePropertySlug,
};
