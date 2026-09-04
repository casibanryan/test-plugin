#!/usr/bin/env node
// scripts/bump-version.js
// Moves every version string in the repository at once.
//
//   node scripts/bump-version.js patch      0.3.0 -> 0.3.1
//   node scripts/bump-version.js minor      0.3.0 -> 0.4.0
//   node scripts/bump-version.js major      0.3.0 -> 1.0.0
//   node scripts/bump-version.js 0.4.2      an exact version
//   node scripts/bump-version.js patch --dry-run
//
// This exists because the version is not one number. It is the same number written in
// nine places, plus two derived files, and `npm run versions:verify` fails the build if
// any one of them disagrees — which is the right behaviour, and miserable to satisfy by
// hand. CONTRACT_VERSION also feeds the contract digest, so a bump changes the digest,
// which changes the lock file and the generated client configs. Anything less than all
// of it together is drift.
//
// What it does NOT touch: channels.json's `lastVerified` records. Those say what a
// channel was last PROVEN to serve, and bumping a version proves nothing about a
// deployed channel. Only a deploy may advance them.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));

// --- work out the target version -----------------------------------------
const rootPkgPath = path.join(REPO_ROOT, 'package.json');
const current = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8')).version;

if (!/^\d+\.\d+\.\d+$/.test(current)) {
  console.error(`FAIL  the root version is not a plain semver: ${current}`);
  process.exit(1);
}

function resolveTarget(spec) {
  if (!spec) return null;
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [major, minor, patch] = current.split('.').map(Number);
  if (spec === 'major') return `${major + 1}.0.0`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;
  return null;
}

const next = resolveTarget(arg);
if (!next) {
  console.error('usage: node scripts/bump-version.js <patch|minor|major|X.Y.Z> [--dry-run]');
  process.exit(1);
}
if (next === current) {
  console.error(`FAIL  the tree is already at ${current}`);
  process.exit(1);
}

console.log(`\n${current}  ->  ${next}${DRY_RUN ? '   (dry run)' : ''}\n`);

// --- the files that carry the version literally ---------------------------
// Each entry is edited by a targeted replacement rather than a whole-file rewrite, so
// comments, key order and formatting survive — these files are read by people.
const edits = [
  // A JSON `"version"` at the top level. Matched with the preceding brace-newline so a
  // dependency's version field cannot be hit by accident.
  ...[
    'package.json',
    'packages/contract/package.json',
    'packages/server/package.json',
    'packages/clients/package.json',
    'e2e/package.json',
    'packages/clients/claude/.claude-plugin/plugin.json',
  ].map((rel) => ({
    rel,
    find: new RegExp(`("version"\\s*:\\s*")${current.replace(/\./g, '\\.')}(")`),
    replace: `$1${next}$2`,
  })),

  // The contract's own declaration — the one every other version is checked against.
  {
    rel: 'packages/contract/src/protocol.js',
    find: new RegExp(`(const CONTRACT_VERSION = ')${current.replace(/\./g, '\\.')}(')`),
    replace: `$1${next}$2`,
  },

  // The marketplace entry. This is the number a user's Claude Code compares against
  // its cached copy to decide an update exists, so the bump is invisible without it.
  {
    rel: '.claude-plugin/marketplace.json',
    find: new RegExp(`("version"\\s*:\\s*")${current.replace(/\./g, '\\.')}(")`),
    replace: `$1${next}$2`,
  },
];

let failed = false;
for (const edit of edits) {
  const abs = path.join(REPO_ROOT, edit.rel);
  if (!fs.existsSync(abs)) {
    console.log(`FAIL  ${edit.rel} is missing`);
    failed = true;
    continue;
  }
  const before = fs.readFileSync(abs, 'utf8');
  const after = before.replace(edit.find, edit.replace);
  if (after === before) {
    // Silence here would leave one file behind at the old version and let the commit
    // land, for versions:verify to reject later with no hint of which file it was.
    console.log(`FAIL  ${edit.rel} — no ${current} to replace`);
    failed = true;
    continue;
  }
  if (!DRY_RUN) fs.writeFileSync(abs, after);
  console.log(`ok    ${edit.rel}`);
}

if (failed) {
  console.error('\nFAIL  nothing was regenerated; fix the files above and run again');
  process.exit(1);
}

if (DRY_RUN) {
  console.log('\nok    dry run — no files written');
  process.exit(0);
}

// --- the derived files ----------------------------------------------------
// In this order: the digest depends on CONTRACT_VERSION, the client configs carry the
// contract version in their headers, and the lockfile records each workspace version.
const run = (label, file, args, opts = {}) => {
  console.log(`\n-- ${label}`);
  execFileSync(file, args, { cwd: REPO_ROOT, stdio: 'inherit', ...opts });
};

run('contract digest and lock', process.execPath, ['packages/contract/bin/contract-digest.js', '--write']);
run('every client config', process.execPath, ['packages/clients/scripts/generate.js', '--write']);
// package-lock.json carries the root version and every workspace version; `npm ci`
// refuses to run when those disagree with the package.json files, so CI would fail
// before a single check got the chance to run.
//
// `shell: true` on Windows because npm is a .cmd there, and Node refuses to spawn a
// .cmd without a shell — the arguments are all literals in this file, so there is
// nothing here for a shell to reinterpret.
run(
  'package-lock.json',
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--package-lock-only', '--ignore-scripts', '--silent'],
  { shell: process.platform === 'win32' }
);

console.log(`\nok    ${current} -> ${next} across ${edits.length} files, plus the lock, the configs and package-lock.json`);
console.log('      Confirm with:  npm run verify:all');
