// e2e/tiers/tier3-client.js
// Tier 3 — the client tier, and the reason this suite exists.
//
// Tiers 1 and 2 each check one side of a boundary: the platform API behaves as the hub
// assumes (tier 1), and the deployed hub speaks correct MCP (tier 2). Both can pass
// while the thing that actually breaks for users is still broken, because neither
// looks at the CLIENT.
//
// The failure this tier is built to catch:
//
//   1. someone changes the tool surface in packages/contract
//   2. the hub is rebuilt and deployed — it is internally consistent, so tier 1 and
//      tier 2 both pass
//   3. the Axle channel manifest still pins the OLD contract digest
//   4. nothing fails anywhere in the pipeline
//   5. a user's editor calls a tool whose schema moved, and the error arrives days
//      later and several repositories away from the change that caused it
//
// So this tier compares three things that must agree, and names which pair disagrees:
//
//   the repo       what packages/contract builds right now
//   the hub        what the deployed endpoint reports at /version
//   the client     what packages/clients/axle/channels.json pins for this channel
//
// It then goes further than digests and checks the actual served surface: the tool
// names, and every input field of every tool, as a client token is offered them. A
// digest match with a differing surface would mean the digest is not covering
// something it should, which is worth knowing too.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { compareContract } = require('@pivotly/contract');
const { CONTRACT_VERSION, ENDPOINTS } = require('@pivotly/contract/protocol');
const { contractDigest, contractSurface } = require('@pivotly/contract/digest');
const { CLIENT_TOOL_NAMES, SERVICE_TOOL_NAMES, getTool } = require('@pivotly/contract/tools');
const { authHeaders } = require('@pivotly/contract/auth');

const AXLE_ROOT = path.join(__dirname, '..', '..', 'packages', 'clients', 'axle');

const name = 'tier3-client';
const describe = 'client/channel compatibility: the repo, the deployed hub, and the Axle manifest must agree';

async function run({ hubUrl, token, channel, check, timeoutMs }) {
  const repo = { contractVersion: CONTRACT_VERSION, contractDigest: contractDigest() };

  // --- the client's half ---------------------------------------------------
  const manifestPath = path.join(AXLE_ROOT, 'channels.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const channelName = channel || manifest.default;
  const pinned = (manifest.channels || {})[channelName];

  if (!check(`the Axle manifest declares the "${channelName}" channel`, Boolean(pinned))) return;

  const client = { contractVersion: pinned.contractVersion, contractDigest: pinned.contractDigest };

  // --- the deployed hub's half ---------------------------------------------
  const versionUrl = `${hubUrl.replace(/\/+$/, '')}${ENDPOINTS.version}`;
  let hub = null;
  try {
    const res = await fetch(versionUrl, { signal: AbortSignal.timeout(timeoutMs) });
    check(`GET ${ENDPOINTS.version} answers`, res.ok, `${versionUrl} returned ${res.status}`);
    if (res.ok) hub = await res.json();
  } catch (err) {
    check(`GET ${ENDPOINTS.version} answers`, false, `${versionUrl}: ${err.message}`);
  }
  if (!hub) return;

  // --- the three-way comparison -------------------------------------------
  const repoVsHub = compareContract(repo, hub);
  check(
    'the deployed hub serves the contract this repository builds',
    repoVsHub.verdict === 'ok',
    `${repoVsHub.reason}. The deployed build is from a different contract than this checkout — either the deploy has not finished, or it was built from another commit.`
  );

  const clientVsHub = compareContract(client, hub);
  check(
    `the Axle "${channelName}" pin matches the deployed hub`,
    clientVsHub.verdict === 'ok',
    `${clientVsHub.reason}. THIS IS THE CASCADE: the hub moved and the client manifest did not follow. Run: npm run axle:autopatch -- --sync-pin --channel=${channelName}`
  );

  const clientVsRepo = compareContract(client, repo);
  check(
    `the Axle "${channelName}" pin matches this repository`,
    clientVsRepo.verdict === 'ok',
    `${clientVsRepo.reason}. The tool surface changed in this checkout without resyncing the client manifest.`
  );

  // A differing major is called out separately: it is not a resyncable drift, it means
  // the shipped client cannot talk to that hub at all.
  check(
    'the deployed hub is not a breaking contract major for this client',
    clientVsHub.verdict !== 'breaking',
    `${clientVsHub.reason} — clients on the "${channelName}" channel are broken until they upgrade, not merely out of date`
  );

  // --- the served surface, not just its digest ----------------------------
  const rpc = async (method, params) => {
    const res = await fetch(`${hubUrl.replace(/\/+$/, '')}${ENDPOINTS.mcp}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...authHeaders({ token, channel: channelName, requestId: `tier3-${method}` }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  const list = await rpc('tools/list');
  if (!check('tools/list answers for the client token', list.status === 200 && list.json?.result, `status ${list.status}`)) return;

  const served = list.json.result.tools;
  const servedNames = served.map((t) => t.name).sort();

  check(
    'the deployed hub offers a client token exactly the contract client surface',
    JSON.stringify(servedNames) === JSON.stringify(CLIENT_TOOL_NAMES.slice().sort()),
    `served [${servedNames.join(', ')}], contract declares [${CLIENT_TOOL_NAMES.join(', ')}]`
  );

  const leaked = servedNames.filter((n) => SERVICE_TOOL_NAMES.includes(n));
  check('no service tool is offered to a client token', leaked.length === 0, `leaked: ${leaked.join(', ')}`);

  // Field-level comparison. A digest that matched while a field's type or requiredness
  // differed would mean the digest is not covering what it claims to.
  const surface = contractSurface();
  for (const tool of served) {
    const declared = getTool(tool.name);
    if (!check(`the served tool ${tool.name} is one the contract declares`, Boolean(declared))) continue;

    check(`${tool.name} is served with the contract's description`, tool.description === declared.description, 'the description a model reads has drifted from the contract');

    const declaredFields = Object.keys(declared.input).sort();
    const servedFields = Object.keys(tool.inputSchema?.properties || {}).sort();
    check(
      `${tool.name} is served with exactly the contract's input fields`,
      JSON.stringify(servedFields) === JSON.stringify(declaredFields),
      `served [${servedFields.join(', ')}], contract declares [${declaredFields.join(', ')}]`
    );

    const declaredRequired = Object.entries(declared.input)
      .filter(([, field]) => !field.optional)
      .map(([key]) => key)
      .sort();
    const servedRequired = (tool.inputSchema?.required || []).slice().sort();
    check(
      `${tool.name} agrees with the contract about which inputs are required`,
      JSON.stringify(servedRequired) === JSON.stringify(declaredRequired),
      `served required [${servedRequired.join(', ')}], contract requires [${declaredRequired.join(', ')}]`
    );

    // readOnly is what a client uses to decide whether a tool needs confirmation. A
    // write tool advertised as read-only would get called without one.
    const servedReadOnly = tool.annotations?.readOnlyHint;
    check(`${tool.name} advertises the contract's readOnly hint`, servedReadOnly === declared.readOnly, `served ${servedReadOnly}, contract says ${declared.readOnly}`);

    check(`${tool.name} is a read-only tool, as every client-surface tool must be`, declared.readOnly === true, `${tool.name} is on the client surface but declares readOnly: ${declared.readOnly}`);
  }

  check('the contract surface is internally valid', surface.tools.length > 0);

  console.log(
    `      repo ${repo.contractDigest} | hub ${hub.contractDigest} | client(${channelName}) ${client.contractDigest} | commit ${hub.commit}`
  );
}

module.exports = { name, describe, run };
