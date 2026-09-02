// packages/hub/src/http.js
// The cloud transport: Streamable HTTP MCP on /mcp, plus the three probe endpoints the
// deployment pipeline drives.
//
// Stateless by choice. Each POST /mcp is authenticated, given its own McpServer and
// transport, answered, and torn down. No session map, no sticky routing, no state to
// lose — which is what makes the App Service story simple: instances can be added,
// recycled, or swapped between slots mid-flight and no client notices.
//
// The probes are not decoration; each one answers a different question the pipeline
// asks at a different moment, and the split between the first two is load-bearing:
//
//   /healthz   is the PROCESS alive?  Never calls upstream. If liveness depended on
//              the platform API, an API outage would make App Service conclude every
//              hub instance was broken and restart the whole fleet — turning someone
//              else's incident into ours.
//   /readyz    can this instance SERVE?  Calls the platform API's own health endpoint,
//              so an instance that cannot reach its only data source stops taking
//              traffic. This is the gate a deploy waits on before a slot swap.
//   /version   which build is this?  The deploy polls it for the commit it just
//              pushed, and the Axle autopatch compares its contract digest against
//              what the client was shipped with.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { ENDPOINTS, VERSION_PAYLOAD_KEYS } = require('@pivotly/contract/protocol');
const { HEADERS } = require('@pivotly/contract/auth');
const { ERROR_CODES, PivotlyError, isPivotlyError } = require('@pivotly/contract/errors');

const { createMcpServer } = require('./mcp');

function sendJson(res, status, body, requestId) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    [HEADERS.requestId]: requestId,
  });
  res.end(payload);
}

// Read the body ourselves rather than handing the socket to the transport, so an
// oversized request is refused before it is parsed instead of after.
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;

    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limitBytes) {
        over = true;
        chunks.length = 0; // stop holding what we have already refused
        // Drain the rest instead of destroying the request. Destroying tears down the
        // socket, so the 400 this rejection produces would never reach the client —
        // they would see a connection reset and have no idea why.
        req.resume();
        reject(new PivotlyError(ERROR_CODES.INVALID_INPUT, `request body exceeds ${limitBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function createHttpServer({ upstream, config, logger, authenticator }) {
  // Readiness is cached briefly. App Service and the deploy loop both poll it, and an
  // upstream round trip per poll is waste — but caching a *failure* would delay
  // noticing recovery, so only success is cached.
  let readyCache = { at: 0, body: null };
  const READY_TTL_MS = 2000;

  async function handleReady(res, requestId) {
    const now = Date.now();
    if (readyCache.body && now - readyCache.at < READY_TTL_MS) {
      return sendJson(res, 200, readyCache.body, requestId);
    }

    try {
      const upstreamHealth = await upstream.health(requestId);
      const body = {
        ok: true,
        ready: true,
        channel: config.channel,
        upstream: { url: upstream.baseUrl, reachable: true, reported: upstreamHealth ?? null },
      };
      readyCache = { at: now, body };
      return sendJson(res, 200, body, requestId);
    } catch (err) {
      // The hub has no data of its own, so an unreachable API means this instance
      // cannot serve anything but the two in-process greeting tools. Reporting ready
      // would let a deploy swap it into production and call that a success.
      const code = isPivotlyError(err) ? err.code : ERROR_CODES.UNAVAILABLE;
      logger.error('readiness check failed', { requestId, upstream: upstream.baseUrl, error: err.message });
      return sendJson(
        res,
        503,
        { ok: false, ready: false, code, message: 'the platform API is not reachable from this instance', upstream: { url: upstream.baseUrl, reachable: false } },
        requestId
      );
    }
  }

  async function handleMcp(req, res, requestId) {
    // The transport writes this response, not sendJson, so the correlation header has
    // to be set before it takes over — otherwise the one path a client actually uses
    // is the one path it cannot correlate to a log line.
    res.setHeader(HEADERS.requestId, requestId);

    let principal;
    try {
      principal = await authenticator.authenticate(req.headers, requestId);
    } catch (err) {
      // Authentication fails at the transport layer, before any MCP framing exists,
      // so it is answered as HTTP rather than as a JSON-RPC error.
      const wire = isPivotlyError(err) ? err : new PivotlyError(ERROR_CODES.UNAUTHENTICATED, 'authentication failed');
      logger.warn('mcp request rejected', { requestId, code: wire.code });
      res.setHeader('www-authenticate', 'Bearer realm="pivotly-hub"');
      return sendJson(res, wire.httpStatus, wire.toJSON(), requestId);
    }

    let body;
    try {
      const raw = await readBody(req, config.maxBodyBytes);
      body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch (err) {
      const wire = isPivotlyError(err) ? err : new PivotlyError(ERROR_CODES.INVALID_INPUT, 'request body is not valid JSON');
      return sendJson(res, wire.httpStatus, wire.toJSON(), requestId);
    }

    // Stateless: sessionIdGenerator undefined. One server and one transport per
    // request, discarded when the response is done.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer({ principal, upstream, config, logger, authenticator, requestId });

    res.on('close', () => {
      // Closing in this order matters: the transport must stop before the server it
      // is attached to, or an in-flight write can outlive its own server.
      transport.close().catch((e) => logger.debug('transport close', { requestId, error: e.message }));
      server.close().catch((e) => logger.debug('server close', { requestId, error: e.message }));
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const server = http.createServer((req, res) => {
    const requestId = String(req.headers[HEADERS.requestId] || crypto.randomUUID());
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    res.on('finish', () => {
      // One line per request. The client's channel and contract version are logged
      // because "which client versions are still calling us" is the question you need
      // answered before retiring a contract.
      logger.info('http', {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - started,
        clientChannel: req.headers[HEADERS.channel] || null,
        clientContract: req.headers[HEADERS.clientContract] || null,
      });
    });

    (async () => {
      if (path === ENDPOINTS.health) {
        // Deliberately dependency-free: liveness must not fail because the platform
        // API did. See the note at the top of this file.
        return sendJson(res, 200, { ok: true, alive: true, channel: config.channel, uptimeSeconds: Math.round(process.uptime()) }, requestId);
      }

      if (path === ENDPOINTS.ready) return handleReady(res, requestId);

      if (path === ENDPOINTS.version) {
        const body = {};
        for (const key of VERSION_PAYLOAD_KEYS) body[key] = config.identity[key] ?? null;
        body.upstream = upstream.baseUrl;
        return sendJson(res, 200, body, requestId);
      }

      if (path === ENDPOINTS.mcp) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { allow: 'POST, GET, DELETE, OPTIONS' });
          return res.end();
        }
        return handleMcp(req, res, requestId);
      }

      return sendJson(res, 404, { ok: false, code: ERROR_CODES.NOT_FOUND, message: `no route for ${path}` }, requestId);
    })().catch((err) => {
      logger.error('unhandled request error', { requestId, path, error: err.message, stack: err.stack });
      if (!res.headersSent) sendJson(res, 500, { ok: false, code: ERROR_CODES.INTERNAL, message: 'internal error' }, requestId);
      else res.destroy();
    });
  });

  // App Service fronts this with a proxy that will hang up first; a slightly longer
  // server-side timeout means the proxy decides, not a half-closed socket.
  server.headersTimeout = config.requestTimeoutMs + 5000;
  server.requestTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = 65_000;

  return server;
}

module.exports = { createHttpServer, readBody };
