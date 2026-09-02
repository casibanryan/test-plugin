#!/usr/bin/env node
// e2e/run.js
// The multi-tier end-to-end driver.
//
//   node run.js                                  boot a local stack and run every tier
//   node run.js --hub-url=https://... --api-url=https://...
//                                                run against deployed endpoints
//   node run.js --tiers=2,3                      run a subset
//   node run.js --hub-url=... --expect-commit=$GITHUB_SHA
//
// Three tiers, deliberately layered so a failure says WHERE the boundary broke rather
// than just that something is broken:
//
//   tier 1  platform   the API the hub depends on behaves as assumed
//   tier 2  protocol   the deployed hub speaks correct MCP and enforces its auth chain
//   tier 3  client     the repo, the deployed hub, and the Axle channel manifest all
//                      agree about the tool surface
//
// Tiers 1 and 2 can both pass while users are broken, because neither looks at the
// client. Tier 3 is what closes that gap — see the note at the top of
// tiers/tier3-client.js.
//
// With no --hub-url, the driver stands up the whole stack locally (fake platform API +
// hub, both on ephemeral ports) and runs the same tiers against it. That is what makes
// this runnable on a laptop and in a pull request with no deployed environment, using
// the identical tier code that runs against production.

'use strict';

const path = require('node:path');

const TIERS = [require('./tiers/tier1-platform'), require('./tiers/tier2-protocol'), require('./tiers/tier3-client')];

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

async function startLocalStack() {
  // Required lazily: running against deployed endpoints must not need the hub's test
  // double to be present at all.
  const { createFakePlatformApi } = require('@pivotly/hub/scripts/fake-platform-api');
  const { buildRuntime, serveHttp } = require('@pivotly/hub/src/index');

  const api = createFakePlatformApi();
  const apiUrl = await api.listen(0);
  // Something for tier 1's queue checks to find. An empty queue is a valid answer, but
  // it leaves the claimed-job response shape unexercised.
  api.seed.job('t-dev', 'e2e.local', { seeded: true });

  const runtime = buildRuntime({ HUB_CHANNEL: 'local', HUB_LOG_LEVEL: 'error', PIVOTLY_API_URL: apiUrl, PORT: '0' });
  const server = await serveHttp(runtime);
  const hubUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    hubUrl,
    apiUrl,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      await api.close();
    },
  };
}

async function main() {
  const wanted = (arg('tiers') || '1,2,3').split(',').map((s) => s.trim());
  const timeoutMs = Number(arg('timeout-ms', '20000'));
  const expectCommit = arg('expect-commit');
  const channel = arg('channel') || process.env.PIVOTLY_CHANNEL || 'local';

  let hubUrl = arg('hub-url') || process.env.HUB_URL;
  let apiUrl = arg('api-url') || process.env.PIVOTLY_API_URL;
  let token = arg('token') || process.env.SMOKE_TOKEN;
  let serviceToken = arg('service-token') || process.env.VERIFY_SERVICE_TOKEN;

  let local = null;
  if (!hubUrl) {
    console.log('no --hub-url given — booting a local stack (fake platform API + hub)\n');
    local = await startLocalStack();
    hubUrl = local.hubUrl;
    apiUrl = apiUrl || local.apiUrl;
    // The fake API's fixture tokens. Only used for the local stack; a deployed run must
    // supply real ones.
    token = token || 'smoke-token';
    serviceToken = serviceToken || 'worker-token';
  }

  if (!token) {
    console.error('FAIL  pass --token= (or set SMOKE_TOKEN) — a READ-ONLY client token');
    process.exit(1);
  }

  const results = [];
  let currentTier = null;
  const check = (label, condition, detail) => {
    const passed = Boolean(condition);
    results.push({ tier: currentTier, label, passed, detail: passed ? undefined : detail });
    console.log(`${passed ? 'ok   ' : 'FAIL '} ${label}${passed || detail == null ? '' : `\n      ${detail}`}`);
    return passed;
  };

  try {
    for (const tier of TIERS) {
      const number = tier.name.match(/^tier(\d)/)[1];
      if (!wanted.includes(number)) continue;

      currentTier = tier.name;
      console.log(`\n${'═'.repeat(72)}`);
      console.log(`${tier.name} — ${tier.describe}`);
      console.log('═'.repeat(72));

      try {
        await tier.run({ hubUrl, apiUrl, token, serviceToken, channel, expectCommit, check, timeoutMs });
      } catch (err) {
        // A tier that throws must not stop the others: knowing that tier 3 also fails
        // is often what identifies the cause of a tier 2 failure.
        check(`${tier.name} ran to completion`, false, `${err.message}`);
      }
    }
  } finally {
    if (local) await local.stop();
  }

  // --- summary -------------------------------------------------------------
  const failures = results.filter((r) => !r.passed);
  const byTier = {};
  for (const r of results) {
    byTier[r.tier] = byTier[r.tier] || { total: 0, failed: 0 };
    byTier[r.tier].total += 1;
    if (!r.passed) byTier[r.tier].failed += 1;
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`summary — ${hubUrl}${local ? ' (local stack)' : ''}`);
  console.log('═'.repeat(72));
  for (const [tier, stats] of Object.entries(byTier)) {
    console.log(`${stats.failed ? 'FAIL ' : 'ok   '} ${tier.padEnd(16)} ${stats.total - stats.failed}/${stats.total} passed`);
  }

  if (failures.length) {
    console.log('');
    for (const f of failures) console.error(`FAIL  [${f.tier}] ${f.label}${f.detail ? `\n        ${f.detail}` : ''}`);
    console.log(`\nFAIL  ${failures.length} of ${results.length} checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nok    all ${results.length} checks passed across ${Object.keys(byTier).length} tiers`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FAIL  ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main, TIERS };
