# TileServer GL - Project Architecture

Complete technical documentation for understanding and forking this project commercially.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Express Architecture Patterns](#express-architecture-patterns)
3. [Source Files Reference](#source-files-reference)
4. [Complete Routes & Endpoints](#complete-routes--endpoints)
5. [Data Flow & Request Handling](#data-flow--request-handling)
6. [Configuration System](#configuration-system)
7. [Middleware Stack](#middleware-stack)
8. [Security Analysis](#security-analysis)

---

## Project Overview

**TileServer GL** is a map tile server built on Express.js that:

- Serves **vector tiles** (PBF format) from MBTiles or PMTiles sources
- Renders **raster tiles** (PNG/JPG/WebP) server-side using MapLibre GL Native
- Serves **MapLibre GL styles** with automatic source URL rewriting
- Provides **elevation data** endpoints (Terrarium and Mapbox encodings)
- Generates **static map images** with overlays (markers, paths)
- Supports **remote data sources** (HTTP, HTTPS, S3 for PMTiles)

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Web Framework | Express.js 5.x | HTTP server and routing |
| Tile Rendering | @maplibre/maplibre-gl-native | Server-side raster rendering |
| Image Processing | Sharp | Image format conversion |
| Canvas Rendering | node-canvas | Overlay rendering (markers, paths) |
| Data Sources | @mapbox/mbtiles, pmtiles | Tile data storage formats |
| Coordinate Utils | @mapbox/sphericalmercator | Tile coordinate conversions |
| CLI | Commander | Command-line argument parsing |

### Node.js Requirements

- **Node.js 20, 22, or 24** (specified in `package.json` engines)

---

## Express Architecture Patterns

### Server Initialization (server.js:43-54)

```javascript
async function start(opts) {
  const app = express().disable('x-powered-by');  // Security: hide backend stack
  // ...
  app.enable('trust proxy');  // Trust X-Forwarded-* headers from proxies
```

### Why `disable('x-powered-by')`?

| Without disable | With disable |
|-----------------|--------------|
| Response includes `X-Powered-By: Express` | Header is omitted |
| Attackers know you use Express | Technology stack hidden |
| They can target Express-specific CVEs | Harder to fingerprint server |

**Security benefit:** Prevents information leakage about server technology.

### Why `enable('trust proxy')`?

When your server is behind a load balancer (AWS ALB, Cloudflare, Nginx):

```
Client (203.0.113.50)
        │
        ▼
   Load Balancer (10.0.0.1)  ← Adds X-Forwarded-For: 203.0.113.50
        │
        ▼
   TileServer
```

With `trust proxy` enabled:
```javascript
req.ip          // → 203.0.113.50 (real client IP, not load balancer IP)
req.protocol    // → "https" (original protocol)
req.hostname    // → "tiles.yourdomain.com" (original host)
```

**Important:** Only enable if behind a trusted proxy. If exposed directly to internet, attackers can spoof these headers.

### Sub-Apps Architecture

A **sub-app** is a separate Express application mounted on the main app at a specific path.

```javascript
// server.js:173-182 - Mounting sub-apps
app.use('/data/', serve_data.init(options, serving.data, opts));
app.use('/styles/', serve_style.init(options, serving.styles, opts));
```

Each sub-app creates its own Express instance:
```javascript
// serve_data.js:46-49
init: function (options, repo, programOpts) {
  const app = express().disable('x-powered-by');  // ← NEW Express instance
  app.use(express.json());  // ← Middleware ONLY for this sub-app

  // Routes ONLY apply to /data/*
  app.get('/:id/:z/:x/:y.:format', handler);

  return app;  // ← Return to be mounted
}
```

**Sub-Apps Diagram:**
```
┌─────────────────────────────────────────────────────────────┐
│                    Main App (server.js)                     │
│                                                             │
│  Middleware: trust proxy, morgan, validation                │
│  Routes: /styles.json, /data.json, /health, /              │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   /data/*     │    │   /styles/*   │    │     /*        │
│ serve_data.js │    │serve_style.js │    │ serve_font.js │
│               │    │serve_rendered │    │               │
│ Own Express:  │    │               │    │ Own Express:  │
│ - json()      │    │ Own Express   │    │ - none        │
└───────────────┘    └───────────────┘    └───────────────┘
```

**Why use sub-apps?**
- **Modularity:** Each module handles its own routes
- **Isolation:** Middleware in sub-apps doesn't affect main app
- **Testability:** Each sub-app can be tested independently

---

## Source Files Reference

### Entry Points

#### `src/main.js` (Entry Point)
**Purpose:** CLI entry point and server initialization

**Key Responsibilities:**
- Parse command-line arguments with Commander
- Auto-detect `.mbtiles` or `.pmtiles` files in current directory
- Load configuration from `config.json` or create auto-config
- Start the Express server

**Key Code Sections:**
```javascript
// Lines 57-117: CLI options parsing with Commander
program
  .option('--file <file>', 'MBTiles or PMTiles file')
  .option('-c, --config <file>', 'Configuration file')
  .option('-p, --port <port>', 'Port [8080]')
  .option('-C|--no-cors', 'Disable CORS headers')
  .option('-V, --verbose [level]', 'Verbose output (1-3)')
  // ... more options

// Lines 122-141: Server startup
const startServer = (configPath, config) => {
  return server({
    configPath,
    config,
    bind: opts.bind,
    port: opts.port,
    cors: opts.cors,
    // ... more options
  });
};
```

**CLI Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `--file <file>` | - | MBTiles or PMTiles file (local or remote) |
| `--mbtiles <file>` | - | (DEPRECATED) MBTiles file |
| `-c, --config <file>` | `config.json` | Configuration file |
| `-b, --bind <address>` | - | Bind address |
| `-p, --port <port>` | `8080` | Server port |
| `-C, --no-cors` | CORS enabled | Disable CORS headers |
| `-u, --public_url <url>` | - | Public URL for subpath hosting |
| `-V, --verbose [level]` | - | Verbose output (1-3) |
| `-s, --silent` | - | Less verbose output |
| `--fetch-timeout <ms>` | `15000` | HTTP fetch timeout |
| `--ignore-missing-files` | - | Continue if data files missing |

---

#### `src/server.js` (Main Server)
**Purpose:** Express server setup, route mounting, style/data loading

**Key Responsibilities:**
- Initialize Express app with middleware
- Load configuration and resolve paths
- Mount sub-apps for data, styles, fonts
- Load styles and data sources from config
- Serve web UI templates (Handlebars)
- Handle server lifecycle (start, shutdown, reload)

**Architecture Overview:**
```
server.js
    │
    ├── Express App Initialization (Line 46)
    │   └── app = express().disable('x-powered-by')
    │
    ├── Middleware Setup (Lines 54-171)
    │   ├── trust proxy
    │   ├── morgan logging
    │   └── cors (optional)
    │
    ├── Sub-app Mounting (Lines 173-182)
    │   ├── /data/    → serve_data.js
    │   ├── /files/   → express.static
    │   ├── /styles/  → serve_style.js + serve_rendered.js
    │   └── /         → serve_font.js
    │
    ├── Style Loading (Lines 191-487)
    │   └── addStyle() for each style in config
    │
    ├── Data Loading (Lines 503-523)
    │   └── serve_data.add() for each data source
    │
    └── Template Routes (Lines 743-946)
        ├── / (index page)
        ├── /styles/:id/ (viewer)
        ├── /styles/:id/wmts.xml
        └── /data/:view/:id/
```

**Key Functions:**
| Function | Line | Purpose |
|----------|------|---------|
| `start(opts)` | 43 | Initialize and configure Express app |
| `addStyle(id, item, ...)` | 191 | Load and configure a map style |
| `serveTemplate(urlPath, template, dataGetter)` | 689 | Serve Handlebars templates |
| `addTileJSONs(arr, req, type, tileSize)` | 606 | Build TileJSON responses |
| `server(opts)` | 1031 | Exported server startup function |

---

### Core Modules

#### `src/serve_data.js` (Vector Tile & Elevation Data)
**Purpose:** Serve raw vector tiles and elevation data

**Routes Defined:**
```javascript
// Line 62: Tile data endpoint
GET /:id/:z/:x/:y.:format

// Line 341: Single point elevation
GET /:id/elevation/:z/:x/:y

// Line 434: Batch elevation (POST)
POST /:id/elevation
Body: { "points": [{ "lon": number, "lat": number, "z": number }] }

// Line 469: TileJSON metadata
GET /:id.json
```

**Key Functions:**
| Function | Line | Purpose |
|----------|------|---------|
| `init(options, repo, programOpts)` | 46 | Initialize Express sub-app |
| `add(options, repo, params, id, programOpts)` | 510 | Add data source to repository |
| `validateElevationSource(id, res)` | 179 | Validate elevation data config |
| `getBatchElevations(sourceInfo, points)` | 264 | Batch elevation queries |

**Sparse Tile Handling:**
```javascript
// Line 117: Missing tile response
return res.status(item.sparse ? 404 : 204).send();
// sparse=true  → 404 (allows overzooming)
// sparse=false → 204 (empty tile, no overzooming)
```

---

#### `src/serve_rendered.js` (Raster Tile Rendering)
**Purpose:** Render raster tiles and static images using MapLibre GL Native

**Routes Defined:**
```javascript
// Line 1088: Tile and static image rendering
GET /:id{/:p1}/:p2/:p3/:p4{@:scale}{.:format}

// Line 1151: TileJSON for rendered tiles
GET {/:tileSize}/:id.json
```

**URL Patterns:**
| Pattern | Example | Purpose |
|---------|---------|---------|
| `/:id/:z/:x/:y.:format` | `/styles/basic/10/512/384.png` | 256px tile |
| `/:id/512/:z/:x/:y.:format` | `/styles/basic/512/10/512/384.png` | 512px tile |
| `/:id/static/:lon,:lat,:zoom/:wx.:h@:scale.:format` | `/styles/basic/static/8.5,47.3,12/600x400@2x.png` | Static image |
| `/:id/static/auto/:wx.:h.:format` | `/styles/basic/static/auto/600x400.png?marker=...` | Auto-bounds image |

**Renderer Pool System:**
```javascript
// Lines 1226-1487: Renderer pool creation
const createPool = (ratio, mode, min, max) => {
  const createRenderer = (ratio, createCallback) => {
    const renderer = new mlgl.Map({
      mode,        // 'tile' or 'static'
      ratio,       // 1, 2, or 3 for @1x, @2x, @3x
      request: async (req, callback) => {
        // Handle mbtiles://, pmtiles://, http://, https://, fonts://, sprites://
      }
    });
    renderer.load(styleJSON);
    createCallback(null, renderer);
  };
  return new advancedPool.Pool({ min, max, create, destroy });
};
```

**Pool Configuration:**
```javascript
// Lines 1773-1792: Pool sizes per scale factor
const minPoolSizes = options.minRendererPoolSizes || [8, 4, 2];  // @1x, @2x, @3x
const maxPoolSizes = options.maxRendererPoolSizes || [16, 8, 4];
```

**Key Functions:**
| Function | Line | Purpose |
|----------|------|---------|
| `init(options, repo, programOpts)` | 1069 | Initialize Express sub-app |
| `add(options, repo, params, id, ...)` | 1194 | Add style with renderers |
| `respondImage(...)` | 482 | Render and respond with image |
| `handleTileRequest(...)` | 779 | Process tile requests |
| `handleStaticRequest(...)` | 866 | Process static image requests |
| `extractPathsFromQuery(query, transformer)` | 207 | Parse path overlay params |
| `extractMarkersFromQuery(query, options, transformer)` | 348 | Parse marker overlay params |
| `createEmptyResponse(format, color, callback)` | 99 | Create blank tile for errors |

---

#### `src/serve_style.js` (Style JSON & Sprites)
**Purpose:** Serve style.json files and sprite assets

**Routes Defined:**
```javascript
// Line 36: Style JSON
GET /:id/style.json

// Line 88: Sprite assets (supports multiple sprites via :spriteID)
GET /:id/sprite{/:spriteID}{@:scale}{.:format}
// Examples:
//   /styles/basic/sprite.json
//   /styles/basic/sprite@2x.json
//   /styles/basic/sprite.png
//   /styles/basic/sprite@2x.png
//   /styles/basic/sprite/dark.json  (named sprite)
```

**URL Rewriting:**
```javascript
// Lines 280, 333, 356: Convert to local:// protocol
source.url = `local://data/${identifier}.json`;
styleJSON.sprite = `local://styles/${id}/sprite`;
styleJSON.glyphs = 'local://fonts/{fontstack}/{range}.pbf';
```

**Key Functions:**
| Function | Line | Purpose |
|----------|------|---------|
| `init(options, repo, programOpts)` | 26 | Initialize Express sub-app |
| `add(options, repo, params, id, ...)` | 197 | Add style to repository |
| `remove(repo, id)` | 380 | Remove style from repository |

---

#### `src/serve_font.js` (Font Serving)
**Purpose:** Serve font PBF files for text rendering in maps

**Routes Defined:**
```javascript
// Font PBF files
GET /fonts/:fontstack/:range.pbf

// Font list
GET /fonts.json
```

---

#### `src/render.js` (Canvas Overlay Rendering)
**Purpose:** Render overlays (paths, markers), watermarks, and attribution using node-canvas

**Key Functions:**
| Function | Line | Purpose |
|----------|------|---------|
| `renderOverlay(z, x, y, bearing, pitch, w, h, scale, paths, markers, query)` | 400 | Render paths and markers overlay |
| `renderWatermark(width, height, scale, text)` | 469 | Render watermark text |
| `renderAttribution(width, height, scale, text)` | 492 | Render attribution box |
| `drawPath(ctx, path, query, pathQuery, z)` | 231 | Draw a path on canvas |
| `drawMarker(ctx, marker, z)` | 105 | Draw a marker icon |

**Path Styling via Query:**
```
?path=fill:red|stroke:blue|width:3|8.5,47.3|8.6,47.4
&path=enc:{encoded_polyline}
```

**Marker Styling via Query:**
```
?marker=47.3,8.5|icon.png|scale:0.5|offset:10,-20
```

---

### Data Source Adapters

#### `src/pmtiles_adapter.js` (PMTiles Support)
**Purpose:** Read tiles from PMTiles files (local, HTTP, HTTPS, S3)

**Key Functions:**
```javascript
// Open PMTiles source
openPMtiles(inputFile, s3Profile, requestPayer, s3Region, s3UrlFormat, verbose)

// Get metadata
getPMtilesInfo(source, inputFile)

// Fetch tile (used via utils.fetchTileData)
```

**Supported URLs:**
- Local file: `/path/to/file.pmtiles`
- HTTP: `http://example.com/tiles.pmtiles`
- HTTPS: `https://example.com/tiles.pmtiles`
- S3: `s3://bucket/path/file.pmtiles`

---

#### `src/mbtiles_wrapper.js` (MBTiles Support)
**Purpose:** Read tiles from MBTiles files (local only)

**Key Functions:**
```javascript
// Open MBTiles file
openMbTilesWrapper(filePath)

// Methods on returned object:
// - getInfo(): Get metadata
// - getMbTiles(): Get underlying @mapbox/mbtiles instance
```

---

### Utility Modules

#### `src/utils.js` (Utility Functions)
**Purpose:** Common utility functions used across modules

**Key Functions:**
| Function | Purpose |
|----------|---------|
| `getPublicUrl(publicUrl, req)` | Get base URL for responses |
| `getTileUrls(req, tiles, path, tileSize, format, publicUrl, aliases)` | Generate tile URLs |
| `fixTileJSONCenter(tileJSON)` | Fix center array format |
| `isValidHttpUrl(url)` | Check if HTTP/HTTPS URL |
| `isValidRemoteUrl(url)` | Check if HTTP/HTTPS/S3 URL |
| `fetchTileData(source, sourceType, z, x, y)` | Fetch tile from any source |
| `getFontsPbf(...)` | Concatenate font PBFs |
| `listFonts(fontPath)` | List available fonts |
| `allowedTileSizes(size)` | Validate tile size (256 or 512) |
| `allowedScales(scale, maxScale)` | Validate scale factor |
| `readFile(path)` | Read file with error handling |
| `lonLatToTilePixel(lon, lat, z, tileSize)` | Convert coords to tile pixels |

---

#### `src/promises.js` (Promise Utilities)
**Purpose:** Promise-based wrappers for async operations

**Key Functions:**
```javascript
existsP(path)      // Check if file exists
gunzipP(data)      // Gunzip buffer
gzipP(data)        // Gzip buffer
```

---

#### `src/healthcheck.js` (Health Check)
**Purpose:** Simple health check script for Docker/container orchestration

---

## Complete Routes & Endpoints

### Main Server Routes (server.js)

| Method | Route | Line | Handler | Purpose |
|--------|-------|------|---------|---------|
| GET | `/styles.json` | 577 | inline | List all available styles |
| GET | `/:tileSize/rendered.json` | 641 | inline | TileJSON for rendered tiles |
| GET | `/data.json` | 652 | inline | TileJSON for all data sources |
| GET | `/:tileSize/index.json` | 664 | inline | Combined TileJSON index |
| GET | `/` | 743 | `serveTemplate` | Front page (index.tmpl) |
| GET | `/styles/:id/` | 861 | `serveTemplate` | Style viewer (viewer.tmpl) |
| GET | `/styles/:id/wmts.xml` | 886 | `serveTemplate` | WMTS capability document |
| GET | `/data/:view/:id/` | 924 | `serveTemplate` | Data preview (data.tmpl) |
| GET | `/health` | 960 | inline | Health check endpoint |

### Data Routes (serve_data.js → `/data/`)

| Method | Route | Line | Purpose |
|--------|-------|------|---------|
| GET | `/data/:id/:z/:x/:y.:format` | 62 | Serve vector tile |
| GET | `/data/:id/elevation/:z/:x/:y` | 341 | Single point elevation |
| POST | `/data/:id/elevation` | 434 | Batch elevation query |
| GET | `/data/:id.json` | 469 | TileJSON metadata |

### Style Routes (serve_style.js → `/styles/`)

| Method | Route | Line | Purpose |
|--------|-------|------|---------|
| GET | `/styles/:id/style.json` | 36 | Serve style JSON |
| GET | `/styles/:id/sprite{/:spriteID}{@:scale}{.:format}` | 88 | Serve sprite assets |

### Rendered Routes (serve_rendered.js → `/styles/`)

| Method | Route | Line | Purpose |
|--------|-------|------|---------|
| GET | `/styles/:id/:z/:x/:y.:format` | 1088 | 256px raster tile |
| GET | `/styles/:id/:tileSize/:z/:x/:y.:format` | 1088 | Custom size raster tile |
| GET | `/styles/:id/static/:staticType/:size@:scale.:format` | 1088 | Static map image |
| GET | `/styles/:id.json` | 1151 | TileJSON for rendered |

### Font Routes (serve_font.js → `/`)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/fonts/:fontstack/:range.pbf` | Serve font PBF |
| GET | `/fonts.json` | List available fonts |

### Static Routes

| Mount | Source | Purpose |
|-------|--------|---------|
| `/` | `public/resources/` | MapLibre GL, Leaflet, etc. |
| `/files/` | `paths.files` | User static files |

---

## Data Flow & Request Handling

### Tile Request Flow

```
Client Request: GET /data/v3/10/512/384.pbf?key=xxx
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Express App (server.js)                                    │
│  - CORS check                                               │
│  - Logging (morgan)                                         │
│  - Validation middleware (API key + CORS)                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  serve_data.js sub-app (mounted at /data/)                  │
│  Route: GET /:id/:z/:x/:y.:format                           │
│                                                             │
│  1. Lookup repo[id] to get source info                      │
│  2. Validate coordinates (z, x, y bounds)                   │
│  3. Call fetchTileData(source, sourceType, z, x, y)         │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  utils.js: fetchTileData()                                  │
│                                                             │
│  if sourceType === 'pmtiles':                               │
│    → pmtiles_adapter.getTile()                              │
│  if sourceType === 'mbtiles':                               │
│    → mbtiles.getTile()                                      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Response Processing                                        │
│  - Gunzip if needed                                         │
│  - Apply dataDecoratorFunc if configured                    │
│  - Gzip response                                            │
│  - Set headers (Content-Type, Content-Encoding)             │
│  - Return Buffer                                            │
└─────────────────────────────────────────────────────────────┘
```

### Rendered Tile Request Flow

```
Client Request: GET /styles/basic/10/512/384.png
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  serve_rendered.js sub-app                                  │
│  Route: GET /:id/:z/:x/:y.:format                           │
│                                                             │
│  1. Lookup repo[id] to get renderer pool                    │
│  2. Calculate tile center coordinates                       │
│  3. Call respondImage()                                     │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  respondImage()                                             │
│  1. Validate parameters (lon, lat, size, format)            │
│  2. Acquire renderer from pool                              │
│  3. Call renderer.render({ zoom, center, width, height })   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  MapLibre GL Native Renderer                               │
│  - Renders style with sources                               │
│  - Makes internal requests for tiles, fonts, sprites        │
│  - Returns raw RGBA buffer                                  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Image Processing (Sharp)                                   │
│  - Convert RGBA buffer to PNG/JPEG/WebP                     │
│  - Apply composites (overlay, watermark, attribution)       │
│  - Apply format options (quality, compression)              │
│  - Return Buffer                                            │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Response                                                   │
│  - Set Last-Modified header                                 │
│  - Set Content-Type header                                  │
│  - Send image buffer                                        │
└─────────────────────────────────────────────────────────────┘
```

### Style Loading Flow

```
Config:
{
  "styles": {
    "basic": {
      "style": "basic/style.json",
      "tilejson": { "bounds": [...] }
    }
  },
  "data": {
    "v3": { "mbtiles": "switzerland.mbtiles" }
  }
}
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  server.js: addStyle("basic", item, ...)                    │
│                                                             │
│  1. Read style JSON from file/URL                           │
│  2. For each source in styleJSON.sources:                   │
│     - Parse URL (mbtiles://, pmtiles://, http://)           │
│     - Resolve to data source ID                             │
│     - Call serve_style.add() if serve_data=true             │
│     - Call serve_rendered.add() if serve_rendered=true      │
└─────────────────────────────────────────────────────────────┘
```

---

## Configuration System

### config.json Structure

```json
{
  "options": {
    "paths": {
      "root": ".",
      "styles": "styles",
      "fonts": "fonts",
      "sprites": "sprites",
      "mbtiles": "data",
      "pmtiles": "data",
      "icons": "icons",
      "files": "files"
    },
    "pbfAlias": "pbf",
    "maxScaleFactor": 3,
    "maxSize": 2048,
    "serveAllStyles": false,
    "forefront": false,
    "sparse": true,
    "formatQuality": {
      "jpeg": 80,
      "webp": 90
    },
    "formatOptions": {
      "png": { "compressionLevel": 6 },
      "jpeg": { "quality": 80, "progressive": false },
      "webp": { "quality": 90 }
    },
    "minRendererPoolSizes": [8, 4, 2],
    "maxRendererPoolSizes": [16, 8, 4],
    "tileMargin": 0,
    "dataDecorator": "./decorator.js"
  },
  "styles": {
    "basic": {
      "style": "basic/style.json",
      "serve_data": true,
      "serve_rendered": true,
      "tilejson": {
        "attribution": "© OpenMapTiles",
        "bounds": [5.96, 45.82, 10.49, 47.81]
      },
      "watermark": "© MyCompany",
      "staticAttributionText": "© MyCompany"
    }
  },
  "data": {
    "v3": {
      "mbtiles": "switzerland.mbtiles",
      "tilejson": {
        "attribution": "© OpenMapTiles"
      }
    },
    "terrain": {
      "pmtiles": "https://example.com/terrain.pmtiles",
      "encoding": "terrarium",
      "tileSize": 512
    }
  }
}
```

### Path Resolution

All paths in config are resolved relative to the config file location:

```javascript
// server.js:88-105
paths.root = path.resolve(configPath ? path.dirname(configPath) : process.cwd(), paths.root || '');
paths.styles = path.resolve(paths.root, paths.styles || '');
paths.fonts = path.resolve(paths.root, paths.fonts || '');
// ... etc
```

### Data Source Options

| Option | Type | Description |
|--------|------|-------------|
| `mbtiles` | string | Path to MBTiles file (local only) |
| `pmtiles` | string | Path or URL to PMTiles (local, HTTP, S3) |
| `s3Profile` | string | AWS profile for S3 PMTiles |
| `s3Region` | string | AWS region for S3 PMTiles |
| `requestPayer` | boolean | S3 requester pays |
| `s3UrlFormat` | string | S3 URL format override |
| `sparse` | boolean | Allow overzooming on missing tiles |
| `encoding` | string | Elevation encoding: `terrarium` or `mapbox` |
| `tileSize` | number | Tile size (256 or 512) |

### Style Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `style` | string | required | Path to style.json |
| `serve_data` | boolean | true | Serve style.json endpoint |
| `serve_rendered` | boolean | true | Serve rendered tiles |
| `tilejson` | object | {} | TileJSON overrides |
| `watermark` | string | - | Watermark text |
| `staticAttributionText` | string | - | Attribution on static images |
| `mapping` | object | {} | Map source names to data IDs |

---

## Middleware Stack

### Custom Middleware (src/middleware/)

#### `src/middleware/validation.js` (API Key Validation + CORS)
**Purpose:** API Key validation with external service and CORS handling with wildcard origin support

**Implementation:**
```javascript
// Environment Variables:
// - AUTH_BASE_URL: Base URL to validation API (e.g., https://api.example.com)
// - ALLOWED_ORIGINS: JSON array of allowed origins (e.g., ["http://localhost:4000"])
// - IS_CHECK_ALLOWED_ORIGINS: Set to false to allow all origins (default: true)

// Public paths (no validation required)
const PUBLIC_PATHS = ['/', '/index.css', '/favicon.ico'];

function shouldSkipValidation(path) {
  if (PUBLIC_PATHS.includes(path)) return true;
  if (path.startsWith('/images/')) return true;  // All images public
  return false;
}

export async function validationMiddleware(req, res, next) {
  if (shouldSkipValidation(req.path)) return next();

  const apiKey = req.query.key;
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API Key' });
  }

  const result = await validateApiKey(apiKey);
  if (!result.is_valid) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  // Apply CORS with validated origins
  const corsMiddleware = createCorsMiddleware(result.origins);
  corsMiddleware(req, res, next);
}
```

**Public Paths (no validation):**
| Path | Description |
|------|-------------|
| `/` | Index page |
| `/index.css` | Stylesheet |
| `/favicon.ico` | Favicon |
| `/images/*` | All image assets (logo, markers, etc.) |

**API Key:** Passed via `?key=xxx` query parameter.

**Wildcard Origin Patterns (like Mapbox):**
| Pattern | Matches |
|---------|---------|
| `https://*.example.com` | `https://app.example.com`, `https://www.example.com` |
| `https://example.com/*` | `https://example.com/map`, `https://example.com/admin/dashboard` |
| `https://*.example.com/*` | `https://app.example.com/map`, `https://www.example.com/any/path` |

**API Endpoint Required:**
- `GET {AUTH_BASE_URL}/api/validation?api_key={key}`
- Response: `{"is_valid": true, "allowed_origins": ["https://domain1.com", "https://*.domain2.com"]}`

**Note:** In-memory caching removed - delegated to backend validation service.

#### `src/middleware/index.js` (Exports)
```javascript
export { validationMiddleware } from './validation.js';
```

---

### Current Stack (in order)

```
Request → express.disable('x-powered-by')
        → express.enable('trust proxy')
        → morgan(logFormat) [if not test]
        → validationMiddleware (API Key + CORS)
        → express.static('public/resources')
        → Sub-apps (/data/, /styles/, fonts)
        → Template routes
        → Response
```

### Middleware Details

| Order | Middleware | Location | Purpose | Security Implication |
|-------|------------|----------|---------|---------------------|
| 1 | `disable('x-powered-by')` | server.js:46 | Hide backend stack from response headers | Prevents server fingerprinting |
| 2 | `enable('trust proxy')` | server.js:54 | Trust X-Forwarded-* headers | ⚠️ Only safe behind trusted proxy |
| 3 | `morgan(logFormat)` | server.js:60-68 | HTTP request logging | May log sensitive data (IPs, paths) |
| 4 | `validationMiddleware` | server.js:170 | API Key validation + CORS | ✅ Protects non-public routes with origin control |
| 5 | Sub-apps | server.js:172-181 | Route handling | Each has own middleware |

### Morgan Logging (server.js:56-69)

```javascript
const logFormat = process.env.NODE_ENV === 'production' ? 'tiny' : 'dev';
app.use(morgan(logFormat, {
  stream: opts.logFile
    ? fs.createWriteStream(opts.logFile, { flags: 'a' })
    : process.stdout,
  skip: (req, res) =>
    opts.silent && (res.statusCode === 200 || res.statusCode === 304),
}));
```

**Log formats:**
- `dev` (development): Colored, detailed
- `tiny` (production): Minimal output
- Custom via `--log_format` option

**GDPR consideration:** Logs contain IP addresses. Consider anonymization for EU compliance.

### CORS Configuration (via validationMiddleware)

CORS is now handled by the `validationMiddleware` which:
- Validates API Key first
- Returns allowed origins from the validation API response
- Supports wildcard origin patterns (like Mapbox)
- Can be configured to allow all origins with `IS_CHECK_ALLOWED_ORIGINS=false`

**Configuration via environment variables:**
- `IS_CHECK_ALLOWED_ORIGINS=true` - Validate origins against allowed list (default)
- `IS_CHECK_ALLOWED_ORIGINS=false` - Allow all origins (`Access-Control-Allow-Origin: *`)
- `ALLOWED_ORIGINS` - Fallback JSON array when API doesn't return `allowed_origins`


### Sub-app Middleware

Each sub-app (`serve_data.js`, `serve_style.js`, `serve_rendered.js`) creates its own Express instance:

```javascript
// serve_data.js:48
const app = express().disable('x-powered-by');
app.use(express.json());  // For POST body parsing (elevation batch queries)
```

**Note:** Middleware added to sub-apps only affects that sub-app's routes, not the main app.

---

## Security Analysis

### Current Security Measures

| Measure | Location | Status |
|---------|----------|--------|
| Hide X-Powered-By | server.js:46 | ✅ Implemented |
| Trust Proxy | server.js:54 | ⚠️ Enabled (configurable) |
| API Key Authentication | middleware/validation.js | ✅ Implemented |
| CORS with Origin Control | middleware/validation.js | ✅ Wildcard pattern support |
| Input Sanitization | Multiple | ✅ Removes `\n\r` |
| Path Sanitization | serve_rendered.js:394 | ✅ Uses sanitize-filename |
| Bounds Validation | serve_data.js:97 | ✅ Validates tile coords |
| Sprite Path Sanitization | serve_style.js:148 | ✅ Removes `../` |

### API Key Authentication

The codebase validates API Keys via the `validationMiddleware`:

**API Key:** Passed via `?key=xxx` query parameter.

```javascript
// middleware/validation.js
export async function validationMiddleware(req, res, next) {
  if (shouldSkipValidation(req.path)) return next();

  const apiKey = req.query.key;
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API Key' });
  }

  const result = await validateApiKey(apiKey);
  if (!result.is_valid) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  // Apply CORS with validated origins
  const corsMiddleware = createCorsMiddleware(result.origins);
  corsMiddleware(req, res, next);
}
```

**Public routes** (no key required): `/`, `/index.css`, `/favicon.ico`, `/images/*`

**Protected routes** require API Key via `?key=xxx` query parameter.

---

## Summary Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TileServer GL Architecture                         │
└─────────────────────────────────────────────────────────────────────────────┘

                                    │
                          ┌─────────┴─────────┐
                          │   CLI (main.js)   │
                          │ - Parse args      │
                          │ - Load config     │
                          │ - Start server    │
                          └─────────┬─────────┘
                                    │
                          ┌─────────┴─────────┐
                          │  Express Server   │
                          │   (server.js)     │
                          │                   │
                          │ Middleware:       │
                          │ - trust proxy     │
                          │ - morgan          │
                          │ - cors (opt)      │
                          │ - validation      │
                          └─────────┬─────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         │                          │                          │
         ▼                          ▼                          ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   /data/*       │      │   /styles/*     │      │      /*         │
│  serve_data.js  │      │ serve_style.js  │      │  serve_font.js  │
│                 │      │ serve_rendered  │      │                 │
│ Endpoints:      │      │                 │      │ Endpoints:      │
│ - Tiles         │      │ Endpoints:      │      │ - Font PBFs     │
│ - TileJSON      │      │ - style.json    │      │ - Font list     │
│ - Elevation     │      │ - Sprites       │      │                 │
│                 │      │ - Rendered      │      │                 │
└────────┬────────┘      │ - Static maps   │      └────────┬────────┘
         │               └────────┬────────┘               │
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Data Sources  │      │ MapLibre Native │      │    Font Files   │
│                 │      │   Renderers     │      │      (PBF)      │
│ ┌─────────────┐ │      │                 │      │                 │
│ │  MBTiles    │ │      │ ┌─────────────┐ │      │                 │
│ │ (local)     │ │      │ │ Tile Pool   │ │      │                 │
│ └─────────────┘ │      │ │ @1x,@2x,@3x │ │      │                 │
│ ┌─────────────┐ │      │ └─────────────┘ │      │                 │
│ │  PMTiles    │ │      │ ┌─────────────┐ │      │                 │
│ │ (local/http)│ │      │ │ Static Pool │ │      │                 │
│ │ (s3://)     │ │      │ │ @1x,@2x,@3x │ │      │                 │
│ └─────────────┘ │      │ └─────────────┘ │      │                 │
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

---

## Quick Reference

### Start Server
```bash
# With config file
node src/main.js -c config.json -p 8080

# With single mbtiles file
node src/main.js --file switzerland.mbtiles

# With remote PMTiles
node src/main.js --file https://example.com/tiles.pmtiles

# With options
node src/main.js -c config.json -p 8080 --verbose 2 --cors
```

### Key Environment Variables
- `NODE_ENV` - Environment (development, production, test)
- `PORT` - Override default port
- `BIND` - Override bind address
- `UV_THREADPOOL_SIZE` - Thread pool size (auto-calculated)
- `AUTH_BASE_URL` - Base URL for validation API (e.g., https://api.example.com)
- `ALLOWED_ORIGINS` - JSON array of allowed CORS origins (e.g., `["http://localhost:4000"]`)
- `IS_CHECK_ALLOWED_ORIGINS` - Set to false to allow all origins (default: true)

### Test Commands
```bash
npm test                    # Run all tests
npm run test-docker         # Run tests with xvfb
npm run test:visual:generate  # Generate visual fixtures
```

### Lint Commands
```bash
npm run lint:js             # Check JS/JSON
npm run lint:js:fix         # Auto-fix
npm run lint:yml            # Check YAML
```
