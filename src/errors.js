class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, message, details);
const unauthorized = (message = 'Authentication required') => new ApiError(401, message);
const forbidden = (message = 'You do not have permission to do that') => new ApiError(403, message);
const notFound = (what = 'Resource') => new ApiError(404, `${what} not found`);
const conflict = (message) => new ApiError(409, message);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict };
