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
                    │  │ - Auth      │  │
                    │  │ - CORS      │  │
                    │  │ - Caching   │  │
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
      - NODE_ENV=production
      - AUTH_API_URL=${AUTH_API_URL}
      # Rate Limiting (optional)
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
│   ├── auth.js
│   ├── cors.js
│   ├── security.js
│   └── cache.js
├── server.js           # 5-10 lines added
└── ... (unchanged)
```

---

## Implementation

### Step 1: Authentication

**Create: `src/middleware/auth.js`**

```javascript
/**
 * Authentication middleware
 * Environment Variables:
 * - AUTH_API_URL: Full URL to auth API
 */

const authCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const item = authCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    authCache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(key, value) {
  authCache.set(key, { value, expiry: Date.now() + CACHE_TTL });
}

async function checkKey(api_key) {
  const cached = getCached(api_key);
  if (cached !== null) return cached;

  try {
    const url = `${process.env.AUTH_API_URL}/validation?api_key=${api_key}`;
    const response = await fetch(url);

    if (!response.ok) return false;

    const data = await response.json();
    setCached(api_key, data.is_valid);

    return data.is_valid;
  } catch (error) {
    console.error('Auth error:', error.message);
    return cached ?? false;
  }
}

export async function authMiddleware(req, res, next) {
  if (req.path === '/health') return next();

  if (!req.query.key) {
    return res.status(401).send('Missing access token');
  }

  const isValid = await checkKey(req.query.key);
  if (!isValid) {
    return res.status(401).send('Invalid access token');
  }

  next();
}
```

---

### Step 2: CORS (Origins from API)

**Create: `src/middleware/cors.js`**

```javascript
/**
 * CORS middleware - origins from API
 * Environment Variables:
 * - AUTH_API_URL: Full URL to auth API
 */

let cachedOrigins = null;
let originsCacheExpiry = 0;
const ORIGINS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchAllowedOrigins() {
  if (cachedOrigins && Date.now() < originsCacheExpiry) {
    return cachedOrigins;
  }

  try {
    const url = `${process.env.AUTH_API_URL}/origins`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error('Failed to fetch origins:', response.status);
      return cachedOrigins || [];
    }

    const data = await response.json();
    cachedOrigins = data.origins || data.allowed_origins || [];
    originsCacheExpiry = Date.now() + ORIGINS_CACHE_TTL;

    return cachedOrigins;
  } catch (error) {
    console.error('Error fetching origins:', error.message);
    return cachedOrigins || [];
  }
}

export async function corsMiddleware(req, res, next) {
  const allowedOrigins = await fetchAllowedOrigins();
  const origin = req.headers.origin;

  if (!origin) return next();

  if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
  }

  next();
}
```

---

### Step 3: Security + Rate Limiting

**Create: `src/middleware/security.js`**

```javascript
/**
 * Security middleware
 * Environment Variables:
 * - RATE_LIMIT_WINDOW_MS: Window in ms (default: 60000)
 * - RATE_LIMIT_MAX: Max requests (default: 1000)
 */

import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "https:"],
    },
  },
});

const rateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '1000', 10),
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const securityMiddleware = [helmetMiddleware, rateLimiter];
```

---

### Step 4: Cache Headers

**Create: `src/middleware/cache.js`**

```javascript
export function cacheMiddleware(req, res, next) {
  // Tiles - 1 year (immutable)
  if (req.path.match(/\/\d+\/\d+\/\d+\.[a-z]+$/)) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
  }
  // TileJSON - 5 minutes
  else if (req.path.endsWith('.json')) {
    res.set('Cache-Control', 'public, max-age=300');
  }
  // Static - 1 hour
  else if (req.path.startsWith('/resources/') || req.path.startsWith('/files/')) {
    res.set('Cache-Control', 'public, max-age=3600');
  }

  next();
}
```

---

### Step 5: Export

**Create: `src/middleware/index.js`**

```javascript
export { authMiddleware } from './auth.js';
export { corsMiddleware } from './cors.js';
export { securityMiddleware } from './security.js';
export { cacheMiddleware } from './cache.js';
```

---

## Changes to server.js

```javascript
// === ADD AT TOP (~line 15) ===
import { authMiddleware, corsMiddleware, securityMiddleware, cacheMiddleware } from './middleware/index.js';

// === REMOVE (~line 169-171) ===
// Delete existing CORS block

// === ADD (~line 172) ===
// === CUSTOM MIDDLEWARE ===
app.use(cacheMiddleware);
app.use(...securityMiddleware);
app.use(corsMiddleware);
app.use(authMiddleware);
// === END ===
```

---

## Environment Variables

```bash
# .env file (add to .gitignore)
AUTH_API_URL=https://your-api.example.com

# Optional
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=1000
```

---

## Dependencies

```bash
npm install helmet express-rate-limit
```

---

## API Endpoints Required

Your API needs:

| Endpoint | Response |
|----------|----------|
| `GET /validation?api_key={key}` | `{"is_valid": true}` |
| `GET /origins` | `{"origins": ["https://domain1.com", "https://domain2.com"]}` |

---

## File Structure

```
src/
├── middleware/
│   ├── index.js
│   ├── auth.js
│   ├── cors.js
│   ├── security.js
│   └── cache.js
├── server.js           # 5-10 lines
└── ...
```

---

## Testing

```bash
# Auth fail
curl http://localhost:8080/data/v3.json
# 401 Missing access token

# Auth success
curl "http://localhost:8080/data/v3.json?key=your-key"
# 200 OK

# Health (no auth)
curl http://localhost:8080/health
# 200 OK

# CORS
curl -H "Origin: https://yourdomain.com" -I http://localhost:8080/health
# Access-Control-Allow-Origin header
```
