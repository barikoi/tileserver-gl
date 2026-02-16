/**
 * Authentication middleware for TileServer GL
 * Validates API keys against external auth service with in-memory caching
 *
 * Environment Variables:
 * - AUTH_BASE_URL: Base URL to auth API (e.g., https://api.example.com)
 */

// In-memory cache for API key validation results
const authCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get cached validation result
 * @param {string} key - API key
 * @returns {boolean|null} - Cached result or null if not cached/expired
 */
function getCached(key) {
  const item = authCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    authCache.delete(key);
    return null;
  }
  return item.value;
}

/**
 * Cache validation result
 * @param {string} key - API key
 * @param {boolean} value - Validation result
 */
function setCached(key, value) {
  authCache.set(key, { value, expiry: Date.now() + CACHE_TTL });
}

/**
 * Check if API key is valid by calling external auth service
 * @param {string} apiKey - The API key to validate
 * @returns {Promise<boolean>} - True if valid, false otherwise
 */
async function checkKey(apiKey) {
  // Check cache first
  const cached = getCached(apiKey);
  if (cached !== null) {
    return cached;
  }

  try {
    const url = `${process.env.AUTH_BASE_URL}/api/validation?api_key=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      return false;
    }

    const data = await response.json();

    // Cache the result
    setCached(apiKey, data.is_valid);

    return data.is_valid;
  } catch (error) {
    console.error('Auth validation error:', error.message);
    // Return cached value on error, or false if not cached
    return cached ?? false;
  }
}

// Public paths (exact match)
const PUBLIC_PATHS = ['/', '/index.css', '/favicon.ico'];

/**
 * Check if a request should skip authentication
 * @param {string} path - Request path
 * @returns {boolean} - True if should skip auth, false otherwise
 */
function shouldSkipAuth(path) {
  // Exact path matches
  if (PUBLIC_PATHS.includes(path)) return true;
  // All images are public
  if (path.startsWith('/images/')) return true;
  return false;
}

/**
 * Express middleware for API key validation
 * Skips authentication for public assets
 */
export async function authMiddleware(req, res, next) {
  // Skip auth for public assets
  if (shouldSkipAuth(req.path)) {
    return next();
  }

  // Check for API key in query parameter
  if (!req.query.key) {
    return res.status(401).send('Missing access token');
  }

  // Validate API key
  const isValid = await checkKey(req.query.key);
  if (!isValid) {
    return res.status(401).send('Invalid access token');
  }

  next();
}
