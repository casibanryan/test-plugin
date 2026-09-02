// packages/clients/axle/test/axle.test.js
// Tests for the client's channel management and generated manifest.
//
// The autopatch tests run against a throwaway copy of the manifests in a temp
// directory, so a test can assert what --write and --sync-pin actually do without
// touching the committed files.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const { CHANNELS, HARDENED_CHANNELS, ENDPOINTS, CONTRACT_VERSION } = require('@pivotly/contract/protocol');
const { HEADERS } = require('@pivotly/contract/auth');
const { contractDigest } = require('@pivotly/contract/digest');
const { compareContract } = require('@pivotly/contract');
const { mcpConfigFor } = require('../scripts/autopatch');

const ROOT = path.join(__dirname, '..');
const channelsManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'channels.json'), 'utf8'));
const mcpJson = JSON.parse(fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf8'));
const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Committed state
// ---------------------------------------------------------------------------
test('every contract channel is declared, and no others', () => {
  assert.deepEqual(Object.keys(channelsManifest.channels).sort(), CHANNELS.slice().sort());
});

test('the committed .mcp.json is exactly what autopatch would generate', () => {
  // The check that stops a hand-edit: if someone tweaks .mcp.json directly, the file
  // and channels.json disagree and the next deploy points somewhere unexpected.
  const channelName = channelsManifest.default;
  const expected = mcpConfigFor({ name: channelName, ...channelsManifest.channels[channelName] });
  assert.deepEqual(mcpJson, expected, 'run: npm run autopatch -w @pivotly/axle -- --write');
});

test('the committed manifest is pinned to the contract this repo builds', () => {
  const channel = channelsManifest.channels[channelsManifest.default];
  const verdict = compareContract(
    { contractVersion: channel.contractVersion, contractDigest: channel.contractDigest },
    { contractVersion: CONTRACT_VERSION, contractDigest: contractDigest() }
  );
  assert.equal(verdict.verdict, 'ok', verdict.reason);
});

test('no committed manifest contains a literal token', () => {
  const auth = mcpJson.mcpServers['pivotly-hub'].headers[HEADERS.auth];
  assert.match(auth, /^Bearer \$\{[A-Z_][A-Z0-9_]*\}$/);
  assert.equal(auth.includes('dev-token'), false);
});

test('hardened channels are https and local is the only exception', () => {
  for (const [name, channel] of Object.entries(channelsManifest.channels)) {
    if (HARDENED_CHANNELS.includes(name) || name === 'dev') {
      assert.ok(channel.url.startsWith('https://'), `${name} must be https, got ${channel.url}`);
    }
  }
  assert.equal(channelsManifest.channels.local.requireHttps, false);
  assert.ok(channelsManifest.channels.local.url.startsWith('http://127.0.0.1'), 'the local exception must be loopback only');
});

test('every channel url targets the contract MCP path', () => {
  for (const [name, channel] of Object.entries(channelsManifest.channels)) {
    assert.ok(channel.url.endsWith(ENDPOINTS.mcp), `${name}: ${channel.url}`);
  }
});

test('the plugin version tracks the package version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pluginJson.version, pkg.version);
});

// ---------------------------------------------------------------------------
// mcpConfigFor
// ---------------------------------------------------------------------------
test('mcpConfigFor declares an http server and interpolates the token env var', () => {
  const config = mcpConfigFor({ name: 'dev', url: 'https://example.test/mcp', contractVersion: '1.2.3', tokenEnv: 'MY_TOKEN' });
  const server = config.mcpServers['pivotly-hub'];
  assert.equal(server.type, 'http');
  assert.equal(server.url, 'https://example.test/mcp');
  assert.equal(server.headers[HEADERS.auth], 'Bearer ${MY_TOKEN}');
  assert.equal(server.headers[HEADERS.channel], 'dev');
  assert.equal(server.headers[HEADERS.clientContract], '1.2.3');
});

test('mcpConfigFor tells the hub which channel and contract the client is on', () => {
  // The hub logs these, and "which client versions are still calling us" is the
  // question you have to answer before retiring a contract version.
  const config = mcpConfigFor({ name: 'prerelease', url: 'https://x.test/mcp', contractVersion: '0.9.0', tokenEnv: 'T' });
  const headers = config.mcpServers['pivotly-hub'].headers;
  assert.ok(headers[HEADERS.channel]);
  assert.ok(headers[HEADERS.clientContract]);
});

// ---------------------------------------------------------------------------
// autopatch, run as a subprocess against a scratch copy
// ---------------------------------------------------------------------------
// A throwaway copy of just the manifests. The script itself is NOT copied — it is run
// from its real location with AXLE_MANIFEST_DIR pointed here, so these tests exercise
// the shipped code rather than a duplicate of it (and it can still resolve its
// workspace dependencies).
function scratchCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axle-autopatch-'));
  fs.copyFileSync(path.join(ROOT, 'channels.json'), path.join(dir, 'channels.json'));
  fs.copyFileSync(path.join(ROOT, '.mcp.json'), path.join(dir, '.mcp.json'));
  return dir;
}

const AUTOPATCH = path.join(ROOT, 'scripts', 'autopatch.js');

// Async, not execFileSync, and that is load-bearing. Several tests below stand up a
// fake hub INSIDE this process; a synchronous child would block this event loop, the
// fake hub could never accept the subprocess connection, and every one of those tests
// would fail on a timeout that looks like a network problem and is not.
const runAutopatch = async (dir, args, env = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [AUTOPATCH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PIVOTLY_CHANNEL: '', AXLE_MANIFEST_DIR: dir, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
};

test('--write points .mcp.json at the requested channel', async () => {
  const dir = scratchCopy();
  const res = await runAutopatch(dir, ['--write', '--channel=local']);
  assert.equal(res.code, 0, res.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.equal(written.mcpServers['pivotly-hub'].url, channelsManifest.channels.local.url);
  assert.equal(written.mcpServers['pivotly-hub'].headers[HEADERS.channel], 'local');
});

test('PIVOTLY_CHANNEL selects the channel when no flag is given', async () => {
  const dir = scratchCopy();
  const res = await runAutopatch(dir, ['--write'], { PIVOTLY_CHANNEL: 'prerelease' });
  assert.equal(res.code, 0, res.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.equal(written.mcpServers['pivotly-hub'].url, channelsManifest.channels.prerelease.url);
});

test('an unknown channel is refused rather than defaulted', async () => {
  const dir = scratchCopy();
  const res = await runAutopatch(dir, ['--write', '--channel=staging']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unknown channel "staging"/);
});

test('--check fails when .mcp.json has drifted, and does not repair it', async () => {
  const dir = scratchCopy();
  const target = path.join(dir, '.mcp.json');
  const tampered = JSON.parse(fs.readFileSync(target, 'utf8'));
  tampered.mcpServers['pivotly-hub'].url = 'https://somewhere-else.example/mcp';
  fs.writeFileSync(target, JSON.stringify(tampered, null, 2));

  const res = await runAutopatch(dir, ['--check', '--timeout-ms=300']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /drifted/);
  // A check that fixed what it was checking would let a pull request pass by
  // rewriting the evidence.
  const after = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(after.mcpServers['pivotly-hub'].url, 'https://somewhere-else.example/mcp');
});

test('--check fails when a channel pin no longer matches the contract in this checkout', async () => {
  const dir = scratchCopy();
  const manifestPath = path.join(dir, 'channels.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.channels.production.contractDigest = 'ffffffffffff';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const res = await runAutopatch(dir, ['--check', '--channel=production', '--timeout-ms=300']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /tool surface changed without updating the client manifest/);
});

test('--check tolerates an unreachable channel rather than failing CI on network access', async () => {
  const dir = scratchCopy();
  // A fork's pull request has no route to Azure. Requiring one would make CI depend
  // on a deployed environment, so unreachable is a note, not a failure.
  const res = await runAutopatch(dir, ['--check', '--channel=production', '--timeout-ms=300']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /not reachable/);
});

// ---------------------------------------------------------------------------
// --check and --sync-pin against a hub that actually answers
// ---------------------------------------------------------------------------
function fakeHub(identity) {
  const server = http.createServer((req, res) => {
    if (req.url === ENDPOINTS.version) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(identity));
      return;
    }
    res.writeHead(404).end();
  });
  return {
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Repoints the `local` channel at a hub on a known port, so these tests drive the
// real fetch path rather than a mock.
function pointLocalAt(dir, port) {
  const manifestPath = path.join(dir, 'channels.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.channels.local.url = `http://127.0.0.1:${port}${ENDPOINTS.mcp}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

test('--check passes when the deployed digest matches the pin', async () => {
  const hub = fakeHub({ contractVersion: CONTRACT_VERSION, contractDigest: contractDigest(), commit: 'abc123', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    pointLocalAt(dir, port);
    await runAutopatch(dir, ['--write', '--channel=local']);

    const res = await runAutopatch(dir, ['--check', '--channel=local']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /serves the pinned contract/);
    assert.match(res.stdout, /deployed commit abc123/);
  } finally {
    await hub.close();
  }
});

test('--check fails when the deployed hub serves a different contract', async () => {
  const hub = fakeHub({ contractVersion: CONTRACT_VERSION, contractDigest: 'aaaaaaaaaaaa', commit: 'def456', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    pointLocalAt(dir, port);
    await runAutopatch(dir, ['--write', '--channel=local']);

    const res = await runAutopatch(dir, ['--check', '--channel=local']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /does not match the deployed hub/);
  } finally {
    await hub.close();
  }
});

test('a differing contract MAJOR is reported as breaking, not as a resyncable drift', async () => {
  // The distinction matters: a patch verdict says "update the manifest", a breaking
  // verdict says "this client cannot talk to that hub at all".
  const hub = fakeHub({ contractVersion: '9.0.0', contractDigest: 'bbbbbbbbbbbb', commit: 'x', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    pointLocalAt(dir, port);
    await runAutopatch(dir, ['--write', '--channel=local']);

    const res = await runAutopatch(dir, ['--check', '--channel=local']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /BREAKING/);
    assert.match(res.stderr, /must be upgraded/);
  } finally {
    await hub.close();
  }
});

test('--sync-pin advances the pin to what a verified deploy is serving', async () => {
  const hub = fakeHub({ contractVersion: CONTRACT_VERSION, contractDigest: contractDigest(), commit: 'deadbeef', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    const manifestPath = path.join(dir, 'channels.json');
    const manifest = pointLocalAt(dir, port);
    manifest.channels.local.contractDigest = 'cccccccccccc'; // a stale pin
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const res = await runAutopatch(dir, ['--sync-pin', '--channel=local']);
    assert.equal(res.code, 0, res.stderr);
    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(after.channels.local.contractDigest, contractDigest());
    assert.match(res.stdout, /pin advanced/);
  } finally {
    await hub.close();
  }
});

test('--sync-pin refuses to pin a contract this checkout did not build', async () => {
  // The guard against pinning mid-rollout, or pinning a hub deployed from another
  // commit: the recorded pin would then describe a surface this client never saw.
  const hub = fakeHub({ contractVersion: CONTRACT_VERSION, contractDigest: 'eeeeeeeeeeee', commit: 'other', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    pointLocalAt(dir, port);
    const res = await runAutopatch(dir, ['--sync-pin', '--channel=local']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /Refusing to pin a contract this client was not built from/);
  } finally {
    await hub.close();
  }
});

test('--sync-pin refuses to guess when the hub cannot be reached', async () => {
  const dir = scratchCopy();
  pointLocalAt(dir, 9); // discard port: nothing listens
  const res = await runAutopatch(dir, ['--sync-pin', '--channel=local', '--timeout-ms=300']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /must never guess/);
});

test('--print reports the resolved channel without writing anything', async () => {
  const dir = scratchCopy();
  const before = fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8');
  const res = await runAutopatch(dir, ['--print', '--channel=dev']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.channel, 'dev');
  assert.equal(out.thisCheckout.digest, contractDigest());
  assert.equal(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'), before);
});
