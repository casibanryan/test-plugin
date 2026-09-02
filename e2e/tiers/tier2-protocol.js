// e2e/tiers/tier2-protocol.js
// Tier 2 — the protocol tier: does the deployed hub speak correct MCP over the network?
//
// Driven against a real endpoint, as a real client, with a read-only token. The checks
// live in packages/hub/scripts/smoke-remote.js — the same script the deploy job runs
// against the pre-release slot before a swap and against production after one. Running
// the same script in all three places is what makes "it passed in pre-release" and
// "it passed in production" mean the same thing.

'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SMOKE = path.join(__dirname, '..', '..', 'packages', 'hub', 'scripts', 'smoke-remote.js');

const name = 'tier2-protocol';
const describe = 'the deployed MCP endpoint speaks correct MCP and enforces its auth chain';

async function run({ hubUrl, token, channel, expectCommit, check, timeoutMs }) {
  const args = [SMOKE, `--url=${hubUrl}`, `--token=${token}`, `--channel=${channel}`, `--timeout-ms=${timeoutMs}`];
  if (expectCommit) args.push(`--expect-commit=${expectCommit}`);

  try {
    const { stdout } = await execFileAsync(process.execPath, args, { encoding: 'utf8' });
    for (const line of stdout.trimEnd().split('\n')) console.log(`      ${line}`);
    check('the deployed endpoint passes every protocol check', true);
  } catch (err) {
    for (const line of String(err.stdout || '').trimEnd().split('\n')) console.log(`      ${line}`);
    for (const line of String(err.stderr || '').trimEnd().split('\n')) if (line) console.log(`      ${line}`);
    check('the deployed endpoint passes every protocol check', false, 'smoke-remote.js reported failures — see the output above');
  }
}

module.exports = { name, describe, run };
