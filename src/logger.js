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
 * @param {number} statusCode - HTTP status code
 * @returns {string} Standardized error message
 */
function getStandardErrorMessage(statusCode) {
  if (statusCode === 401) return 'Missing API Key';
  if (statusCode === 403) return 'Forbidden';
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
    return getStandardErrorMessage(res.statusCode);
  },
  customErrorMessage: (_req, res) => {
    return getStandardErrorMessage(res.statusCode);
  },
});

export { logger, httpLogger };
