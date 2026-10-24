/**
 * Pagination Utility
 */

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Parse pagination parameters from request query
 * @param {object} query
 * @param {object} defaults
 * @returns {{page: number, limit: number, skip: number}}
 */
const parsePagination = (query = {}, defaults = {}) => {
  const defaultPage = defaults.page || DEFAULT_PAGE;
  const defaultLimit = defaults.limit || DEFAULT_LIMIT;
  const maxLimit = defaults.maxLimit || MAX_LIMIT;

  const rawPage = parseInt(query.page, 10);
  const rawLimit = parseInt(query.limit, 10);

  const page = !isNaN(rawPage) && rawPage > 0 ? rawPage : defaultPage;
  const limit = !isNaN(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit;
  const skip = (page - 1) * limit;

  return { page, limit, skip };
};

/**
 * Format standard pagination response envelope
 * @param {object} params
 * @param {Array} params.data
 * @param {number} params.total
 * @param {number} params.page
 * @param {number} params.limit
 * @returns {object}
 */
const formatPaginatedResponse = ({ data, total, page, limit }) => {
  const totalPages = Math.ceil(total / limit) || 1;
  return {
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
};

module.exports = {
  parsePagination,
  formatPaginatedResponse,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
