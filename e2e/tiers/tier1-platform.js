// e2e/tiers/tier1-platform.js
// Tier 1 — the platform tier: does the API the hub depends on behave as assumed?
//
// This is the tier that used to be "check the database". The hub owns no schema, so
// there is nothing of its own to inspect — but it does rely on a set of API behaviours
// (identity resolution, a client credential being refused on every write, 404 for a
// missing record, an empty queue answering 200), and each of those is a place where a
// platform-side change breaks clients without a line of hub code changing.
//
// The checks themselves live in packages/hub/scripts/verify-upstream.js, which is also
// what the deploy job runs directly. This tier drives that same script rather than
// reimplementing it: two copies of "what the hub assumes" would drift, and the copy
// that drifted would be the one nobody ran.

'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const VERIFIER = path.join(__dirname, '..', '..', 'packages', 'hub', 'scripts', 'verify-upstream.js');

const name = 'tier1-platform';
const describe = 'the platform API behaves the way the hub assumes it does';

async function run({ apiUrl, token, serviceToken, check, timeoutMs }) {
  if (!apiUrl) {
    check('a platform API url was provided', false, 'pass --api-url= (or set PIVOTLY_API_URL) to run tier 1');
    return;
  }
  if (!serviceToken) {
    check('a service token was provided', false, 'pass --service-token= (or set VERIFY_SERVICE_TOKEN) to run tier 1');
    return;
  }

  const args = [VERIFIER, `--url=${apiUrl}`, `--client-token=${token}`, `--service-token=${serviceToken}`, `--timeout-ms=${timeoutMs}`];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { encoding: 'utf8' });
    // Reprint the verifier's own output, indented, so a failure is diagnosable from
    // this suite's log without going and running it separately.
    for (const line of stdout.trimEnd().split('\n')) console.log(`      ${line}`);
    check('every upstream assumption holds', true);
  } catch (err) {
    for (const line of String(err.stdout || '').trimEnd().split('\n')) console.log(`      ${line}`);
    for (const line of String(err.stderr || '').trimEnd().split('\n')) if (line) console.log(`      ${line}`);
    check('every upstream assumption holds', false, 'verify-upstream.js reported failures — see the output above');
  }
}

module.exports = { name, describe, run };
