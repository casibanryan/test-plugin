// packages/hub/testkit/harness.js
// Boots a real hub HTTP server on an ephemeral port and hands back a small MCP client.
//
// Nothing inside the hub is stubbed — and with no database, no upstream API and no
// credentials, there is nothing left that could be. The tests go over a real socket,
// through the real Streamable HTTP transport, so a bug in framing, header handling or
// error mapping fails a unit test rather than waiting for a deployed smoke test.
//
// It lives in testkit/ rather than test/ because Node's test runner treats every .js
// file under test/ as a test file, and a harness is not a test.

'use strict';

const { buildRuntime, serveHttp } = require('../src/index');
const { MCP_PROTOCOL_VERSION, ENDPOINTS, HEADERS } = require('@pivotly/contract/protocol');

async function startHarness(envOverrides = {}) {
  const runtime = buildRuntime({
    HUB_CHANNEL: 'local',
    // Silent by default; a failing test can pass HUB_LOG_LEVEL: 'debug' to see the logs.
    HUB_LOG_LEVEL: envOverrides.HUB_LOG_LEVEL || 'error',
    PORT: '0',
    ...envOverrides,
  });

  const server = await serveHttp(runtime);
  const base = `http://127.0.0.1:${server.address().port}`;

  let id = 0;
  const rpc = async (method, params, extraHeaders = {}) => {
    const res = await fetch(`${base}${ENDPOINTS.mcp}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [HEADERS.client]: 'testkit',
        [HEADERS.channel]: 'local',
        [HEADERS.requestId]: `test-${++id}`,
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null, text };
  };

  return {
    base,
    runtime,
    rpc,

    get: async (path) => {
      const res = await fetch(`${base}${path}`);
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, text };
    },

    // tools/call, with the tool's JSON payload already unwrapped from MCP's text
    // content — every assertion would otherwise start with the same three lines.
    call: async (name, args) => {
      const res = await rpc('tools/call', { name, arguments: args ?? {} });
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

    listTools: async () => {
      const res = await rpc('tools/list');
      return (res.json?.result?.tools || []).map((t) => t.name).sort();
    },

    initialize: () => rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } }),

    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startHarness };
