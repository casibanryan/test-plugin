// packages/hub/src/index.js
// Composition root and CLI.
//
//   node src/index.js              serve MCP over HTTP        (how the deployed app runs)
//   node src/index.js --stdio      serve MCP over stdio       (local dev / Claude Desktop)
//   node src/index.js --selftest   print build identity, exit
//
// --selftest is what the pipeline runs against a freshly packaged build before it is
// deployed anywhere: it proves the build boots, the contract loads, and the declared
// and implemented tool sets agree — with no network and no configuration.

'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logging');
const { createHttpServer } = require('./http');
const { createMcpServer, selftest, assertHandlersMatchContract } = require('./mcp');

function buildRuntime(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger({ level: config.logLevel, channel: config.channel, commit: config.identity.commit });

  // Fail at boot, not at first call: a mismatch between the contract and the handler
  // registry means this build is wrong, and the deploy should never reach a slot swap.
  assertHandlersMatchContract();

  return { config, logger };
}

async function serveHttp({ config, logger }) {
  const server = createHttpServer({ config, logger });

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = server.address();

  logger.info('hub listening', {
    port,
    channel: config.channel,
    contractVersion: config.identity.contractVersion,
    contractDigest: config.identity.contractDigest,
    mcpProtocolVersion: config.identity.mcpProtocolVersion,
    commit: config.identity.commit,
  });

  // App Service sends SIGTERM and then waits. Draining in-flight requests before
  // exiting is what makes a slot swap invisible to a client mid-call.
  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// stdio is for pointing a local client (Claude Desktop, a CLI) at local code. No token:
// the hub is anonymous, and stdio has no request headers to carry one anyway.
async function serveStdio({ config, logger }) {
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  logger.info('serving stdio', { channel: config.channel, contractDigest: config.identity.contractDigest });

  const server = createMcpServer({ config, logger, requestId: 'stdio', client: 'stdio', channel: config.channel });
  await server.connect(new StdioServerTransport());
  return server;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--selftest')) {
    console.log(JSON.stringify(selftest(loadConfig(process.env)), null, 2));
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
