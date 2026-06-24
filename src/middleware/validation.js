/**
 * @module middleware/validation
 * @description API Key validation + CORS middleware for TileServer GL
 *
 * Validates API Key against external service (Redis caching handled by backend).
 * Also handles CORS based on allowed origins from validation response.
 *
 * Supports wildcard origin patterns (domain-only, no protocol):
 * - *.example.com → matches https://app.example.com, http://www.example.com
 * - example.com → matches https://example.com, http://example.com
 * @requires cors
 * @requires module:app.config
 * @example
 * // Environment Variables:
 * // AUTH_BASE_URL: Base URL to validation API (e.g., https://api.example.com)
 * // IS_CHECK_ALLOWED_ORIGINS: Set to false to allow all origins (default: true)
 */

import cors from 'cors';
import { config } from '../app.config.js';
import { logger } from '../logger.js';

/**
 * Get request-scoped logger or fallback to base logger
 * Ensures logging works even if httpLogger hasn't initialized req.log
 * @param {import('express').Request} req - Express request object
 * @returns {import('pino').Logger} Logger instance with request context
 */
function getLogger(req) {
  return req.log ?? logger;
}

/**
 * Reusable CORS middleware for skipped validation paths
 * @type {import('express').RequestHandler}
 */
const skipValidationCorsMiddleware = cors({ origin: '*' });

/**
 * Cached CORS middleware for allow-all scenario (when origin checking is disabled)
 * @type {import('express').RequestHandler}
 */
const allowAllCorsMiddleware = cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
});

/**
 * Extract host from a URL/origin string (removes protocol).
 * @param {string} origin - Full URL or origin
 * @returns {string} Host (hostname[:port])
 */
function stripProtocol(origin) {
  try {
    const url = new URL(origin);
    return url.hostname; // hostname without port
  } catch {
    // fallback for non-standard inputs
    return origin.replace(/^[a-z]+:\/\//i, '');
  }
}

/**
 * Convert a domain wildcard pattern to RegExp.
 * `*` matches within a single domain label (not across dots).
 * @param {string} pattern - Wildcard pattern (e.g., "*.example.com")
 * @returns {RegExp} Regex for matching domain patterns
 */
function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*'); // wildcard matches across dots for multi-level subdomains

  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Check if origin matches allowed pattern (with wildcard support)
 * Strips protocol from origin for domain-only matching
 * @param {string} origin - Request origin (e.g., https://app.example.com)
 * @param {string[]} allowedOrigins - List of domain-only allowed origin patterns
 * @returns {boolean} True if origin is allowed, false otherwise
 * @example
 * isOriginAllowed('https://app.example.com', ['*.example.com'])
 * // Returns true
 *
 * isOriginAllowed('https://evil.com', ['*.example.com'])
 * // Returns false
 *
 * isOriginAllowed('https://any.domain.com', ['*'])
 * // Returns true
 */
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return false;

  // Strip protocol for domain-only pattern matching
  const hostname = stripProtocol(origin);

  for (const pattern of allowedOrigins) {
    // Wildcard allows all origins
    if (pattern === '*') return true;

    // Exact match (domain-only)
    if (pattern === hostname) return true;

    // Wildcard pattern match
    if (pattern.includes('*')) {
      try {
        const regex = patternToRegex(pattern);
        if (regex.test(hostname)) return true;
      } catch {
        // Invalid pattern, skip
      }
    }
  }

  return false;
}

/**
 * Validation result from API key validation
 * @typedef {object} ValidationResult
 * @property {boolean} is_valid - Whether the API key is valid
 * @property {string[]} allowed_origins - Combined list of global and key-specific allowed origins
 */

/**
 * Validate API Key by calling external service
 *
 * Makes a request to the validation API with timeout protection.
 * On failure (non-OK response, timeout, or network error), returns invalid result.
 * @param {string} apiKey - The API Key to validate
 * @param {import('express').Request} [req] - Express request object for request-scoped logging
 * @returns {Promise<ValidationResult>} Validation result with combined allowed origins
 * @throws {never} All errors are caught and return invalid result
 * @example
 * const result = await validateApiKey('my-api-key')
 * if (result.is_valid) {
 *   console.log('Allowed origins:', result.allowed_origins)
 * }
 */
async function validateApiKey(apiKey, req) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.auth.timeout);
  const log = getLogger(req);

  try {
    const url = `${config.auth.baseUrl}/api/validation?api_key=${apiKey}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      log.error(
        { statusCode: response.status, apiKey: apiKey.substring(0, 8) + '...' },
        'Auth service returned non-OK status',
      );
      return { is_valid: false, allowed_origins: [] };
    }

    const data = await response.json();

    return {
      is_valid: data?.is_valid ?? false,
      allowed_origins: data?.allowed_origins || [],
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      log.error(
        { errorType: 'AbortError', timeout: config.auth.timeout },
        'API key validation timeout',
      );
    } else {
      log.error({ err: error }, 'API key validation error');
    }
    return { is_valid: false, allowed_origins: [] };
  }
}

/**
 * Check if a request should skip validation based on file extension or path
 *
 * Static assets skip API key validation
 * Public paths (health endpoint) also skip validation
 * @param {string} path - Request path (e.g., /styles/main.css)
 * @returns {boolean} True if should skip validation, false otherwise
 * @example
 * shouldSkipValidation('/styles/main.css') // Returns true
 * shouldSkipValidation('/health') // Returns true
 * shouldSkipValidation('/tiles/1/2/3.pbf') // Returns false
 */
function shouldSkipValidation(path) {
  // Check file extension
  if (config.validation.skipExtensions.some((ext) => path.endsWith(ext))) {
    return true;
  }
  // Check public paths
  if (config.validation.skipPaths?.includes(path)) {
    return true;
  }
  return false;
}

/**
 * Create CORS middleware with dynamic origin based on allowed origins
 * @param {string[]} allowedOrigins - List of domain-only allowed origin patterns (can include wildcards)
 * @param {import('express').Request} [req] - Express request object for request-scoped logging
 * @returns {import('express').RequestHandler} Express middleware handler
 * @example
 * const middleware = createCorsMiddleware(['*.example.com'])
 * app.use(middleware)
 */
function createCorsMiddleware(allowedOrigins, req) {
  // Reuse cached instance when origin checking is disabled
  if (!config.cors.isCheckAllowedOrigins) {
    return allowAllCorsMiddleware;
  }

  const log = getLogger(req);

  // Create the CORS middleware
  const corsMiddleware = cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);

      if (isOriginAllowed(origin, allowedOrigins)) {
        callback(null, true);
      } else {
        log.warn({ origin, allowedOrigins }, 'CORS: Blocked origin');
        // Create a proper CORS error with status code
        const corsError = new Error('Origin not allowed');
        corsError.status = 403;
        corsError.message = 'CORS policy: Origin not allowed';
        callback(corsError);
      }
    },
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });

  // Wrap to set res.locals.errorMessage for logging sync
  return (req, res, next) => {
    corsMiddleware(req, res, (err) => {
      if (err && err.status === 403) {
        res.locals.errorMessage = 'CORS policy: Origin not allowed';
      }
      next(err);
    });
  };
}

/**
 * Apply CORS to the response and continue. Shared by both auth handlers.
 *
 * On OPTIONS, the CORS middleware short-circuits with 204 No Content.
 * Otherwise it decorates the response and yields to the next middleware.
 *
 * @param {string[]} allowedOrigins - Origins to permit (passed to createCorsMiddleware)
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 * @returns {void}
 */
function applyCorsAndContinue(allowedOrigins, req, res, next) {
  const corsMiddleware = createCorsMiddleware(allowedOrigins, req);
  if (req.method === 'OPTIONS') {
    return corsMiddleware(req, res, () => res.status(204).end());
  }
  return corsMiddleware(req, res, next);
}

/**
 * Static-mode auth handler.
 * Validates ?key= against config.auth.accessTokens (any match authenticates);
 * applies CORS from config.cors.allowedOrigins. No call to AUTH_BASE_URL.
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 * @returns {Promise<void>}
 */
async function handleStaticAuth(req, res, next) {
  const token = req.query.key;
  if (!token || !config.auth.accessTokens.includes(token)) {
    res.locals.errorMessage = 'Invalid token';
    getLogger(req).warn(
      {
        origin: req.headers.origin,
        keyPrefix: token ? String(token).substring(0, 8) + '...' : null,
      },
      'Static auth: invalid token',
    );
    return res.status(401).json({ error: 'Invalid token' });
  }

  return applyCorsAndContinue(config.cors.allowedOrigins, req, res, next);
}

/**
 * Dynamic-mode auth handler (existing behavior, extracted verbatim).
 * Validates ?key= via AUTH_BASE_URL; applies CORS from API response.
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 * @returns {Promise<void>}
 */
async function handleDynamicAuth(req, res, next) {
  const apiKey = req.query.key;
  if (!apiKey) {
    res.locals.errorMessage = 'Missing API Key';
    return res.status(401).json({ error: 'Missing API Key' });
  }

  const result = await validateApiKey(apiKey, req);
  if (!result.is_valid) {
    res.locals.errorMessage = 'Invalid API Key';
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  return applyCorsAndContinue(result.allowed_origins, req, res, next);
}

/**
 * Express middleware: API key validation + CORS.
 *
 * Shared prelude (skip-validation, OPTIONS preflight for skipped paths) runs
 * for both modes. Dispatches to the mode-specific handler based on
 * config.auth.mode.
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 * @returns {Promise<void>}
 * @example
 * // In your Express app:
 * import { validationMiddleware } from './middleware/validation.js'
 * app.use(validationMiddleware)
 */
export async function validationMiddleware(req, res, next) {
  // Handle OPTIONS preflight for skipped validation paths
  if (req.method === 'OPTIONS' && shouldSkipValidation(req.path)) {
    return skipValidationCorsMiddleware(req, res, () => {
      res.status(204).end();
    });
  }

  // Skip validation for static assets
  if (shouldSkipValidation(req.path)) {
    return skipValidationCorsMiddleware(req, res, next);
  }

  // Mode dispatch (decided once at config-load)
  if (config.auth.mode === 'static') {
    return handleStaticAuth(req, res, next);
  }
  return handleDynamicAuth(req, res, next);
}
