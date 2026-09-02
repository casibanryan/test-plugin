#!/usr/bin/env node
// packages/hub/scripts/smoke-remote.js
// Smoke test for a DEPLOYED hub endpoint, over the network, as a real client.
//
//   node scripts/smoke-remote.js --url=https://hub-prerelease.azurewebsites.net
//   node scripts/smoke-remote.js --url=... --expect-commit=$GITHUB_SHA
//   node scripts/smoke-remote.js --url=... --json
//
// Run by the pipeline three times: against the container on the build agent, against
// the pre-release slot before a swap, and against production immediately after. The
// same script every time, so "it passed in pre-release" and "it passed in production"
// mean the same thing.
//
// Deliberately dependency-free — plain fetch, no MCP client library. A smoke test that
// used the SDK would pass while the raw protocol was subtly wrong, and a client that
// is not the SDK is exactly what this is meant to catch.
//
// The token it uses is a read-only client credential. It never has, and must never be
// given, a service token: a smoke test that could write would be writing to production
// on every deploy.

'use strict';

const { ENDPOINTS, VERSION_PAYLOAD_KEYS, SUPPORTED_MCP_PROTOCOL_VERSIONS } = require('@pivotly/contract/protocol');
const { CLIENT_TOOL_NAMES, SERVICE_TOOL_NAMES, STATELESS_TOOL_NAMES } = require('@pivotly/contract/tools');
const { authHeaders } = require('@pivotly/contract/auth');
const { contractDigest } = require('@pivotly/contract/digest');
const { CONTRACT_VERSION, MCP_PROTOCOL_VERSION } = require('@pivotly/contract/protocol');

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

  const token = arg('token') || process.env.SMOKE_TOKEN;
  if (!token) throw new Error('pass --token=... (or set SMOKE_TOKEN) — a READ-ONLY client token');

  const expectCommit = arg('expect-commit');
  const expectDigest = arg('expect-digest') || contractDigest();
  const timeoutMs = Number(arg('timeout-ms', '15000'));
  const channel = arg('channel') || process.env.PIVOTLY_CHANNEL || 'ci';

  const c = createChecker();
  console.log(`\nsmoke: ${base}\n`);

  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* reported by the caller */
    }
    return { status: res.status, json, text };
  };

  let rpcId = 0;
  const rpc = async (method, params, bearer = token) => {
    const res = await fetch(`${base}${ENDPOINTS.mcp}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Both types: the Streamable HTTP spec allows the server to answer with either
        // a JSON body or an SSE stream, and a client that sends only one is a client
        // that breaks the day the server changes its mind.
        accept: 'application/json, text/event-stream',
        ...authHeaders({ token: bearer, channel, requestId: `smoke-${++rpcId}` }),
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
    return { status: res.status, json, text };
  };

  // --- probes --------------------------------------------------------------
  const health = await get(ENDPOINTS.health);
  c.equal(`GET ${ENDPOINTS.health} is 200`, health.status, 200);
  c.ok(`${ENDPOINTS.health} reports alive`, health.json?.alive === true, health.text?.slice(0, 200));

  const version = await get(ENDPOINTS.version);
  c.equal(`GET ${ENDPOINTS.version} is 200`, version.status, 200);
  for (const key of VERSION_PAYLOAD_KEYS) {
    c.ok(`${ENDPOINTS.version} reports ${key}`, version.json && key in version.json, `payload: ${version.text?.slice(0, 200)}`);
  }

  // The cascade guard. If the deployed hub's contract digest differs from the one this
  // checkout computes, the client and the server disagree about the tool surface — the
  // exact failure that otherwise shows up as a broken tool call in someone's editor.
  c.equal('the deployed contract digest matches this checkout', version.json?.contractDigest, expectDigest);
  c.equal('the deployed contract version matches this checkout', version.json?.contractVersion, CONTRACT_VERSION);
  c.ok(
    'the deployed MCP protocol version is one we support',
    SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version.json?.mcpProtocolVersion),
    `server speaks ${version.json?.mcpProtocolVersion}, we accept ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(', ')}`
  );

  // Proves the deploy actually landed, rather than trusting the deploy API's word.
  if (expectCommit) {
    c.equal('the deployed commit is the one we just pushed', version.json?.commit, expectCommit);
  }

  const ready = await get(ENDPOINTS.ready);
  c.equal(`GET ${ENDPOINTS.ready} is 200`, ready.status, 200);
  c.ok(`${ENDPOINTS.ready} reports the platform API reachable`, ready.json?.upstream?.reachable === true, ready.text?.slice(0, 300));

  // --- auth ----------------------------------------------------------------
  const noAuth = await fetch(`${base}${ENDPOINTS.mcp}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  c.equal('an unauthenticated MCP call is refused with 401', noAuth.status, 401);
  c.ok('the 401 carries a WWW-Authenticate challenge', (noAuth.headers.get('www-authenticate') || '').includes('Bearer'));

  const badToken = await rpc('tools/list', {}, 'definitely-not-a-real-token');
  c.equal('a bogus token is refused with 401', badToken.status, 401);

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

  // A read-only client token must be offered exactly the client surface.
  c.equal('a client token is served exactly the client tool surface', served, CLIENT_TOOL_NAMES.slice().sort());

  // And must not be offered any service tool. Asserted separately from the equality
  // above so the failure message says which forbidden tool leaked.
  const leaked = served.filter((n) => SERVICE_TOOL_NAMES.includes(n));
  c.ok('no service tool is exposed to a client token', leaked.length === 0, `leaked: ${leaked.join(', ')}`);

  // Every advertised tool must carry a description and a schema — this is what the
  // model reads, and an empty one is a silent quality regression.
  for (const tool of list.json?.result?.tools || []) {
    c.ok(`${tool.name} advertises a description and an input schema`, Boolean(tool.description) && Boolean(tool.inputSchema));
  }

  // --- a real call ---------------------------------------------------------
  // Only stateless tools: a smoke test must not depend on, or create, tenant data.
  const canary = STATELESS_TOOL_NAMES.includes('greeting_hello') ? 'greeting_hello' : STATELESS_TOOL_NAMES[0];
  const call = await rpc('tools/call', { name: canary, arguments: { name: 'smoke', hour: 9 } });
  c.equal(`tools/call ${canary} succeeds`, call.status, 200);
  c.ok(`${canary} is not an error result`, call.json?.result?.isError !== true, call.text?.slice(0, 300));

  let payload = null;
  try {
    payload = JSON.parse(call.json?.result?.content?.[0]?.text || 'null');
  } catch {
    /* reported below */
  }
  c.ok(`${canary} returns a JSON payload`, payload && payload.ok === true, call.text?.slice(0, 300));
  c.ok(`${canary} returns the expected greeting`, /^Good morning, smoke!/.test(payload?.message || ''), payload?.message);

  // A write must be refused for this token — not merely absent from tools/list, but
  // actually refused if called by name.
  const write = await rpc('tools/call', { name: 'usdf_record_put', arguments: { kind: 'greeting.session', payload: {} } });
  const writeText = write.json?.result?.content?.[0]?.text || '';
  c.ok(
    'a client token cannot call a service write tool',
    write.json?.result?.isError === true || write.json?.error != null,
    `the write was NOT refused: ${writeText.slice(0, 200)}`
  );

  // Input validation must happen server-side, from the contract's schema.
  const bad = await rpc('tools/call', { name: canary, arguments: { hour: 99 } });
  c.ok('the server rejects input that violates the contract schema', bad.json?.result?.isError === true || bad.json?.error != null, bad.text?.slice(0, 200));

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
