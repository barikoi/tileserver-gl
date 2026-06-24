import { expect } from 'chai';

// Startup validation tests for app.config.js.
//
// app.config.js calls validateConfig(config) at module load. We reload the
// module with different env vars to verify the fail-fast contract.

/**
 * Reload app.config.js with the given AUTH_MODE and env vars.
 * @param {string|undefined} mode - AUTH_MODE value (undefined to clear it).
 * @param {{accessToken?: string, baseUrl?: string}} [env] - Optional env values.
 * @returns {Promise<typeof import('../src/app.config.js').config>} Loaded config.
 */
async function loadConfig(mode, env) {
  delete process.env.AUTH_MODE;
  delete process.env.ACCESS_TOKEN;
  delete process.env.AUTH_BASE_URL;
  delete process.env.ALLOWED_ORIGINS;
  if (mode !== undefined) process.env.AUTH_MODE = mode;
  if (env?.accessToken !== undefined)
    process.env.ACCESS_TOKEN = env.accessToken;
  if (env?.baseUrl !== undefined) process.env.AUTH_BASE_URL = env.baseUrl;

  const url = `../src/app.config.js?ts=${Date.now()}-${Math.random()}`;
  return (await import(url)).config;
}

describe('Config startup validation', function () {
  this.timeout(5000);

  it('boots in static mode with a single ACCESS_TOKEN', async function () {
    const cfg = await loadConfig('static', { accessToken: 'token-abc' });
    expect(cfg.auth.mode).to.equal('static');
    expect(cfg.auth.accessTokens).to.deep.equal(['token-abc']);
  });

  it('boots in static mode with multiple comma-separated ACCESS_TOKEN values', async function () {
    const cfg = await loadConfig('static', {
      accessToken: 'token-a,token-b,token-c',
    });
    expect(cfg.auth.mode).to.equal('static');
    expect(cfg.auth.accessTokens).to.deep.equal([
      'token-a',
      'token-b',
      'token-c',
    ]);
  });

  it('trims whitespace around comma-separated ACCESS_TOKEN values', async function () {
    const cfg = await loadConfig('static', {
      accessToken: ' token-a , token-b ,, token-c ',
    });
    expect(cfg.auth.accessTokens).to.deep.equal([
      'token-a',
      'token-b',
      'token-c',
    ]);
  });

  it('boots in dynamic mode when AUTH_BASE_URL is set', async function () {
    const cfg = await loadConfig('dynamic', {
      baseUrl: 'https://auth.example.com',
    });
    expect(cfg.auth.mode).to.equal('dynamic');
    expect(cfg.auth.baseUrl).to.equal('https://auth.example.com');
  });

  it('throws when AUTH_MODE=static and ACCESS_TOKEN is unset', async function () {
    let threw = null;
    try {
      await loadConfig('static', { accessToken: '' });
    } catch (err) {
      threw = err;
    }
    expect(threw).to.be.an('error');
    expect(threw.message).to.match(
      /FATAL: AUTH_MODE=static requires ACCESS_TOKEN/,
    );
  });

  it('throws when AUTH_MODE=static and ACCESS_TOKEN is only whitespace/commas', async function () {
    let threw = null;
    try {
      await loadConfig('static', { accessToken: ' , , ' });
    } catch (err) {
      threw = err;
    }
    expect(threw).to.be.an('error');
    expect(threw.message).to.match(
      /FATAL: AUTH_MODE=static requires ACCESS_TOKEN/,
    );
  });

  it('throws when AUTH_MODE=dynamic and AUTH_BASE_URL is unset', async function () {
    let threw = null;
    try {
      await loadConfig('dynamic', { baseUrl: '' });
    } catch (err) {
      threw = err;
    }
    expect(threw).to.be.an('error');
    expect(threw.message).to.match(
      /FATAL: AUTH_MODE=dynamic requires AUTH_BASE_URL/,
    );
  });

  it('throws on invalid AUTH_MODE value', async function () {
    let threw = null;
    try {
      await loadConfig('auto');
    } catch (err) {
      threw = err;
    }
    expect(threw).to.be.an('error');
    expect(threw.message).to.match(
      /FATAL: AUTH_MODE must be 'static' or 'dynamic'/,
    );
  });

  it("defaults to 'dynamic' when AUTH_MODE is unset (with AUTH_BASE_URL set)", async function () {
    const cfg = await loadConfig(undefined, {
      baseUrl: 'https://auth.example.com',
    });
    expect(cfg.auth.mode).to.equal('dynamic');
  });
});
