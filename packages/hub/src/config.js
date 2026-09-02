// packages/hub/src/config.js
// Environment -> validated config, resolved once at boot.
//
// There is very little to configure, and that is the point. The hub has no database,
// no upstream API and no credentials, so the only things it needs to know are which
// port to listen on and which channel it is. Everything else has a working default,
// which is why `npm run dev:hub` needs no setup at all.

'use strict';

const { CHANNELS, HARDENED_CHANNELS, CONTRACT_VERSION, MCP_PROTOCOL_VERSION } = require('@pivotly/contract/protocol');
const { contractDigest } = require('@pivotly/contract/digest');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function loadConfig(env = process.env) {
  const channel = (env.HUB_CHANNEL || 'local').toLowerCase();
  if (!CHANNELS.includes(channel)) {
    throw new Error(`HUB_CHANNEL must be one of ${CHANNELS.join(', ')} (got "${channel}")`);
  }

  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT is not a valid port: ${env.PORT}`);

  const logLevel = (env.HUB_LOG_LEVEL || 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`HUB_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  return {
    channel,
    // `prerelease` and `production` carry real traffic. Nothing in the hub currently
    // behaves differently, but the flag is here because the clients and the pipeline
    // both hold these two channels to https, and a hub that did not know which rung it
    // was on could not report it on /version for them to check.
    hardened: HARDENED_CHANNELS.includes(channel),
    mode: env.HUB_MODE === 'stdio' ? 'stdio' : 'http',
    port,
    host: env.HUB_HOST || '0.0.0.0',
    logLevel,

    // Build identity, injected by the pipeline at package time. This is how a deploy
    // proves the commit it just pushed is the one actually serving a channel: the
    // deploy gate polls /version for its own SHA rather than trusting the deploy API.
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

    // App Service cuts a request at 230s regardless, so stay well inside that and
    // return a clean MCP error rather than having the socket severed.
    requestTimeoutMs: Number(env.HUB_REQUEST_TIMEOUT_MS || 30000),
    maxBodyBytes: Number(env.HUB_MAX_BODY_BYTES || 1024 * 1024),
  };
}

module.exports = { loadConfig, LOG_LEVELS };
