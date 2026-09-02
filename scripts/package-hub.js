#!/usr/bin/env node
// scripts/package-hub.js
// Builds the deployable artifact for the hub: a directory containing exactly what
// Azure App Service needs to run it, plus a manifest describing what is inside.
//
//   node scripts/package-hub.js                    build into dist/hub
//   node scripts/package-hub.js --out=/tmp/hub     build somewhere else
//
// This replaced a container image. The hub is a stateless Node process with no OS-level
// surface of its own, so App Service's run-from-package deploy does the same job with
// far less machinery — no registry, no base image to keep patched, no image pull on
// cold start.
//
// What a container gave us for free and this has to do deliberately:
//
//   * an immutable, content-addressed artifact. The manifest written here records a
//     sha256 over every file, so the pipeline can prove the zip it smoke-tested is the
//     zip it deployed, rather than rebuilding and hoping the two match.
//   * a scannable dependency set. `npm audit --omit=dev` against the committed lockfile
//     covers the part of a Node app where the real risk is; there is no OS package
//     layer left to scan.
//
// Deliberately NOT included: devDependencies, tests, the fake platform API, the client
// package, and docs. A test double that ships to production is a test double that can
// be reached in production.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

// Everything the hub needs at runtime, and nothing else. Each entry is copied
// verbatim; anything not listed does not reach the artifact.
const INCLUDE = [
  'package.json',
  'package-lock.json',
  'packages/contract/package.json',
  'packages/contract/src',
  'packages/contract/contract.lock.json',
  'packages/hub/package.json',
  'packages/hub/src',
];

// scripts/ is included except for the test double, because the pipeline runs the smoke
// test from inside the artifact — the thing being tested and the thing doing the
// testing are then the same build.
const INCLUDE_SCRIPTS = ['smoke-remote.js', 'verify-upstream.js'];

function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copyRecursive(path.join(from, entry), path.join(to, entry));
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// A stable, content-addressed identity for the artifact: every file's path and sha256,
// hashed in sorted order. Two builds of the same commit produce the same digest.
function digestTree(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // A symlink is hashed by where it points, not by what is there: following it
      // would either read a directory (EISDIR) or silently hash content that is not
      // part of this artifact.
      if (entry.isSymbolicLink()) {
        files.push({ path: full, link: fs.readlinkSync(full) });
      } else if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push({ path: full });
      }
    }
  };
  walk(root);

  const entries = files
    .map((f) => ({ rel: path.relative(root, f.path).split(path.sep).join('/'), link: f.link, abs: f.path }))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.rel);
    hash.update(entry.link ? crypto.createHash('sha256').update(entry.link).digest() : crypto.createHash('sha256').update(fs.readFileSync(entry.abs)).digest());
  }
  return {
    digest: hash.digest('hex').slice(0, 16),
    fileCount: entries.length,
    symlinks: entries.filter((e) => e.link).map((e) => e.rel),
  };
}

function main() {
  const outDir = path.resolve(arg('out', path.join(REPO_ROOT, 'dist', 'hub')));
  const commit = process.env.BUILD_COMMIT || process.env.GITHUB_SHA || 'dev';
  const builtAt = process.env.BUILD_TIMESTAMP || new Date().toISOString();

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const rel of INCLUDE) {
    const from = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(from)) throw new Error(`cannot package: ${rel} does not exist`);
    copyRecursive(from, path.join(outDir, rel));
  }
  for (const script of INCLUDE_SCRIPTS) {
    copyRecursive(path.join(REPO_ROOT, 'packages/hub/scripts', script), path.join(outDir, 'packages/hub/scripts', script));
  }

  // Production dependencies only, resolved from the committed lockfile. `npm ci` rather
  // than `npm install` so the artifact's dependency tree is the reviewed one.
  execFileSync('npm', ['ci', '--omit=dev', '--workspace', '@pivotly/hub', '--include-workspace-root'], {
    cwd: outDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  // npm links every workspace package into node_modules as a SYMLINK. Those resolve
  // fine on this machine, but the artifact is zipped and unpacked on App Service, and
  // symlink handling through a zip is not something to rely on — a broken link there
  // surfaces as MODULE_NOT_FOUND at startup, on the deployed instance, with no local
  // reproduction. So every link is turned into a real directory before packaging, and
  // the result is asserted to contain none.
  const scopeDir = path.join(outDir, 'node_modules', '@pivotly');
  if (fs.existsSync(scopeDir)) {
    for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      const full = path.join(scopeDir, entry.name);
      if (!entry.isSymbolicLink()) continue;

      let target;
      try {
        target = fs.realpathSync(full);
      } catch {
        // Already dangling here, which would have been a startup failure there.
        fs.rmSync(full, { force: true });
        console.log(`ok    removed the dangling workspace link @pivotly/${entry.name}`);
        continue;
      }
      fs.rmSync(full, { recursive: true, force: true });
      copyRecursive(target, full);
      console.log(`ok    dereferenced the @pivotly/${entry.name} workspace link into a real directory`);
    }
  }

  const contractEntry = path.join(scopeDir, 'contract', 'package.json');
  if (!fs.existsSync(contractEntry)) {
    throw new Error('the artifact has no usable @pivotly/contract — it would fail at startup with MODULE_NOT_FOUND');
  }

  // App Service starts the app with this. Kept in the artifact rather than in a portal
  // setting so it is versioned with the code it starts.
  fs.writeFileSync(
    path.join(outDir, 'startup.sh'),
    [
      '#!/bin/sh',
      '# Generated by scripts/package-hub.js. App Service runs this as the startup command.',
      '# exec, so the hub is PID 1 and receives App Service\'s SIGTERM directly — that is',
      '# what lets src/index.js drain in-flight requests before a slot swap completes.',
      'exec node packages/hub/src/index.js',
      '',
    ].join('\n')
  );

  const { digest, fileCount, symlinks } = digestTree(outDir);
  if (symlinks.length) {
    throw new Error(
      `the artifact still contains ${symlinks.length} symlink(s), which may not survive the deploy zip: ${symlinks.slice(0, 5).join(', ')}`
    );
  }

  const manifest = {
    artifact: 'pivotly-hub',
    version: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/hub/package.json'), 'utf8')).version,
    contractVersion: require('@pivotly/contract/protocol').CONTRACT_VERSION,
    contractDigest: require('@pivotly/contract/digest').contractDigest(),
    commit,
    builtAt,
    artifactDigest: digest,
    fileCount,
    node: process.version,
  };
  fs.writeFileSync(path.join(outDir, 'artifact.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify(manifest, null, 2));
  console.log(`\nok    packaged into ${outDir}`);
}

module.exports = { digestTree, INCLUDE, INCLUDE_SCRIPTS };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  }
}
