// packages/hub/test/hub.test.js
// The hub, end to end over HTTP, against the fake platform API.
//
// These are the tests that would catch a regression in the thing that matters most:
// that a client credential is served a read-only surface and cannot reach a write by
// any route the transport offers.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startHarness } = require('../testkit/harness');
const { CLIENT_TOOL_NAMES, SERVICE_TOOL_NAMES, TOOL_NAMES } = require('@pivotly/contract/tools');
const { ERROR_CODES } = require('@pivotly/contract/errors');
const { VERSION_PAYLOAD_KEYS, ENDPOINTS } = require('@pivotly/contract/protocol');
const { contractDigest } = require('@pivotly/contract/digest');

// One hub for the whole file. Every test is independent of the others' state because
// the hub holds none — which is itself worth noticing.
let hub;
test.before(async () => {
  hub = await startHarness();
});
test.after(async () => {
  await hub.stop();
});

// ---------------------------------------------------------------------------
test('the client surface is exactly the contract client surface', async () => {
  assert.deepEqual(await hub.listTools('dev-token'), CLIENT_TOOL_NAMES.slice().sort());
});

test('a client session is served no service tool at all', async () => {
  const served = await hub.listTools('dev-token');
  for (const name of SERVICE_TOOL_NAMES) {
    assert.equal(served.includes(name), false, `${name} leaked onto the client surface`);
  }
});

test('a service session is served the whole surface', async () => {
  assert.deepEqual(await hub.listTools('worker-token'), TOOL_NAMES.slice().sort());
});

test('a client cannot call a service tool even by name', async () => {
  const res = await hub.call('usdf_record_put', { kind: 'greeting.session', payload: { greeting: 'a', answer: 'b', mood: 'c' } }, 'dev-token');
  assert.equal(res.isError, true);
  // The tool is not registered for this session, so the SDK refuses it before any
  // handler runs. That is the intended answer: unknown, rather than forbidden.
  assert.match(res.raw, /not found/i);
});

test('a client cannot claim a job even by name', async () => {
  const res = await hub.call('job_claim', { worker: 'w' }, 'dev-token');
  assert.equal(res.isError, true);
});

// ---------------------------------------------------------------------------
test('the stateless greeting tools answer without touching the platform API', async () => {
  const before = hub.api.calls().length;

  const hello = await hub.call('greeting_hello', { name: 'Resty', hour: 14 });
  assert.equal(hello.isError, false);
  assert.equal(hello.payload.ok, true);
  assert.equal(hello.payload.greeting, 'Good afternoon, Resty!');
  assert.match(hello.payload.message, /How's your day going so far\?$/);

  // Identity resolution is the only upstream call permitted, and even that may be
  // absent because src/auth.js caches it for a few seconds. What must never appear is
  // a record or job call: if a greeting started needing platform data, the pipeline
  // would lose its dependency-free canary and a platform outage would take the
  // greeting tools down with it.
  const paths = [...new Set(hub.api.calls().slice(before).map((c) => c.path))];
  assert.deepEqual(paths.filter((p) => p !== '/v1/me'), []);
});

test('greeting_day_check classifies a negation as negative', async () => {
  const res = await hub.call('greeting_day_check', { name: 'Resty', answer: 'not great' });
  assert.equal(res.payload.mood, 'negative');
  assert.match(res.payload.reply, /^Resty,/);
});

test('the contract schema rejects bad input at the server', async () => {
  const res = await hub.call('greeting_hello', { hour: 99 });
  assert.equal(res.isError, true);
  assert.match(res.raw, /23/); // the contract's max
});

test('an unknown argument cannot influence a tool: it is stripped before the handler', async () => {
  // Worth pinning down, because the advertised JSON Schema says
  // `additionalProperties: false` while zod's default object behaviour is to STRIP
  // unknown keys rather than reject them. So an extra argument is not an error — but
  // it also never reaches the handler, which is the property that matters: a caller
  // cannot smuggle a field past the contract and have it change what a tool does.
  const res = await hub.call('greeting_hello', { name: 'Resty', hour: 9, nope: 'ignored' });
  assert.equal(res.isError, false);
  assert.equal(res.payload.greeting, 'Good morning, Resty!');
  assert.equal('nope' in res.payload, false);
});

// ---------------------------------------------------------------------------
test('a service credential can write and a client can then read it back', async () => {
  const write = await hub.call(
    'usdf_record_put',
    { kind: 'greeting.session', payload: { greeting: 'hi', answer: 'good', mood: 'positive' }, idempotencyKey: 'harness-1' },
    'worker-token'
  );
  assert.equal(write.isError, false, write.raw);
  assert.equal(write.payload.ok, true);
  assert.equal(write.payload.deduplicated, false);
  assert.match(write.payload.checksum, /^[0-9a-f]{64}$/);

  // Same tenant, read-only client token.
  const read = await hub.call('usdf_record_get', { recordId: write.payload.recordId }, 'dev-token');
  assert.equal(read.payload.ok, true);
  assert.deepEqual(read.payload.payload, { greeting: 'hi', answer: 'good', mood: 'positive' });
});

test('the same idempotency key does not create a second record', async () => {
  const args = { kind: 'greeting.session', payload: { greeting: 'x', answer: 'y', mood: 'z' }, idempotencyKey: 'harness-idem' };
  const first = await hub.call('usdf_record_put', args, 'worker-token');
  const second = await hub.call('usdf_record_put', args, 'worker-token');
  assert.equal(second.payload.recordId, first.payload.recordId);
  assert.equal(second.payload.deduplicated, true);
});

test("another tenant's record reads as absent, not as forbidden", async () => {
  const write = await hub.call('usdf_record_put', { kind: 'greeting.session', payload: { greeting: 'a', answer: 'b', mood: 'c' } }, 'worker-token');
  const read = await hub.call('usdf_record_get', { recordId: write.payload.recordId }, 'other-token');
  // not_found, never forbidden: a 403 would confirm the id exists in some other tenant.
  assert.equal(read.payload.ok, false);
  assert.equal(read.payload.code, 'not_found');
});

test('a record that does not exist is not_found rather than an error result', async () => {
  const read = await hub.call('usdf_record_get', { recordId: '00000000-0000-4000-8000-000000000000' }, 'dev-token');
  assert.equal(read.isError, false, 'a missing record is an answer, not a failure');
  assert.equal(read.payload.code, 'not_found');
});

test('an invalid payload is refused with the contract input code', async () => {
  const res = await hub.call('usdf_record_put', { kind: 'greeting.session', payload: { greeting: 'only' } }, 'worker-token');
  assert.equal(res.isError, true);
  assert.equal(res.payload.code, ERROR_CODES.INVALID_INPUT);
});

test('an unregistered kind is refused with the contract input code', async () => {
  const res = await hub.call('usdf_record_put', { kind: 'not.a.kind', payload: {} }, 'worker-token');
  assert.equal(res.isError, true);
  assert.equal(res.payload.code, ERROR_CODES.INVALID_INPUT);
});

// ---------------------------------------------------------------------------
test('an empty job queue is a successful claimed:false, not an error', async () => {
  const res = await hub.call('job_claim', { worker: 'test-worker', kinds: ['nothing.queued.here'] }, 'worker-token');
  assert.equal(res.isError, false);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.claimed, false);
});

test('a queued job is claimed with a lease in the future', async () => {
  hub.api.seed.job('t-dev', 'harness.job', { n: 1 });
  const res = await hub.call('job_claim', { worker: 'test-worker', kinds: ['harness.job'], leaseSeconds: 30 }, 'worker-token');
  assert.equal(res.payload.claimed, true);
  assert.equal(res.payload.kind, 'harness.job');
  assert.equal(res.payload.attempt, 1);
  assert.ok(new Date(res.payload.leaseExpiresAt) > new Date());
});

test('a claimed job is not handed to a second worker', async () => {
  hub.api.seed.job('t-dev', 'harness.exclusive', {});
  const first = await hub.call('job_claim', { worker: 'w1', kinds: ['harness.exclusive'] }, 'worker-token');
  const second = await hub.call('job_claim', { worker: 'w2', kinds: ['harness.exclusive'] }, 'worker-token');
  assert.equal(first.payload.claimed, true);
  assert.equal(second.payload.claimed, false, 'the same job was claimed twice');
});

// ---------------------------------------------------------------------------
test('an unauthenticated MCP call is 401 with a challenge', async () => {
  const res = await fetch(`${hub.base}${ENDPOINTS.mcp}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') || '', /Bearer/);
  const body = await res.json();
  assert.equal(body.code, ERROR_CODES.UNAUTHENTICATED);
});

test('a malformed Authorization header is 401, not 500', async () => {
  const res = await fetch(`${hub.base}${ENDPOINTS.mcp}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Basic abc' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401);
});

test('an unknown token is token_invalid, and says nothing about which tokens exist', async () => {
  const res = await hub.rpc('tools/list', {}, 'nope-not-a-token');
  assert.equal(res.status, 401);
  assert.equal(res.json.code, ERROR_CODES.TOKEN_INVALID);
  assert.equal(res.json.message, 'the presented token is not valid');
});

test('a body that is not JSON is 400, not 500', async () => {
  const res = await fetch(`${hub.base}${ENDPOINTS.mcp}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer dev-token' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

test('an oversized body is refused before it is parsed', async () => {
  const small = await startHarness({ HUB_MAX_BODY_BYTES: '200' });
  try {
    const res = await fetch(`${small.base}${ENDPOINTS.mcp}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer dev-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greeting_hello', arguments: { name: 'x'.repeat(5000) } } }),
    });
    assert.equal(res.status, 400);
  } finally {
    await small.stop();
  }
});

// ---------------------------------------------------------------------------
test('initialize identifies the server and agrees a protocol version', async () => {
  const res = await hub.initialize();
  assert.equal(res.status, 200);
  assert.equal(res.json.result.serverInfo.name, 'pivotly-hub');
  assert.ok(res.json.result.protocolVersion);
});

test('the transport is stateless: tools/list works without a prior initialize', async () => {
  // This is the property that lets the hub run behind App Service with no sticky
  // routing and survive a slot swap mid-session. If it regressed, every request after
  // a swap would fail until the client reconnected.
  const res = await hub.rpc('tools/list');
  assert.equal(res.status, 200);
  assert.ok(res.json.result.tools.length > 0);
});

test('/healthz answers without calling the platform API', async () => {
  const before = hub.api.calls().length;
  const res = await hub.get(ENDPOINTS.health);
  assert.equal(res.status, 200);
  assert.equal(res.json.alive, true);
  assert.equal(hub.api.calls().length, before, 'liveness must not depend on upstream');
});

test('/readyz reports the platform API reachable', async () => {
  const res = await hub.get(ENDPOINTS.ready);
  assert.equal(res.status, 200);
  assert.equal(res.json.ready, true);
  assert.equal(res.json.upstream.reachable, true);
});

test('/readyz is 503 when the platform API is unreachable, but /healthz stays 200', async () => {
  const isolated = await startHarness();
  await isolated.api.close(); // the API is gone; the hub is not
  try {
    const ready = await isolated.get(ENDPOINTS.ready);
    assert.equal(ready.status, 503);
    assert.equal(ready.json.ready, false);
    assert.equal(ready.json.upstream.reachable, false);

    const health = await isolated.get(ENDPOINTS.health);
    assert.equal(health.status, 200, 'an upstream outage must not fail liveness and restart the fleet');
  } finally {
    await isolated.stop();
  }
});

test('/version reports every key the contract requires', async () => {
  const res = await hub.get(ENDPOINTS.version);
  assert.equal(res.status, 200);
  for (const key of VERSION_PAYLOAD_KEYS) assert.ok(key in res.json, `missing ${key}`);
  assert.equal(res.json.contractDigest, contractDigest());
  assert.equal(res.json.server, 'pivotly-hub');
});

test('an unknown path is 404 with a contract error code', async () => {
  const res = await hub.get('/not-a-route');
  assert.equal(res.status, 404);
  assert.equal(res.json.code, ERROR_CODES.NOT_FOUND);
});

test('the request id is echoed back so a client can correlate a log line', async () => {
  const res = await hub.rpc('tools/list', {}, 'dev-token', { 'x-request-id': 'my-correlation-id' });
  assert.equal(res.headers.get('x-request-id'), 'my-correlation-id');
});

// ---------------------------------------------------------------------------
test("the hub forwards the caller's own token upstream and holds none of its own", async () => {
  hub.forgetIdentities();
  const before = hub.api.calls().length;
  await hub.call('usdf_record_get', { recordId: 'whatever' }, 'dev-token');

  const upstreamCalls = hub.api.calls().slice(before);
  assert.ok(upstreamCalls.length > 0);
  for (const call of upstreamCalls) {
    // Every upstream call carries the caller's bearer token, never a hub credential.
    assert.equal(call.headers.authorization, 'Bearer dev-token', `${call.path} did not forward the caller's token`);
  }
});

test('the hub tells the API which channel and contract version it is', async () => {
  hub.forgetIdentities(); // force a fresh /v1/me rather than a cache hit
  const before = hub.api.calls().length;
  await hub.call('greeting_hello', {}, 'dev-token');
  const call = hub.api.calls().slice(before)[0];
  assert.ok(call, 'no upstream call was made');
  assert.equal(call.headers['x-pivotly-channel'], 'local');
  assert.ok(call.headers['x-pivotly-contract']);
});

test('an identity is cached briefly, so a burst of calls is not a burst of /v1/me', async () => {
  hub.forgetIdentities();
  const before = hub.api.calls().length;
  await hub.call('greeting_hello', {}, 'dev-token');
  await hub.call('greeting_hello', {}, 'dev-token');
  await hub.call('greeting_day_check', { answer: 'fine' }, 'dev-token');
  const whoami = hub.api.calls().slice(before).filter((c) => c.path === '/v1/me');
  assert.equal(whoami.length, 1, `expected one identity call, saw ${whoami.length}`);
});
