// packages/contract/src/auth.js
// Auth conventions. Both sides of the wire read this file: the client to build the
// request, the hub to take it apart. Keeping the header name and scope grammar here is
// what stops a client and a server from disagreeing about how a caller is identified.

'use strict';

const { ERROR_CODES, PivotlyError } = require('./errors');

// --- transport conventions -------------------------------------------------

const AUTH_HEADER = 'authorization';
const AUTH_SCHEME = 'Bearer';

// Non-secret request metadata the hub logs and uses for tenant routing.
const HEADERS = {
  auth: AUTH_HEADER,
  channel: 'x-pivotly-channel',           // which client channel is calling
  clientContract: 'x-pivotly-contract',   // contract version the client was built against
  requestId: 'x-request-id',
  tenant: 'x-pivotly-tenant',
};

// --- scope grammar ---------------------------------------------------------
// "<resource>:<action>". A principal holding "<resource>:*" holds every action on it;
// "*" is reserved for platform service principals and never granted to a user token.

const SCOPES = {
  GREETING_READ: 'greeting:read',
  GREETING_WRITE: 'greeting:write',
  USDF_READ: 'usdf:read',
  USDF_WRITE: 'usdf:write',
  JOBS_CLAIM: 'jobs:claim',
  ADMIN: '*',
};

const ALL_SCOPES = Object.values(SCOPES);

const SCOPE_PATTERN = /^(?:\*|[a-z][a-z0-9-]*:(?:\*|[a-z][a-z0-9-]*))$/;

function isValidScope(scope) {
  return typeof scope === 'string' && SCOPE_PATTERN.test(scope);
}

// Does `held` (one granted scope) satisfy `required`?
function scopeSatisfies(held, required) {
  if (held === SCOPES.ADMIN) return true;
  if (held === required) return true;
  const [heldRes, heldAct] = String(held).split(':');
  const [reqRes] = String(required).split(':');
  return heldAct === '*' && heldRes === reqRes;
}

function hasScope(granted, required) {
  const list = Array.isArray(granted) ? granted : [];
  return list.some((held) => scopeSatisfies(held, required));
}

// All of `required` must be satisfied. Returns the first missing scope, or null.
function missingScope(granted, required = []) {
  for (const req of required) if (!hasScope(granted, req)) return req;
  return null;
}

// --- principal kind --------------------------------------------------------
// What sort of caller this is, which decides which half of the tool surface it can
// even see. This is coarser and more durable than a scope: scopes get granted and
// widened over time, whereas "is this an interactive editor plugin or a platform
// worker" is a property of how the credential was issued and should never change.
//
//   client   an end-user client such as the Axle Claude Code plugin. READ-ONLY.
//            Never issued a write scope, and refused service tools outright.
//   service  a platform component (a queue worker, an ingest job) running with its
//            own credential, not on behalf of an interactive session.

const PRINCIPAL_KINDS = ['client', 'service'];

// The audience a tool is written for; see tools.js. A client principal calling a
// service tool is refused before scopes are even consulted.
const AUDIENCES = ['client', 'service'];

const audienceAllows = (principalKind, toolAudience) =>
  toolAudience === 'client' ? true : principalKind === 'service';

// --- principal -------------------------------------------------------------
// The normalized caller identity. `pv_api.principal_for_token()` returns exactly these
// columns, and the in-memory dev store fabricates the same shape, so every code path
// downstream of auth sees one type.

const PRINCIPAL_KEYS = ['principalId', 'email', 'tenantId', 'kind', 'scopes', 'disabled', 'source'];

function normalizePrincipal(row) {
  if (!row) return null;
  return {
    principalId: row.principalId ?? row.principal_id ?? null,
    email: (row.email ?? '').toLowerCase(),
    tenantId: row.tenantId ?? row.tenant_id ?? null,
    // Unknown or missing kind resolves to 'client', the least privileged option: a
    // misconfigured principal loses write access rather than gaining it.
    kind: PRINCIPAL_KINDS.includes(row.kind) ? row.kind : 'client',
    scopes: Array.isArray(row.scopes) ? row.scopes.slice().sort() : [],
    disabled: Boolean(row.disabled ?? false),
    source: row.source ?? 'db',
  };
}

// --- credential parsing ----------------------------------------------------

// Pull the bearer token out of a header map. Throws a contract error rather than
// returning null so the caller cannot forget to check.
function parseBearer(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = v;
  const raw = lower[AUTH_HEADER];
  if (!raw) throw new PivotlyError(ERROR_CODES.UNAUTHENTICATED, 'missing Authorization header');
  const value = Array.isArray(raw) ? raw[0] : String(raw);
  const [scheme, ...rest] = value.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== AUTH_SCHEME.toLowerCase()) {
    throw new PivotlyError(ERROR_CODES.UNAUTHENTICATED, `Authorization must use the ${AUTH_SCHEME} scheme`);
  }
  const token = rest.join('');
  if (!token) throw new PivotlyError(ERROR_CODES.UNAUTHENTICATED, 'empty bearer token');
  return token;
}

// What a client should send. Used by axle and by every smoke test, so the pipeline
// exercises the same construction real clients use.
function authHeaders({ token, channel, tenantId, requestId } = {}) {
  const out = {};
  if (token) out[HEADERS.auth] = `${AUTH_SCHEME} ${token}`;
  out[HEADERS.clientContract] = require('./protocol').CONTRACT_VERSION;
  if (channel) out[HEADERS.channel] = channel;
  if (tenantId) out[HEADERS.tenant] = tenantId;
  if (requestId) out[HEADERS.requestId] = requestId;
  return out;
}

// Never log a token. 8 chars of prefix is enough to correlate, not enough to replay.
const redactToken = (token) => (typeof token === 'string' && token.length > 8 ? `${token.slice(0, 8)}…` : '…');

module.exports = {
  AUTH_HEADER,
  AUTH_SCHEME,
  HEADERS,
  SCOPES,
  ALL_SCOPES,
  SCOPE_PATTERN,
  PRINCIPAL_KINDS,
  AUDIENCES,
  audienceAllows,
  PRINCIPAL_KEYS,
  isValidScope,
  scopeSatisfies,
  hasScope,
  missingScope,
  normalizePrincipal,
  parseBearer,
  authHeaders,
  redactToken,
};
