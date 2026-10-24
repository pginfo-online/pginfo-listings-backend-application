// Production Grade Error Middleware (delegates to centralized common errorHandler)
const errorHandler = require('../common/middleware/errorHandler');

module.exports = errorHandler;
