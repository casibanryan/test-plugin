// packages/hub/src/http.js
// The cloud transport: Streamable HTTP MCP on /mcp, plus the three probes the
// deployment pipeline drives.
//
// ANONYMOUS BY DESIGN. There is no Authorization header and no credential check. The
// hub serves two pure functions over data the caller supplied in the same request — no
// database, no upstream API, no tenant data, nothing that belongs to anyone. There is
// therefore nothing for auth to protect, and adding a token would be theatre: it would
// have to be distributed to every client and would guard a time-of-day greeting.
//
// What that does mean, stated plainly so nobody is surprised later: anyone who can
// reach the URL can call these tools. The moment a tool touches real data, auth stops
// being optional — and the contract enforces that boundary, refusing to build if any
// tool is not read-only (see packages/contract/src/digest.js).
//
// Stateless: each POST /mcp gets its own McpServer and transport, answered and torn
// down. No session map, no sticky routing, nothing to lose — which is what makes the
// App Service story simple: instances can be added, recycled or slot-swapped mid-flight.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { ENDPOINTS, HEADERS, VERSION_PAYLOAD_KEYS } = require('@pivotly/contract/protocol');
const { ERROR_CODES, PivotlyError, isPivotlyError } = require('@pivotly/contract/errors');

const { createMcpServer, assertHandlersMatchContract } = require('./mcp');

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
        chunks.length = 0;
        // Drain rather than destroy: destroying the request tears down the socket, so
        // the 400 this produces would never reach the client — they would see a
        // connection reset and have no idea why.
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

function createHttpServer({ config, logger }) {
  async function handleMcp(req, res, requestId) {
    // The transport writes this response, not sendJson, so the correlation header has
    // to be set before it takes over.
    res.setHeader(HEADERS.requestId, requestId);

    let body;
    try {
      const raw = await readBody(req, config.maxBodyBytes);
      body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch (err) {
      const wire = isPivotlyError(err) ? err : new PivotlyError(ERROR_CODES.INVALID_INPUT, 'request body is not valid JSON');
      return sendJson(res, wire.httpStatus, wire.toJSON(), requestId);
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer({
      config,
      logger,
      requestId,
      client: req.headers[HEADERS.client] || null,
      channel: req.headers[HEADERS.channel] || null,
    });

    res.on('close', () => {
      // Order matters: the transport must stop before the server it is attached to, or
      // an in-flight write can outlive its own server.
      transport.close().catch((e) => logger.debug('transport close', { requestId, error: e.message }));
      server.close().catch((e) => logger.debug('server close', { requestId, error: e.message }));
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  // Readiness. With no database and no upstream, there is no dependency to probe — so
  // rather than duplicating /healthz, this re-verifies that THIS BUILD is coherent:
  // the contract and handler registry still agree, and every declared schema still
  // builds. That is cheap, and it is exactly the failure a bad package or a partial
  // deploy produces. The two probes stay separate anyway because App Service points
  // its health check at one of them and the deploy gate polls it.
  function handleReady(res, requestId) {
    try {
      const { tools } = assertHandlersMatchContract();
      return sendJson(
        res,
        200,
        {
          ok: true,
          ready: true,
          channel: config.channel,
          contractDigest: config.identity.contractDigest,
          tools,
          dependencies: [], // deliberately none — see the note at the top of this file
        },
        requestId
      );
    } catch (err) {
      logger.error('readiness check failed — this build is not coherent', { requestId, error: err.message });
      return sendJson(res, 503, { ok: false, ready: false, code: ERROR_CODES.INTERNAL, message: 'this build is not serving a coherent tool surface' }, requestId);
    }
  }

  const server = http.createServer((req, res) => {
    const requestId = String(req.headers[HEADERS.requestId] || crypto.randomUUID());
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    res.on('finish', () => {
      // One line per request. The calling client and its contract version are logged
      // because "which clients are still on the old contract" is the question you have
      // to answer before retiring one — and with several clients, you need to know
      // which of them to chase.
      logger.info('http', {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - started,
        client: req.headers[HEADERS.client] || null,
        clientChannel: req.headers[HEADERS.channel] || null,
        clientContract: req.headers[HEADERS.clientContract] || null,
      });
    });

    (async () => {
      if (path === ENDPOINTS.health) {
        return sendJson(res, 200, { ok: true, alive: true, channel: config.channel, uptimeSeconds: Math.round(process.uptime()) }, requestId);
      }

      if (path === ENDPOINTS.ready) return handleReady(res, requestId);

      if (path === ENDPOINTS.version) {
        const body = {};
        for (const key of VERSION_PAYLOAD_KEYS) body[key] = config.identity[key] ?? null;
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
