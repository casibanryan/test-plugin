// packages/contract/test/contract.test.js
// Tier 0 of the test pyramid: the contract validates itself. Every other workspace
// derives from these declarations, so a defect here is a defect everywhere — these
// tests run first in CI and nothing else runs if they fail.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contract = require('../src/index');
const { TOOLS, TOOL_NAMES, STATELESS_TOOL_NAMES, REQUIRED_SCOPES } = require('../src/tools');
const auth = require('../src/auth');
const { ERROR_CODES, PivotlyError } = require('../src/errors');
const { contractDigest, contractSurface, lockBody, canonical } = require('../src/digest');
const { zodInputFor, allInputShapes } = require('../src/zod');
const protocol = require('../src/protocol');

test('every tool descriptor is well formed', () => {
  // contractSurface() throws on any invalid descriptor, so building it is the assertion.
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

test('zod schemas derive from the descriptors and actually validate', () => {
  allInputShapes(); // throws on a bad descriptor

  const hello = zodInputFor('greeting_hello');
  assert.deepEqual(hello.parse({ name: 'Resty', hour: 9 }), { name: 'Resty', hour: 9 });
  assert.deepEqual(hello.parse({}), {});
  assert.throws(() => hello.parse({ hour: 24 }), /hour/i);
  assert.throws(() => hello.parse({ hour: 9.5 }));
  assert.throws(() => hello.parse({ nope: 1 }), /unrecognized|Unrecognized/);

  const dayCheck = zodInputFor('greeting_day_check');
  assert.throws(() => dayCheck.parse({}), /answer/i);

  const claim = zodInputFor('job_claim');
  assert.deepEqual(claim.parse({ worker: 'w1' }), { worker: 'w1' });
  assert.throws(() => claim.parse({ worker: 'w1', leaseSeconds: 1 }));
});

test('write tools require a write scope and read tools do not', () => {
  for (const tool of TOOLS) {
    if (tool.readOnly) {
      assert.ok(
        tool.scopes.every((s) => s.endsWith(':read') || s === auth.SCOPES.ADMIN),
        `${tool.name} is read-only but asks for ${tool.scopes.join(', ')}`
      );
    } else {
      assert.ok(tool.scopes.some((s) => !s.endsWith(':read')), `${tool.name} writes but asks only for read scopes`);
    }
  }
});

test('every scope a tool requires is a declared scope', () => {
  for (const scope of REQUIRED_SCOPES) {
    assert.ok(auth.ALL_SCOPES.includes(scope), `${scope} is required by a tool but not declared in auth.SCOPES`);
    assert.ok(auth.isValidScope(scope));
  }
});

test('stateless tools are the ones that touch no database', () => {
  assert.deepEqual(
    STATELESS_TOOL_NAMES.slice().sort(),
    TOOLS.filter((t) => !t.touchesDatabase).map((t) => t.name).sort()
  );
  assert.ok(STATELESS_TOOL_NAMES.length > 0, 'the pipeline needs at least one database-free smoke tool');
});

test('scope wildcards widen in one direction only', () => {
  assert.ok(auth.hasScope(['usdf:*'], 'usdf:write'));
  assert.ok(auth.hasScope(['*'], 'jobs:claim'));
  assert.ok(auth.hasScope(['greeting:read'], 'greeting:read'));

  assert.equal(auth.hasScope(['usdf:read'], 'usdf:write'), false);
  assert.equal(auth.hasScope(['usdf:*'], 'jobs:claim'), false, 'a wildcard must not cross resources');
  assert.equal(auth.hasScope([], 'greeting:read'), false);
  assert.equal(auth.hasScope(undefined, 'greeting:read'), false);
});

test('missingScope names the first unsatisfied scope', () => {
  assert.equal(auth.missingScope(['usdf:write'], ['usdf:write']), null);
  assert.equal(auth.missingScope(['usdf:read'], ['usdf:read', 'usdf:write']), 'usdf:write');
  assert.equal(auth.missingScope([], []), null);
});

test('invalid scope strings are rejected', () => {
  for (const bad of ['USDF:WRITE', 'usdf', 'usdf:', ':write', 'usdf:write:extra', '', null, 'usdf write']) {
    assert.equal(auth.isValidScope(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

test('parseBearer accepts a well-formed header and rejects everything else', () => {
  assert.equal(auth.parseBearer({ Authorization: 'Bearer abc123' }), 'abc123');
  assert.equal(auth.parseBearer({ authorization: 'bearer abc123' }), 'abc123', 'scheme is case-insensitive');

  const codeOf = (headers) => {
    try {
      auth.parseBearer(headers);
      return null;
    } catch (e) {
      return e.code;
    }
  };
  assert.equal(codeOf({}), ERROR_CODES.UNAUTHENTICATED);
  assert.equal(codeOf({ authorization: 'Basic abc' }), ERROR_CODES.UNAUTHENTICATED);
  assert.equal(codeOf({ authorization: 'Bearer' }), ERROR_CODES.UNAUTHENTICATED);
  assert.equal(codeOf({ authorization: 'Bearer   ' }), ERROR_CODES.UNAUTHENTICATED);
});

test('authHeaders builds what parseBearer expects and always states the client contract', () => {
  const headers = auth.authHeaders({ token: 'tok', channel: 'prerelease', requestId: 'r1' });
  assert.equal(auth.parseBearer(headers), 'tok');
  assert.equal(headers[auth.HEADERS.clientContract], protocol.CONTRACT_VERSION);
  assert.equal(headers[auth.HEADERS.channel], 'prerelease');
});

test('normalizePrincipal accepts both snake_case rows and camelCase objects', () => {
  const fromApi = auth.normalizePrincipal({ principal_id: 'p1', email: 'A@B.com', tenant_id: 't1', kind: 'service', scopes: ['b', 'a'] });
  assert.deepEqual(fromApi, { principalId: 'p1', email: 'a@b.com', tenantId: 't1', kind: 'service', scopes: ['a', 'b'], disabled: false, source: 'db' });
  assert.deepEqual(Object.keys(fromApi).sort(), auth.PRINCIPAL_KEYS.slice().sort());
  assert.equal(auth.normalizePrincipal(null), null);
});

test('an unknown or missing principal kind resolves to the read-only one', () => {
  // The safe direction, and it matters: a platform API that stopped sending `kind`, or
  // sent one this contract does not know, must cost a principal its write access
  // rather than grant it.
  assert.equal(auth.normalizePrincipal({ principalId: 'p', email: 'a@b.c' }).kind, 'client');
  assert.equal(auth.normalizePrincipal({ principalId: 'p', email: 'a@b.c', kind: 'superuser' }).kind, 'client');
  assert.equal(auth.normalizePrincipal({ principalId: 'p', email: 'a@b.c', kind: 'service' }).kind, 'service');
});

test('redactToken never returns the token', () => {
  assert.equal(auth.redactToken('supersecrettoken').includes('secrettoken'), false);
  assert.equal(auth.redactToken('short'), '…');
});

test('PivotlyError carries a code, an HTTP status, and no stack on the wire', () => {
  const err = new PivotlyError(ERROR_CODES.FORBIDDEN_ALLOWLIST, 'nope', { tool: 'usdf_record_put' });
  assert.equal(err.httpStatus, 403);
  const wire = JSON.parse(JSON.stringify(err));
  assert.deepEqual(Object.keys(wire).sort(), ['code', 'details', 'message', 'ok']);
  assert.equal(wire.ok, false);
});

test('every error code has an HTTP status', () => {
  for (const code of Object.values(ERROR_CODES)) {
    assert.equal(typeof require('../src/errors').HTTP_STATUS_FOR_CODE[code], 'number', `${code} has no status`);
  }
});

test('the digest is deterministic and insensitive to key order', () => {
  assert.equal(contractDigest(), contractDigest());
  assert.match(contractDigest(), /^[0-9a-f]{12}$/);
  assert.deepEqual(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(JSON.stringify(canonical({ b: 1, a: 2 })), '{"a":2,"b":1}');
});

test('canonical drops undefined but keeps null', () => {
  assert.deepEqual(canonical({ a: undefined, b: null }), { b: null });
});

test('contract.lock.json matches the source', () => {
  const lockPath = path.join(__dirname, '..', 'contract.lock.json');
  assert.ok(fs.existsSync(lockPath), 'contract.lock.json is missing — run: npm run contract:digest -- --write');
  const onDisk = fs.readFileSync(lockPath, 'utf8');
  assert.equal(onDisk, `${JSON.stringify(lockBody(), null, 2)}\n`, 'lock file drift — run: npm run contract:digest -- --write');
});

test('protocol constants are coherent', () => {
  assert.match(protocol.CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(protocol.MCP_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(
    protocol.SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(protocol.MCP_PROTOCOL_VERSION),
    'the version we speak must be in the version list we accept'
  );
  assert.deepEqual(protocol.CHANNELS, ['local', 'dev', 'prerelease', 'production']);
  for (const c of protocol.HARDENED_CHANNELS) assert.ok(protocol.CHANNELS.includes(c));
  for (const key of ['mcp', 'health', 'ready', 'version']) assert.match(protocol.ENDPOINTS[key], /^\//);
});

test('compareContract classifies drift the way the pipeline acts on it', () => {
  const server = { contractVersion: '0.2.0', contractDigest: 'aaaaaaaaaaaa' };

  assert.equal(contract.compareContract({ contractVersion: '0.2.0', contractDigest: 'aaaaaaaaaaaa' }, server).verdict, 'ok');
  assert.equal(contract.compareContract({ contractVersion: '0.2.0', contractDigest: 'bbbbbbbbbbbb' }, server).verdict, 'patch');
  assert.equal(contract.compareContract({ contractVersion: '0.1.0', contractDigest: 'bbbbbbbbbbbb' }, server).verdict, 'patch');
  assert.equal(contract.compareContract({ contractVersion: '1.0.0', contractDigest: 'bbbbbbbbbbbb' }, server).verdict, 'breaking');
  assert.equal(contract.compareContract({ contractVersion: '0.2.0', contractDigest: 'aaaaaaaaaaaa' }, {}).verdict, 'unknown');
});

test('contractIdentity reports exactly what /version must expose', () => {
  const id = contract.contractIdentity();
  assert.equal(id.contractDigest, contractDigest());
  assert.equal(id.contractVersion, protocol.CONTRACT_VERSION);
  assert.deepEqual(id.toolNames, TOOL_NAMES);
  for (const key of ['contractVersion', 'contractDigest', 'mcpProtocolVersion']) {
    assert.ok(protocol.VERSION_PAYLOAD_KEYS.includes(key), `${key} must be part of the /version payload contract`);
  }
});

test('the contract package version tracks the contract version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.version, protocol.CONTRACT_VERSION, 'package.json and CONTRACT_VERSION must not drift');
});
