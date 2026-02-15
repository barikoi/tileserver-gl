# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TileServer GL is a map tile server for vector and raster tiles using MapLibre GL styles. It supports server-side raster rendering via MapLibre GL Native, and serves data from MBTiles and PMTiles sources (including remote HTTP/HTTPS/S3 URLs for PMTiles).

## Development Commands

```bash
# Install dependencies
npm install

# Run the server (requires config.json or mbtiles/pmtiles file)
node src/main.js

# Run tests (expects test_data/config.json to exist)
npm test

# Run tests on Linux (with virtual framebuffer)
npm run test-docker

# Generate visual test fixtures
npm run test:visual:generate

# Linting
npm run lint:js          # Check JS/JSON with ESLint and Prettier
npm run lint:js:fix      # Auto-fix linting issues
npm run lint:yml         # Check YAML files

# Build static resources (copies MapLibre, Leaflet, etc. to public/resources/)
npm run prepare
```

## Architecture

### Entry Points
- `src/main.js` - CLI entry point with Commander argument parsing. Handles config file loading and auto-detection of mbtiles/pmtiles files.
- `src/server.js` - Express server setup. Initializes routes, loads styles and data sources, manages renderer pools.

### Core Modules
- `src/serve_rendered.js` - Raster tile rendering using MapLibre GL Native. Manages renderer pools for different scale factors. Handles tile and static image requests with overlays (markers, paths).
- `src/serve_data.js` - Serves raw vector tiles (PBF/GeoJSON) and elevation data. Supports batch elevation queries.
- `src/serve_style.js` - Serves style.json files with source URL rewriting.
- `src/serve_font.js` - Serves font PBF files for text rendering.

### Data Sources
- `src/pmtiles_adapter.js` - PMTiles support (local files, HTTP, HTTPS, S3).
- `src/mbtiles_wrapper.js` - MBTiles support (local files only).

### Rendering
- `src/render.js` - Canvas-based rendering for overlays (paths, markers), watermarks, and attribution text.

### Utilities
- `src/utils.js` - Coordinate utilities, URL validation, tile URL generation.

## Key Patterns

### Renderer Pools
The server uses `advanced-pool` to manage MapLibre GL Native renderer instances. Separate pools exist for tile rendering (`renderers`) and static image rendering (`renderersStatic`), with different pool sizes per scale factor (1x, 2x, 3x).

### Data Source Resolution
Style sources use URL schemes like `mbtiles://sourceName/{z}/{x}/{y}.pbf` or `pmtiles://sourceName/{z}/{x}/{y}.pbf`. The server intercepts these requests and resolves them to actual data sources defined in the config.

### Sparse Tile Handling
- `sparse=true` (default for raster): Returns 404 for missing tiles, allowing overzooming.
- `sparse=false` (default for vector): Returns 204 for missing tiles, preventing overzooming.

### Configuration
Config is a JSON file with `options`, `styles`, and `data` sections. Paths are resolved relative to the config file location. See documentation at https://tileserver.readthedocs.io/en/latest/.

## Testing

Tests use mocha with chai and supertest. The test setup (`test/setup.js`) changes to `test_data/` directory and starts the server on port 8888. Tests are in `test/*.js`.

## Important Notes

- Node.js 20, 22, or 24 required
- Import order matters in `serve_rendered.js`: `canvas` must be imported before `@maplibre/maplibre-gl-native` to avoid ARM crashes
- The `-light` variant (`tileserver-gl-light`) excludes raster rendering and uses `serve_light.js` instead of `serve_rendered.js`
