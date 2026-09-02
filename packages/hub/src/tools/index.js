// packages/hub/src/tools/index.js
// Tool handlers, keyed by the contract's tool name.
//
// A handler is a plain async function of (args, ctx) -> plain object. It does no
// validation (the contract's zod schema, applied by the SDK, already did), no auth
// (src/auth.js already did), and no response shaping (src/mcp.js does that). What is
// left is the actual behaviour, which is what makes these short.
//
// ctx carries { principal, upstream, logger, requestId }. The principal carries the
// caller's own token, and every upstream call forwards it — so the platform API
// authorises the end user on each call, not the hub.
//
// Every name here must exist in the contract and vice versa; src/mcp.js asserts the
// two sets are equal at boot, so a tool declared but not implemented (or implemented
// but not declared) is a startup failure rather than a runtime surprise.

'use strict';

const { buildGreeting, respondToDay } = require('../lib/greeting');

const HANDLERS = {
  // --- client surface: read-only, and answered entirely in this process -----
  // No upstream call at all, which is why the pipeline uses these as its transport
  // canary: they prove MCP framing and the auth chain work before anything depends
  // on the platform API being reachable.
  greeting_hello: async ({ name, hour }) => {
    const { greeting, question, message } = buildGreeting({ name, hour });
    return { ok: true, greeting, question, message };
  },

  greeting_day_check: async ({ name, answer }) => {
    const { mood, reply } = respondToDay({ name, answer });
    return { ok: true, mood, reply };
  },

  // --- client surface: read-only, served by the platform API ----------------
  usdf_record_get: async ({ recordId }, { principal, upstream, requestId }) => {
    const record = await upstream.recordGet({ recordId, token: principal.token, requestId });
    // The API answers 404 for another tenant's record as well as for one that does
    // not exist, and the client sees the same thing for both — an id must not be
    // confirmable across a tenant boundary.
    if (!record) return { ok: false, code: 'not_found', message: 'no such record' };
    return {
      ok: true,
      recordId: record.recordId,
      kind: record.kind,
      schemaVersion: record.schemaVersion,
      payload: record.payload,
      createdAt: record.createdAt,
    };
  },

  // --- service surface: never registered for a client session ---------------
  usdf_record_put: async ({ kind, payload, idempotencyKey }, { principal, upstream, requestId }) => {
    const result = await upstream.recordPut({ kind, payload, idempotencyKey, token: principal.token, requestId });
    return {
      ok: true,
      recordId: result.recordId,
      kind: result.kind,
      schemaVersion: result.schemaVersion,
      checksum: result.checksum,
      deduplicated: result.deduplicated === true,
    };
  },

  job_claim: async ({ worker, kinds, leaseSeconds }, { principal, upstream, requestId }) => {
    const claim = await upstream.jobClaim({
      worker,
      kinds: kinds && kinds.length ? kinds : null,
      leaseSeconds: leaseSeconds ?? 60,
      token: principal.token,
      requestId,
    });
    // An empty queue is a successful answer with claimed: false, not an error — a
    // worker polling an idle queue should not be logging failures.
    if (!claim || claim.claimed !== true) return { ok: true, claimed: false };
    return {
      ok: true,
      claimed: true,
      jobId: claim.jobId,
      kind: claim.kind,
      payload: claim.payload,
      attempt: claim.attempt,
      leaseExpiresAt: claim.leaseExpiresAt,
    };
  },
};

module.exports = { HANDLERS };
