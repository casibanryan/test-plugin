#!/usr/bin/env node
// e2e/run.js
// The end-to-end driver.
//
//   node run.js                    every tier
//   node run.js --tiers=1          just the offline contract tier
//
// Two tiers, layered so a failure says WHERE the boundary broke rather than just that
// something is broken:
//
//   tier 1  contract   this checkout is coherent: lock, tool surface, handlers, configs
//   tier 2  protocol   the server speaks correct MCP over a real pipe, as a client
//                      drives it
//
// Tier 1 can pass while users are broken, because it never runs the server. Tier 2
// closes that gap by spawning the copy a client actually launches.
//
// This suite used to run three tiers against a deployed hub, walking the channel
// ladder with --all-channels. The hub is gone (see docs/ARCHITECTURE.md) and every
// channel is served over stdio from this checkout, so there is no endpoint to probe
// and no deployed contract that could disagree with the built one. What that check
// was FOR is now structural: the tool surface is generated from the contract and
// drift-checked, so it cannot lag.

'use strict';

const TIERS = [require('./tiers/tier1-contract'), require('./tiers/tier2-protocol')];

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

async function main() {
  const wanted = (arg('tiers') || '1,2').split(',').map((s) => s.trim());
  const timeoutMs = Number(arg('timeout-ms', '20000'));

  const results = [];
  let currentTier = null;
  const check = (label, condition, detail) => {
    const passed = Boolean(condition);
    results.push({ tier: currentTier, label, passed, detail: passed ? undefined : detail });
    console.log(`${passed ? 'ok   ' : 'FAIL '} ${label}${passed || detail == null ? '' : `\n      ${detail}`}`);
    return passed;
  };

  for (const tier of TIERS) {
    if (!wanted.includes(tier.name.match(/^tier(\d)/)[1])) continue;
    currentTier = tier.name;
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`${tier.name} — ${tier.describe}`);
    console.log('═'.repeat(72));
    try {
      await tier.run({ check, timeoutMs });
    } catch (err) {
      // A tier that throws must not stop the others: knowing tier 2 also failed is
      // often what identifies the cause of a tier 1 failure.
      check(`${tier.name} ran to completion`, false, err.message);
    }
  }

  // --- summary -------------------------------------------------------------
  const failures = results.filter((r) => !r.passed);
  const grouped = {};
  for (const r of results) {
    grouped[r.tier] = grouped[r.tier] || { total: 0, failed: 0 };
    grouped[r.tier].total += 1;
    if (!r.passed) grouped[r.tier].failed += 1;
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('summary');
  console.log('═'.repeat(72));
  for (const [key, stats] of Object.entries(grouped)) {
    console.log(`${stats.failed ? 'FAIL ' : 'ok   '} ${key.padEnd(40)} ${stats.total - stats.failed}/${stats.total} passed`);
  }

  if (failures.length) {
    console.log('');
    for (const f of failures) console.error(`FAIL  [${f.tier}] ${f.label}${f.detail ? `\n        ${f.detail}` : ''}`);
    console.log(`\nFAIL  ${failures.length} of ${results.length} checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nok    all ${results.length} checks passed across ${Object.keys(grouped).length} tier(s)`);
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
