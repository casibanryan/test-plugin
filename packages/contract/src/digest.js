// packages/contract/src/digest.js
// Deterministic digest of the whole contract surface.
//
// This one 12-hex string is the pipeline's cascade guard. It is:
//   * committed to contract.lock.json           -> a contract edit can't land unnoticed
//   * baked into the hub image and served at /version
//   * pinned per channel in the Axle channel manifest
// so "core changed but the client wasn't updated" becomes a failing check in CI rather
// than a broken tool call in someone's editor.

'use strict';

const crypto = require('node:crypto');
const { TOOLS, FIELD_TYPES } = require('./tools');
const { ALL_SCOPES, HEADERS, AUTH_SCHEME, SCOPE_PATTERN, PRINCIPAL_KEYS, PRINCIPAL_KINDS, AUDIENCES, isValidScope } = require('./auth');
const { ERROR_CODES } = require('./errors');
const { CONTRACT_VERSION, MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS, ENDPOINTS } = require('./protocol');

// Recursively sort object keys so JSON.stringify is order-independent. Without this,
// moving a field up in the source would change the digest and fail CI for no reason.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        if (value[k] !== undefined) acc[k] = canonical(value[k]);
        return acc;
      }, {});
  }
  return value;
}

// Descriptor keys that participate in the digest. `describe` is deliberately included:
// a tool description is part of what a model sees, so changing it IS a contract change
// that clients should be told about.
const FIELD_KEYS = ['type', 'optional', 'min', 'max', 'minItems', 'maxItems', 'values', 'describe'];

// Tool-level keys that participate in the digest, so a new declaration key cannot be
// added to tools.js and silently stay outside the hash.
const TOOL_KEYS = ['name', 'audience', 'title', 'description', 'scopes', 'readOnly', 'touchesDatabase', 'input', 'output'];

function assertValidField(toolName, section, key, field) {
  if (!field || typeof field !== 'object') throw new Error(`${toolName}.${section}.${key} is not a descriptor object`);
  if (!FIELD_TYPES.includes(field.type)) {
    throw new Error(`${toolName}.${section}.${key} has unknown type "${field.type}" (allowed: ${FIELD_TYPES.join(', ')})`);
  }
  if (field.type === 'enum' && (!Array.isArray(field.values) || field.values.length === 0)) {
    throw new Error(`${toolName}.${section}.${key} is an enum with no values`);
  }
  for (const k of Object.keys(field)) {
    if (!FIELD_KEYS.includes(k)) throw new Error(`${toolName}.${section}.${key} has unrecognised descriptor key "${k}"`);
  }
}

function normalizeField(field) {
  const out = {};
  for (const k of FIELD_KEYS) if (field[k] !== undefined) out[k] = field[k];
  return out;
}

// Validates the whole contract while building the hashable view of it, so an invalid
// contract can never produce a digest at all.
function contractSurface() {
  const tools = TOOLS.map((tool) => {
    for (const req of ['name', 'title', 'description']) {
      if (!tool[req] || typeof tool[req] !== 'string') throw new Error(`tool ${tool.name || '<unnamed>'} is missing ${req}`);
    }
    if (!Array.isArray(tool.scopes) || tool.scopes.length === 0) throw new Error(`tool ${tool.name} declares no scopes`);
    for (const s of tool.scopes) if (!isValidScope(s)) throw new Error(`tool ${tool.name} declares invalid scope "${s}"`);
    if (typeof tool.readOnly !== 'boolean') throw new Error(`tool ${tool.name} must declare readOnly`);
    if (typeof tool.touchesDatabase !== 'boolean') throw new Error(`tool ${tool.name} must declare touchesDatabase`);
    if (!AUDIENCES.includes(tool.audience)) {
      throw new Error(`tool ${tool.name} must declare audience as one of ${AUDIENCES.join(' | ')}`);
    }
    if (tool.readOnly === false && tool.scopes.every((s) => s.endsWith(':read'))) {
      throw new Error(`tool ${tool.name} is a write tool but requires only read scopes`);
    }

    // THE invariant behind "a client cannot write". A contract that puts a write tool
    // on the client surface does not produce a digest at all, so it cannot be locked,
    // cannot pass CI, and cannot be built into an image.
    if (tool.audience === 'client' && tool.readOnly !== true) {
      throw new Error(
        `tool ${tool.name} is on the client surface but is not readOnly — client-facing tools must never write. ` +
          `Give it audience: 'service' if a write is genuinely intended.`
      );
    }
    if (tool.audience === 'client' && tool.scopes.some((s) => !s.endsWith(':read') && s !== '*')) {
      throw new Error(`tool ${tool.name} is on the client surface but requires the non-read scope "${tool.scopes.find((s) => !s.endsWith(':read'))}"`);
    }

    const section = (obj, label) =>
      Object.keys(obj || {})
        .sort()
        .reduce((acc, key) => {
          assertValidField(tool.name, label, key, obj[key]);
          acc[key] = normalizeField(obj[key]);
          return acc;
        }, {});

    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      scopes: tool.scopes.slice().sort(),
      readOnly: tool.readOnly,
      touchesDatabase: tool.touchesDatabase,
      audience: tool.audience,
      input: section(tool.input, 'input'),
      output: section(tool.output, 'output'),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  for (const tool of TOOLS) {
    for (const k of Object.keys(tool)) {
      if (!TOOL_KEYS.includes(k)) throw new Error(`tool ${tool.name} has unrecognised declaration key "${k}"`);
    }
  }

  const names = tools.map((t) => t.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`duplicate tool name: ${dup}`);

  return canonical({
    contractVersion: CONTRACT_VERSION,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    supportedMcpProtocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
    endpoints: ENDPOINTS,
    auth: {
      scheme: AUTH_SCHEME,
      headers: HEADERS,
      scopes: ALL_SCOPES.slice().sort(),
      scopePattern: SCOPE_PATTERN.source,
      principalKeys: PRINCIPAL_KEYS.slice().sort(),
      principalKinds: PRINCIPAL_KINDS.slice().sort(),
      audiences: AUDIENCES.slice().sort(),
    },
    errorCodes: Object.values(ERROR_CODES).sort(),
    tools,
  });
}

// 12 hex chars: short enough to read in a log line and paste into a manifest, wide
// enough (48 bits) that an accidental collision between two contracts won't happen.
const DIGEST_LENGTH = 12;

function contractDigest() {
  const json = JSON.stringify(contractSurface());
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex').slice(0, DIGEST_LENGTH);
}

// The full lock file body, so bin/contract-digest.js and the tests agree byte-for-byte.
function lockBody() {
  return {
    _comment:
      'Generated by `npm run contract:digest -- --write`. Committed so a contract change is always a reviewed diff. CI fails when this drifts from the source.',
    contractVersion: CONTRACT_VERSION,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    digest: contractDigest(),
    tools: TOOLS.map((t) => ({
      name: t.name,
      audience: t.audience,
      scopes: t.scopes.slice().sort(),
      readOnly: t.readOnly,
      touchesDatabase: t.touchesDatabase,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

module.exports = { canonical, contractSurface, contractDigest, lockBody, DIGEST_LENGTH };
