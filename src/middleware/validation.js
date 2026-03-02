/**
 * @module middleware/validation
 * @description API Key validation + CORS middleware for TileServer GL
 *
 * Validates API Key against external service (Redis caching handled by backend).
 * Also handles CORS based on allowed origins from validation response.
 *
 * Supports wildcard origin patterns like Mapbox:
 * - https://*.example.com → matches https://app.example.com, https://www.example.com
 * - https://example.com/* → matches any path on example.com
 *
 * @requires cors
 * @requires module:app.config
 *
 * @example
 * // Environment Variables:
 * // AUTH_BASE_URL: Base URL to validation API (e.g., https://api.example.com)
 * // ALLOWED_ORIGINS: JSON array of allowed origins (e.g., ["http://localhost:4000"])
 * // IS_CHECK_ALLOWED_ORIGINS: Set to false to allow all origins (default: true)
 */

import cors from 'cors';
import { config } from '../app.config.js';

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
 * Convert wildcard pattern to regex (Mapbox-style)
 *
 * Supports `*` which matches any characters including `/`
 *
 * @param {string} pattern - Wildcard pattern (e.g., https://*.example.com/*)
 * @returns {RegExp} Regex pattern for matching origins
 * @example
 * patternToRegex('https://*.example.com')
 * // Returns /^https:\/\/*.+\.example\.com$/i
 */
function patternToRegex(pattern) {
  // Escape special regex characters except *
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  return new RegExp(`^${regex}$`, 'i');
}

/**
 * Check if origin matches allowed pattern (with wildcard support)
 *
 * @param {string} origin - Request origin (e.g., https://app.example.com)
 * @param {string[]} allowedOrigins - List of allowed origin patterns
 * @returns {boolean} True if origin is allowed, false otherwise
 * @example
 * isOriginAllowed('https://app.example.com', ['https://*.example.com'])
 * // Returns true
 *
 * isOriginAllowed('https://evil.com', ['https://*.example.com'])
 * // Returns false
 */
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return false;

  for (const pattern of allowedOrigins) {
    // Exact match
    if (pattern === origin) return true;

    // Wildcard pattern match
    if (pattern.includes('*')) {
      try {
        const regex = patternToRegex(pattern);
        if (regex.test(origin)) return true;
      } catch {
        // Invalid pattern, skip
      }
    }
  }

  return false;
}

/**
 * Validation result from API key validation
 * @typedef {Object} ValidationResult
 * @property {boolean} is_valid - Whether the API key is valid
 * @property {string[]} allowed_origins - Combined list of global and key-specific allowed origins
 */

/**
 * Validate API Key by calling external service
 *
 * Makes a request to the validation API with timeout protection.
 * On failure (non-OK response, timeout, or network error), returns invalid result.
 *
 * @param {string} apiKey - The API Key to validate
 * @returns {Promise<ValidationResult>} Validation result with combined allowed origins
 * @throws {never} All errors are caught and return invalid result
 * @example
 * const result = await validateApiKey('my-api-key')
 * if (result.is_valid) {
 *   console.log('Allowed origins:', result.allowed_origins)
 * }
 */
async function validateApiKey(apiKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.auth.timeout);

  try {
    const url = `${config.auth.baseUrl}/api/validation?api_key=${apiKey}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error('[Validation] Auth service returned:', response.status);
      return { is_valid: false, allowed_origins: [] };
    }

    const data = await response.json();

    // Always include global env origins + API response origins
    const origins = [
      ...config.cors.allowedOrigins,
      ...(data?.allowed_origins || []),
    ];

    return {
      is_valid: data?.is_valid ?? false,
      allowed_origins: origins,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error('[Validation] API key validation timeout');
    } else {
      console.error('[Validation] API key validation error:', error.message);
    }
    return { is_valid: false, allowed_origins: [] };
  }
}

/**
 * Check if a request should skip validation based on file extension or path
 *
 * Static assets skip API key validation
 * Public paths (health endpoint) also skip validation
 *
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
 *
 * @param {string[]} allowedOrigins - List of allowed origin patterns (can include wildcards)
 * @returns {import('express').RequestHandler} Express middleware handler
 * @example
 * const middleware = createCorsMiddleware(['https://*.example.com'])
 * app.use(middleware)
 */
function createCorsMiddleware(allowedOrigins) {
  // Reuse cached instance when origin checking is disabled
  if (!config.cors.isCheckAllowedOrigins) {
    return allowAllCorsMiddleware;
  }

  // Dynamic CORS needed - must create per-request (origins vary per API key)
  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);

      if (isOriginAllowed(origin, allowedOrigins)) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Blocked origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });
}

/**
 * Express middleware for API Key validation + CORS
 *
 * Flow:
 * 1. Skip validation for static assets (based on file extension)
 * 2. Check for API key in query parameter `key`
 * 3. Validate API key against external service
 * 4. Apply CORS with combined allowed origins (global + key-specific)
 *
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 * @returns {Promise<void>}
 * @throws {never} Responds with 401 for missing/invalid API key
 *
 * @example
 * // In your Express app:
 * import { validationMiddleware } from './middleware/validation.js'
 * app.use(validationMiddleware)
 *
 * @example
 * // Request with API key:
 * // GET /tiles/1/2/3.pbf?key=my-api-key
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
    return next();
  }

  // Get API Key from query param
  const apiKey = req.query.key;
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API Key' });
  }

  // Validate API Key and get allowed origins
  const result = await validateApiKey(apiKey);
  if (!result.is_valid) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  // Apply CORS with validated origins
  const corsMiddleware = createCorsMiddleware(result.allowed_origins);

  // Handle OPTIONS preflight for authenticated paths
  if (req.method === 'OPTIONS') {
    return corsMiddleware(req, res, () => {
      res.status(204).end();
    });
  }

  // Apply CORS and continue to next middleware
  corsMiddleware(req, res, next);
}
