// packages/hub/testkit/harness.js
// Boots a real hub HTTP server in front of a real (fake) platform API, on ephemeral
// ports, and hands back a small MCP client.
//
// It lives in testkit/ rather than test/ because Node's test runner treats every .js
// file under test/ as a test file, and a harness is not a test.
//
// Nothing is stubbed inside the hub. The tests go over a socket, through the real
// Streamable HTTP transport, the real auth chain and the real upstream HTTP client —
// so a bug in framing, header handling, or error mapping fails a unit test rather than
// waiting for the deployed smoke test to catch it.

'use strict';

const { createFakePlatformApi } = require('../scripts/fake-platform-api');
const { buildRuntime, serveHttp } = require('../src/index');
const { authHeaders } = require('@pivotly/contract/auth');
const { MCP_PROTOCOL_VERSION, ENDPOINTS } = require('@pivotly/contract/protocol');

async function startHarness(envOverrides = {}) {
  const api = createFakePlatformApi();
  const apiUrl = await api.listen(0);

  const runtime = buildRuntime({
    HUB_CHANNEL: 'local',
    // Silence by default; a failing test can pass HUB_LOG_LEVEL: 'debug' to see the
    // structured logs on stderr.
    HUB_LOG_LEVEL: envOverrides.HUB_LOG_LEVEL || 'error',
    PIVOTLY_API_URL: apiUrl,
    PORT: '0',
    ...envOverrides,
  });

  const server = await serveHttp(runtime);
  const base = `http://127.0.0.1:${server.address().port}`;

  let id = 0;
  const rpc = async (method, params, token = 'dev-token', extraHeaders = {}) => {
    const res = await fetch(`${base}${ENDPOINTS.mcp}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...authHeaders({ token, channel: 'test', requestId: `test-${++id}` }),
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null, text };
  };

  return {
    base,
    apiUrl,
    api,
    runtime,
    rpc,

    get: async (path) => {
      const res = await fetch(`${base}${path}`);
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, text };
    },

    // tools/call, with the tool's JSON payload already unwrapped from MCP's text
    // content — every assertion would otherwise start with the same three lines.
    call: async (name, args, token = 'dev-token') => {
      const res = await rpc('tools/call', { name, arguments: args ?? {} }, token);
      const raw = res.json?.result?.content?.[0]?.text;
      let payload = null;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { _unparseable: raw };
        }
      }
      return { ...res, isError: res.json?.result?.isError === true, payload, raw };
    },

    listTools: async (token = 'dev-token') => {
      const res = await rpc('tools/list', {}, token);
      return (res.json?.result?.tools || []).map((t) => t.name).sort();
    },

    // Drops the short-lived identity cache in src/auth.js, so the next call is
    // forced to resolve its token upstream again. Needed by any test that asserts
    // what the hub sends to the API.
    forgetIdentities: () => runtime.authenticator._cache.clear(),

    initialize: (token = 'dev-token') =>
      rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } }, token),

    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await api.close();
    },
  };
}

module.exports = { startHarness };
