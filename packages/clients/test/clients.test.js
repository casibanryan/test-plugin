// packages/clients/test/clients.test.js
// Tests for channel resolution and config generation across every declared client.
//
// The generator tests run the REAL script as a subprocess against a throwaway copy of
// the manifests, so they assert what `--write`, `--check` and `--sync-pin` actually do
// without touching the committed files.

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

const { CHANNELS, HARDENED_CHANNELS, ENDPOINTS, HEADERS, CLIENTS, CONTRACT_VERSION } = require('@pivotly/contract/protocol');
const { contractDigest } = require('@pivotly/contract/digest');
const { compareContract } = require('@pivotly/contract');
const { renderAll, headersFor, writeToml, writeMcpJson } = require('../scripts/generate');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'channels.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Committed state
// ---------------------------------------------------------------------------
test('every contract channel is declared, and no others', () => {
  assert.deepEqual(Object.keys(manifest.channels).sort(), CHANNELS.slice().sort());
});

test('every declared client has its config committed, exactly as generated', () => {
  // The check that stops a hand-edit: if someone tweaks a config directly, it and
  // channels.json disagree and the next deploy points somewhere unexpected.
  const channelName = manifest.default;
  for (const r of renderAll({ name: channelName, ...manifest.channels[channelName] })) {
    assert.ok(fs.existsSync(r.file), `${r.relative} is missing — run: npm run clients:generate`);
    assert.equal(fs.readFileSync(r.file, 'utf8'), r.content, `${r.relative} has drifted — run: npm run clients:generate`);
  }
});

test('every channel is pinned to the contract this repo builds', () => {
  // All four, not just the default: a partial resync is otherwise invisible until that
  // channel is deployed.
  for (const [name, channel] of Object.entries(manifest.channels)) {
    const verdict = compareContract(
      { contractVersion: channel.contractVersion, contractDigest: channel.contractDigest },
      { contractVersion: CONTRACT_VERSION, contractDigest: contractDigest() }
    );
    assert.equal(verdict.verdict, 'ok', `${name}: ${verdict.reason}`);
  }
});

test('no committed client config contains a credential', () => {
  for (const client of CLIENTS) {
    const raw = fs.readFileSync(path.join(ROOT, client.id, client.configPath), 'utf8');
    assert.equal(/authorization/i.test(raw), false, `${client.id} emits an Authorization header`);
    assert.equal(/\bBearer\b/.test(raw), false, `${client.id} emits a Bearer scheme`);
    assert.deepEqual(raw.match(/\b[A-Za-z0-9_-]{32,}\b/g), null, `${client.id} contains something token-shaped`);
  }
});

test('hardened channels are https, and local is the only plaintext exception', () => {
  for (const [name, channel] of Object.entries(manifest.channels)) {
    if (name === 'local') continue;
    assert.ok(channel.url.startsWith('https://'), `${name} must be https, got ${channel.url}`);
  }
  assert.equal(manifest.channels.local.requireHttps, false);
  assert.ok(manifest.channels.local.url.startsWith('http://127.0.0.1'), 'the local exception must be loopback only');
  for (const name of HARDENED_CHANNELS) assert.notEqual(manifest.channels[name].requireHttps, false);
});

test('every channel url is distinct and targets the contract MCP path', () => {
  const urls = Object.values(manifest.channels).map((c) => c.url);
  assert.equal(new Set(urls).size, urls.length, 'two channels share a url; promoting one would promote the other');
  for (const [name, channel] of Object.entries(manifest.channels)) {
    assert.ok(channel.url.endsWith(ENDPOINTS.mcp), `${name}: ${channel.url}`);
  }
});

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------
test('headersFor sends caller identity and no credential', () => {
  const headers = headersFor({ id: 'axle' }, { name: 'dev', contractVersion: '1.2.3' });
  assert.equal(headers[HEADERS.client], 'axle');
  assert.equal(headers[HEADERS.channel], 'dev');
  assert.equal(headers[HEADERS.clientContract], '1.2.3');
  assert.equal(Object.keys(headers).some((k) => /authorization/i.test(k)), false);
});

test('the mcp-json writer declares an http server at the channel url', () => {
  const config = JSON.parse(writeMcpJson({ id: 'axle' }, { name: 'dev', url: 'https://x.test/mcp', contractVersion: '1.2.3' }));
  const server = config.mcpServers['pivotly-hub'];
  assert.equal(server.type, 'http');
  assert.equal(server.url, 'https://x.test/mcp');
  assert.equal(server.headers[HEADERS.client], 'axle');
});

test('the toml writer emits a parseable server block', () => {
  const toml = writeToml({ id: 'codex' }, { name: 'dev', url: 'https://x.test/mcp', contractVersion: '1.2.3' });
  assert.match(toml, /^# GENERATED/);
  assert.match(toml, /\[mcp_servers\.pivotly_hub\]/);
  assert.match(toml, /url = "https:\/\/x\.test\/mcp"/);
  assert.match(toml, /\[mcp_servers\.pivotly_hub\.http_headers\]/);
  assert.match(toml, /"x-pivotly-client" = "codex"/);
});

test('the toml writer refuses a value it cannot safely quote', () => {
  // Better to fail loudly than to emit a malformed config that the host silently
  // ignores or half-parses.
  assert.throws(
    () => writeToml({ id: 'codex' }, { name: 'dev', url: 'https://x.test/"quoted"/mcp', contractVersion: '1' }),
    /needs TOML escaping/
  );
});

test('renderAll covers every declared client, and can target one', () => {
  const channel = { name: 'local', ...manifest.channels.local };
  assert.equal(renderAll(channel).length, CLIENTS.length);
  assert.equal(renderAll(channel, 'axle').length, 1);
  assert.throws(() => renderAll(channel, 'nope'), /unknown client "nope"/);
});

// ---------------------------------------------------------------------------
// The generator, as a subprocess against a scratch copy
// ---------------------------------------------------------------------------
// The script itself is NOT copied — it runs from its real location with
// PIVOTLY_CLIENTS_DIR pointed at the scratch dir, so these tests exercise the shipped
// code (and it can still resolve its workspace dependencies).
function scratchCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivotly-clients-'));
  fs.copyFileSync(path.join(ROOT, 'channels.json'), path.join(dir, 'channels.json'));
  for (const client of CLIENTS) {
    fs.mkdirSync(path.join(dir, client.id), { recursive: true });
    fs.copyFileSync(path.join(ROOT, client.id, client.configPath), path.join(dir, client.id, client.configPath));
  }
  return dir;
}

const GENERATE = path.join(ROOT, 'scripts', 'generate.js');

// Async, not execFileSync, and that is load-bearing: several tests stand up a fake hub
// INSIDE this process, and a synchronous child would block this event loop so the fake
// hub could never accept the subprocess's connection — every one of those tests would
// then fail on a timeout that looks like a network problem and is not.
const run = async (dir, args, env = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [GENERATE, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PIVOTLY_CHANNEL: '', PIVOTLY_CLIENTS_DIR: dir, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
};

const readConfig = (dir, clientId) => {
  const client = CLIENTS.find((c) => c.id === clientId);
  return fs.readFileSync(path.join(dir, clientId, client.configPath), 'utf8');
};

test('--write repoints every client at the requested channel', async () => {
  const dir = scratchCopy();
  const res = await run(dir, ['--write', '--channel=local']);
  assert.equal(res.code, 0, res.stderr);
  for (const client of CLIENTS) {
    const raw = readConfig(dir, client.id);
    assert.ok(raw.includes(manifest.channels.local.url), `${client.id} was not repointed`);
    assert.ok(raw.includes('"x-pivotly-channel" = "local"') || raw.includes('"x-pivotly-channel": "local"'), `${client.id} did not record the channel`);
  }
});

test('--write --client targets one client and leaves the others alone', async () => {
  const dir = scratchCopy();
  const before = readConfig(dir, 'codex');
  const res = await run(dir, ['--write', '--channel=dev', '--client=axle']);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(readConfig(dir, 'axle').includes(manifest.channels.dev.url));
  assert.equal(readConfig(dir, 'codex'), before, 'codex should not have been touched');
});

test('PIVOTLY_CHANNEL selects the channel when no flag is given', async () => {
  const dir = scratchCopy();
  const res = await run(dir, ['--write'], { PIVOTLY_CHANNEL: 'prerelease' });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(readConfig(dir, 'axle').includes(manifest.channels.prerelease.url));
});

test('an unknown channel is refused rather than defaulted', async () => {
  const dir = scratchCopy();
  const res = await run(dir, ['--write', '--channel=staging']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unknown channel "staging"/);
});

test('--check fails on drift in ANY client, and does not repair it', async () => {
  const dir = scratchCopy();
  const target = path.join(dir, 'codex', 'config.toml');
  fs.writeFileSync(target, `${readConfig(dir, 'codex')}\n# hand-edited\n`);

  const res = await run(dir, ['--check', '--timeout-ms=300']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /codex\/config\.toml has drifted/);
  // A check that fixed what it was checking would let a pull request pass by rewriting
  // the evidence.
  assert.match(fs.readFileSync(target, 'utf8'), /# hand-edited/);
});

test('--check fails when a channel pin no longer matches this checkout', async () => {
  const dir = scratchCopy();
  const manifestPath = path.join(dir, 'channels.json');
  const scratch = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  scratch.channels.production.contractDigest = 'ffffffffffff';
  fs.writeFileSync(manifestPath, JSON.stringify(scratch, null, 2));

  const res = await run(dir, ['--check', '--channel=production', '--timeout-ms=300']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /tool surface changed without regenerating the clients/);
});

test('--check tolerates an unreachable channel rather than failing CI on network access', async () => {
  // A fork's pull request has no route to Azure. Requiring one would make CI depend on
  // a deployed environment, so unreachable is a note, not a failure.
  const dir = scratchCopy();
  const res = await run(dir, ['--check', '--channel=production', '--timeout-ms=300']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /not reachable/);
});

// ---------------------------------------------------------------------------
// Against a hub that actually answers
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

// Repoints the `local` channel at a hub on a known port, so these drive the real fetch
// path rather than a mock.
function pointLocalAt(dir, port) {
  const manifestPath = path.join(dir, 'channels.json');
  const scratch = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  scratch.channels.local.url = `http://127.0.0.1:${port}${ENDPOINTS.mcp}`;
  fs.writeFileSync(manifestPath, JSON.stringify(scratch, null, 2));
  return scratch;
}

test('--check passes when the deployed digest matches the pin', async () => {
  const hub = fakeHub({ contractVersion: CONTRACT_VERSION, contractDigest: contractDigest(), commit: 'abc123', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    pointLocalAt(dir, port);
    await run(dir, ['--write', '--channel=local']);

    const res = await run(dir, ['--check', '--channel=local']);
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
    await run(dir, ['--write', '--channel=local']);

    const res = await run(dir, ['--check', '--channel=local']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /does not match the deployed hub/);
  } finally {
    await hub.close();
  }
});

test('a differing contract MAJOR is reported as breaking, not as resyncable drift', async () => {
  // The distinction matters: patch says "regenerate the configs", breaking says "these
  // clients cannot talk to that hub at all".
  const hub = fakeHub({ contractVersion: '9.0.0', contractDigest: 'bbbbbbbbbbbb', commit: 'x', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    pointLocalAt(dir, port);
    await run(dir, ['--write', '--channel=local']);

    const res = await run(dir, ['--check', '--channel=local']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /BREAKING/);
    assert.match(res.stderr, /must be upgraded/);
  } finally {
    await hub.close();
  }
});

test('--sync-pin advances the pin and regenerates EVERY client together', async () => {
  const hub = fakeHub({ contractVersion: CONTRACT_VERSION, contractDigest: contractDigest(), commit: 'deadbeef', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    const manifestPath = path.join(dir, 'channels.json');
    const scratch = pointLocalAt(dir, port);
    scratch.channels.local.contractDigest = 'cccccccccccc'; // a stale pin
    fs.writeFileSync(manifestPath, JSON.stringify(scratch, null, 2));

    const res = await run(dir, ['--sync-pin', '--channel=local']);
    assert.equal(res.code, 0, res.stderr);

    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(after.channels.local.contractDigest, contractDigest());
    assert.match(res.stdout, /pin advanced/);

    // The pin and the configs must move together, or a client would still be pointing
    // at the previous channel while the manifest claims otherwise.
    for (const client of CLIENTS) {
      assert.ok(readConfig(dir, client.id).includes(`127.0.0.1:${port}`), `${client.id} was not regenerated with the pin`);
    }
  } finally {
    await hub.close();
  }
});

test('--sync-pin refuses to pin a contract this checkout did not build', async () => {
  // The guard against pinning mid-rollout, or pinning a hub deployed from another
  // commit: the recorded pin would then describe a surface these clients never saw.
  const hub = fakeHub({ contractVersion: CONTRACT_VERSION, contractDigest: 'eeeeeeeeeeee', commit: 'other', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    pointLocalAt(dir, port);
    const res = await run(dir, ['--sync-pin', '--channel=local']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /Refusing to pin a contract these clients were not generated from/);
  } finally {
    await hub.close();
  }
});

test('--sync-pin refuses to guess when the hub cannot be reached', async () => {
  const dir = scratchCopy();
  pointLocalAt(dir, 9); // discard port: nothing listens
  const res = await run(dir, ['--sync-pin', '--channel=local', '--timeout-ms=300']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /must never guess/);
});

test('--print reports every client without writing anything', async () => {
  const dir = scratchCopy();
  const before = CLIENTS.map((c) => readConfig(dir, c.id));
  const res = await run(dir, ['--print', '--channel=dev']);
  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.channel, 'dev');
  assert.equal(out.thisCheckout.digest, contractDigest());
  assert.deepEqual(out.clients.map((c) => c.id).sort(), CLIENTS.map((c) => c.id).sort());
  assert.deepEqual(CLIENTS.map((c) => readConfig(dir, c.id)), before, '--print must not write');
});
