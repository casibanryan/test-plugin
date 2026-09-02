// packages/hub/src/index.js
// Composition root and CLI.
//
//   node src/index.js              serve MCP over HTTP        (how the container runs)
//   node src/index.js --stdio      serve MCP over stdio       (local dev / debugging)
//   node src/index.js --selftest   print build identity + tool surface, exit
//
// --selftest is what the pipeline runs against a freshly built image before it is
// pushed anywhere: it proves the image boots, the contract loads, and the declared and
// implemented tool sets agree — without needing a token, a network, or the platform
// API to be up.

'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logging');
const { createUpstreamClient } = require('./upstream/client');
const { createAuthenticator } = require('./auth');
const { createHttpServer } = require('./http');
const { createMcpServer, selftest, assertHandlersMatchContract } = require('./mcp');

function buildRuntime(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger({ level: config.logLevel, channel: config.channel, commit: config.identity.commit });

  // Fail at boot, not at first call: a mismatch between the contract and the handler
  // registry means this build is wrong, and the deploy should never reach a slot swap.
  assertHandlersMatchContract();

  const upstream = createUpstreamClient(config, logger);
  const authenticator = createAuthenticator({ upstream, logger });

  return { config, logger, upstream, authenticator };
}

async function serveHttp(runtime) {
  const { config, logger, upstream, authenticator } = runtime;
  const server = createHttpServer({ upstream, config, logger, authenticator });

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = server.address();

  logger.info('hub listening', {
    port,
    channel: config.channel,
    upstream: upstream.baseUrl,
    contractVersion: config.identity.contractVersion,
    contractDigest: config.identity.contractDigest,
    mcpProtocolVersion: config.identity.mcpProtocolVersion,
  });

  // App Service sends SIGTERM and then waits. Draining in-flight requests before
  // exiting is what makes a slot swap invisible to a client mid-call.
  const shutdown = async (signal) => {
    logger.info('shutting down', { signal });
    server.close();
    await upstream.close().catch((e) => logger.warn('upstream close failed', { error: e.message }));
    // Give in-flight responses a moment, then leave regardless.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// stdio is for a developer pointing a local client at local code. It authenticates
// once, from HUB_STDIO_TOKEN, because stdio has no per-request headers to carry a
// credential — so it is only ever available on an unhardened channel.
async function serveStdio(runtime) {
  const { config, logger, upstream, authenticator } = runtime;
  if (config.hardened) throw new Error(`stdio transport is not available on the "${config.channel}" channel`);

  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  if (!config.stdioToken) throw new Error('stdio mode needs HUB_STDIO_TOKEN — stdio has no request headers to carry a credential');

  const principal = await authenticator.authenticate({ authorization: `Bearer ${config.stdioToken}` }, 'stdio');
  logger.info('serving stdio', { email: principal.email, kind: principal.kind });

  const server = createMcpServer({ principal, upstream, config, logger, authenticator, requestId: 'stdio' });
  await server.connect(new StdioServerTransport());
  return server;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--selftest')) {
    // No upstream client is constructed and no request is made, so this stays runnable
    // inside a freshly built image with no API reachable and no secrets configured.
    const config = loadConfig({
      ...process.env,
      HUB_CHANNEL: 'local',
      PIVOTLY_API_URL: process.env.PIVOTLY_API_URL || 'http://127.0.0.1:8790',
    });
    console.log(JSON.stringify(selftest(config), null, 2));
    return;
  }

  const runtime = buildRuntime();
  if (argv.includes('--stdio') || runtime.config.mode === 'stdio') await serveStdio(runtime);
  else await serveHttp(runtime);
}

module.exports = { buildRuntime, serveHttp, serveStdio, main };

if (require.main === module) {
  main().catch((err) => {
    // Structured, on stderr, then a non-zero exit: App Service restarts the instance
    // and the deploy gate sees an instance that never became ready.
    process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'hub failed to start', error: err.message, stack: err.stack })}\n`);
    process.exit(1);
  });
}
