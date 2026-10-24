const HttpStatus = require('../constants/httpStatus');
const ErrorCodes = require('../constants/errorCodes');

/**
 * Base Application Error
 */
class AppError extends Error {
  constructor(
    message = 'An unexpected error occurred',
    statusCode = HttpStatus.INTERNAL_SERVER_ERROR,
    errorCode = ErrorCodes.INTERNAL_ERROR,
    details = null
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
