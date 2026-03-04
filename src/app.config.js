/**
 * Application configuration for TileServer GL
 * Centralized configuration loaded from environment variables
 * @module app.config
 */

/**
 * Application configuration object
 * @typedef {object} AppConfig
 * @property {object} auth - Authentication settings
 * @property {string} auth.baseUrl - Base URL for validation API
 * @property {number} auth.timeout - Request timeout in milliseconds
 * @property {object} cors - CORS settings
 * @property {boolean} cors.isCheckAllowedOrigins - Whether to check allowed origins
 * @property {object} validation - Validation settings
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
