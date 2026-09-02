// packages/contract/src/digest.js
// Deterministic digest of the whole contract surface.
//
// This one 12-hex string is the pipeline's cascade guard. It is:
//   * committed to contract.lock.json               -> a contract edit can't land unnoticed
//   * baked into the deployed build and served at /version
//   * pinned per channel in packages/clients/channels.json
// so "core changed but the clients weren't updated" becomes a failing check in CI
// rather than a broken tool call in someone's editor.
//
// Because every client is generated from the same contract, one digest covers all of
// them: if Axle and Codex are both built from this repo, they cannot disagree about the
// tool surface without the digest saying so.

'use strict';

const crypto = require('node:crypto');
const { TOOLS, FIELD_TYPES } = require('./tools');
const { ERROR_CODES } = require('./errors');
const {
  CONTRACT_VERSION,
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  ENDPOINTS,
  HEADERS,
  CLIENTS,
  CHANNELS,
} = require('./protocol');

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
// a tool description is part of what a model reads, so changing it IS a contract change
// that clients should be told about.
const FIELD_KEYS = ['type', 'optional', 'min', 'max', 'minItems', 'maxItems', 'values', 'describe'];

// Tool-level keys that participate, so a new declaration key cannot be added to
// tools.js and silently stay outside the hash.
const TOOL_KEYS = ['name', 'title', 'description', 'readOnly', 'input', 'output'];

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

const normalizeField = (field) => {
  const out = {};
  for (const k of FIELD_KEYS) if (field[k] !== undefined) out[k] = field[k];
  return out;
};

// Validates the whole contract while building the hashable view of it, so an invalid
// contract can never produce a digest at all.
function contractSurface() {
  const tools = TOOLS.map((tool) => {
    for (const req of ['name', 'title', 'description']) {
      if (!tool[req] || typeof tool[req] !== 'string') throw new Error(`tool ${tool.name || '<unnamed>'} is missing ${req}`);
    }

    // THE invariant. This hub is anonymous — anyone who can reach the URL can call
    // anything it serves — so every tool must be safe for an anonymous caller. A tool
    // that writes, mutates, or reaches a credentialed system does not belong on this
    // surface, and a contract declaring one does not produce a digest at all: it cannot
    // be locked, cannot pass CI, and cannot be built into an artifact.
    if (tool.readOnly !== true) {
      throw new Error(
        `tool ${tool.name} declares readOnly: ${tool.readOnly} — every tool on this hub must be read-only, because the hub serves them without authentication.`
      );
    }

    for (const k of Object.keys(tool)) {
      if (!TOOL_KEYS.includes(k)) throw new Error(`tool ${tool.name} has unrecognised declaration key "${k}"`);
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
      readOnly: tool.readOnly,
      input: section(tool.input, 'input'),
      output: section(tool.output, 'output'),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const names = tools.map((t) => t.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`duplicate tool name: ${dup}`);

  return canonical({
    contractVersion: CONTRACT_VERSION,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    supportedMcpProtocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
    endpoints: ENDPOINTS,
    headers: HEADERS,
    channels: CHANNELS,
    // Client ids and formats are part of the surface: adding a client changes what this
    // repo generates, and every client's config is verified against this digest.
    clients: CLIENTS.map((c) => ({ id: c.id, format: c.format, configPath: c.configPath, plugin: c.plugin })),
    errorCodes: Object.values(ERROR_CODES).sort(),
    tools,
  });
}

// 12 hex chars: short enough to read in a log line and paste into a manifest, wide
// enough (48 bits) that an accidental collision between two contracts won't happen.
const DIGEST_LENGTH = 12;

function contractDigest() {
  return crypto.createHash('sha256').update(JSON.stringify(contractSurface()), 'utf8').digest('hex').slice(0, DIGEST_LENGTH);
}

// The full lock file body, so bin/contract-digest.js and the tests agree byte for byte.
function lockBody() {
  return {
    _comment:
      'Generated by `npm run contract:digest -- --write`. Committed so a contract change is always a reviewed diff. CI fails when this drifts from the source.',
    contractVersion: CONTRACT_VERSION,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    digest: contractDigest(),
    clients: CLIENTS.map((c) => c.id).sort(),
    tools: TOOLS.map((t) => ({ name: t.name, readOnly: t.readOnly })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

module.exports = { canonical, contractSurface, contractDigest, lockBody, DIGEST_LENGTH };
