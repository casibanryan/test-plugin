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

const { CHANNELS, HARDENED_CHANNELS, ENDPOINTS, HEADERS, CLIENTS, CONTRACT_VERSION, transportOf, STDIO_CHANNELS } = require('@pivotly/contract/protocol');
const { contractDigest } = require('@pivotly/contract/digest');
const { compareContract } = require('@pivotly/contract');
const { renderAll, headersFor, writeToml, writeMcpJson, writeGeminiJson, renderSkill, skillReach, Skill } = require('../scripts/generate');

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

test('a channel is allowed to lag this checkout — that is the normal state', () => {
  // lastVerified RECORDS what a channel was last proven to serve. It is deliberately
  // NOT required to equal what this checkout builds: while the next version is in
  // development, production is still serving the previous one. An earlier version of
  // this repo asserted equality here, which deadlocked every contract change behind a
  // deploy that could not happen yet.
  for (const [name, channel] of Object.entries(manifest.channels)) {
    if (channel.lastVerified == null) continue; // never deployed — nothing to check
    const lv = channel.lastVerified;
    assert.match(lv.contractDigest, /^[0-9a-f]{12}$/, `${name} has a malformed verification record`);
    assert.match(lv.contractVersion, /^\d+\.\d+\.\d+$/, `${name} has a malformed contract version`);
    assert.ok(lv.at, `${name} records no verification timestamp`);
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
    // A stdio channel has no address at all, so there is no scheme to hold to https.
    if (transportOf(name) === 'stdio') {
      assert.equal(channel.url, undefined, `${name} is stdio and must not carry a url`);
      continue;
    }
    assert.ok(channel.url.startsWith('https://'), `${name} must be https, got ${channel.url}`);
  }
  assert.equal(manifest.channels.local.requireHttps, false);
  assert.ok(manifest.channels.local.url.startsWith('http://127.0.0.1'), 'the local exception must be loopback only');
  for (const name of HARDENED_CHANNELS) assert.notEqual(manifest.channels[name].requireHttps, false);
});

test('every channel url is distinct and targets the contract MCP path', () => {
  const withUrls = Object.entries(manifest.channels).filter(([name]) => transportOf(name) === 'http');
  const urls = withUrls.map(([, c]) => c.url);
  assert.equal(new Set(urls).size, urls.length, 'two channels share a url; promoting one would promote the other');
  for (const [name, channel] of withUrls) {
    assert.ok(channel.url.endsWith(ENDPOINTS.mcp), `${name}: ${channel.url}`);
  }
});

test('a stdio channel declares a command and a relocatable path', () => {
  for (const name of STDIO_CHANNELS) {
    const channel = manifest.channels[name];
    assert.ok(channel, `${name} is declared by the contract but missing from the manifest`);
    assert.ok(channel.command, `${name} must declare a command to run`);
    assert.ok(Array.isArray(channel.args) && channel.args.length > 0, `${name} must declare args`);
    // The install directory carries the version number, so an absolute path would work
    // for exactly one release.
    for (const a of channel.args) assert.ok(!/^([A-Za-z]:[\\/]|\/)/.test(a), `${name}: ${a} is an absolute path`);
  }
});

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------
test('headersFor sends caller identity and no credential', () => {
  const headers = headersFor({ id: 'claude' }, { name: 'dev' });
  assert.equal(headers[HEADERS.client], 'claude');
  assert.equal(headers[HEADERS.channel], 'dev');
  // The contract the client was GENERATED from — always this build, never a value read
  // back out of the channel record.
  assert.equal(headers[HEADERS.clientContract], CONTRACT_VERSION);
  assert.equal(Object.keys(headers).some((k) => /authorization/i.test(k)), false);
});

test('the mcp-json writer declares an http server at the channel url', () => {
  const config = JSON.parse(writeMcpJson({ id: 'claude' }, { name: 'dev', url: 'https://x.test/mcp' }));
  const server = config.mcpServers['pivotly-hub'];
  assert.equal(server.type, 'http');
  assert.equal(server.url, 'https://x.test/mcp');
  assert.equal(server.headers[HEADERS.client], 'claude');
});

test('the toml writer emits a parseable server block', () => {
  const toml = writeToml({ id: 'codex' }, { name: 'dev', url: 'https://x.test/mcp' });
  assert.match(toml, /^# GENERATED/);
  assert.match(toml, /\[mcp_servers\.pivotly_hub\]/);
  assert.match(toml, /url = "https:\/\/x\.test\/mcp"/);
  assert.match(toml, /\[mcp_servers\.pivotly_hub\.http_headers\]/);
  assert.match(toml, /"x-pivotly-client" = "codex"/);
});

test('the toml writer refuses a value it cannot safely quote', () => {
  // Better to fail loudly than to emit a malformed config that the host silently
  // ignores or half-parses.
  assert.throws(() => writeToml({ id: 'codex' }, { name: 'dev', url: 'https://x.test/"quoted"/mcp' }), /needs TOML escaping/);
});

test('the gemini writer uses httpUrl, not the url key that mcp-json emits', () => {
  // The whole reason this client does not share the mcp-json writer. Gemini reads a
  // plain `url` as an SSE endpoint, so emitting one would point it at a transport the
  // hub does not serve — and it would fail at connect time, not here.
  const config = JSON.parse(writeGeminiJson({ id: 'gemini' }, { name: 'dev', transport: 'http', url: 'https://x.test/mcp' }));
  const server = config.mcpServers['pivotly-hub'];
  assert.equal(server.httpUrl, 'https://x.test/mcp');
  assert.equal(server.url, undefined, 'a plain url would be read as SSE');
  assert.equal(server.type, undefined, 'gemini has no type discriminator; the key is the transport');
  assert.equal(server.headers[HEADERS.client], 'gemini');
  assert.equal(server.headers[HEADERS.channel], 'dev');
});

test('the gemini writer names the bundled server by a repo-relative path', () => {
  // Gemini has no CLAUDE_PLUGIN_ROOT to substitute, so the placeholder Claude Code
  // gets would reach it verbatim and never resolve.
  const channel = { name: 'bundled', ...manifest.channels.bundled };
  const config = JSON.parse(writeGeminiJson({ id: 'gemini' }, channel));
  const server = config.mcpServers['pivotly-greeting'];
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['packages/server/greeting-stdio.js']);
  assert.equal(server.httpUrl, undefined, 'a stdio channel has no address');
  assert.equal(server.headers, undefined, 'a stdio channel makes no request to identify');
  assert.ok(server.args.every((a) => !a.includes('CLAUDE_PLUGIN_ROOT')), 'gemini cannot substitute that placeholder');
});

test('renderAll covers every declared client, and can target one', () => {
  const channel = { name: 'local', ...manifest.channels.local };
  assert.equal(renderAll(channel).length, CLIENTS.length);
  assert.equal(renderAll(channel, 'claude').length, 1);
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
  // The whole client directory, not just its config file: a client can own more than
  // one generated artifact (the bundled server's tools.json), and a scratch copy
  // missing one would report drift that says nothing about the test.
  for (const client of CLIENTS) {
    fs.cpSync(path.join(ROOT, client.id), path.join(dir, client.id), { recursive: true });
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
  const res = await run(dir, ['--write', '--channel=dev', '--client=claude']);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(readConfig(dir, 'claude').includes(manifest.channels.dev.url));
  assert.equal(readConfig(dir, 'codex'), before, 'codex should not have been touched');
});

test('PIVOTLY_CHANNEL selects the channel when no flag is given', async () => {
  const dir = scratchCopy();
  const res = await run(dir, ['--write'], { PIVOTLY_CHANNEL: 'prerelease' });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(readConfig(dir, 'claude').includes(manifest.channels.prerelease.url));
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

test('--check does NOT fail when a channel was last verified on an older contract', async () => {
  // The regression guard for the deadlock: an out-of-date verification record is
  // information, not an error. Production lags while the next version is built, and
  // failing on that would make every contract change unshippable.
  const dir = scratchCopy();
  const manifestPath = path.join(dir, 'channels.json');
  const scratch = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  scratch.channels.production.lastVerified = {
    contractVersion: '0.1.0',
    contractDigest: 'ffffffffffff',
    commit: 'oldsha',
    at: '2020-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(manifestPath, JSON.stringify(scratch, null, 2));

  // The committed configs are generated for the default channel, so point the scratch
  // copy at production first — otherwise this asserts on drift rather than on how an
  // out-of-date verification record is treated.
  await run(dir, ['--write', '--channel=production']);

  const res = await run(dir, ['--check', '--channel=production', '--timeout-ms=300']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /normal until it is deployed/);
});

test('--check fails on a malformed verification record', async () => {
  // A record that looks like evidence and is not is worse than no record at all.
  const dir = scratchCopy();
  const manifestPath = path.join(dir, 'channels.json');
  const scratch = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  scratch.channels.production.lastVerified = { contractVersion: 'not-semver', contractDigest: 'nope' };
  fs.writeFileSync(manifestPath, JSON.stringify(scratch, null, 2));

  const res = await run(dir, ['--check', '--channel=production', '--timeout-ms=300']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /malformed lastVerified/);
});

test('--check tolerates an unreachable channel rather than failing CI on network access', async () => {
  // A fork's pull request has no route to Azure. Requiring one would make CI depend on
  // a deployed environment, so unreachable is a note, not a failure.
  const dir = scratchCopy();
  await run(dir, ['--write', '--channel=production']);
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

test('--check passes when the deployed hub serves this checkout', async () => {
  const hub = fakeHub({ contractVersion: CONTRACT_VERSION, contractDigest: contractDigest(), commit: 'abc123', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    pointLocalAt(dir, port);
    await run(dir, ['--write', '--channel=local']);

    const res = await run(dir, ['--check', '--channel=local']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /serves this checkout's contract/);
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
    assert.match(res.stderr, /but this checkout builds/);
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
    assert.match(res.stderr, /cannot talk to that hub/);
  } finally {
    await hub.close();
  }
});

test('--sync-pin records what the channel is now verified to serve', async () => {
  const hub = fakeHub({ contractVersion: CONTRACT_VERSION, contractDigest: contractDigest(), commit: 'deadbeef', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    const manifestPath = path.join(dir, 'channels.json');
    pointLocalAt(dir, port);

    const res = await run(dir, ['--sync-pin', '--channel=local']);
    assert.equal(res.code, 0, res.stderr);

    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).channels.local.lastVerified;
    assert.equal(after.contractDigest, contractDigest());
    assert.equal(after.contractVersion, CONTRACT_VERSION);
    assert.equal(after.commit, 'deadbeef', 'the record must name the commit that was verified');
    assert.ok(after.at, 'the record must say when');
    assert.match(res.stdout, /now verified at contract/);
  } finally {
    await hub.close();
  }
});

test('--sync-pin only touches the channel it was asked about', async () => {
  const hub = fakeHub({ contractVersion: CONTRACT_VERSION, contractDigest: contractDigest(), commit: 'deadbeef', channel: 'local' });
  const port = await hub.listen();
  try {
    const dir = scratchCopy();
    const manifestPath = path.join(dir, 'channels.json');
    pointLocalAt(dir, port);

    await run(dir, ['--sync-pin', '--channel=local']);
    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).channels;
    assert.ok(after.local.lastVerified, 'local should have been recorded');
    for (const other of ['dev', 'prerelease', 'production']) {
      assert.equal(after[other].lastVerified, null, `${other} must not be touched by a local deploy`);
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

// ---------------------------------------------------------------------------
// Skills: one source, rendered per host
// ---------------------------------------------------------------------------
// The failure these guard against is quieter than a bad config. A skill shipped to the
// wrong host does not crash anything — it just tells that host to do something
// impossible, and the only symptom is a model behaving oddly.

test('every declared client receives the skills that name it, and no others', () => {
  for (const skill of Skill.all()) {
    for (const client of CLIENTS) {
      if (!client.skillsPath) continue;
      const file = path.join(ROOT, client.id, client.skillsPath, skill.name, 'SKILL.md');
      assert.equal(
        fs.existsSync(file),
        skill.reaches(client.id),
        `${client.id}/${skill.name}: on disk=${fs.existsSync(file)} but declared reach=${skill.reaches(client.id)}`
      );
    }
  }
});

test('a rendered skill keeps its own host blocks and drops every other', () => {
  const source = [
    '---',
    'name: probe',
    'clients: [claude, codex, gemini]',
    '<!-- if:claude -->',
    'description: the claude one, use when greeting',
    '<!-- endif -->',
    '<!-- if:codex,gemini -->',
    'description: the shared one, use when greeting',
    '<!-- endif -->',
    '---',
    '',
    'shared body',
    '<!-- if:claude -->',
    'claude only',
    '<!-- endif -->',
    '<!-- if:gemini -->',
    'gemini only',
    '<!-- endif -->',
  ].join('\n');

  const claude = renderSkill(source, 'claude', 'probe');
  assert.match(claude, /claude only/);
  assert.doesNotMatch(claude, /gemini only/);
  assert.match(claude, /description: the claude one/);

  const gemini = renderSkill(source, 'gemini', 'probe');
  assert.match(gemini, /gemini only/);
  assert.doesNotMatch(gemini, /claude only/);
  assert.match(gemini, /description: the shared one/);

  // Build-only metadata and the markers themselves must never reach a host, and a
  // rendering must carry exactly one description or the host reads whichever it parses
  // first.
  for (const rendered of [claude, gemini, renderSkill(source, 'codex', 'probe')]) {
    assert.doesNotMatch(rendered, /<!--\s*(if:|endif)/, 'conditional markers must be stripped');
    assert.doesNotMatch(rendered, /^clients:/m, 'the build-only clients: line must be stripped');
    assert.equal((rendered.match(/^description:/gm) || []).length, 1);
  }
});

test('an authoring mistake in a skill fails loudly, naming the line', () => {
  const front = '---\nname: probe\nclients: [claude]\ndescription: probe, use never\n---\n';
  assert.throws(() => renderSkill(`${front}\n<!-- if:clod -->\nx\n<!-- endif -->\n`, 'claude', 'probe'), /unknown client "clod"/);
  assert.throws(() => renderSkill(`${front}\n<!-- if:claude -->\nx\n`, 'claude', 'probe'), /never closes it/);
  assert.throws(() => renderSkill(`${front}\n<!-- endif -->\n`, 'claude', 'probe'), /no matching <!-- if: -->/);
  // Reach is required, never defaulted to everyone.
  assert.throws(() => skillReach('---\nname: probe\ndescription: x\n---\n', 'probe'), /must declare which clients receive it/);
  assert.throws(() => skillReach('---\nname: probe\nclients: []\n---\n', 'probe'), /should be deleted, not shipped/);
});

test('a skill left behind after its reach narrows is reported, then pruned', async () => {
  const dir = scratchCopy();
  const client = CLIENTS.find((c) => c.skillsPath);
  const stale = path.join(dir, client.id, client.skillsPath, 'leftover');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'SKILL.md'), '---\nname: leftover\ndescription: nobody declares this, use never\n---\n\nstale.\n');

  const checked = await run(dir, ['--check']);
  assert.equal(checked.code, 1);
  assert.match(checked.stderr, /leftover is not declared by any skill/);

  const written = await run(dir, ['--write']);
  assert.equal(written.code, 0, written.stderr);
  assert.equal(fs.existsSync(stale), false, '--write must remove a skill no longer declared for this client');
});

test('--print reports one entry per client, however many files a client receives', async () => {
  const dir = scratchCopy();
  const res = await run(dir, ['--print']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  // The regression this pins: folding skills into `clients` made every client appear
  // once per file it received.
  assert.deepEqual(
    out.clients.map((c) => c.id),
    CLIENTS.map((c) => c.id)
  );
  assert.ok(out.generated.length > out.clients.length, 'generated lists every file, so it must be the longer list');
});
