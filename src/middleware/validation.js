/**
 * API Key validation + CORS middleware for TileServer GL
 * Validates API Key against external service (Redis caching handled by backend)
 * Also handles CORS based on allowed origins from validation response
 *
 * Supports wildcard origin patterns like Mapbox:
 * - https://*.example.com → matches https://app.example.com, https://www.example.com
 * - https://example.com/* → matches any path on example.com
 *
 * Environment Variables:
 * - AUTH_BASE_URL: Base URL to validation API (e.g., https://api.example.com)
 * - ALLOWED_ORIGINS: JSON array of allowed origins (e.g., ["http://localhost:4000"])
 * - IS_CHECK_ALLOWED_ORIGINS: Set to false to allow all origins (default: true)
 */

import cors from 'cors';

// Configuration
const IS_CHECK_ALLOWED_ORIGINS =
  process.env.IS_CHECK_ALLOWED_ORIGINS !== 'false';

/**
 * Convert wildcard pattern to regex (Mapbox-style)
 * Supports:
 * - * (matches any characters including /)
 * @param {string} pattern - Wildcard pattern (e.g., https://*.example.com/*)
 * @returns {RegExp} - Regex pattern
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
 * @param {string} origin - Request origin (e.g., https://app.example.com)
 * @param {string[]} allowedOrigins - List of allowed origin patterns
 * @returns {boolean} - True if origin is allowed
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
 * Validate API Key by calling external service
 * @param {string} apiKey - The API Key to validate
 * @returns {Promise<{ is_valid: boolean, allowed_origins: string[] }>} - Validation result with origins
 */
async function validateApiKey(apiKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `${process.env.AUTH_BASE_URL}/api/validation?api_key=${apiKey}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error('[Validation] Auth service returned:', response.status);
      return { is_valid: false, allowed_origins: [] };
    }

    const data = await response.json();

    // Parse ALLOWED_ORIGINS from env (JSON array string)
    let envOrigins = [];
    if (process.env.ALLOWED_ORIGINS) {
      try {
        const parsed = JSON.parse(process.env.ALLOWED_ORIGINS);
        envOrigins = Array.isArray(parsed) ? parsed : [];
      } catch {
        // Invalid JSON in env
      }
    }

    // Priority: env > API response > empty array
    const origins = envOrigins?.length
      ? envOrigins
      : data?.allowed_origins?.length
        ? data?.allowed_origins
        : [];

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

// Public paths (exact match)
const PUBLIC_PATHS = ['/', '/index.css', '/favicon.ico'];

// Reusable CORS middleware for public paths
const publicCorsMiddleware = cors({ origin: '*' });

/**
 * Check if a request should skip validation
 * @param {string} path - Request path
 * @returns {boolean} - True if should skip validation, false otherwise
 */
function shouldSkipValidation(path) {
  // Exact path matches
  if (PUBLIC_PATHS.includes(path)) return true;
  // All images are public
  if (path.startsWith('/images/')) return true;
  return false;
}

/**
 * Create CORS middleware with dynamic origin based on allowed origins
 * @param {string[]} allowedOrigins - List of allowed origin patterns
 * @returns {import('express').RequestHandler} Express middleware handler
 */
function createCorsMiddleware(allowedOrigins) {
  // If origin checking is disabled, use cors package with wildcard '*'
  if (!IS_CHECK_ALLOWED_ORIGINS) {
    return cors({
      origin: '*',
      methods: ['GET', 'HEAD', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
    });
  }

  // Otherwise, check against allowed origins
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
 * Skips validation for public assets
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 * @returns {Promise<void>}
 */
export async function validationMiddleware(req, res, next) {
  // Handle OPTIONS preflight for public paths
  if (req.method === 'OPTIONS' && shouldSkipValidation(req.path)) {
    return publicCorsMiddleware(req, res, () => {
      res.status(204).end();
    });
  }

  // Skip validation for public assets
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
