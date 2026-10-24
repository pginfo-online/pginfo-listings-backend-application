const { logger } = require('../../utils/logger');
const HttpStatus = require('../constants/httpStatus');
const ErrorCodes = require('../constants/errorCodes');

/**
 * Production-Grade Express Error Handler
 */
const errorHandler = (err, req, res, next) => {
  try {
    let statusCode = err.statusCode || HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = err.errorCode || ErrorCodes.INTERNAL_ERROR;
    let message = err.message || 'Internal Server Error';
    let details = err.details || null;

    // Zod validation error
    if (err.name === 'ZodError' && err.issues) {
      statusCode = HttpStatus.BAD_REQUEST;
      errorCode = ErrorCodes.VALIDATION_ERROR;
      message = 'Request validation failed';
      details = err.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      }));
    }

    // Mongoose validation error
    else if (err.name === 'ValidationError' && err.errors) {
      statusCode = HttpStatus.BAD_REQUEST;
      errorCode = ErrorCodes.VALIDATION_ERROR;
      const errors = Object.values(err.errors).map((e) => e.message);
      message = errors.join(', ');
      details = Object.entries(err.errors).map(([field, e]) => ({
        field,
        message: e.message,
      }));
    }

    // Mongoose duplicate key error
    else if (err.code === 11000) {
      statusCode = HttpStatus.CONFLICT;
      errorCode = ErrorCodes.RESOURCE_CONFLICT;
      const field = err.keyValue ? Object.keys(err.keyValue)[0] : 'record';
      message = `${field.charAt(0).toUpperCase() + field.slice(1)} already exists`;
      details = { field, value: err.keyValue ? err.keyValue[field] : undefined };
    }

    // Mongoose cast error (invalid ObjectId)
    else if (err.name === 'CastError') {
      statusCode = HttpStatus.BAD_REQUEST;
      errorCode = ErrorCodes.BAD_REQUEST;
      message = `Invalid ID format for: ${err.path}`;
    }

    // JWT errors
    else if (err.name === 'JsonWebTokenError') {
      statusCode = HttpStatus.UNAUTHORIZED;
      errorCode = ErrorCodes.AUTH_TOKEN_INVALID;
      message = 'Invalid authentication token';
    } else if (err.name === 'TokenExpiredError') {
      statusCode = HttpStatus.UNAUTHORIZED;
      errorCode = ErrorCodes.AUTH_TOKEN_EXPIRED;
      message = 'Authentication token has expired. Please refresh your session.';
    }

    // Multer file upload errors
    else if (err.code === 'LIMIT_FILE_SIZE') {
      statusCode = HttpStatus.BAD_REQUEST;
      errorCode = ErrorCodes.BAD_REQUEST;
      message = 'File size exceeds maximum allowed limit (10MB)';
    }

    const requestId = req.id || req.headers['x-request-id'] || 'n/a';
    logger.error(`[${requestId}] ${req.method} ${req.originalUrl} → ${statusCode} [${errorCode}]: ${message}`);

    // CORS headers on error responses
    const origin = req.headers.origin;
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    }

    return res.status(statusCode).json({
      success: false,
      errorCode,
      message,
      ...(details && { details }),
      requestId,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
  } catch (handlerErr) {
    logger.error(`Error in errorHandler: ${handlerErr.message}`);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      errorCode: ErrorCodes.INTERNAL_ERROR,
      message: 'An unexpected internal error occurred',
    });
  }
};

module.exports = errorHandler;
