#!/usr/bin/env node
// e2e/run.js
// The multi-tier end-to-end driver.
//
//   node run.js                              boot a local hub and run every tier
//   node run.js --hub-url=https://...         run against a deployed endpoint
//   node run.js --all-channels                run against EVERY reachable channel
//   node run.js --tiers=1                     just the offline tier
//   node run.js --hub-url=... --channel=production --expect-commit=$GITHUB_SHA
//
// Three tiers, layered so a failure says WHERE the boundary broke rather than just
// that something is broken:
//
//   tier 1  contract   this checkout is coherent: lock, tool surface, handlers, configs
//   tier 2  protocol   a hub endpoint speaks correct MCP over the network
//   tier 3  clients    the repo, the deployed hub, and the client configs all agree
//
// Tiers 1 and 2 can both pass while users are broken, because neither looks at what the
// clients shipped with. Tier 3 closes that gap — see the note atop tiers/tier3-clients.js.
//
// With no --hub-url, the driver starts a hub itself on an ephemeral port and runs the
// same tiers against it. That is what makes this runnable on a laptop and in a pull
// request with no deployed environment, using the identical tier code that runs against
// production.
//
// --all-channels is the ladder check: it walks every channel in the client manifest and
// runs the network tiers against each one that answers, skipping the rest with a note.
// One command then tells you the state of local, dev, prerelease and production —
// including whether any of them has drifted from what the clients were built against.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CHANNELS, transportOf } = require('@pivotly/contract/protocol');

const TIERS = [require('./tiers/tier1-contract'), require('./tiers/tier2-protocol'), require('./tiers/tier3-clients')];

const CHANNELS_PATH = path.join(__dirname, '..', 'packages', 'clients', 'channels.json');

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

async function startLocalHub() {
  // Required lazily so a deployed-endpoint run does not need the hub package present.
  const { buildRuntime, serveHttp } = require('@pivotly/hub/src/index');
  const runtime = buildRuntime({ HUB_CHANNEL: 'local', HUB_LOG_LEVEL: 'error', PORT: '0' });
  const server = await serveHttp(runtime);
  return {
    hubUrl: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Is this endpoint answering at all? Used by --all-channels so an undeployed channel is
// reported as skipped rather than failing the run.
async function reachable(hubUrl, timeoutMs) {
  try {
    const res = await fetch(`${hubUrl.replace(/\/+$/, '')}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const wanted = (arg('tiers') || '1,2,3').split(',').map((s) => s.trim());
  const timeoutMs = Number(arg('timeout-ms', '20000'));
  const expectCommit = arg('expect-commit');
  const allChannels = flag('all-channels');

  const results = [];
  let currentTier = null;
  let currentTarget = null;
  const check = (label, condition, detail) => {
    const passed = Boolean(condition);
    results.push({ tier: currentTier, target: currentTarget, label, passed, detail: passed ? undefined : detail });
    console.log(`${passed ? 'ok   ' : 'FAIL '} ${label}${passed || detail == null ? '' : `\n      ${detail}`}`);
    return passed;
  };

  // Build the list of targets to run the network tiers against.
  const targets = [];
  let local = null;

  if (allChannels) {
    const manifest = JSON.parse(fs.readFileSync(CHANNELS_PATH, 'utf8'));
    for (const name of CHANNELS) {
      const channel = manifest.channels[name];
      if (!channel) continue;
      // Tiers 2 and 3 drive an HTTP endpoint. A stdio channel has none — it is covered
      // by the bundled-server tests instead, so skipping it here is correct rather
      // than a gap.
      if (transportOf(name) === 'stdio') {
        console.log(`skip  channel "${name}" is served over stdio, which tiers 2 and 3 cannot drive`);
        continue;
      }
      // The channel URL includes the MCP path; the tiers want the origin.
      const origin = new URL(channel.url).origin;
      targets.push({ label: name, hubUrl: origin, channel: name });
    }
  } else {
    const hubUrl = arg('hub-url') || process.env.HUB_URL;
    if (hubUrl) {
      targets.push({ label: arg('channel') || 'target', hubUrl, channel: arg('channel') || null });
    } else {
      console.log('no --hub-url given — starting a local hub\n');
      local = await startLocalHub();
      // No channel asserted: a locally started hub reports `local`, and demanding a
      // specific channel here would fail for no reason.
      targets.push({ label: 'local (started here)', hubUrl: local.hubUrl, channel: null });
    }
  }

  try {
    // --- tier 1 runs once: it is about the checkout, not about an endpoint ---
    const tier1 = TIERS[0];
    if (wanted.includes('1')) {
      currentTier = tier1.name;
      currentTarget = 'checkout';
      console.log(`\n${'═'.repeat(72)}`);
      console.log(`${tier1.name} — ${tier1.describe}`);
      console.log('═'.repeat(72));
      try {
        await tier1.run({ check, timeoutMs });
      } catch (err) {
        check(`${tier1.name} ran to completion`, false, err.message);
      }
    }

    // --- the network tiers run per target ---------------------------------
    const networkTiers = TIERS.slice(1).filter((t) => wanted.includes(t.name.match(/^tier(\d)/)[1]));

    for (const target of targets) {
      if (!networkTiers.length) break;

      if (allChannels) {
        const up = await reachable(target.hubUrl, Math.min(timeoutMs, 5000));
        console.log(`\n${'─'.repeat(72)}`);
        if (!up) {
          // Not a failure: an undeployed channel is a fact about the ladder, not a bug.
          console.log(`skip  ${target.label} — ${target.hubUrl} is not reachable`);
          continue;
        }
        console.log(`channel ${target.label} — ${target.hubUrl}`);
        console.log('─'.repeat(72));
      }

      for (const tier of networkTiers) {
        currentTier = tier.name;
        currentTarget = target.label;
        console.log(`\n${'═'.repeat(72)}`);
        console.log(`${tier.name} [${target.label}] — ${tier.describe}`);
        console.log('═'.repeat(72));
        try {
          await tier.run({ hubUrl: target.hubUrl, channel: target.channel, expectCommit, check, timeoutMs });
        } catch (err) {
          // A tier that throws must not stop the others: knowing tier 3 also failed is
          // often what identifies the cause of a tier 2 failure.
          check(`${tier.name} ran to completion`, false, err.message);
        }
      }
    }
  } finally {
    if (local) await local.stop();
  }

  // --- summary -------------------------------------------------------------
  const failures = results.filter((r) => !r.passed);
  const grouped = {};
  for (const r of results) {
    const key = `${r.tier} [${r.target}]`;
    grouped[key] = grouped[key] || { total: 0, failed: 0 };
    grouped[key].total += 1;
    if (!r.passed) grouped[key].failed += 1;
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('summary');
  console.log('═'.repeat(72));
  for (const [key, stats] of Object.entries(grouped)) {
    console.log(`${stats.failed ? 'FAIL ' : 'ok   '} ${key.padEnd(40)} ${stats.total - stats.failed}/${stats.total} passed`);
  }

  if (failures.length) {
    console.log('');
    for (const f of failures) console.error(`FAIL  [${f.tier} / ${f.target}] ${f.label}${f.detail ? `\n        ${f.detail}` : ''}`);
    console.log(`\nFAIL  ${failures.length} of ${results.length} checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nok    all ${results.length} checks passed across ${Object.keys(grouped).length} tier/target combinations`);
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
