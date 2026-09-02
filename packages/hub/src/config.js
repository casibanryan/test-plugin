// packages/hub/src/config.js
// Environment -> validated config, resolved once at boot.
//
// The job here is refusing to start in a shape that would be wrong in a protected
// channel. The hub has no database and no persistent state, so almost all of its
// configuration is about one thing: which platform API it talks to. Getting that
// wrong is the failure that matters — a prerelease hub pointed at the production API
// would pass every probe and be actively harmful, so the pairing is checked rather
// than assumed.

'use strict';

const { CHANNELS, HARDENED_CHANNELS, CONTRACT_VERSION, MCP_PROTOCOL_VERSION } = require('@pivotly/contract/protocol');
const { contractDigest } = require('@pivotly/contract/digest');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function loadConfig(env = process.env) {
  const channel = (env.HUB_CHANNEL || 'local').toLowerCase();
  if (!CHANNELS.includes(channel)) {
    throw new Error(`HUB_CHANNEL must be one of ${CHANNELS.join(', ')} (got "${channel}")`);
  }
  const hardened = HARDENED_CHANNELS.includes(channel);

  const baseUrl = env.PIVOTLY_API_URL || '';
  if (!baseUrl) {
    throw new Error('PIVOTLY_API_URL is required — the hub holds no data and cannot serve anything without the platform API');
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`PIVOTLY_API_URL is not a valid URL: ${baseUrl}`);
  }

  // Plaintext HTTP to the platform API would put every forwarded bearer token on the
  // wire in clear. Allowed only for a loopback address in an unhardened channel.
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(loopback && !hardened)) {
    throw new Error(`PIVOTLY_API_URL must use https (got ${parsed.protocol}//${parsed.hostname}) — the caller's token is forwarded upstream`);
  }

  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT is not a valid port: ${env.PORT}`);

  const logLevel = (env.HUB_LOG_LEVEL || 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`HUB_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  const requestTimeoutMs = Number(env.HUB_REQUEST_TIMEOUT_MS || 30000);
  // 3 x 8s = 24s worst case, comfortably inside the 30s request budget below. These
  // three defaults are chosen together; the check further down enforces the relation
  // so overriding one of them in an App Setting cannot quietly break it.
  const upstreamTimeoutMs = Number(env.PIVOTLY_API_TIMEOUT_MS || 8000);
  const maxAttempts = Number(env.PIVOTLY_API_MAX_ATTEMPTS || 3);

  // The retry budget has to fit inside the request budget, or the hub holds a client
  // waiting past its own timeout and then answers into a closed socket.
  const worstCase = upstreamTimeoutMs * maxAttempts;
  if (worstCase >= requestTimeoutMs) {
    throw new Error(
      `upstream retry budget (${maxAttempts} x ${upstreamTimeoutMs}ms = ${worstCase}ms) must be less than HUB_REQUEST_TIMEOUT_MS (${requestTimeoutMs}ms)`
    );
  }

  return {
    channel,
    hardened,
    mode: env.HUB_MODE === 'stdio' ? 'stdio' : 'http',
    port,
    host: env.HUB_HOST || '0.0.0.0',
    logLevel,

    upstream: {
      baseUrl,
      timeoutMs: upstreamTimeoutMs,
      maxAttempts,
      retryDelayMs: Number(env.PIVOTLY_API_RETRY_DELAY_MS || 250),
    },

    // Build identity. The pipeline injects these at image build time so /version can
    // prove which commit is actually serving a channel — the deploy verification step
    // polls for the commit it just pushed rather than trusting the deploy API.
    identity: {
      server: 'pivotly-hub',
      serverVersion: require('../package.json').version,
      contractVersion: CONTRACT_VERSION,
      contractDigest: contractDigest(),
      mcpProtocolVersion: MCP_PROTOCOL_VERSION,
      channel,
      commit: env.BUILD_COMMIT || 'dev',
      builtAt: env.BUILD_TIMESTAMP || null,
    },

    // App Service kills a request at 230s regardless, so stay well inside that and
    // return a clean MCP error instead of having the socket cut.
    requestTimeoutMs,
    maxBodyBytes: Number(env.HUB_MAX_BODY_BYTES || 1024 * 1024),

    // stdio has no per-request headers to carry a credential, so it authenticates once
    // from this. Unhardened channels only — index.js enforces that.
    stdioToken: env.HUB_STDIO_TOKEN || '',
  };
}

module.exports = { loadConfig, LOG_LEVELS };
