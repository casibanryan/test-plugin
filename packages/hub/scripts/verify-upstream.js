#!/usr/bin/env node
// packages/hub/scripts/verify-upstream.js
// Verifies that a platform API actually behaves the way the hub assumes it does.
//
//   node scripts/verify-upstream.js --url=https://api-prerelease.pivotly.com
//   node scripts/verify-upstream.js --url=... --json
//
// This is the check that replaced verifying a database. The hub owns no schema, no
// migrations and no grants, so there is nothing of its own to inspect — but it does
// depend on a set of API behaviours, and every one of those assumptions is a place
// where a change on the platform side could break clients without any hub code
// changing. This script makes each assumption explicit and testable.
//
// The pipeline runs it against the pre-release API before promoting a hub build, which
// is what stops "the core team changed an endpoint" from becoming "the plugin is
// broken for everyone".
//
// Tokens: needs a read-only CLIENT token and a SERVICE token. The service token is
// used only to confirm the write path exists and that the *client* token is refused on
// it. It writes at most one record, with an idempotency key, into whatever tenant it
// belongs to — so point this at a pre-release API, never at production.

'use strict';

const crypto = require('node:crypto');

const { UPSTREAM_ENDPOINTS } = require('@pivotly/contract/protocol');
const { authHeaders, PRINCIPAL_KEYS } = require('@pivotly/contract/auth');
const { ERROR_CODES } = require('@pivotly/contract/errors');

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

function createChecker() {
  const results = [];
  return {
    group(name) {
      console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`);
    },
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
  const base = (arg('url') || process.env.PIVOTLY_API_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('pass --url=https://... (or set PIVOTLY_API_URL)');

  const clientToken = arg('client-token') || process.env.SMOKE_TOKEN;
  const serviceToken = arg('service-token') || process.env.VERIFY_SERVICE_TOKEN;
  if (!clientToken) throw new Error('pass --client-token=... (or set SMOKE_TOKEN) — a read-only client token');
  if (!serviceToken) throw new Error('pass --service-token=... (or set VERIFY_SERVICE_TOKEN)');

  const timeoutMs = Number(arg('timeout-ms', '15000'));
  const c = createChecker();
  console.log(`\nverify upstream: ${base}\n`);

  const call = async (method, endpoint, { token, body, params } = {}) => {
    const path = endpoint.replace(/:([a-zA-Z]+)/g, (_, k) => encodeURIComponent(params[k]));
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...authHeaders({ token, channel: 'verify' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* reported by the caller */
    }
    return { status: res.status, json, text, contentType: res.headers.get('content-type') || '' };
  };

  // -----------------------------------------------------------------------
  c.group('reachability');
  const health = await call('GET', UPSTREAM_ENDPOINTS.health);
  c.equal(`GET ${UPSTREAM_ENDPOINTS.health} is 200`, health.status, 200);
  c.ok('the health endpoint returns JSON', health.contentType.includes('application/json'), `content-type: ${health.contentType}`);
  // The hub's /readyz calls this WITHOUT a token, so it must not require one — if it
  // did, a token rotation would take the whole hub fleet out of rotation.
  c.ok('the health endpoint does not require authentication', health.status !== 401, 'the hub readiness probe sends no token');

  // -----------------------------------------------------------------------
  c.group('identity');
  const me = await call('GET', UPSTREAM_ENDPOINTS.whoami, { token: clientToken });
  c.equal(`GET ${UPSTREAM_ENDPOINTS.whoami} is 200 for a valid token`, me.status, 200);

  // The hub normalises this payload into a principal, so every key it reads must be
  // present. A missing `kind` would silently resolve to the read-only default and a
  // missing `scopes` would refuse everything — both are confusing failures far from
  // their cause, which is why they are asserted here.
  for (const key of ['principalId', 'email', 'kind', 'scopes']) {
    c.ok(`/v1/me reports ${key}`, me.json && me.json[key] != null, `payload keys: ${Object.keys(me.json || {}).join(', ')}`);
  }
  c.ok('/v1/me reports scopes as an array', Array.isArray(me.json?.scopes), typeof me.json?.scopes);
  c.ok(
    '/v1/me reports a principal kind the contract knows',
    ['client', 'service'].includes(me.json?.kind),
    `got "${me.json?.kind}"; the hub would fall back to the read-only kind`
  );
  c.equal('the smoke token is a CLIENT principal', me.json?.kind, 'client');

  const unknownKeys = Object.keys(me.json || {}).filter((k) => !PRINCIPAL_KEYS.includes(k) && k !== 'disabled');
  // Not a failure — an additive API change is allowed — but worth surfacing, because
  // it is usually the first sign the contract needs updating.
  if (unknownKeys.length) console.log(`note  /v1/me returned keys the contract does not model: ${unknownKeys.join(', ')}`);

  const anon = await call('GET', UPSTREAM_ENDPOINTS.whoami);
  c.equal('an unauthenticated /v1/me is 401', anon.status, 401);
  const bogus = await call('GET', UPSTREAM_ENDPOINTS.whoami, { token: 'not-a-real-token' });
  c.equal('a bogus token is 401, not 403 or 500', bogus.status, 401);

  const service = await call('GET', UPSTREAM_ENDPOINTS.whoami, { token: serviceToken });
  c.equal('the service token resolves', service.status, 200);
  c.equal('the service token is a SERVICE principal', service.json?.kind, 'service');

  // -----------------------------------------------------------------------
  c.group('error shape');
  // The hub prefers the API's own `code` when it is one the contract knows, and falls
  // back to a status mapping otherwise. Either is fine — but a 4xx with no parseable
  // body at all becomes an opaque `internal` for the client, which is a bad answer.
  c.ok('a refusal returns a JSON body', bogus.json != null, `body: ${bogus.text?.slice(0, 200)}`);
  const known = new Set(Object.values(ERROR_CODES));
  if (bogus.json?.code) {
    c.ok(
      `the API's error code "${bogus.json.code}" is one the contract knows`,
      known.has(bogus.json.code),
      `known codes: ${[...known].join(', ')} — an unknown code is mapped by HTTP status instead`
    );
  } else {
    console.log('note  the API does not send a `code` field; the hub maps by HTTP status');
  }

  // -----------------------------------------------------------------------
  c.group('write guard');
  // THE assumption the client/service split rests on. The hub keeps service tools out
  // of a client's tools/list, but that is a convenience — this is the enforcement, and
  // if it were missing, the split would be cosmetic.
  const clientWrite = await call('POST', UPSTREAM_ENDPOINTS.recordPut, {
    token: clientToken,
    body: { kind: 'greeting.session', payload: { greeting: 'verify', answer: 'verify', mood: 'neutral' }, idempotencyKey: `verify-must-fail-${Date.now()}` },
  });
  c.ok(
    'a CLIENT token is refused on the write endpoint',
    clientWrite.status === 403,
    `expected 403, got ${clientWrite.status}. If this is 2xx the platform allows a client credential to write and the read-only guarantee is not real.`
  );
  if (clientWrite.json?.code) {
    c.equal('the refusal is reported as forbidden_audience', clientWrite.json.code, ERROR_CODES.FORBIDDEN_AUDIENCE);
  }

  const jobClaimAsClient = await call('POST', UPSTREAM_ENDPOINTS.jobClaim, { token: clientToken, body: { worker: 'verify', kinds: null, leaseSeconds: 60 } });
  c.ok('a CLIENT token is refused on the job claim endpoint', jobClaimAsClient.status === 403, `expected 403, got ${jobClaimAsClient.status}`);

  // -----------------------------------------------------------------------
  c.group('read and write paths');
  const idempotencyKey = `verify-upstream-${crypto.randomUUID()}`;
  const payload = { greeting: 'verify', answer: 'verify', mood: 'neutral' };

  const write = await call('POST', UPSTREAM_ENDPOINTS.recordPut, { token: serviceToken, body: { kind: 'greeting.session', payload, idempotencyKey } });
  const wroteOk = c.ok('a SERVICE token can write a record', write.status === 200 || write.status === 201, `status ${write.status}: ${write.text?.slice(0, 200)}`);

  if (wroteOk) {
    for (const key of ['recordId', 'kind', 'schemaVersion', 'checksum']) {
      c.ok(`the write response reports ${key}`, write.json && write.json[key] != null, `keys: ${Object.keys(write.json || {}).join(', ')}`);
    }

    // Idempotency, because the hub advertises it in the tool's description and a
    // client may rely on retrying safely.
    const again = await call('POST', UPSTREAM_ENDPOINTS.recordPut, { token: serviceToken, body: { kind: 'greeting.session', payload, idempotencyKey } });
    c.ok('the same idempotency key returns the original record', again.json?.recordId === write.json?.recordId, `${again.json?.recordId} vs ${write.json?.recordId}`);
    c.ok('a deduplicated write says so', again.json?.deduplicated === true, `deduplicated: ${again.json?.deduplicated}`);

    const read = await call('GET', UPSTREAM_ENDPOINTS.recordGet, { token: serviceToken, params: { recordId: write.json.recordId } });
    c.equal('the record can be read back', read.status, 200);
    c.equal('the record round-trips unchanged', read.json?.payload, payload);

    const invalid = await call('POST', UPSTREAM_ENDPOINTS.recordPut, { token: serviceToken, body: { kind: 'greeting.session', payload: { greeting: 'only' } } });
    c.ok('an invalid payload is refused', invalid.status === 400 || invalid.status === 422, `got ${invalid.status}`);

    const unregistered = await call('POST', UPSTREAM_ENDPOINTS.recordPut, { token: serviceToken, body: { kind: 'not.a.registered.kind', payload: {} } });
    c.ok('an unregistered kind is refused', unregistered.status === 400 || unregistered.status === 422, `got ${unregistered.status}`);
  }

  // A missing record must be 404, and the hub turns that into `not_found` rather than
  // an error result. Any other status here would surface to a client as an outage.
  const missing = await call('GET', UPSTREAM_ENDPOINTS.recordGet, { token: serviceToken, params: { recordId: crypto.randomUUID() } });
  c.equal('a missing record is 404', missing.status, 404);

  // -----------------------------------------------------------------------
  c.group('job queue');
  const claim = await call('POST', UPSTREAM_ENDPOINTS.jobClaim, { token: serviceToken, body: { worker: `verify-${process.pid}`, kinds: null, leaseSeconds: 30 } });
  c.equal('the claim endpoint answers 200', claim.status, 200);
  // An empty queue must be a successful "nothing to do", not a 404 and not an error —
  // otherwise every idle worker poll logs a failure.
  c.ok('an empty queue is a 200 with claimed:false, not an error', claim.json != null && typeof claim.json.claimed === 'boolean', `body: ${claim.text?.slice(0, 200)}`);
  if (claim.json?.claimed === true) {
    for (const key of ['jobId', 'kind', 'attempt', 'leaseExpiresAt']) {
      c.ok(`a claimed job reports ${key}`, claim.json[key] != null, `keys: ${Object.keys(claim.json).join(', ')}`);
    }
    c.ok('a claimed job carries a lease in the future', new Date(claim.json.leaseExpiresAt) > new Date(), claim.json.leaseExpiresAt);
  } else {
    console.log('note  the queue was empty, so the claimed-job response shape was not exercised');
  }

  const noWorker = await call('POST', UPSTREAM_ENDPOINTS.jobClaim, { token: serviceToken, body: { kinds: null, leaseSeconds: 30 } });
  c.ok('a claim without a worker identifier is refused', noWorker.status === 400 || noWorker.status === 422, `got ${noWorker.status}`);

  // -----------------------------------------------------------------------
  const failures = c.failures();
  const summary = { ok: failures.length === 0, url: base, checks: c.results().length, failed: failures.length };

  console.log('');
  if (flag('json')) console.log(JSON.stringify({ ...summary, failures }, null, 2));
  console.log(failures.length ? `FAIL  ${failures.length} of ${summary.checks} upstream assumptions do not hold` : `ok    all ${summary.checks} upstream assumptions hold`);
  if (failures.length) {
    for (const f of failures) console.error(`      ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
