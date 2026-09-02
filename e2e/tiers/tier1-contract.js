// e2e/tiers/tier1-contract.js
// Tier 1 — the build tier: is THIS checkout internally coherent?
//
// Runs with no network and no running hub, and it runs first because everything above
// it derives from the contract. If the lock and the source disagree, or a declared tool
// has no handler, a green protocol tier only tells you that a wrong build is being
// served correctly.
//
// This replaced a tier that checked an upstream platform API. The hub no longer has
// one — it serves two pure functions — so the thing worth verifying at the bottom of
// the stack is the build itself.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TOOL_NAMES } = require('@pivotly/contract/tools');
const { CONTRACT_VERSION, CLIENTS, CHANNELS } = require('@pivotly/contract/protocol');
const { contractDigest, lockBody, contractSurface } = require('@pivotly/contract/digest');
const { assertHandlersMatchContract } = require('@pivotly/hub/src/mcp');
const { renderAll } = require('@pivotly/clients/scripts/generate');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CLIENTS_ROOT = path.join(REPO_ROOT, 'packages', 'clients');

const name = 'tier1-contract';
const describe = 'this checkout is coherent: lock, tool surface, handlers, and client configs';

async function run({ check }) {
  // The lock must match the source — the first line of the cascade guard. A tool
  // surface cannot change without a reviewed lock diff.
  const lockPath = path.join(REPO_ROOT, 'packages', 'contract', 'contract.lock.json');
  const onDisk = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
  check('contract.lock.json exists', Boolean(onDisk), 'run: npm run contract:digest -- --write');
  check('contract.lock.json matches the source', onDisk === `${JSON.stringify(lockBody(), null, 2)}\n`, 'run: npm run contract:digest -- --write');

  // Building the surface validates every descriptor, so this both throws on a bad one
  // and confirms the digest is computable at all.
  let surface = null;
  try {
    surface = contractSurface();
    check('the contract surface is valid', true);
  } catch (err) {
    check('the contract surface is valid', false, err.message);
  }
  check('the digest is a 12-hex string', /^[0-9a-f]{12}$/.test(contractDigest()), contractDigest());

  if (surface) {
    // Every tool must be read-only, because the hub serves them anonymously. This is
    // the invariant that stands in for authentication.
    for (const tool of surface.tools) {
      check(`${tool.name} is read-only`, tool.readOnly === true, 'a writable tool cannot be served without authentication');
    }
  }

  // The hub's handler registry must cover exactly the declared tools. Importing the
  // hub's own assertion rather than reimplementing it means this tier cannot disagree
  // with what the hub does at boot.
  try {
    const { tools } = assertHandlersMatchContract();
    check('the hub implements exactly the declared tool set', tools === TOOL_NAMES.length, `${tools} handlers vs ${TOOL_NAMES.length} declared tools`);
  } catch (err) {
    check('the hub implements exactly the declared tool set', false, err.message);
  }

  // Every channel must be pinned to what this checkout builds — all of them, not just
  // the default, because a partial resync is otherwise invisible until that channel is
  // deployed.
  const manifest = JSON.parse(fs.readFileSync(path.join(CLIENTS_ROOT, 'channels.json'), 'utf8'));
  check(`channels.json declares all ${CHANNELS.length} contract channels`, Object.keys(manifest.channels).length === CHANNELS.length);

  for (const channelName of CHANNELS) {
    const channel = manifest.channels[channelName];
    if (!check(`channel "${channelName}" is declared`, Boolean(channel))) continue;
    check(
      `channel "${channelName}" pins this checkout's contract`,
      channel.contractDigest === contractDigest(),
      `pinned ${channel.contractDigest}, built ${contractDigest()}`
    );
    check(`channel "${channelName}" pins this checkout's version`, channel.contractVersion === CONTRACT_VERSION, `pinned ${channel.contractVersion}, built ${CONTRACT_VERSION}`);
  }

  // Every declared client must render, and what renders must be what is committed.
  const defaultChannel = { name: manifest.default, ...manifest.channels[manifest.default] };
  const rendered = renderAll(defaultChannel);
  check(`all ${CLIENTS.length} declared clients render`, rendered.length === CLIENTS.length, `${rendered.length} rendered`);
  for (const r of rendered) {
    const committed = fs.existsSync(r.file) ? fs.readFileSync(r.file, 'utf8') : null;
    check(`${r.relative} is committed exactly as generated`, committed === r.content, 'run: npm run clients:generate');
  }

  console.log(`      contract ${CONTRACT_VERSION} (${contractDigest()}) | ${TOOL_NAMES.length} tools | ${CLIENTS.length} clients | ${CHANNELS.length} channels`);
}

module.exports = { name, describe, run };
