/**
 * Application configuration for TileServer GL
 * Centralized configuration loaded from environment variables
 * @module app.config
 */

/**
 * Application configuration object
 * @typedef {object} AppConfig
 * @property {object} auth - Authentication settings
 * @property {string} auth.baseUrl - Base URL for validation API (dynamic mode)
 * @property {number} auth.timeout - Request timeout in milliseconds
 * @property {'static'|'dynamic'} auth.mode - Auth mode (defaults to 'dynamic')
 * @property {string[]} auth.accessTokens - Static access tokens from comma-separated ACCESS_TOKEN env (required when mode === 'static')
 * @property {object} cors - CORS settings
 * @property {boolean} cors.isCheckAllowedOrigins - Whether to check allowed origins
 * @property {string[]} cors.allowedOrigins - Allowed origins for static mode
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
    /** Base URL for validation API (from AUTH_BASE_URL env). Required in dynamic mode. */
    baseUrl: process.env.AUTH_BASE_URL || '',
    /** Request timeout in milliseconds */
    timeout: 5000,
    /** Auth mode: 'static' (use ACCESS_TOKEN) or 'dynamic' (call AUTH_BASE_URL). Defaults to 'dynamic'. */
    mode: process.env.AUTH_MODE || 'dynamic',
    /**
     * Static access tokens parsed from comma-separated ACCESS_TOKEN env var.
     * A request is valid in static mode if its ?key= matches any token.
     * Required (at least one) when mode === 'static'.
     */
    accessTokens: (process.env.ACCESS_TOKEN || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  /**
   * CORS settings
   */
  cors: {
    /** Whether to check allowed origins (from IS_CHECK_ALLOWED_ORIGINS env) */
    isCheckAllowedOrigins: process.env.IS_CHECK_ALLOWED_ORIGINS !== 'false',
    /**
     * Comma-separated allowed origins for static mode (from ALLOWED_ORIGINS env).
     * Domain-only matching with wildcard support.
     */
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
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

/**
 * Validate that the selected auth mode has its required env vars set.
 * Called at module load — throws on misconfiguration (fail-fast at startup).
 * @param {typeof config} cfg - Config object to validate
 * @throws {Error} with a FATAL-prefixed message on violation
 */
function validateConfig(cfg) {
  if (cfg.auth.mode !== 'static' && cfg.auth.mode !== 'dynamic') {
    throw new Error(
      `FATAL: AUTH_MODE must be 'static' or 'dynamic' (got: '${cfg.auth.mode}'). ` +
        `Set AUTH_MODE to 'static' (uses ACCESS_TOKEN + ALLOWED_ORIGINS) or 'dynamic' (uses AUTH_BASE_URL). ` +
        `Leave AUTH_MODE unset to default to 'dynamic'.`,
    );
  }
  if (cfg.auth.mode === 'static' && cfg.auth.accessTokens.length === 0) {
    throw new Error(
      'FATAL: AUTH_MODE=static requires ACCESS_TOKEN. ' +
        'Either set ACCESS_TOKEN (comma-separated for multiple) to the static key(s) clients must send as ?key=, ' +
        "or change AUTH_MODE to 'dynamic' (and set AUTH_BASE_URL) to validate keys via the remote API.",
    );
  }
  if (cfg.auth.mode === 'dynamic' && !cfg.auth.baseUrl) {
    throw new Error(
      'FATAL: AUTH_MODE=dynamic requires AUTH_BASE_URL. ' +
        'Either set AUTH_BASE_URL to the validation API base URL, or change AUTH_MODE to ' +
        "'static' (and set ACCESS_TOKEN + ALLOWED_ORIGINS) to use a static key with no remote validation.",
    );
  }
}

validateConfig(config);
