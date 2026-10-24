const crypto = require('crypto');

/**
 * Request Correlation ID Middleware
 * Assigns a unique ID to every incoming request for end-to-end tracing across logs.
 */
const correlationMiddleware = (req, res, next) => {
  const correlationId =
    req.headers['x-request-id'] ||
    req.headers['x-correlation-id'] ||
    crypto.randomUUID();

  req.id = correlationId;
  res.setHeader('X-Request-Id', correlationId);
  next();
};

module.exports = correlationMiddleware;
