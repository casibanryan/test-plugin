// packages/contract/src/protocol.js
// Protocol and version constants. THE source of truth — hub, clients, CI and the
// deployed /version endpoint all read these, so a bump here is the single event that
// ripples outward. Nothing in this file may import from another workspace.

'use strict';

// MCP wire protocol the hub speaks. Bumping this is a breaking change for clients
// that pin it; CI cross-checks it against the version the deployed hub reports.
const MCP_PROTOCOL_VERSION = '2025-06-18';

// Protocol versions the hub will still accept from an older client. The oldest entry
// is the compatibility floor: drop one only in a major CONTRACT_VERSION bump.
const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// The Pivotly contract itself: tool surface + auth conventions + error codes.
// MAJOR = a tool/field/scope was removed or its meaning changed (clients must update).
// MINOR = additive only (older clients keep working).
const CONTRACT_VERSION = '0.2.0';

// Deployment channels, ordered from least to most protected. Promotion always moves
// left-to-right; the pipeline refuses a skip (see docs/PIPELINE.md).
const CHANNELS = ['local', 'dev', 'prerelease', 'production'];

// Channels that must never run without a real database or real token resolution.
const HARDENED_CHANNELS = ['prerelease', 'production'];

// HTTP surface the hub exposes alongside the MCP endpoint. The pipeline probes these
// by name, so they are contract, not implementation detail.
const ENDPOINTS = {
  mcp: '/mcp',
  health: '/healthz',   // liveness: process is up. Never touches the database.
  ready: '/readyz',     // readiness: database reachable + security layer verified.
  version: '/version',  // contract/protocol/build identity, used by client autopatch.
};

// ---------------------------------------------------------------------------
// The upstream platform API
// ---------------------------------------------------------------------------
// The hub owns no data. Every read and every write is a call to the Pivotly platform
// API, which owns the database, the schemas, the job queue, and the access rules. The
// hub is a stateless protocol adapter: it speaks MCP to a client and HTTPS to the API,
// and it forwards the caller's own bearer token rather than holding a credential of
// its own — so the API authorises the end user, not the hub.
//
// These paths live in the contract because both the hub and the pipeline's verifier
// drive them, and a rename has to be a reviewed contract change rather than a string
// edited in one of the two places.
const UPSTREAM_ENDPOINTS = {
  health: '/healthz',                       // GET  — is the API up?
  whoami: '/v1/me',                         // GET  — resolve the caller's token to an identity
  recordGet: '/v1/usdf/records/:recordId',  // GET  — read one USDF record
  recordPut: '/v1/usdf/records',            // POST — create one (service credentials only)
  jobClaim: '/v1/jobs/claim',               // POST — claim the next job (service credentials only)
};

// Minimum acceptable server identity payload from ENDPOINTS.version. The client
// autopatch and the e2e tier-3 check both assert exactly these keys exist.
const VERSION_PAYLOAD_KEYS = [
  'server',
  'serverVersion',
  'contractVersion',
  'contractDigest',
  'mcpProtocolVersion',
  'channel',
  'commit',
  'builtAt',
];

module.exports = {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  CONTRACT_VERSION,
  CHANNELS,
  HARDENED_CHANNELS,
  ENDPOINTS,
  UPSTREAM_ENDPOINTS,
  VERSION_PAYLOAD_KEYS,
};
