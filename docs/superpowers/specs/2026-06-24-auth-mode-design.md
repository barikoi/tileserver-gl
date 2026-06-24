# Static-vs-Dynamic Auth Mode — Design Spec

> Status: **Awaiting user review.** Produced via the `superpowers:brainstorming` skill.
> Companion implementation plan: `docs/superpowers/plans/2026-06-24-auth-mode-plan.md`
>
> No source code has been changed. No commits made. `.env.example` has been updated as part of this design pass.

---

## Context

TileServer GL currently has exactly one authentication path: every request's `?key=` is forwarded to `${AUTH_BASE_URL}/api/validation`, which returns `{is_valid, allowed_origins}`. This is the **dynamic** mode — auth data is fetched per request from a remote service.

Some deployments do not have (or need) a remote validation backend. For those, a **static** mode is required: a single access token configured via env, and a fixed CORS allowlist, with no outbound validation calls. The server should support both modes, selected explicitly at startup via an `AUTH_MODE` env var.

The goal is a clean separation: one deployment runs in exactly one mode. There is no per-request mode switching, no inference from request properties (origin, path, or otherwise). All shared concerns (CORS handling, skip-validation for static assets, logging, the `cors` package) remain common to both modes. Only two things differ between modes:

1. How the `?key=` is validated (static compare vs. AUTH_BASE_URL call).
2. Where the CORS allowlist comes from (env var vs. API response).

## Goals

- Add a static auth mode alongside the existing dynamic mode.
- Mode is declared explicitly at startup via `AUTH_MODE` env var.
- Misconfiguration (missing required env var for the chosen mode, invalid `AUTH_MODE` value) fails fast at startup.
- Shared logic stays shared: skip-validation, CORS helpers, origin matching, logging.
- Zero behavior change for operators who don't set `AUTH_MODE` (defaults to dynamic = today's behavior).

## Non-Goals

- Per-request mode switching.
- Inference of mode from request properties (origin, path, IP, etc.).
- Token rotation, revocation, or short-lived credentials.
- Alternative token transports (header, cookie). `?key=` only.
- Migration off the `cors` npm package.
- Code changes for `TZ` (Node consumes it automatically via `env_file`).
- Touching `src/server.js` mount structure (single `validationMiddleware` mount preserved).

## Decisions

| Aspect | Decision | Rationale |
|---|---|---|
| Mode selector | `AUTH_MODE` env var (`static` \| `dynamic`) | Explicit operator intent; no inference from other env vars |
| Default when `AUTH_MODE` unset | `dynamic` | Preserves today's behavior — operators who haven't migrated are unaffected |
| Invalid `AUTH_MODE` value | Server refuses to start | Catches typos at boot, not at first request |
| Static mode auth | `req.query.key` matches any value in the parsed `ACCESS_TOKEN` list (comma-separated, trimmed) | Supports both single-token and multi-client deployments without code changes; same transport as dynamic |
| Static mode CORS source | `process.env.ALLOWED_ORIGINS` (comma-separated, domain-only, wildcard-supporting) | Decoupled from any remote service |
| Dynamic mode auth | Unchanged — call `${AUTH_BASE_URL}/api/validation?api_key=<key>` | Zero impact on existing clients |
| Dynamic mode CORS source | Unchanged — `allowed_origins` from API response | Existing behavior |
| Static mode mismatch (wrong/missing key) | 401 `{error: 'Invalid token'}` | No fall-through to AUTH_BASE_URL — pure mode separation |
| Both `ACCESS_TOKEN` and `AUTH_BASE_URL` set | Whichever matches `AUTH_MODE` wins; the other is ignored | Mode is decided by `AUTH_MODE`, not by which vars happen to be present |
| `IS_CHECK_ALLOWED_ORIGINS=false` | Allow all origins in both modes | Existing flag, unchanged semantics — checked inside `createCorsMiddleware` |
| `TZ` env var | Documentation only, no code | Node consumes it automatically |
| Mode-specific code layout | Two named handlers (`handleStaticAuth`, `handleDynamicAuth`) behind one `validationMiddleware` entry | "Both modes work separately" — each handler is readable end-to-end without the other |

## Architecture

### Single entry point, two handlers, shared plumbing

`validationMiddleware` in `src/middleware/validation.js` remains the only global auth+CORS gate (mounted once at `src/server.js:171`). Its body becomes a thin dispatcher. Two private handlers in the same file encapsulate mode-specific behavior. All shared helpers are reused unchanged.

```
                    validationMiddleware(req, res, next)
                              │
                  ┌───────────┴───────────┐
            shared skip-validation        │
            + OPTIONS preflight           │
                  │                       │
                  ▼                       │
        config.auth.mode === 'static'?    │
            │             │              │
           YES            NO             │
            │             │              │
            ▼             ▼              │
   handleStaticAuth   handleDynamicAuth  │
            │             │              │
            └────────┬────┘              │
                     ▼                   │
        shared: createCorsMiddleware     │
        + isOriginAllowed + logger       │
```

### Request decision flow

```
1. shouldSkipValidation(path)?                                  [shared, unchanged]
   → skipValidationCorsMiddleware; next()

2. OPTIONS + shouldSkipValidation?                              [shared, unchanged]
   → skipValidationCorsMiddleware; 204

3. Dispatch on config.auth.mode:

   STATIC MODE (config.auth.mode === 'static'):
     a. config.auth.accessTokens.includes(req.query.key)?
        NO  → 401 {error: 'Invalid token'}                      [NEW]
        YES → createCorsMiddleware(config.cors.allowedOrigins)  [NEW]
              OPTIONS → 204
              else → cors + next

   DYNAMIC MODE (config.auth.mode === 'dynamic'):              [unchanged logic]
     a. !req.query.key? → 401 {error: 'Missing API Key'}
     b. validateApiKey(key, req):
        !is_valid → 401 {error: 'Invalid API Key'}
        is_valid  → createCorsMiddleware(result.allowed_origins)
                    OPTIONS → 204
                    else → cors + next
```

### `IS_CHECK_ALLOWED_ORIGINS` interaction

`createCorsMiddleware` (existing, `src/middleware/validation.js:214`) already returns the cached `allowAllCorsMiddleware` when `config.cors.isCheckAllowedOrigins === false`. This check happens **inside** the helper, before the per-mode origin list is consulted. As a result:

- `IS_CHECK_ALLOWED_ORIGINS=false` + static mode → CORS `'*'`, `ACCESS_TOKEN` still required for auth.
- `IS_CHECK_ALLOWED_ORIGINS=false` + dynamic mode → CORS `'*'`, `?key=` still validated via AUTH_BASE_URL.

No new code needed to support this combination.

### Inert-by-default behavior

Operators who do not set `AUTH_MODE` continue to get today's behavior:

1. `AUTH_MODE` unset → `config.auth.mode = 'dynamic'`.
2. Startup validation: `AUTH_BASE_URL` required → existing deployments already set it.
3. `validationMiddleware` dispatches to `handleDynamicAuth` → identical to today's code path.

No existing test, deployment, or client request changes behavior.

## Components Changed

1. **`src/app.config.js`** — extend `config.auth` and `config.cors`:
   - `config.auth.mode`: `'static'` | `'dynamic'`, derived from `process.env.AUTH_MODE`. Unset → `'dynamic'`. Invalid non-empty value → thrown error at module load (fail-fast).
   - `config.auth.accessTokens`: `(process.env.ACCESS_TOKEN || '').split(',').map(s => s.trim()).filter(Boolean)` — array of one or more tokens. Empty array when env is unset or contains only whitespace/commas.
   - `config.cors.allowedOrigins`: `(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)`.
   - Add a **startup validator** function `validateConfig(config)` that asserts the chosen mode has its required env var. Violations throw with an actionable FATAL-prefixed message (see Error Matrix for exact text). Messages tell the operator what's wrong AND what to do (which env to set or which alternative mode to switch to).
   - The validator is called at the bottom of `app.config.js` so import-time evaluation enforces it.

2. **`src/middleware/validation.js`** — refactor `validationMiddleware` (current L275-315):
   - Keep the shared skip-validation + OPTIONS preflight block at the top (current L277-287).
   - Replace the rest with a dispatch: `if (config.auth.mode === 'static') return handleStaticAuth(req, res, next); return handleDynamicAuth(req, res, next);`
   - Add private `handleStaticAuth(req, res, next)` (~15 lines).
   - Extract today's post-skip logic into private `handleDynamicAuth(req, res, next)` (~20 lines, body is today's L290-315 verbatim).
   - Do **not** modify any other function in this file.

3. **`.env.example`** — already updated in this design pass:
   - Added `AUTH_MODE=dynamic` with strict semantics + fail-fast docs.
   - Grouped vars by mode (dynamic-only, static-only, shared).
   - Documented `TZ` is consumed automatically.
   - Documented `ALLOWED_ORIGINS` wildcard syntax.
   - Removed the misleading placeholder `barikoi.com` and placeholder token values.

4. **No changes to:** `src/server.js`, `src/serve_*.js`, `src/utils.js`, `src/main.js`, `src/logger.js`, `src/render.js`, `src/pmtiles_adapter.js`, `src/mbtiles_wrapper.js`, `createCorsMiddleware`, `isOriginAllowed`, `stripProtocol`, `patternToRegex`, `validateApiKey`, `shouldSkipValidation`, `getLogger`, `skipValidationCorsMiddleware`, `allowAllCorsMiddleware`.

## Error Matrix

| Case | Status | Body | Existing? |
|---|---|---|---|
| Skip-validation path (static asset, `/`, `/health`) | 200/204 | n/a | Yes |
| **Static mode**, valid `?key=` | 200 | n/a | **NEW** |
| **Static mode**, missing `?key=` | 401 | `{error: 'Invalid token'}` | **NEW** |
| **Static mode**, wrong `?key=` | 401 | `{error: 'Invalid token'}` | **NEW** |
| Dynamic mode, missing key | 401 | `{error: 'Missing API Key'}` | Yes |
| Dynamic mode, AUTH_BASE_URL validation fails | 401 | `{error: 'Invalid API Key'}` | Yes |
| CORS origin-blocked within either mode | 403 | `'CORS policy: Origin not allowed'` | Yes |
| Startup with invalid `AUTH_MODE` value (e.g. `auto`) | n/a — boot fails | `FATAL: AUTH_MODE must be 'static' or 'dynamic' (got: 'auto'). Set AUTH_MODE to 'static' (uses ACCESS_TOKEN + ALLOWED_ORIGINS) or 'dynamic' (uses AUTH_BASE_URL). Leave AUTH_MODE unset to default to 'dynamic'.` | **NEW** |
| Startup with `AUTH_MODE=static` and `ACCESS_TOKEN` unset | n/a — boot fails | `FATAL: AUTH_MODE=static requires ACCESS_TOKEN. Either set ACCESS_TOKEN to the static key clients must send as ?key=, or change AUTH_MODE to 'dynamic' (and set AUTH_BASE_URL) to validate keys via the remote API.` | **NEW** |
| Startup with `AUTH_MODE=dynamic` and `AUTH_BASE_URL` unset | n/a — boot fails | `FATAL: AUTH_MODE=dynamic requires AUTH_BASE_URL. Either set AUTH_BASE_URL to the validation API base URL, or change AUTH_MODE to 'static' (and set ACCESS_TOKEN + ALLOWED_ORIGINS) to use a static key with no remote validation.` | **NEW** |

All runtime rejections continue to set `res.locals.errorMessage` for pino logger consistency.

## Logging

Use request-scoped logger via `getLogger(req)` (existing). Mode-specific additions:

- Static mode token mismatch → `warn` with origin and masked key prefix (first 8 chars).
- Static mode dispatch → optional `debug` log "auth mode: static" on first request (cheap observability).
- Dynamic mode → no new logs; existing `validateApiKey` error logging preserved.

Startup validator throws synchronously at module load (inside `app.config.js`, which is imported by `main.js`); the thrown `Error`'s message surfaces in Node's uncaught top-level stack trace, failing the boot. No explicit `logger.fatal` call is used — the throw itself is the abort signal.

## Testing Strategy

Extend existing test files. No new framework.

1. **`test/test-origins.js`** (existing) — add cases for env-driven `config.cors.allowedOrigins` matching semantics (multi-domain, wildcard, mixed). These lock the contract the static-mode handler depends on.

2. **New `test/test-static-auth.js`** covering static-mode middleware behavior:
   - Static mode, valid token → 200
   - Static mode, missing token → 401 `'Invalid token'`
   - Static mode, wrong token → 401 `'Invalid token'`
   - Static mode, OPTIONS preflight → 204 with CORS headers
   - Static mode, `IS_CHECK_ALLOWED_ORIGINS=false` → CORS `'*'`, token still required
   - Static mode, CORS origin not in `ALLOWED_ORIGINS` → 403

3. **New `test/test-config-validation.js`** covering startup validation:
   - `AUTH_MODE=static` + `ACCESS_TOKEN` set → ok
   - `AUTH_MODE=static` + `ACCESS_TOKEN` unset → throws
   - `AUTH_MODE=dynamic` + `AUTH_BASE_URL` set → ok
   - `AUTH_MODE=dynamic` + `AUTH_BASE_URL` unset → throws
   - `AUTH_MODE=auto` → throws
   - `AUTH_MODE` unset → defaults to `'dynamic'`, requires `AUTH_BASE_URL`

4. **Existing tests** (`test/*.js`) must continue to pass unchanged — they exercise dynamic mode and skip-paths, which are not modified.

## Verification

- `npm run test-docker` passes (existing + new tests).
- `npm run lint:js` is clean.

## Open Questions

None. All decisions confirmed with user during brainstorming:

- Mode selector: explicit `AUTH_MODE` env var (static | dynamic).
- Default: `dynamic` when unset.
- Invalid value: startup failure.
- Missing required var for mode: startup failure.
- Static transport: `?key=` (same as dynamic).
- ACCESS_TOKEN: single token OR comma-separated list; any match authenticates.
- Static mismatch: 401, no fall-through.
- Both env vars set: `AUTH_MODE` decides which wins.
- `IS_CHECK_ALLOWED_ORIGINS` works in both modes (shared helper).
- Approach: two named handlers behind one `validationMiddleware` entry point.
