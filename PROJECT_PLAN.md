# Commercial Fork Implementation Plan

Planning document for forking tileserver-gl commercially with authentication, CORS, security headers, and rate limiting.

---

## Branch Strategy

```
upstream/maptiler/tileserver-gl
              │
              │ (sync)
              ▼
         master (clean, synced with upstream)
              │
              │ (merge to dev)
              ▼
           dev (your features implemented here)
```

| Branch | Purpose |
|--------|---------|
| `master` | Clean copy of upstream, used for syncing |
| `dev` | All custom features implemented here |

---

## Syncing with Upstream

### One-time Setup

```bash
git remote add upstream https://github.com/maptiler/tileserver-gl.git
```

### Regular Sync Workflow

```bash
git checkout master
git fetch upstream
git merge upstream/master
git push origin master
git checkout dev
git merge master
git push origin dev
```

---

## Production Architecture (Docker)

```
┌─────────────────────────────────────────────────────────────────┐
│                    DOCKER PRODUCTION SETUP                       │
└─────────────────────────────────────────────────────────────────┘

                    ┌───────────────────┐
                    │  Docker Host      │
                    │                   │
                    │  ┌─────────────┐  │
                    │  │ tileserver  │  │
                    │  │ - :8080     │  │
                    │  │ - API Key   │  │
                    │  │ - CORS      │  │
                    │  │ - 8GB RAM   │  │
                    │  └──────┬──────┘  │
                    └─────────┼─────────┘
                              │
                    ┌─────────┴─────────┐
                    │   External API    │
                    └───────────────────┘
```

### Docker Compose

```yaml
services:
  tileserver-gl:
    build: .
    container_name: ts-map-api
    restart: always
    user: root
    environment:
      - TZ=Asia/Dhaka
      - AUTH_BASE_URL=${AUTH_BASE_URL}
      # Rate Limiting (optional - not yet implemented)
      # - RATE_LIMIT_WINDOW_MS=60000
      # - RATE_LIMIT_MAX=1000
    ports:
      - 8080:8080
    volumes:
      - ./data:/data
    command:
      - "-l"
      - "output.log"
    deploy:
      resources:
        limits:
          memory: 8G
```

---

## Minimal Intrusion Pattern

```
src/
├── middleware/
│   ├── index.js
│   └── validation.js   # API Key validation + CORS + wildcard origins
├── server.js           # validationMiddleware added
└── ... (unchanged)
```

---

## Implementation

### Step 1: API Key Validation + CORS ✅ IMPLEMENTED

**File: `src/middleware/validation.js`**

Combined API Key validation + CORS middleware. API validates key AND returns allowed origins (similar to Mapbox URL restrictions).

**Features:**
- Wildcard origin patterns (like Mapbox): `https://*.example.com/*`
- API Key via query parameter (`?key=xxx`)
- Caching delegated to backend validation service
- Handles OPTIONS preflight requests

```javascript
/**
 * API Key validation + CORS middleware for TileServer GL
 * Supports wildcard origin patterns like Mapbox:
 * - https://*.example.com → matches https://app.example.com, https://www.example.com
 * - https://example.com/* → matches any path on example.com
 */

import cors from 'cors';

// Configuration
const IS_CHECK_ALLOWED_ORIGINS = process.env.IS_CHECK_ALLOWED_ORIGINS !== 'false';

// Convert wildcard pattern to regex
function patternToRegex(pattern) {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{DOUBLE_STAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{DOUBLE_STAR}}/g, '.*');
  return new RegExp(`^${regex}$`, 'i');
}

// Check if origin matches allowed pattern
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return false;
  for (const pattern of allowedOrigins) {
    if (pattern === origin) return true;
    if (pattern.includes('*')) {
      if (patternToRegex(pattern).test(origin)) return true;
    }
  }
  return false;
}

// Validate API Key by calling external service
async function validateApiKey(apiKey) {
  const url = `${process.env.AUTH_BASE_URL}/api/validation?api_key=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();

  // Priority: env ALLOWED_ORIGINS > API allowed_origins > empty array
  let envOrigins = [];
  if (process.env.ALLOWED_ORIGINS) {
    try {
      const parsed = JSON.parse(process.env.ALLOWED_ORIGINS);
      envOrigins = Array.isArray(parsed) ? parsed : [];
    } catch { /* Invalid JSON */ }
  }

  const origins = envOrigins?.length
    ? envOrigins
    : data?.allowed_origins?.length
      ? data?.allowed_origins
      : [];

  return { is_valid: data?.is_valid ?? false, origins };
}

export async function validationMiddleware(req, res, next) {
  if (shouldSkipValidation(req.path)) return next();

  const apiKey = req.query.key;
  if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

  const result = await validateApiKey(apiKey);
  if (!result.is_valid) return res.status(401).json({ error: 'Invalid API Key' });

  // Apply CORS with validated origins
  const corsMiddleware = createCorsMiddleware(result.origins);

  if (req.method === 'OPTIONS') {
    return corsMiddleware(req, res, () => res.status(204).end());
  }

  corsMiddleware(req, res, next);
}
```

**Public Paths (no validation required):**
- `/` - Index page
- `/index.css` - Stylesheet
- `/favicon.ico` - Favicon
- `/images/*` - All image assets

**API Response Format (like Mapbox token restrictions):**
```json
{
  "is_valid": true,
  "allowed_origins": [
    "https://client1.example.com",
    "https://*.client1.com/*",
    "http://localhost:3000"
  ]
}
```

**Wildcard Pattern Examples:**
| Pattern | Matches |
|---------|---------|
| `https://*.example.com` | `https://app.example.com`, `https://www.example.com` |
| `https://example.com/*` | `https://example.com/map`, `https://example.com/admin/dashboard` |
| `https://*.example.com/*` | `https://app.example.com/map`, `https://www.example.com/any/path` |
| `http://localhost:*` | `http://localhost:3000`, `http://localhost:8080` |

---

## Changes to server.js ✅ IMPLEMENTED

```javascript
// === ADD AT TOP (line 25) ===
import { validationMiddleware } from './middleware/index.js';

// === ADD (line 170) ===
// API Key validation + CORS middleware (combined)
app.use(validationMiddleware);
```

---

## Environment Variables

```bash
# .env file (add to .gitignore)
AUTH_BASE_URL=https://your-api.example.com

# Optional: Fallback allowed origins (JSON array) when API doesn't return allowed_origins
ALLOWED_ORIGINS=["http://localhost:4000","http://localhost:3000"]

# Optional: Set to false to allow all origins (CORS: *)
IS_CHECK_ALLOWED_ORIGINS=true
```

---

## API Endpoints Required

Your API needs:

| Endpoint | Response |
|----------|----------|
| `GET /api/validation?api_key={key}` | `{"is_valid": true, "allowed_origins": ["https://domain1.com", "https://*.domain2.com"]}` |

---

## File Structure

**Current (implemented):**
```
src/
├── middleware/
│   ├── index.js         ✅ Implemented (exports validationMiddleware)
│   └── validation.js    ✅ Implemented (API Key validation + CORS + wildcard origins)
├── server.js            ✅ Validation middleware added at line 170
└── ...
```

**Note:** `auth.js` has been deleted and merged into `validation.js`. Caching is delegated to the backend service.

---

## Testing

```bash
# Validation fail - no token
curl http://localhost:8080/data/v3.json
# 401 {"error": "Missing API Key"}

# Validation with query param
curl "http://localhost:8080/data/v3.json?key=your-token"
# 200 OK

# Validation + CORS - valid token with matching origin
curl -H "Origin: https://yourdomain.com" "http://localhost:8080/data/v3.json?key=your-token"
# 200 OK with Access-Control-Allow-Origin: https://yourdomain.com

# Validation + CORS - wildcard pattern match
curl -H "Origin: https://app.yourdomain.com" "http://localhost:8080/data/v3.json?key=your-token"
# 200 OK with Access-Control-Allow-Origin: https://app.yourdomain.com (if pattern is https://*.yourdomain.com)

# Validation + CORS - valid token with wrong origin
curl -H "Origin: https://evil.com" "http://localhost:8080/data/v3.json?key=your-token"
# 200 OK but NO Access-Control-Allow-Origin header

# OPTIONS preflight
curl -X OPTIONS -H "Origin: https://yourdomain.com" "http://localhost:8080/data/v3.json?key=your-token"
# 204 with CORS headers

# Public path (no validation)
curl http://localhost:8080/
# 200 OK
```
