// packages/contract/test/contract.test.js
// Tier 0: the contract validates itself. Every other workspace derives from these
// declarations, so a defect here is a defect everywhere — these run first in CI and
// nothing else runs if they fail.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contract = require('../src/index');
const { TOOLS, TOOL_NAMES, getTool } = require('../src/tools');
const { ERROR_CODES, HTTP_STATUS_FOR_CODE, PivotlyError } = require('../src/errors');
const { contractDigest, contractSurface, lockBody, canonical } = require('../src/digest');
const { zodInputFor, allInputShapes } = require('../src/zod');
const protocol = require('../src/protocol');

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
test('every tool descriptor is well formed', () => {
  // contractSurface() throws on any invalid descriptor, so building it IS the assertion.
  const surface = contractSurface();
  assert.equal(surface.tools.length, TOOLS.length);
  for (const tool of surface.tools) {
    assert.ok(tool.description.length > 20, `${tool.name} needs a description a model can act on`);
    assert.ok(Object.keys(tool.output).length > 0, `${tool.name} declares no output shape`);
  }
});

test('tool names are unique, sorted, and snake_case', () => {
  assert.deepEqual(TOOL_NAMES, [...new Set(TOOL_NAMES)].sort());
  for (const name of TOOL_NAMES) assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} is not snake_case`);
});

test('every tool is read-only, because the hub serves them anonymously', () => {
  for (const tool of TOOLS) assert.equal(tool.readOnly, true, `${tool.name} is not read-only`);
});

test('the digest builder REFUSES a contract with a non-read-only tool', () => {
  // The invariant that replaces auth. Proven by actually breaking it: a tool that
  // could write must make the contract unbuildable, so it can never be locked, pass
  // CI, or reach an artifact.
  TOOLS.push({
    name: 'danger_write',
    title: 'A write tool that should never be allowed here',
    description: 'This exists only inside this test, to prove the guard fires.',
    readOnly: false,
    input: {},
    output: { ok: { type: 'boolean' } },
  });
  try {
    assert.throws(() => contractSurface(), /must be read-only/);
  } finally {
    TOOLS.pop();
  }
  // And the contract is buildable again once removed, so the test left nothing behind.
  assert.match(contractDigest(), /^[0-9a-f]{12}$/);
});

test('an unrecognised tool declaration key is rejected', () => {
  TOOLS.push({
    name: 'sneaky',
    title: 'A tool with an undeclared key',
    description: 'The digest must cover every declared key, or one could hide outside the hash.',
    readOnly: true,
    input: {},
    output: { ok: { type: 'boolean' } },
    scopes: ['something:secret'],
  });
  try {
    assert.throws(() => contractSurface(), /unrecognised declaration key "scopes"/);
  } finally {
    TOOLS.pop();
  }
});

test('zod schemas derive from the descriptors and actually validate', () => {
  allInputShapes(); // throws on a bad descriptor

  const hello = zodInputFor('greeting_hello');
  assert.deepEqual(hello.parse({ name: 'Resty', hour: 9 }), { name: 'Resty', hour: 9 });
  assert.deepEqual(hello.parse({}), {});
  assert.throws(() => hello.parse({ hour: 24 }), /hour/i);
  assert.throws(() => hello.parse({ hour: 9.5 }));
  assert.throws(() => hello.parse({ nope: 1 }), /nrecognized/);

  const dayCheck = zodInputFor('greeting_day_check');
  assert.throws(() => dayCheck.parse({}), /answer/i);
  assert.throws(() => dayCheck.parse({ answer: '' }), /answer/i);
});

test('getTool resolves a declared tool and nothing else', () => {
  assert.equal(getTool('greeting_hello').name, 'greeting_hello');
  assert.equal(getTool('nope'), null);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
test('PivotlyError carries a code and an HTTP status, and leaks no stack', () => {
  const err = new PivotlyError(ERROR_CODES.INVALID_INPUT, 'nope', { field: 'hour' });
  assert.equal(err.httpStatus, 400);
  const wire = JSON.parse(JSON.stringify(err));
  assert.deepEqual(Object.keys(wire).sort(), ['code', 'details', 'message', 'ok']);
  assert.equal(wire.ok, false);
});

test('every error code has an HTTP status', () => {
  for (const code of Object.values(ERROR_CODES)) {
    assert.equal(typeof HTTP_STATUS_FOR_CODE[code], 'number', `${code} has no status`);
  }
});

test('there are no auth error codes, because there is no auth', () => {
  const codes = Object.values(ERROR_CODES).join(' ');
  for (const gone of ['unauthenticated', 'token_invalid', 'forbidden']) {
    assert.equal(codes.includes(gone), false, `${gone} is still declared but auth was removed`);
  }
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------
test('the digest is deterministic and insensitive to key order', () => {
  assert.equal(contractDigest(), contractDigest());
  assert.match(contractDigest(), /^[0-9a-f]{12}$/);
  assert.deepEqual(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(JSON.stringify(canonical({ b: 1, a: 2 })), '{"a":2,"b":1}');
});

test('canonical drops undefined but keeps null', () => {
  assert.deepEqual(canonical({ a: undefined, b: null }), { b: null });
});

test('the digest covers the tool descriptions a model reads', () => {
  // Changing a description changes what the model is told, so it IS a contract change.
  const before = contractDigest();
  const tool = getTool('greeting_hello');
  const original = tool.description;
  tool.description = `${original} (edited)`;
  try {
    assert.notEqual(contractDigest(), before, 'editing a description must change the digest');
  } finally {
    tool.description = original;
  }
  assert.equal(contractDigest(), before, 'the digest must return to its previous value');
});

test('the digest covers the declared clients', () => {
  const before = contractDigest();
  protocol.CLIENTS.push({ id: 'zzz-test', title: 'x', host: 'x', format: 'toml', configPath: 'c.toml', plugin: false });
  try {
    assert.notEqual(contractDigest(), before, 'adding a client must change the digest');
  } finally {
    protocol.CLIENTS.pop();
  }
});

test('contract.lock.json matches the source', () => {
  const lockPath = path.join(__dirname, '..', 'contract.lock.json');
  assert.ok(fs.existsSync(lockPath), 'contract.lock.json is missing — run: npm run contract:digest -- --write');
  assert.equal(
    fs.readFileSync(lockPath, 'utf8'),
    `${JSON.stringify(lockBody(), null, 2)}\n`,
    'lock file drift — run: npm run contract:digest -- --write'
  );
});

// ---------------------------------------------------------------------------
// Protocol, channels, clients
// ---------------------------------------------------------------------------
test('protocol constants are coherent', () => {
  assert.match(protocol.CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(protocol.MCP_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(
    protocol.SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(protocol.MCP_PROTOCOL_VERSION),
    'the version we speak must be in the list we accept'
  );
  for (const key of ['mcp', 'health', 'ready', 'version']) assert.match(protocol.ENDPOINTS[key], /^\//);
});

test('the channel ladder is ordered and its rungs are declared', () => {
  assert.deepEqual(protocol.CHANNELS, ['local', 'dev', 'prerelease', 'production']);
  // The pipeline reads these rather than hard-coding channel names in YAML.
  assert.ok(protocol.CHANNELS.includes(protocol.CONTINUOUS_CHANNEL));
  assert.ok(protocol.CHANNELS.includes(protocol.RELEASE_CHANNEL));
  assert.ok(protocol.CHANNELS.includes(protocol.PRODUCTION_CHANNEL));

  // Promotion moves left to right: continuous < release < production.
  const rung = (c) => protocol.CHANNELS.indexOf(c);
  assert.ok(rung(protocol.CONTINUOUS_CHANNEL) < rung(protocol.RELEASE_CHANNEL));
  assert.ok(rung(protocol.RELEASE_CHANNEL) < rung(protocol.PRODUCTION_CHANNEL));

  // The hardened rungs are the top of the ladder, never the bottom.
  for (const c of protocol.HARDENED_CHANNELS) {
    assert.ok(protocol.CHANNELS.includes(c));
    assert.ok(rung(c) >= rung(protocol.RELEASE_CHANNEL), `${c} is hardened but sits below the release channel`);
  }
  assert.equal(protocol.HARDENED_CHANNELS.includes('local'), false, 'local must stay unhardened for offline dev');
});

test('every declared client is well formed and uniquely identified', () => {
  const formats = ['mcp-json', 'toml'];
  assert.ok(protocol.CLIENTS.length >= 2, 'the multi-client story needs more than one client to be real');

  for (const client of protocol.CLIENTS) {
    assert.match(client.id, /^[a-z][a-z0-9-]*$/, `${client.id} is not a usable directory name`);
    assert.ok(client.title && client.host, `${client.id} needs a title and a host`);
    assert.ok(formats.includes(client.format), `${client.id} has unknown format "${client.format}"`);
    assert.ok(client.configPath && !path.isAbsolute(client.configPath), `${client.id} configPath must be relative`);
    assert.equal(typeof client.plugin, 'boolean');
  }

  assert.deepEqual(protocol.CLIENT_IDS, [...new Set(protocol.CLIENT_IDS)].sort(), 'client ids must be unique and sorted');
  assert.equal(protocol.getClient('axle').host, 'Claude Code');
  assert.equal(protocol.getClient('nope'), null);
});

test('the request headers clients send carry no credential', () => {
  const names = Object.values(protocol.HEADERS).join(' ');
  assert.equal(names.includes('authorization'), false, 'the hub is anonymous; no auth header should be declared');
  // These three are what make "who is still on the old contract" answerable.
  for (const key of ['client', 'channel', 'clientContract']) assert.ok(protocol.HEADERS[key], `HEADERS.${key} is missing`);
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------
test('compareContract classifies drift the way the pipeline acts on it', () => {
  const server = { contractVersion: '0.3.0', contractDigest: 'aaaaaaaaaaaa' };

  assert.equal(contract.compareContract({ contractVersion: '0.3.0', contractDigest: 'aaaaaaaaaaaa' }, server).verdict, 'ok');
  assert.equal(contract.compareContract({ contractVersion: '0.3.0', contractDigest: 'bbbbbbbbbbbb' }, server).verdict, 'patch');
  assert.equal(contract.compareContract({ contractVersion: '0.1.0', contractDigest: 'bbbbbbbbbbbb' }, server).verdict, 'patch');
  assert.equal(contract.compareContract({ contractVersion: '1.0.0', contractDigest: 'bbbbbbbbbbbb' }, server).verdict, 'breaking');
  assert.equal(contract.compareContract({ contractVersion: '0.3.0', contractDigest: 'aaaaaaaaaaaa' }, {}).verdict, 'unknown');
});

test('contractIdentity reports exactly what /version must expose', () => {
  const id = contract.contractIdentity();
  assert.equal(id.contractDigest, contractDigest());
  assert.equal(id.contractVersion, protocol.CONTRACT_VERSION);
  assert.deepEqual(id.toolNames, TOOL_NAMES);
  assert.deepEqual(id.clientIds, protocol.CLIENT_IDS);
  for (const key of ['contractVersion', 'contractDigest', 'mcpProtocolVersion']) {
    assert.ok(protocol.VERSION_PAYLOAD_KEYS.includes(key), `${key} must be part of the /version payload contract`);
  }
});

test('the contract package version tracks CONTRACT_VERSION', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.version, protocol.CONTRACT_VERSION, 'package.json and CONTRACT_VERSION must not drift');
});
