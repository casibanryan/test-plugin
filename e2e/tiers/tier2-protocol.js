// e2e/tiers/tier2-protocol.js
// Tier 2 — the protocol tier: does a hub endpoint speak correct MCP over the network?
//
// Driven against a real URL, as a real client. The checks live in
// packages/hub/scripts/smoke-remote.js — the same script the deploy jobs run against
// dev, prerelease and production. Running one script everywhere is what makes "it
// passed on prerelease" and "it passed on production" mean the same thing, rather than
// two similar-looking suites that have quietly diverged.

'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SMOKE = path.join(__dirname, '..', '..', 'packages', 'hub', 'scripts', 'smoke-remote.js');

const name = 'tier2-protocol';
const describe = 'the endpoint speaks correct MCP, serves the contract surface, and needs no credential';

async function run({ hubUrl, channel, expectCommit, check, timeoutMs }) {
  const args = [SMOKE, `--url=${hubUrl}`, `--timeout-ms=${timeoutMs}`];
  // Only assert the channel when the caller named one. A locally booted hub reports
  // `local`, and demanding a specific channel there would fail for no reason.
  if (channel) args.push(`--channel=${channel}`);
  if (expectCommit) args.push(`--expect-commit=${expectCommit}`);

  try {
    const { stdout } = await execFileAsync(process.execPath, args, { encoding: 'utf8' });
    // Reprint the script's own output, indented, so a failure is diagnosable from this
    // suite's log without going and running it separately.
    for (const line of stdout.trimEnd().split('\n')) console.log(`      ${line}`);
    check('the endpoint passes every protocol check', true);
  } catch (err) {
    for (const line of String(err.stdout || '').trimEnd().split('\n')) console.log(`      ${line}`);
    for (const line of String(err.stderr || '').trimEnd().split('\n')) if (line) console.log(`      ${line}`);
    check('the endpoint passes every protocol check', false, 'smoke-remote.js reported failures — see the output above');
  }
}

module.exports = { name, describe, run };
