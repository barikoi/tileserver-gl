#!/usr/bin/env node
/**
 * Manual test script for domain-only origin pattern matching
 * Run: node test-origins.js
 *
 * Patterns are domain-only (no protocol, no port). Both http:// and https://
 * origins match the same pattern. Wildcard `*` in patterns like `*.example.com`
 * matches subdomains at any depth (e.g., app.example.com, api.v1.example.com).
 * Pattern `localhost` matches localhost on any port (3000, 8080, etc.).
 */

// Copy of stripProtocol from validation.js
/**
 * Extract hostname from a URL/origin string (removes protocol and port).
 * @param {string} origin - Full URL or origin
 * @returns {string} Hostname without port
 */
function stripProtocol(origin) {
  try {
    const url = new URL(origin);
    return url.hostname; // hostname without port
  } catch {
    // fallback for non-standard inputs
    return origin.replace(/^[a-z]+:\/\//i, '');
  }
}

// Copy of patternToRegex from validation.js
/**
 * Convert a domain wildcard pattern to RegExp.
 * `*` matches any characters including across dots (multi-level subdomains).
 * @param {string} pattern - Wildcard pattern (e.g., "*.example.com")
 * @returns {RegExp} Regex for matching domain patterns
 */
function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*'); // wildcard matches across dots for multi-level subdomains

  return new RegExp(`^${escaped}$`, 'i');
}

// Copy of isOriginAllowed from validation.js
/**
 * Checks if an origin is allowed based on a list of domain-only allowed origin patterns.
 * Strips protocol and port from origin before matching.
 * @param {string} origin - The origin to check (e.g., 'https://example.com')
 * @param {string[]} allowedOrigins - Array of domain-only allowed origin patterns (supports wildcards)
 * @returns {boolean} True if the origin is allowed, false otherwise
 */
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return false;

  const hostname = stripProtocol(origin);

  for (const pattern of allowedOrigins) {
    if (pattern === '*') return true;
    if (pattern === hostname) return true;
    if (pattern.includes('*')) {
      try {
        if (patternToRegex(pattern).test(hostname)) return true;
      } catch {
        // Invalid pattern
      }
    }
  }
  return false;
}

/**
 * Run origin matching tests and print results table.
 * @param {string} title - Test section title
 * @param {string[]} patterns - Allowed origin patterns
 * @param {{origin: string, desc: string}[]} testOrigins - Origins to test
 */
function runTests(title, patterns, testOrigins) {
  console.log(`\n=== ${title} ===\n`);
  console.log('Allowed patterns:');
  patterns.forEach((p) => console.log(`  - ${p}`));
  console.log('\n');

  console.log('ORIGIN'.padEnd(45) + 'STATUS     DESCRIPTION');
  console.log('─'.repeat(85));

  for (const { origin, desc } of testOrigins) {
    const allowed = isOriginAllowed(origin, patterns);
    const status = allowed ? '✓ ALLOWED' : '✗ BLOCKED';
    console.log(`${origin.padEnd(45)} ${status.padEnd(10)} ${desc}`);
  }
  console.log('─'.repeat(85));
}

console.log('=== Origin Pattern Matching Test (Domain-Only) ===');
console.log(
  'Patterns are domain-only (no protocol, no port). Both http and https match.',
);
console.log(
  '*.example.com matches subdomains at any depth. localhost matches any port.\n',
);

// All test origins (browsers always send full origin with protocol)
const testOrigins = [
  // Apex domain - both protocols match
  { origin: 'https://example.com', desc: 'Apex domain (https)' },
  { origin: 'http://example.com', desc: 'Apex domain (http)' },

  // WWW
  { origin: 'https://www.example.com', desc: 'WWW subdomain' },

  // Single-level subdomains
  { origin: 'https://app.example.com', desc: 'app subdomain' },
  { origin: 'https://blog.example.com', desc: 'blog subdomain' },
  { origin: 'https://api.example.com', desc: 'api subdomain' },

  // Multi-level subdomains (matched by *.example.com)
  { origin: 'https://api.v1.example.com', desc: 'multi-level subdomain' },
  {
    origin: 'https://staging.api.example.com',
    desc: '3-level subdomain',
  },

  // Local development - any port on localhost
  { origin: 'http://localhost', desc: 'localhost (default port)' },
  { origin: 'https://localhost', desc: 'localhost (https default)' },
  { origin: 'http://localhost:3000', desc: 'localhost:3000' },
  { origin: 'https://localhost:8080', desc: 'localhost:8080' },

  // Should be blocked
  { origin: 'https://evil.com', desc: 'Different domain' },
  {
    origin: 'https://example.com.evil.com',
    desc: 'Phishing attempt',
  },
];

// Test: Matches the API response pattern
runTests(
  'Domain-Only Patterns (matches API response)',
  [
    'example.com',
    'www.example.com',
    '*.example.com',
    'localhost',
    'staging.api.example.com',
  ],
  testOrigins,
);

// Recommended patterns
console.log('\n=== Recommended Patterns (Domain-Only) ===\n');
console.log('Scenario                                    Pattern');
console.log('─'.repeat(70));
console.log('Single domain                               example.com');
console.log('All subdomains (any depth)                  *.example.com');
console.log(
  'Specific subdomain                          staging.api.example.com',
);
console.log('Local dev (any port)                        localhost');
console.log('Allow all origins                           *');
