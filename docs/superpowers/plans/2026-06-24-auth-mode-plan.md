# Static-vs-Dynamic Auth Mode — Implementation Plan

> Status: **Awaiting user approval of spec** at `docs/superpowers/specs/2026-06-24-auth-mode-design.md`.
>
> Do not execute this plan until the spec is reviewed and approved. No source code changed. No commits made. `.env.example` already updated as Step 4 of this plan.

---

## Critical Files

- `src/app.config.js` — config module (extend with `mode`, `accessTokens`, `allowedOrigins`, startup validator)
- `src/middleware/validation.js` — auth+CORS chokepoint (refactor `validationMiddleware` into dispatcher + two handlers)
- `.env.example` — **already updated** (Step 4 below is already complete)
- `test/test-origins.js` — existing origin tests (extend)
- `test/test-static-auth.js` — new static-mode middleware tests (create)
- `test/test-config-validation.js` — new startup-validation tests (create)

## Reusable Helpers (do NOT reimplement)

- `isOriginAllowed(origin, allowedOrigins)` — `src/middleware/validation.js:94`
- `createCorsMiddleware(allowedOrigins, req)` — `src/middleware/validation.js:214` (already returns `allowAllCorsMiddleware` when `isCheckAllowedOrigins === false`)
- `validateApiKey(apiKey, req)` — `src/middleware/validation.js:143`
- `shouldSkipValidation(path)` — `src/middleware/validation.js:193`
- `getLogger(req)` — `src/middleware/validation.js:29`
- `skipValidationCorsMiddleware`, `allowAllCorsMiddleware` — cached CORS instances

---

## Step 0 — TDD setup (test scaffolding first)

Following superpowers `test-driven-development`:

1. Read existing `test/setup.js` and `test/test-origins.js` to confirm the harness pattern (mocha + chai + supertest, server on port 8888, `test_data/` cwd).
2. Create `test/test-static-auth.js` with **failing** tests for static-mode behavior:
   - Static mode, valid token + allowed origin → 200
   - Static mode, wrong token → 401 `'Invalid token'`
   - Static mode, missing token → 401 `'Invalid token'`
   - Static mode, OPTIONS preflight → 204 with CORS headers
   - Static mode, disallowed origin → 403 `'CORS policy: Origin not allowed'`
3. Create `test/test-config-validation.js` with **failing** tests for startup validation:
   - `AUTH_MODE=static` + `ACCESS_TOKEN` set → does not throw
   - `AUTH_MODE=static` + `ACCESS_TOKEN` unset → throws
   - `AUTH_MODE=dynamic` + `AUTH_BASE_URL` set → does not throw
   - `AUTH_MODE=dynamic` + `AUTH_BASE_URL` unset → throws
   - `AUTH_MODE=invalid` → throws
   - `AUTH_MODE` unset → defaults to `'dynamic'`
4. Do not implement yet. Run `npm run test-docker` (executes the mocha suite inside the test container, since native deps require Docker) — confirm new tests fail with the expected reason (not a setup error).

**Verify:** `npm run test-docker` runs; new tests fail with assertion errors (not crashes).

## Step 1 — Extend `src/app.config.js`

File: `src/app.config.js`

Add the new fields to `config.auth` and `config.cors`, plus a startup validator called at module load.

Literal final JavaScript additions (place `mode` and `accessTokens` inside `auth`, `allowedOrigins` inside `cors`):

```js
auth: {
  baseUrl: process.env.AUTH_BASE_URL || '',
  timeout: 5000,
  /** Auth mode: 'static' (use ACCESS_TOKEN) or 'dynamic' (call AUTH_BASE_URL). */
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

cors: {
  isCheckAllowedOrigins: process.env.IS_CHECK_ALLOWED_ORIGINS !== 'false',
  /**
   * Comma-separated allowed origins for static mode.
   * Domain-only matching with wildcard support.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
},
```

Then at the **bottom** of the file (after the `config` export), add the validator:

```js
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
        "Either set ACCESS_TOKEN (comma-separated for multiple) to the static key(s) clients must send as ?key=, " +
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
```

Update the `@typedef` and JSDoc blocks at the top of the file to include the new fields.

**Verify** (run inside the test Docker image — native modules prevent running on host):
- `docker build -f Dockerfile_test -t tileserver-gl-test .` (one-time; rebuild after dependency changes).
- `docker run --rm -e AUTH_MODE=static -e ACCESS_TOKEN=x tileserver-gl-test` → boots cleanly, prints no FATAL. (Container will then attempt to start the server and fail on missing tile data — that's expected; we only care that `app.config.js` does not throw on import.)
- `docker run --rm -e AUTH_MODE=auto tileserver-gl-test` → exits non-zero, stderr includes `FATAL: AUTH_MODE must be 'static' or 'dynamic' (got: 'auto'). Set AUTH_MODE to 'static' ...`.
- `docker run --rm -e AUTH_MODE=static tileserver-gl-test` (no `ACCESS_TOKEN`) → exits non-zero, stderr includes `FATAL: AUTH_MODE=static requires ACCESS_TOKEN. Either set ACCESS_TOKEN ...`.
- `docker run --rm tileserver-gl-test` (no auth env vars) → exits non-zero, stderr includes `FATAL: AUTH_MODE=dynamic requires AUTH_BASE_URL. Either set AUTH_BASE_URL ...`.

Note: alternatively, the unit tests in Step 0's `test/test-config-validation.js` cover the same cases and run inside `npm run test-docker`. The standalone `docker run` smoke above is optional if the unit tests are comprehensive.

## Step 2 — Refactor `validationMiddleware` into dispatcher + handlers

File: `src/middleware/validation.js`

Replace the current `validationMiddleware` body (L275-315) with a dispatcher + two private handlers. Do **not** modify any other function in this file.

Literal final JavaScript:

```js
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
 * Validates ?key= against config.auth.accessTokens (any match); applies CORS from
 * config.cors.allowedOrigins. No call to AUTH_BASE_URL.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
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
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
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
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function validationMiddleware(req, res, next) {
  // Shared: OPTIONS preflight for skipped-validation paths
  if (req.method === 'OPTIONS' && shouldSkipValidation(req.path)) {
    return skipValidationCorsMiddleware(req, res, () => {
      res.status(204).end();
    });
  }

  // Shared: skip validation for static assets and public paths
  if (shouldSkipValidation(req.path)) {
    return skipValidationCorsMiddleware(req, res, next);
  }

  // Mode dispatch (decided once at config-load)
  if (config.auth.mode === 'static') {
    return handleStaticAuth(req, res, next);
  }
  return handleDynamicAuth(req, res, next);
}
```

Note: `handleStaticAuth` and `handleDynamicAuth` are not exported — they are file-private. Only `validationMiddleware` is exported, preserving today's public API and the `src/middleware/index.js` re-export.

Do **not** edit: `createCorsMiddleware`, `isOriginAllowed`, `validateApiKey`, `shouldSkipValidation`, `getLogger`, `skipValidationCorsMiddleware`, `allowAllCorsMiddleware`, `stripProtocol`, `patternToRegex`.

**Verify:**
- `npm run lint:js` — clean.
- `npm run test-docker` — new tests from Step 0 now pass; existing tests unchanged.

## Step 3 — Extend origin-matching tests

File: `test/test-origins.js`

Add cases that exercise `isOriginAllowed` with env-style domain lists (multi-domain, wildcard, mixed). These lock the matching contract the static-mode handler depends on.

**Verify:** `npm run test-docker` — all origin tests pass.

## Step 4 — `.env.example` cleanup (ALREADY COMPLETE)

File: `.env.example` — **already updated in this design pass**. No further work needed. The current file reflects:
- `AUTH_MODE=dynamic` with strict-mode docs.
- Grouped sections: dynamic-only (`AUTH_BASE_URL`), static-only (`ACCESS_TOKEN`, `ALLOWED_ORIGINS`), shared (`IS_CHECK_ALLOWED_ORIGINS`, `TZ`).
- Removed misleading `barikoi.com` and placeholder token values.

**Verify:** Read the current `.env.example` and confirm it matches the spec's "Components Changed" item 3.

## Step 5 — Verification

Following superpowers `verification-before-completion` — run all checks and **observe** the output before claiming success.

1. `npm run lint:js` — must be clean (runs on host; lint needs no native deps).
2. `npm run lint:yml` — must be clean.
3. `npm run test-docker` — all tests pass (existing + new) inside the test container.
4. Backward-compat regression (Docker): build the production image, then run with only `AUTH_BASE_URL` set (no `AUTH_MODE`):
   ```bash
   docker compose build
   docker compose run --rm \
     -e AUTH_MODE= \
     -e AUTH_BASE_URL=https://auth.example.com \
     -e ACCESS_TOKEN= \
     -e ALLOWED_ORIGINS= \
     tileserver-gl
   ```
   Confirm container boots (no FATAL), reaches the auth-middleware log line, and is ready to dispatch in dynamic mode. Stop with `Ctrl+C`.

Manual end-to-end smoke testing (curl, etc.) is performed by the operator outside this plan.

**Verify:** `npm run test-docker` passes; lint is clean; backward-compat check boots in dynamic mode without FATAL. **Do not commit until the user approves** — this plan is for review, not execution.

---

## Execution Notes

- Step order is strict: each step's verification gate must pass before moving to the next.
- TDD ordering enforced: Step 0 (tests) precedes Step 1 and Step 2 (implementation).
- All reusable helpers and exact line numbers are listed above to prevent accidental reimplementation.
- Step 4 is a no-op — already complete.
