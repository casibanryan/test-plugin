// packages/hub/test/hub.test.js
// The hub, end to end over a real socket.
//
// With no database, no upstream API and no credentials, there is nothing left to stub —
// so these tests exercise the whole stack: the real Streamable HTTP transport, the real
// schema validation, the real error mapping.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startHarness } = require('../testkit/harness');
const { TOOL_NAMES } = require('@pivotly/contract/tools');
const { ERROR_CODES } = require('@pivotly/contract/errors');
const { VERSION_PAYLOAD_KEYS, ENDPOINTS, HEADERS, CHANNELS } = require('@pivotly/contract/protocol');
const { contractDigest } = require('@pivotly/contract/digest');

// One hub for the whole file. Every test is independent because the hub holds no state
// between requests — which is itself worth noticing.
let hub;
test.before(async () => {
  hub = await startHarness();
});
test.after(async () => {
  await hub.stop();
});

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------
test('the served surface is exactly the contract surface', async () => {
  assert.deepEqual(await hub.listTools(), TOOL_NAMES.slice().sort());
});

test('every served tool advertises a description, a schema, and readOnly', async () => {
  const res = await hub.rpc('tools/list');
  for (const tool of res.json.result.tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} has a thin description`);
    assert.ok(tool.inputSchema, `${tool.name} has no input schema`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is not advertised as read-only`);
  }
});

test('an unknown tool is refused', async () => {
  const res = await hub.call('no_such_tool', {});
  assert.equal(res.isError, true);
  assert.match(res.raw, /not found/i);
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------
test('greeting_hello personalises and picks the right salutation', async () => {
  const res = await hub.call('greeting_hello', { name: 'Resty', hour: 14 });
  assert.equal(res.isError, false);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.greeting, 'Good afternoon, Resty!');
  assert.match(res.payload.message, /How's your day going so far\?$/);
});

test('greeting_hello stays impersonal with no name, and neutral at night', async () => {
  const res = await hub.call('greeting_hello', { hour: 23 });
  assert.equal(res.payload.greeting, 'Hello!');
});

test('greeting_day_check lets a negation beat the positive word inside it', async () => {
  const res = await hub.call('greeting_day_check', { name: 'Resty', answer: 'not great' });
  assert.equal(res.payload.mood, 'negative');
  assert.match(res.payload.reply, /^Resty,/);
});

test('greeting_day_check is neutral on input it cannot read', async () => {
  const res = await hub.call('greeting_day_check', { answer: 'purple monday sideways' });
  assert.equal(res.payload.mood, 'neutral');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
test('the contract schema rejects bad input at the server', async () => {
  const res = await hub.call('greeting_hello', { hour: 99 });
  assert.equal(res.isError, true);
  assert.match(res.raw, /23/); // the contract's declared max
});

test('a required field cannot be omitted', async () => {
  const res = await hub.call('greeting_day_check', {});
  assert.equal(res.isError, true);
});

test('an unknown argument cannot influence a tool: it is stripped before the handler', async () => {
  // Worth pinning down, because the advertised JSON Schema says
  // `additionalProperties: false` while zod's default object behaviour is to STRIP
  // unknown keys rather than reject them. So an extra argument is not an error — but it
  // never reaches the handler, which is the property that matters.
  const res = await hub.call('greeting_hello', { name: 'Resty', hour: 9, nope: 'ignored' });
  assert.equal(res.isError, false);
  assert.equal(res.payload.greeting, 'Good morning, Resty!');
  assert.equal('nope' in res.payload, false);
});

// ---------------------------------------------------------------------------
// Anonymous access — a deliberate property, so it is asserted
// ---------------------------------------------------------------------------
test('no credential is required: a bare request with no headers works', async () => {
  const res = await fetch(`${hub.base}${ENDPOINTS.mcp}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.tools.length, TOOL_NAMES.length);
});

test('an Authorization header is accepted and simply ignored', async () => {
  // A client that sends one (out of habit, or via a proxy) must not be rejected — the
  // hub has no opinion about credentials it does not use.
  const res = await hub.rpc('tools/list', {}, { authorization: 'Bearer whatever' });
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
test('initialize identifies the server and agrees a protocol version', async () => {
  const res = await hub.initialize();
  assert.equal(res.status, 200);
  assert.equal(res.json.result.serverInfo.name, 'pivotly-hub');
  assert.ok(res.json.result.protocolVersion);
});

test('the transport is stateless: tools/list works with no prior initialize', async () => {
  // This is what lets the hub run behind App Service with no sticky routing and survive
  // a slot swap mid-session. If it regressed, every request after a swap would fail
  // until the client reconnected.
  const res = await hub.rpc('tools/list');
  assert.equal(res.status, 200);
  assert.ok(res.json.result.tools.length > 0);
});

test('a body that is not JSON is 400, not 500', async () => {
  const res = await fetch(`${hub.base}${ENDPOINTS.mcp}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

test('an oversized body is refused before it is parsed, and still answers', async () => {
  const small = await startHarness({ HUB_MAX_BODY_BYTES: '200' });
  try {
    const res = await fetch(`${small.base}${ENDPOINTS.mcp}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greeting_hello', arguments: { name: 'x'.repeat(5000) } } }),
    });
    // A 400 rather than a connection reset: the request is drained, not destroyed.
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, ERROR_CODES.INVALID_INPUT);
  } finally {
    await small.stop();
  }
});

test('the request id is echoed back so a client can correlate a log line', async () => {
  const res = await hub.rpc('tools/list', {}, { [HEADERS.requestId]: 'my-correlation-id' });
  assert.equal(res.headers.get(HEADERS.requestId), 'my-correlation-id');
});

test('an unknown path is 404 with a contract error code', async () => {
  const res = await hub.get('/not-a-route');
  assert.equal(res.status, 404);
  assert.equal(res.json.code, ERROR_CODES.NOT_FOUND);
});

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------
test('/healthz reports liveness with no dependencies', async () => {
  const res = await hub.get(ENDPOINTS.health);
  assert.equal(res.status, 200);
  assert.equal(res.json.alive, true);
});

test('/readyz verifies this build is coherent and declares no dependencies', async () => {
  const res = await hub.get(ENDPOINTS.ready);
  assert.equal(res.status, 200);
  assert.equal(res.json.ready, true);
  assert.equal(res.json.tools, TOOL_NAMES.length);
  // Honest reporting: with nothing external to probe, readiness says so rather than
  // implying it checked something.
  assert.deepEqual(res.json.dependencies, []);
});

test('/version reports every key the contract requires', async () => {
  const res = await hub.get(ENDPOINTS.version);
  assert.equal(res.status, 200);
  for (const key of VERSION_PAYLOAD_KEYS) assert.ok(key in res.json, `missing ${key}`);
  assert.equal(res.json.contractDigest, contractDigest());
  assert.equal(res.json.server, 'pivotly-hub');
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
test('the hub reports the channel it was configured for', async () => {
  for (const channel of ['dev', 'prerelease']) {
    const other = await startHarness({ HUB_CHANNEL: channel });
    try {
      const version = await other.get(ENDPOINTS.version);
      assert.equal(version.json.channel, channel);
      const health = await other.get(ENDPOINTS.health);
      assert.equal(health.json.channel, channel);
    } finally {
      await other.stop();
    }
  }
});

test('an unknown channel is refused at boot rather than defaulted', async () => {
  // A typo in an App Setting must stop the instance, not silently produce a hub that
  // reports a channel nobody deploys to.
  await assert.rejects(() => startHarness({ HUB_CHANNEL: 'staging' }), /HUB_CHANNEL must be one of/);
});

test('every declared channel is a valid hub configuration', async () => {
  for (const channel of CHANNELS) {
    const instance = await startHarness({ HUB_CHANNEL: channel });
    try {
      const res = await instance.get(ENDPOINTS.version);
      assert.equal(res.json.channel, channel);
    } finally {
      await instance.stop();
    }
  }
});
