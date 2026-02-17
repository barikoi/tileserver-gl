#!/usr/bin/env node
/**
 * Manual test script for origin pattern matching
 * Run: node test-origins.js
 */

// Copy of patternToRegex from validation.js
/**
 * Converts a wildcard pattern to a regex for origin matching.
 * @param {string} pattern - The wildcard pattern to convert (e.g., 'https://*.example.com')
 * @returns {RegExp} A regex object for matching origins against the pattern
 */
function patternToRegex(pattern) {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${regex}$`, 'i');
}

// Copy of isOriginAllowed from validation.js
/**
 * Checks if an origin is allowed based on a list of allowed origin patterns.
 * @param {string} origin - The origin to check (e.g., 'https://example.com')
 * @param {string[]} allowedOrigins - Array of allowed origin patterns (supports wildcards)
 * @returns {boolean} True if the origin is allowed, false otherwise
 */
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return false;

  for (const pattern of allowedOrigins) {
    if (pattern === origin) return true;
    if (pattern.includes('*')) {
      try {
        if (patternToRegex(pattern).test(origin)) return true;
      } catch {
        // Invalid pattern
      }
    }
  }
  return false;
}

console.log('=== Origin Pattern Matching Test (Mapbox-style) ===\n');

console.log('* matches ANY characters (including dots and slashes)\n');

// Common domain binding patterns
const patterns = [
  // Apex domain
  'https://example.com',

  // WWW subdomain
  'https://www.example.com',

  // Wildcard - matches all subdomains
  'https://*.example.com',

  // Local development with wildcard port
  'http://localhost:*',
];

console.log('Allowed patterns:');
patterns.forEach((p) => console.log(`  - ${p}`));
console.log('\n');

// Test origins
const testOrigins = [
  // Apex domain tests
  { origin: 'https://example.com', desc: 'Apex domain' },
  { origin: 'http://example.com', desc: 'Apex (wrong protocol)' },

  // WWW tests
  { origin: 'https://www.example.com', desc: 'WWW subdomain' },

  // Single-level subdomains
  { origin: 'https://app.example.com', desc: 'app subdomain' },
  { origin: 'https://blog.example.com', desc: 'blog subdomain' },
  { origin: 'https://support.example.com', desc: 'support subdomain' },
  { origin: 'https://api.example.com', desc: 'api subdomain' },

  // Multi-level subdomains
  { origin: 'https://api.v1.example.com', desc: 'multi-level subdomain' },
  { origin: 'https://staging.api.example.com', desc: '3-level subdomain' },

  // With paths
  { origin: 'https://app.example.com/map', desc: 'subdomain + path' },
  { origin: 'https://example.com/admin/dashboard', desc: 'apex + deep path' },

  // Local development
  { origin: 'http://localhost:3000', desc: 'localhost:3000' },
  { origin: 'http://localhost:8080', desc: 'localhost:8080' },
  { origin: 'https://localhost:3000', desc: 'localhost (wrong protocol)' },

  // Should be blocked
  { origin: 'https://evil.com', desc: 'Different domain' },
  { origin: 'https://example.com.evil.com', desc: 'Phishing attempt' },
];

console.log('Testing origins:\n');
console.log('ORIGIN'.padEnd(45) + 'STATUS     DESCRIPTION');
console.log('─'.repeat(85));

for (const { origin, desc } of testOrigins) {
  const allowed = isOriginAllowed(origin, patterns);
  const status = allowed ? '✓ ALLOWED' : '✗ BLOCKED';
  console.log(`${origin.padEnd(45)} ${status.padEnd(10)} ${desc}`);
}

console.log('\n' + '─'.repeat(85));

// Summary: what patterns to use for common scenarios
console.log('\n=== Recommended Patterns ===\n');
console.log('Scenario                                    Pattern');
console.log('─'.repeat(70));
console.log('Single domain                               https://example.com');
console.log(
  'All subdomains (app, www, api, etc.)        https://*.example.com',
);
console.log('Local dev (any port)                        http://localhost:*');
console.log(
  'Local dev (specific port)                   http://localhost:3000',
);
console.log(
  'Everything on domain (subdomains + paths)   https://*.example.com/*',
);
