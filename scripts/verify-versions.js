#!/usr/bin/env node
// scripts/verify-versions.js
// One check, run early in CI: every version string in the repository agrees.
//
//   node scripts/verify-versions.js
//   node scripts/verify-versions.js --tag=v0.2.0     also require the tag to match
//
// Version drift is a slow, quiet failure. A plugin whose manifest says 0.2.0 while its
// package says 0.2.1 installs fine and reports the wrong version forever; a hub built
// from a contract version that no channel is pinned to serves a surface no client
// expects. None of that produces an error at the time it is introduced, which is
// exactly why it is worth a dedicated check that runs before anything else.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const { CONTRACT_VERSION } = require('@pivotly/contract/protocol');
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
const hub = read('packages/hub/package.json');
const axle = read('packages/clients/axle/package.json');
const plugin = read('packages/clients/axle/.claude-plugin/plugin.json');
const marketplace = read('.claude-plugin/marketplace.json');
const channels = read('packages/clients/axle/channels.json');
const lock = read('packages/contract/contract.lock.json');

// --- one version across the workspace ------------------------------------
// The packages are released together, so they share a version. If that ever stops
// being true, this check is the place to relax it deliberately rather than discovering
// the drift later.
same('contract package version == CONTRACT_VERSION', contract.version, CONTRACT_VERSION);
same('hub version == root version', hub.version, root.version);
same('axle version == root version', axle.version, root.version);
same('contract version == root version', contract.version, root.version);
same('plugin.json version == axle package version', plugin.version, axle.version);

const entry = (marketplace.plugins || []).find((p) => p.name === plugin.name);
ok(`marketplace.json lists the "${plugin.name}" plugin`, Boolean(entry), `lists: ${(marketplace.plugins || []).map((p) => p.name).join(', ')}`);
if (entry) same('marketplace entry version == plugin.json version', entry.version, plugin.version);

// --- the contract lock ----------------------------------------------------
same('contract.lock.json version == CONTRACT_VERSION', lock.contractVersion, CONTRACT_VERSION);
same('contract.lock.json digest == the computed digest', lock.digest, contractDigest());

// --- channel pins ---------------------------------------------------------
// A channel pinned to a contract this repository does not build means the client
// manifest was not resynced after a core change — the cascade the digest exists to
// catch. autopatch --check reports this per channel; here it is checked for all of
// them at once, which is what makes a partial resync visible.
for (const [name, channel] of Object.entries(channels.channels || {})) {
  same(`channel "${name}" pins the contract version this repo builds`, channel.contractVersion, CONTRACT_VERSION);
  same(`channel "${name}" pins the contract digest this repo builds`, channel.contractDigest, contractDigest());
}

// --- release tag ----------------------------------------------------------
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
if (tagArg) {
  const tag = tagArg.slice('--tag='.length).replace(/^v/, '');
  // A tag is permanent and installable, so this is checked at release time as well as
  // in CI — CD cannot rely on CI having run against the exact commit being tagged.
  same(`the release tag matches the root version`, tag, root.version);
}

// --- summary --------------------------------------------------------------
const failures = results.filter((r) => !r.passed);
console.log('');
if (failures.length) {
  console.log(`FAIL  ${failures.length} of ${results.length} version checks failed`);
  console.error('      Versions are bumped together. Update every package.json, plugin.json,');
  console.error('      marketplace.json and channel pin, then re-run:');
  console.error('        npm run contract:digest -- --write && npm run axle:autopatch -- --write');
  process.exitCode = 1;
} else {
  console.log(`ok    all ${results.length} version checks passed — ${root.version}, contract ${CONTRACT_VERSION} (${contractDigest()})`);
}
