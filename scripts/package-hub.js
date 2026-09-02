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
// Deliberately NOT included: devDependencies, tests, the test harness, the client
// package, and docs. The deployed artifact is the hub and its contract, nothing else.

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

// The smoke test travels with the artifact, because the pipeline runs it from inside:
// the thing being tested and the thing doing the testing are then the same build.
const INCLUDE_SCRIPTS = ['smoke-remote.js'];

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

// A content-addressed identity for the artifact: every file's path and sha256, hashed
// in sorted order.
//
// Its job is same-run identity — proving the tree that was scanned and self-tested is
// the tree that gets deployed. It is NOT a reproducible-build guarantee across
// machines: a Windows checkout has CRLF where a Linux one has LF, so the same commit
// legitimately digests differently on a dev box and on a CI runner. Comparing digests
// across environments would be reading it for something it does not claim.
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
    // Reported as "path -> target": knowing where a stray link pointed is what tells
    // you which install step produced it.
    symlinks: entries.filter((e) => e.link).map((e) => `${e.rel} -> ${e.link}`),
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
  //
  // --no-bin-links is what stops npm creating node_modules/.bin/* CLI shims. On Linux
  // those are symlinks; on Windows they are .cmd files, which is why their absence is
  // invisible on a Windows dev machine and shows up on a CI runner. The artifact never
  // invokes a bin shim — startup.sh runs `node packages/hub/src/index.js` directly, and
  // the packaged scripts are run the same way — so there is nothing to lose by not
  // creating them, and one whole class of symlink stops existing.
  //
  // Scoped to this install deliberately, rather than put in a repo .npmrc: the dev
  // install DOES want .bin (npx, local tooling), and a repo-wide setting would break
  // that to fix a packaging concern.
  execFileSync('npm', ['ci', '--omit=dev', '--no-bin-links', '--workspace', '@pivotly/hub', '--include-workspace-root'], {
    cwd: outDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  // npm still links every workspace PACKAGE into node_modules as a symlink; that is
  // unaffected by --no-bin-links. Those resolve fine here, but the artifact is zipped
  // and unpacked on App Service, and symlink handling through a zip is not something to
  // rely on — a broken link surfaces as MODULE_NOT_FOUND at startup, on the deployed
  // instance, with no local reproduction.
  //
  // So this walks the whole artifact rather than just node_modules/@pivotly. The
  // narrower version of this loop passed on Windows and failed on Linux, because it
  // only knew about the symlinks it had been told to expect. Anything link-shaped is
  // resolved here, whatever produced it.
  let dereferenced = 0;
  let removed = 0;

  const resolveLinks = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = fs.realpathSync(full);
        } catch {
          // Dangling already; it would have been a startup failure there.
          fs.rmSync(full, { force: true });
          removed += 1;
          continue;
        }
        fs.rmSync(full, { recursive: true, force: true });
        copyRecursive(target, full);
        dereferenced += 1;
        continue;
      }

      if (entry.isDirectory()) resolveLinks(full);
    }
  };

  resolveLinks(outDir);
  if (dereferenced || removed) {
    console.log(`ok    resolved ${dereferenced} symlink(s) into real files${removed ? `, removed ${removed} dangling` : ''}`);
  }

  const contractEntry = path.join(outDir, 'node_modules', '@pivotly', 'contract', 'package.json');
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
