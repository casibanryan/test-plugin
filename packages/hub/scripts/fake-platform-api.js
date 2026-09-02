#!/usr/bin/env node
// packages/hub/scripts/fake-platform-api.js
// A stand-in for the Pivotly platform API, for local development, unit tests and CI.
//
//   node scripts/fake-platform-api.js --port=8790
//
// This is a TEST DOUBLE, not a second implementation of the platform. It exists so the
// hub can be exercised end to end without the real API, and it deliberately serves the
// same endpoints the contract declares — so the hub uses its ONE real HTTP client
// against it. There is no in-process shortcut and no second code path to drift.
//
// What it models faithfully, because these are the behaviours the hub's own logic
// depends on and a wrong assumption here would hide a real bug:
//
//   * identity resolution from a bearer token, including the client/service kind
//   * a write refused for a client credential (403 forbidden_audience)
//   * tenant-scoped reads: another tenant's record is 404, never 403
//   * idempotent writes
//   * an empty job queue answering 200 with claimed:false, not an error
//
// What it does NOT model, and must not be mistaken for: the real access rules, the
// real schema registry, durability, or concurrency. Its job queue is a JavaScript
// array. Anything that depends on those properties belongs in a test against the real
// API — see scripts/verify-upstream.js, which the pipeline runs against a deployed one.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const { UPSTREAM_ENDPOINTS } = require('@pivotly/contract/protocol');
const { parseBearer } = require('@pivotly/contract/auth');
const { ERROR_CODES } = require('@pivotly/contract/errors');

// Fixture principals. The shape mirrors what the real /v1/me returns, and the split
// is the point: `dev` and `smoke` are client credentials with read scopes only, and
// only `worker` can write.
const PRINCIPALS = {
  'dev-token': {
    principalId: 'p-dev',
    email: 'dev@pivotly.com',
    tenantId: 't-dev',
    kind: 'client',
    scopes: ['greeting:read', 'usdf:read'],
  },
  'smoke-token': {
    principalId: 'p-smoke',
    email: 'smoke@pivotly.com',
    tenantId: 't-dev',
    kind: 'client',
    scopes: ['greeting:read'],
  },
  'worker-token': {
    principalId: 'p-worker',
    email: 'worker@pivotly.com',
    tenantId: 't-dev',
    kind: 'service',
    scopes: ['usdf:read', 'usdf:write', 'jobs:claim'],
  },
  // A second tenant, so cross-tenant reads can be tested.
  'other-token': {
    principalId: 'p-other',
    email: 'other@pivotly.com',
    tenantId: 't-other',
    kind: 'service',
    scopes: ['usdf:read', 'usdf:write'],
  },
};

const SCHEMAS = {
  'greeting.session': {
    schemaVersion: 1,
    required: ['greeting', 'answer', 'mood'],
    properties: { greeting: 'string', answer: 'string', mood: 'string', hour: 'number', client: 'string' },
  },
};

function validate(schema, payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return 'payload must be a JSON object';
  for (const key of schema.required) if (!(key in payload)) return `missing required property "${key}"`;
  for (const [key, value] of Object.entries(payload)) {
    const expected = schema.properties[key];
    if (!expected) return `unexpected property "${key}"`;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== expected) return `property "${key}" must be ${expected}, got ${actual}`;
  }
  return null;
}

function createFakePlatformApi() {
  const records = new Map(); // recordId -> record
  const idempotency = new Map(); // `${tenantId}:${key}` -> recordId
  const jobs = []; // { jobId, tenantId, kind, payload, state, attempts, lockedBy, leaseExpiresAt }
  const calls = []; // every request, so a test can assert what the hub actually sent

  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  const fail = (res, status, code, message) => send(res, status, { ok: false, code, message });

  const identify = (req, res) => {
    let token;
    try {
      token = parseBearer(req.headers);
    } catch {
      fail(res, 401, ERROR_CODES.UNAUTHENTICATED, 'missing or malformed Authorization header');
      return null;
    }
    const principal = PRINCIPALS[token];
    if (!principal) {
      fail(res, 401, ERROR_CODES.TOKEN_INVALID, 'unknown token');
      return null;
    }
    return principal;
  };

  // Writes are refused for a client credential with the shared error code, so the hub
  // maps it back to the same refusal a client would get from the real API.
  const requireService = (res, principal) => {
    if (principal.kind !== 'service') {
      fail(res, 403, ERROR_CODES.FORBIDDEN_AUDIENCE, `principal kind "${principal.kind}" may not write`);
      return false;
    }
    return true;
  };

  const requireScope = (res, principal, scope) => {
    const held = principal.scopes.some((s) => s === scope || s === '*' || s === `${scope.split(':')[0]}:*`);
    if (!held) {
      fail(res, 403, ERROR_CODES.FORBIDDEN_SCOPE, `the ${scope} scope is required`);
      return false;
    }
    return true;
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    calls.push({ method: req.method, path, at: Date.now(), headers: { ...req.headers } });

    try {
      if (path === UPSTREAM_ENDPOINTS.health) {
        return send(res, 200, { ok: true, service: 'fake-platform-api', records: records.size, jobs: jobs.length });
      }

      if (path === UPSTREAM_ENDPOINTS.whoami) {
        const principal = identify(req, res);
        if (!principal) return undefined;
        return send(res, 200, { ...principal, disabled: false });
      }

      if (path === UPSTREAM_ENDPOINTS.recordPut && req.method === 'POST') {
        const principal = identify(req, res);
        if (!principal) return undefined;
        if (!requireService(res, principal)) return undefined;
        if (!requireScope(res, principal, 'usdf:write')) return undefined;

        const body = await readBody(req);
        const schema = SCHEMAS[body.kind];
        if (!schema) return fail(res, 400, ERROR_CODES.INVALID_INPUT, `unregistered kind "${body.kind}"`);
        const problem = validate(schema, body.payload);
        if (problem) return fail(res, 422, ERROR_CODES.INVALID_INPUT, `payload does not satisfy ${body.kind}: ${problem}`);

        const idemKey = body.idempotencyKey ? `${principal.tenantId}:${body.idempotencyKey}` : null;
        if (idemKey && idempotency.has(idemKey)) {
          const existing = records.get(idempotency.get(idemKey));
          return send(res, 200, { ok: true, ...existing, deduplicated: true });
        }

        const record = {
          recordId: crypto.randomUUID(),
          tenantId: principal.tenantId,
          kind: body.kind,
          schemaVersion: schema.schemaVersion,
          payload: body.payload,
          checksum: crypto.createHash('sha256').update(JSON.stringify(body.payload)).digest('hex'),
          createdAt: new Date().toISOString(),
        };
        records.set(record.recordId, record);
        if (idemKey) idempotency.set(idemKey, record.recordId);
        return send(res, 201, { ok: true, ...record, deduplicated: false });
      }

      const recordMatch = path.match(/^\/v1\/usdf\/records\/([^/]+)$/);
      if (recordMatch && req.method === 'GET') {
        const principal = identify(req, res);
        if (!principal) return undefined;
        if (!requireScope(res, principal, 'usdf:read')) return undefined;

        const record = records.get(decodeURIComponent(recordMatch[1]));
        // Another tenant's record is absent, not forbidden: a 403 here would confirm
        // that the id exists somewhere.
        if (!record || record.tenantId !== principal.tenantId) {
          return fail(res, 404, ERROR_CODES.NOT_FOUND, 'no such record');
        }
        return send(res, 200, { ok: true, ...record });
      }

      if (path === UPSTREAM_ENDPOINTS.jobClaim && req.method === 'POST') {
        const principal = identify(req, res);
        if (!principal) return undefined;
        if (!requireService(res, principal)) return undefined;
        if (!requireScope(res, principal, 'jobs:claim')) return undefined;

        const body = await readBody(req);
        if (!body.worker) return fail(res, 400, ERROR_CODES.INVALID_INPUT, 'worker is required');

        const now = Date.now();
        const job = jobs.find(
          (j) =>
            j.tenantId === principal.tenantId &&
            (!body.kinds || body.kinds.length === 0 || body.kinds.includes(j.kind)) &&
            (j.state === 'queued' || (j.state === 'running' && j.leaseExpiresAt < now))
        );
        // An empty queue is a successful answer, so a polling worker is not logging
        // errors all day.
        if (!job) return send(res, 200, { ok: true, claimed: false });

        const reclaimed = job.state === 'running';
        job.state = 'running';
        job.attempts += 1;
        job.lockedBy = body.worker;
        job.leaseExpiresAt = now + Math.max(5, Math.min(body.leaseSeconds ?? 60, 3600)) * 1000;

        return send(res, 200, {
          ok: true,
          claimed: true,
          jobId: job.jobId,
          kind: job.kind,
          payload: job.payload,
          attempt: job.attempts,
          leaseExpiresAt: new Date(job.leaseExpiresAt).toISOString(),
          reclaimed,
        });
      }

      return fail(res, 404, ERROR_CODES.NOT_FOUND, `no route for ${req.method} ${path}`);
    } catch (err) {
      return fail(res, 400, ERROR_CODES.INVALID_INPUT, `bad request: ${err.message}`);
    }
  });

  return {
    server,
    // Seams for tests. Nothing in the hub can reach these.
    seed: {
      job: (tenantId, kind, payload = {}) => {
        const job = { jobId: crypto.randomUUID(), tenantId, kind, payload, state: 'queued', attempts: 0, lockedBy: null, leaseExpiresAt: null };
        jobs.push(job);
        return job;
      },
      record: (record) => records.set(record.recordId, record),
    },
    calls: () => calls.slice(),
    listen: (port = 0) =>
      new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
    tokens: Object.keys(PRINCIPALS),
    PRINCIPALS,
  };
}

module.exports = { createFakePlatformApi, PRINCIPALS, SCHEMAS };

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = Number(portArg ? portArg.slice('--port='.length) : process.env.PORT || 8790);
  const api = createFakePlatformApi();
  api.listen(port).then((url) => {
    // Seed a couple of jobs so a locally running worker has something to claim.
    api.seed.job('t-dev', 'greeting.digest', { window: '1h' });
    api.seed.job('t-dev', 'greeting.digest', { window: '24h' });
    process.stderr.write(
      `${JSON.stringify({
        msg: 'fake platform API listening — TEST DOUBLE, not the real platform',
        url,
        tokens: api.tokens,
      })}\n`
    );
  });
}
