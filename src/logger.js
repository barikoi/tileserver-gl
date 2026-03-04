import pino from 'pino';
import pinoHttp from 'pino-http';

const transport = pino.transport({
  target: 'pino-roll',
  options: {
    file: 'logs/access',
    frequency: 'daily',
    dateFormat: 'yyyy-MM-dd',
    extension: '.log',
    mkdir: true,
    limit: { count: 6 },
  },
});

const logger = pino(transport);

/**
 * Get standardized error messages for common HTTP status codes
 * Checks res.locals.errorMessage first for custom messages from middleware
 * @param {import('express').Response} res - Express response object
 * @returns {string|null} Standardized error message
 */
function getStandardErrorMessage(res) {
  // If response has a custom error message from middleware, use it
  if (res.locals?.errorMessage) {
    return res.locals.errorMessage;
  }

  // Fallback to status code based messages
  const statusCode = res.statusCode;
  if (statusCode === 401) return 'Missing API Key';
  if (statusCode === 403) return 'CORS policy: Origin not allowed';
  if (statusCode >= 500) return 'Server Error';
  if (statusCode >= 200 && statusCode < 400) return 'Request Completed';
  return null;
}

const httpLogger = pinoHttp({
  logger,
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (_req, res) => {
    return getStandardErrorMessage(res);
  },
  customErrorMessage: (_req, res) => {
    return getStandardErrorMessage(res);
  },
});

export { logger, httpLogger };
