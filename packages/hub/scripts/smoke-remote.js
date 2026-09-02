#!/usr/bin/env node
// packages/hub/scripts/smoke-remote.js
// Smoke test for a DEPLOYED hub endpoint, over the network, as a real client.
//
//   node scripts/smoke-remote.js --url=https://pivotly-hub-dev.azurewebsites.net
//   node scripts/smoke-remote.js --url=... --expect-commit=$GITHUB_SHA
//   node scripts/smoke-remote.js --url=... --channel=production --json
//
// The pipeline runs this against every channel it touches: the packaged build on the
// runner, dev after a push to main, prerelease before a swap, and production after one.
// The same script every time, so "it passed on prerelease" and "it passed on
// production" mean the same thing.
//
// Deliberately dependency-free — plain fetch, no MCP client library. A smoke test that
// used the SDK could pass while the raw protocol was subtly wrong, and a client that is
// not the SDK is exactly what this is meant to catch.

'use strict';

const { ENDPOINTS, HEADERS, VERSION_PAYLOAD_KEYS, SUPPORTED_MCP_PROTOCOL_VERSIONS, CONTRACT_VERSION, MCP_PROTOCOL_VERSION, CHANNELS } = require('@pivotly/contract/protocol');
const { TOOL_NAMES } = require('@pivotly/contract/tools');
const { contractDigest } = require('@pivotly/contract/digest');

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

function createChecker() {
  const results = [];
  return {
    ok(label, condition, detail) {
      const passed = Boolean(condition);
      results.push({ label, passed, detail: passed ? undefined : detail });
      console.log(`${passed ? 'ok   ' : 'FAIL '} ${label}${passed || detail == null ? '' : `\n        ${detail}`}`);
      return passed;
    },
    equal(label, actual, expected) {
      return this.ok(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    results: () => results,
    failures: () => results.filter((r) => !r.passed),
  };
}

async function main() {
  const base = (arg('url') || process.env.HUB_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('pass --url=https://... (or set HUB_URL)');

  const expectCommit = arg('expect-commit');
  const expectDigest = arg('expect-digest') || contractDigest();
  const expectChannel = arg('channel');
  const timeoutMs = Number(arg('timeout-ms', '15000'));

  if (expectChannel && !CHANNELS.includes(expectChannel)) {
    throw new Error(`--channel must be one of ${CHANNELS.join(', ')}`);
  }

  const c = createChecker();
  console.log(`\nsmoke: ${base}${expectChannel ? ` (expecting channel ${expectChannel})` : ''}\n`);

  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* reported by the caller */
    }
    return { status: res.status, json, text, headers: res.headers };
  };

  let rpcId = 0;
  // No Authorization header anywhere in this file: the hub is anonymous by design.
  // The headers that ARE sent are identity-of-caller metadata the hub logs.
  const rpc = async (method, params, extraHeaders = {}) => {
    const res = await fetch(`${base}${ENDPOINTS.mcp}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Both types: Streamable HTTP lets the server answer with a JSON body or an SSE
        // stream, and a client that sends only one breaks the day the server changes.
        accept: 'application/json, text/event-stream',
        [HEADERS.client]: 'smoke',
        [HEADERS.channel]: expectChannel || 'ci',
        [HEADERS.clientContract]: CONTRACT_VERSION,
        [HEADERS.requestId]: `smoke-${++rpcId}`,
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params: params ?? {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* reported by the caller */
    }
    return { status: res.status, json, text, headers: res.headers };
  };

  // --- probes --------------------------------------------------------------
  const health = await get(ENDPOINTS.health);
  c.equal(`GET ${ENDPOINTS.health} is 200`, health.status, 200);
  c.ok(`${ENDPOINTS.health} reports alive`, health.json?.alive === true, health.text?.slice(0, 200));

  const ready = await get(ENDPOINTS.ready);
  c.equal(`GET ${ENDPOINTS.ready} is 200`, ready.status, 200);
  c.ok(`${ENDPOINTS.ready} reports a coherent build`, ready.json?.ready === true, ready.text?.slice(0, 300));
  c.equal(`${ENDPOINTS.ready} serves the expected tool count`, ready.json?.tools, TOOL_NAMES.length);

  const version = await get(ENDPOINTS.version);
  c.equal(`GET ${ENDPOINTS.version} is 200`, version.status, 200);
  for (const key of VERSION_PAYLOAD_KEYS) {
    c.ok(`${ENDPOINTS.version} reports ${key}`, version.json && key in version.json, `payload: ${version.text?.slice(0, 200)}`);
  }

  // The cascade guard. If the deployed digest differs from the one this checkout
  // computes, the client and the server disagree about the tool surface.
  c.equal('the deployed contract digest matches this checkout', version.json?.contractDigest, expectDigest);
  c.equal('the deployed contract version matches this checkout', version.json?.contractVersion, CONTRACT_VERSION);
  c.ok(
    'the deployed MCP protocol version is one we support',
    SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version.json?.mcpProtocolVersion),
    `server speaks ${version.json?.mcpProtocolVersion}, we accept ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(', ')}`
  );

  // A hub deployed to the wrong channel reports it here. Catching that matters most
  // right after a slot swap, where the swapped instance could still believe it is
  // prerelease.
  if (expectChannel) {
    c.equal(`the endpoint reports it is on the ${expectChannel} channel`, version.json?.channel, expectChannel);
  }

  // Proves the deploy actually landed, rather than trusting the deploy API's word.
  if (expectCommit) {
    c.equal('the deployed commit is the one we just pushed', version.json?.commit, expectCommit);
  }

  // --- protocol ------------------------------------------------------------
  const init = await rpc('initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'pivotly-smoke', version: CONTRACT_VERSION },
  });
  c.equal('initialize succeeds', init.status, 200);
  c.ok('initialize returns a protocol version', typeof init.json?.result?.protocolVersion === 'string', init.text?.slice(0, 300));
  c.ok('initialize identifies the server', init.json?.result?.serverInfo?.name === 'pivotly-hub', JSON.stringify(init.json?.result?.serverInfo));

  const list = await rpc('tools/list');
  c.equal('tools/list succeeds', list.status, 200);
  const served = (list.json?.result?.tools || []).map((t) => t.name).sort();
  c.equal('the endpoint serves exactly the contract tool surface', served, TOOL_NAMES.slice().sort());

  // Every advertised tool must carry a description and a schema — this is what the
  // model reads, and an empty one is a silent quality regression.
  for (const tool of list.json?.result?.tools || []) {
    c.ok(`${tool.name} advertises a description and an input schema`, Boolean(tool.description) && Boolean(tool.inputSchema));
    c.equal(`${tool.name} advertises itself as read-only`, tool.annotations?.readOnlyHint, true);
  }

  // Anonymous access is a deliberate property, so assert it rather than relying on it.
  // If a credential check is ever added, this failing is the intended alarm.
  const bare = await fetch(`${base}${ENDPOINTS.mcp}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  c.equal('a request with no client headers at all still works (the hub is anonymous)', bare.status, 200);

  // --- real calls ----------------------------------------------------------
  const hello = await rpc('tools/call', { name: 'greeting_hello', arguments: { name: 'smoke', hour: 9 } });
  c.equal('tools/call greeting_hello succeeds', hello.status, 200);
  c.ok('greeting_hello is not an error result', hello.json?.result?.isError !== true, hello.text?.slice(0, 300));

  let payload = null;
  try {
    payload = JSON.parse(hello.json?.result?.content?.[0]?.text || 'null');
  } catch {
    /* reported below */
  }
  c.ok('greeting_hello returns a JSON payload', payload && payload.ok === true, hello.text?.slice(0, 300));
  c.ok('greeting_hello returns the expected greeting', /^Good morning, smoke!/.test(payload?.message || ''), payload?.message);

  const dayCheck = await rpc('tools/call', { name: 'greeting_day_check', arguments: { answer: 'not great' } });
  let mood = null;
  try {
    mood = JSON.parse(dayCheck.json?.result?.content?.[0]?.text || 'null')?.mood;
  } catch {
    /* reported below */
  }
  c.equal('greeting_day_check reads a negation as negative', mood, 'negative');

  // Input validation must happen server-side, from the contract's schema.
  const bad = await rpc('tools/call', { name: 'greeting_hello', arguments: { hour: 99 } });
  c.ok('the server rejects input that violates the contract schema', bad.json?.result?.isError === true || bad.json?.error != null, bad.text?.slice(0, 200));

  const unknown = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  c.ok('an unknown tool is refused', unknown.json?.result?.isError === true || unknown.json?.error != null, unknown.text?.slice(0, 200));

  // --- transport details ---------------------------------------------------
  const correlated = await rpc('tools/list', {}, { [HEADERS.requestId]: 'smoke-correlation-id' });
  c.equal('the request id is echoed back for correlation', correlated.headers.get(HEADERS.requestId), 'smoke-correlation-id');

  const notFound = await get('/definitely-not-a-route');
  c.equal('an unknown route is 404', notFound.status, 404);

  // --- summary -------------------------------------------------------------
  const failures = c.failures();
  const summary = {
    ok: failures.length === 0,
    url: base,
    checks: c.results().length,
    failed: failures.length,
    deployed: version.json ? { commit: version.json.commit, contractDigest: version.json.contractDigest, channel: version.json.channel } : null,
  };

  console.log('');
  if (flag('json')) console.log(JSON.stringify({ ...summary, failures }, null, 2));
  console.log(failures.length ? `FAIL  ${failures.length} of ${summary.checks} checks failed against ${base}` : `ok    all ${summary.checks} checks passed against ${base}`);
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
