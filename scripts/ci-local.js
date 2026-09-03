#!/usr/bin/env node
// scripts/ci-local.js
// Runs the same steps .github/workflows/_verify.yml runs, on this machine.
//
//   node scripts/ci-local.js                 every job
//   node scripts/ci-local.js --job=client    one job
//   node scripts/ci-local.js --skip=artifact skip the slow one (it runs `npm ci`)
//   node scripts/ci-local.js --list          show what would run
//
// Why this exists: the CD pipeline needs Azure resources and a push before any of it
// can execute, which is a long feedback loop for finding out that a shell step has a
// typo. Everything in `_verify.yml` is deliberately a plain npm script or a couple of
// lines of node, so all of it can run here first.
//
// What this does NOT prove, and cannot:
//   * that the workflow YAML is wired correctly (job needs, matrix, artifact upload)
//   * anything about Azure — the deploy, the slot swap, or the App Settings
//   * that a DEPLOYED channel is healthy. The e2e job runs against a hub this process
//     started, so it proves the code; only `npm run e2e -- --hub-url=...` against a
//     real channel proves the deployment.
//
// The job names below mirror the workflow's job names exactly, so a failure here tells
// you which CI job would have gone red.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

// `npm` on Windows is a .cmd, which needs a shell; everything else is spawned directly
// so no argument ever passes through shell quoting.
function run(command, args, options = {}) {
  const needsShell = IS_WINDOWS && (command === 'npm' || command === 'npx');
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: 'utf8',
    shell: needsShell,
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    out: `${result.stdout || ''}${result.stderr || ''}`,
    error: result.error,
  };
}

// ---------------------------------------------------------------------------
// The jobs, mirroring _verify.yml step for step.
// ---------------------------------------------------------------------------
const JOBS = [
  {
    name: 'contract',
    describe: 'the contract lock matches the source, and every version agrees',
    steps: [
      { label: 'The contract lock matches the source', run: () => run('npm', ['run', 'contract:verify']) },
      { label: 'Every version in the repo agrees', run: () => run('npm', ['run', 'versions:verify']) },
      { label: 'Contract self-tests', run: () => run('npm', ['run', 'test:contract']) },
    ],
  },
  {
    name: 'unit',
    describe: 'all workspace tests, plus the hub self-test',
    steps: [
      { label: 'All workspace tests', run: () => run('npm', ['test']) },
      { label: 'The hub self-test reports a coherent build', run: () => run('npm', ['run', 'hub:selftest']) },
    ],
  },
  {
    name: 'client',
    describe: 'every client config, channel pins, skills, and a simulated marketplace install',
    steps: [
      {
        label: 'Manifests validate against the plugin schema',
        run: () => run('npx', ['--yes', '@anthropic-ai/claude-code', 'plugin', 'validate', './packages/clients/axle']),
      },
      { label: 'Client configs, channel pins, and skills', run: () => run('npm', ['run', 'clients:verify']) },
      { label: 'Every client config matches the channel manifest', run: () => run('npm', ['run', 'clients:check', '--', '--timeout-ms=3000']) },
      { label: 'A marketplace install would get a working plugin', run: simulateMarketplaceInstall },
    ],
  },
  {
    name: 'artifact',
    slow: true,
    describe: 'dependency scan, package the artifact, and boot it from the packaged tree',
    steps: [
      {
        label: 'Vulnerability scan of the production dependency tree',
        run: () => run('npm', ['audit', '--omit=dev', '--audit-level=high', '--workspace', '@pivotly/hub', '--include-workspace-root']),
      },
      { label: 'Build the artifact', run: buildArtifact },
      { label: 'Only the hub is in the artifact', run: assertArtifactIsClean },
      { label: 'The artifact boots and self-tests', run: selftestArtifact },
    ],
  },
  {
    name: 'e2e-local',
    describe: 'contract, protocol and client tiers against a hub it boots itself',
    steps: [{ label: 'All three tiers against a local hub', run: () => run('npm', ['run', 'e2e']) }],
  },
];

// The artifact is built outside the repo. On Windows a synced folder (OneDrive) holds
// locks on files inside dist/, and the rebuild then fails on EBUSY for reasons that
// have nothing to do with the code.
const ARTIFACT_DIR = path.join(os.tmpdir(), 'pivotly-ci-local-artifact');

function buildArtifact() {
  fs.rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  return run('node', ['scripts/package-hub.js', `--out=${ARTIFACT_DIR}`], { env: { BUILD_COMMIT: 'ci-local' } });
}

function assertArtifactIsClean() {
  const forbidden = [
    ['packages/hub/test', 'hub tests'],
    ['packages/hub/testkit', 'the test harness'],
    ['packages/clients', 'the clients package'],
    ['e2e', 'the e2e suite'],
  ];
  const found = forbidden.filter(([rel]) => fs.existsSync(path.join(ARTIFACT_DIR, rel)));
  if (found.length) {
    return { code: 1, out: found.map(([rel, what]) => `FAIL  ${what} was packaged into the artifact (${rel})`).join('\n') };
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, 'artifact.json'), 'utf8'));
  return { code: 0, out: `ok    artifact ${manifest.artifactDigest}, ${manifest.fileCount} files, contract ${manifest.contractDigest}` };
}

function selftestArtifact() {
  // No API reachable, on purpose: --selftest must work inside a fresh deploy before
  // anything has been wired up.
  // Needs no configuration at all: --selftest must work inside a fresh deploy before
  // anything has been wired up.
  const result = run('node', ['packages/hub/src/index.js', '--selftest'], { cwd: ARTIFACT_DIR });
  if (result.code !== 0) return result;

  const selftest = JSON.parse(result.out);
  const manifest = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, 'artifact.json'), 'utf8'));
  if (!selftest.ok) return { code: 1, out: 'FAIL  the artifact self-test reported not ok' };
  if (selftest.contractDigest !== manifest.contractDigest) {
    return { code: 1, out: `FAIL  the running code (${selftest.contractDigest}) and the artifact manifest (${manifest.contractDigest}) disagree about the contract` };
  }
  return { code: 0, out: `ok    the packaged tree boots and serves contract ${selftest.contractDigest}` };
}

// Reproduces what a marketplace install copies: the repo as-is, no npm install, no
// build step. The point is that the plugin's own files have to stand on their own.
function simulateMarketplaceInstall() {
  const dir = path.join(os.tmpdir(), 'pivotly-ci-local-install');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // CI archives HEAD, because there the commit under test IS HEAD. Locally the work
  // being checked is usually still staged, and archiving HEAD would export the
  // PREVIOUS commit — passing or failing on code that is not the code in front of you.
  // `git write-tree` turns the current index into a tree object, which is exactly what
  // a commit would contain.
  const tree = run('git', ['write-tree']);
  if (tree.code !== 0) return { code: 1, out: `FAIL  could not read the index\n${tree.out}` };
  const treeish = tree.out.trim().split('\n').pop().trim();

  const archived = run('git', ['archive', '-o', path.join(dir, 'export.tar'), treeish]);
  if (archived.code !== 0) return { code: 1, out: `FAIL  git archive failed\n${archived.out}` };

  // Extracted with cwd set, rather than passing an absolute path to `tar -C`: Windows
  // bsdtar reads the drive letter in "C:\..." as a remote host spec and fails with
  // "Cannot connect to C: resolve failed".
  const extracted = run('tar', ['-xf', 'export.tar'], { cwd: dir });
  if (extracted.code !== 0) return { code: 1, out: `FAIL  could not extract the export\n${extracted.out}` };

  const pluginDir = path.join(dir, 'packages', 'clients', 'axle');
  const problems = [];
  // The same list _verify.yml checks. The hooks are in it because the version notice
  // is the only thing that tells a user their plugin moved, and a hook file left out
  // of the export fails silently — the plugin installs, and simply never speaks.
  for (const rel of ['.claude-plugin/plugin.json', '.mcp.json', 'skills', 'hooks/hooks.json', 'hooks/version-notice.js']) {
    if (!fs.existsSync(path.join(pluginDir, rel))) problems.push(`${rel} is missing from a clean export`);
  }

  if (!problems.length) {
    const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8'));
    const server = Object.values(mcp.mcpServers)[0];
    if (server.type !== 'http') problems.push(`the shipped server is "${server.type}", not http`);
    if (!/^https:\/\//.test(server.url)) problems.push(`the shipped url is not https: ${server.url}`);

    // The hub is anonymous, so a shipped config must carry NO credential at all —
    // neither a literal one nor a placeholder implying the user should find one.
    const raw = fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8');
    if (/authorization/i.test(raw)) problems.push('the shipped config declares an Authorization header, but the hub is anonymous');
    const suspicious = raw.match(/\b[A-Za-z0-9_-]{32,}\b/g) || [];
    if (suspicious.length) problems.push(`the shipped config contains something token-shaped: ${suspicious.slice(0, 2).join(', ')}`);

    if (!problems.length) return { code: 0, out: `ok    a clean install points at ${server.url}, with no credential` };
  }

  return { code: 1, out: problems.map((p) => `FAIL  ${p}`).join('\n') };
}

// ---------------------------------------------------------------------------
function main() {
  const only = arg('job');
  const skip = (arg('skip') || '').split(',').filter(Boolean);
  const selected = JOBS.filter((j) => (only ? j.name === only : true)).filter((j) => !skip.includes(j.name));

  if (flag('list')) {
    for (const job of JOBS) console.log(`${job.name.padEnd(12)} ${job.describe}${job.slow ? '  (slow)' : ''}`);
    return;
  }
  if (!selected.length) {
    console.error(`FAIL  no jobs selected. Known: ${JOBS.map((j) => j.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log('Running the same steps as .github/workflows/_verify.yml\n');
  const summary = [];

  for (const job of selected) {
    console.log(`${'═'.repeat(72)}`);
    console.log(`${job.name} — ${job.describe}`);
    console.log('═'.repeat(72));

    let failed = 0;
    const started = Date.now();

    for (const step of job.steps) {
      const stepStarted = Date.now();
      let result;
      try {
        result = step.run();
      } catch (err) {
        result = { code: 1, out: err.stack || err.message };
      }
      const seconds = ((Date.now() - stepStarted) / 1000).toFixed(1);

      if (result.code === 0) {
        console.log(`ok    ${step.label}  (${seconds}s)`);
        // The last meaningful line is usually the check's own summary; showing it
        // keeps the output readable without hiding what was actually asserted.
        const tail = result.out.trim().split('\n').filter((l) => l.trim()).pop();
        if (tail) console.log(`        ${tail.trim()}`);
      } else {
        failed += 1;
        console.log(`FAIL  ${step.label}  (${seconds}s)`);
        for (const line of result.out.trim().split('\n').slice(-25)) console.log(`        ${line}`);
      }
    }

    summary.push({ job: job.name, failed, steps: job.steps.length, seconds: ((Date.now() - started) / 1000).toFixed(1) });
    console.log('');
  }

  console.log('═'.repeat(72));
  console.log('summary');
  console.log('═'.repeat(72));
  for (const s of summary) {
    console.log(`${s.failed ? 'FAIL ' : 'ok   '} ${s.job.padEnd(12)} ${s.steps - s.failed}/${s.steps} steps  (${s.seconds}s)`);
  }

  const broken = summary.filter((s) => s.failed);
  console.log('');
  if (broken.length) {
    console.log(`FAIL  ${broken.length} job(s) would be red in CI: ${broken.map((s) => s.job).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('ok    every offline CI job passes on this machine');
    console.log('note  this proves the STEPS, not the workflow wiring, and nothing about Azure.');
    console.log('      The e2e job ran against a hub this process started. To check a deployed');
    console.log('      channel:  npm run e2e -- --hub-url=<channel url> --channel=<name>');
  }
}

if (require.main === module) main();

module.exports = { JOBS };
