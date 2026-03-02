/**
 * Application configuration for TileServer GL
 * Centralized configuration loaded from environment variables
 *
 * @module app.config
 */

/**
 * Parse ALLOWED_ORIGINS from env (JSON array string)
 * @type {string[]}
 */
let allowedOrigins = [];
if (process.env.ALLOWED_ORIGINS) {
  try {
    const parsed = JSON.parse(process.env.ALLOWED_ORIGINS);
    allowedOrigins = Array.isArray(parsed) ? parsed : [];
  } catch {
    // Invalid JSON in env
  }
}

/**
 * Application configuration object
 * @typedef {Object} AppConfig
 * @property {Object} auth - Authentication settings
 * @property {string} auth.baseUrl - Base URL for validation API
 * @property {number} auth.timeout - Request timeout in milliseconds
 * @property {Object} cors - CORS settings
 * @property {boolean} cors.isCheckAllowedOrigins - Whether to check allowed origins
 * @property {string[]} cors.allowedOrigins - Global allowed origins from environment
 * @property {Object} validation - Validation settings
 * @property {string[]} validation.skipExtensions - File extensions to skip validation
 * @property {string[]} validation.skipPaths - Paths to skip validation (exact match)
 */

/**
 * Exported application configuration
 * @type {AppConfig}
 */
export const config = {
  /**
   * Authentication settings
   */
  auth: {
    /** Base URL for validation API (from AUTH_BASE_URL env) */
    baseUrl: process.env.AUTH_BASE_URL || '',
    /** Request timeout in milliseconds */
    timeout: 5000,
  },

  /**
   * CORS settings
   */
  cors: {
    /** Whether to check allowed origins (from IS_CHECK_ALLOWED_ORIGINS env) */
    isCheckAllowedOrigins: process.env.IS_CHECK_ALLOWED_ORIGINS !== 'false',
    /** Global allowed origins from ALLOWED_ORIGINS env (JSON array) */
    allowedOrigins: allowedOrigins,
  },

  /**
   * Validation settings
   */
  validation: {
    /** File extensions that skip API key validation */
    skipExtensions: ['.css', '.ico', '.png', '.jpg', '.svg', '.ttf'],
    /** Paths that skip API key validation (exact match) */
    skipPaths: ['/', '/health'],
  },
};
