#!/usr/bin/env node
// scripts/verify-versions.js
// One check, run early in CI: every version string in the repository agrees.
//
//   node scripts/verify-versions.js
//   node scripts/verify-versions.js --tag=v0.3.0     also require the tag to match
//
// Version drift is a slow, quiet failure. A plugin whose manifest says 0.3.0 while its
// package says 0.3.1 installs fine and reports the wrong version forever; a channel
// pinned to a contract nobody builds serves a surface no client expects. None of that
// errors at the moment it is introduced, which is exactly why it gets its own check
// that runs before anything else.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const { CONTRACT_VERSION, CLIENTS, CHANNELS, transportOf } = require('@pivotly/contract/protocol');
const { contractDigest } = require('@pivotly/contract/digest');

const read = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

const results = [];
const ok = (label, condition, detail) => {
  const passed = Boolean(condition);
  results.push({ label, passed, detail: passed ? undefined : detail });
  console.log(`${passed ? 'ok   ' : 'FAIL '} ${label}${passed || detail == null ? '' : `\n        ${detail}`}`);
  return passed;
};
const same = (label, a, b) => ok(label, a === b, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const root = read('package.json');
const contract = read('packages/contract/package.json');
const server = read('packages/server/package.json');
const clients = read('packages/clients/package.json');
const e2e = read('e2e/package.json');
const marketplace = read('.claude-plugin/marketplace.json');
const channels = read('packages/clients/channels.json');
const lock = read('packages/contract/contract.lock.json');

// --- one version across the workspace ------------------------------------
// The packages are released together, so they share a version. If that ever stops
// being true, this is the place to relax it deliberately rather than discovering the
// drift later.
same('contract package version == CONTRACT_VERSION', contract.version, CONTRACT_VERSION);
same('root version == CONTRACT_VERSION', root.version, CONTRACT_VERSION);
same('server version == root version', server.version, root.version);
same('clients version == root version', clients.version, root.version);
same('e2e version == root version', e2e.version, root.version);

// --- the contract lock ---------------------------------------------------
same('contract.lock.json version == CONTRACT_VERSION', lock.contractVersion, CONTRACT_VERSION);
same('contract.lock.json digest == the computed digest', lock.digest, contractDigest());
ok(
  'contract.lock.json lists every declared client',
  JSON.stringify(lock.clients) === JSON.stringify(CLIENTS.map((c) => c.id).sort()),
  `${JSON.stringify(lock.clients)} vs ${JSON.stringify(CLIENTS.map((c) => c.id).sort())}`
);

// --- every declared client -----------------------------------------------
// Iterated from the contract, so adding a client automatically brings it under these
// checks rather than needing to be remembered here.
for (const client of CLIENTS) {
  const dir = path.join('packages', 'clients', client.id);
  ok(`${client.id}/ exists`, fs.existsSync(path.join(REPO_ROOT, dir)), `the contract declares "${client.id}" but ${dir} is missing`);
  ok(`${client.id} config is committed`, fs.existsSync(path.join(REPO_ROOT, dir, client.configPath)), 'run: npm run clients:generate');

  if (!client.plugin) continue;

  const pluginPath = path.join(dir, '.claude-plugin', 'plugin.json');
  if (!ok(`${client.id} plugin manifest exists`, fs.existsSync(path.join(REPO_ROOT, pluginPath)))) continue;

  const plugin = read(pluginPath);
  same(`${client.id} plugin.json version == root version`, plugin.version, root.version);

  const entry = (marketplace.plugins || []).find((p) => p.name === plugin.name);
  if (ok(`marketplace.json lists "${plugin.name}"`, Boolean(entry), `lists: ${(marketplace.plugins || []).map((p) => p.name).join(', ')}`)) {
    same(`marketplace entry version == ${client.id} plugin.json version`, entry.version, plugin.version);
  }
}

// --- channels -------------------------------------------------------------
// NOT checked here: whether a channel's lastVerified matches what this repo builds.
// Those are different facts. `lastVerified` records what that channel was last PROVEN
// to serve; production legitimately lags the working tree while the next version is in
// development. Requiring equality would deadlock every contract change behind a deploy.
//
// What IS checked is that the record is well formed, because a malformed one is worse
// than an absent one — it looks like evidence and is not.
for (const name of CHANNELS) {
  const channel = (channels.channels || {})[name];
  if (!ok(`channels.json declares "${name}"`, Boolean(channel))) continue;
  // A channel is reachable either at an address or by a command. Demanding a url from
  // a stdio channel would fail the one channel that cannot be misconfigured.
  ok(
    `channel "${name}" says where it is reached`,
    transportOf(name) === 'stdio' ? Boolean(channel.command) : Boolean(channel.url),
    JSON.stringify(channel)
  );

  const lv = channel.lastVerified;
  if (lv == null) {
    console.log(`ok    channel "${name}" has never been deployed (lastVerified is null)`);
    continue;
  }
  ok(`channel "${name}" lastVerified has a 12-hex digest`, /^[0-9a-f]{12}$/.test(lv.contractDigest || ''), lv.contractDigest);
  ok(`channel "${name}" lastVerified has a semver contract version`, /^\d+\.\d+\.\d+$/.test(lv.contractVersion || ''), lv.contractVersion);
  ok(`channel "${name}" lastVerified records when it was verified`, Boolean(lv.at), JSON.stringify(lv));
}

// --- release tag ----------------------------------------------------------
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
if (tagArg) {
  // A tag is permanent and installable, so this is checked at release time as well as
  // in CI — CD cannot rely on CI having run against the exact commit being tagged.
  same('the release tag matches the root version', tagArg.slice('--tag='.length).replace(/^v/, ''), root.version);
}

// --- summary --------------------------------------------------------------
const failures = results.filter((r) => !r.passed);
console.log('');
if (failures.length) {
  console.log(`FAIL  ${failures.length} of ${results.length} version checks failed`);
  console.error('      Versions are bumped together. Update CONTRACT_VERSION and every package.json,');
  console.error('      plugin.json and marketplace.json, then run:');
  console.error('        npm run contract:digest -- --write && npm run clients:generate');
  process.exitCode = 1;
} else {
  console.log(
    `ok    all ${results.length} version checks passed — ${root.version}, contract ${CONTRACT_VERSION} (${contractDigest()}), ` +
      `${CLIENTS.length} clients, ${CHANNELS.length} channels`
  );
}
