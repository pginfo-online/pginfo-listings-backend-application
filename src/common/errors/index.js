const AppError = require('./AppError');
const HttpStatus = require('../constants/httpStatus');
const ErrorCodes = require('../constants/errorCodes');

class BadRequestError extends AppError {
  constructor(message = 'Bad Request', errorCode = ErrorCodes.BAD_REQUEST, details = null) {
    super(message, HttpStatus.BAD_REQUEST, errorCode, details);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', errorCode = ErrorCodes.AUTH_UNAUTHORIZED, details = null) {
    super(message, HttpStatus.UNAUTHORIZED, errorCode, details);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden', errorCode = ErrorCodes.AUTH_FORBIDDEN, details = null) {
    super(message, HttpStatus.FORBIDDEN, errorCode, details);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found', errorCode = ErrorCodes.NOT_FOUND, details = null) {
    super(message, HttpStatus.NOT_FOUND, errorCode, details);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict', errorCode = ErrorCodes.RESOURCE_CONFLICT, details = null) {
    super(message, HttpStatus.CONFLICT, errorCode, details);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = null) {
    super(message, HttpStatus.UNPROCESSABLE_ENTITY, ErrorCodes.VALIDATION_ERROR, details);
  }
}

module.exports = {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
};
