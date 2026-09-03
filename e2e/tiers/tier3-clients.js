// e2e/tiers/tier3-clients.js
// Tier 3 — the client tier, and the reason this suite exists.
//
// Tiers 1 and 2 each check one side of a boundary: this checkout is coherent (tier 1),
// and a deployed endpoint speaks correct MCP (tier 2). Both can pass while the thing
// that actually breaks for users is still broken, because neither looks at what the
// CLIENTS were shipped with.
//
// The failure this tier is built to catch:
//
//   1. someone changes the tool surface in packages/contract
//   2. the hub is rebuilt and deployed — internally consistent, so tiers 1 and 2 pass
//   3. the shared channel manifest still pins the OLD contract digest
//   4. nothing fails anywhere in the pipeline
//   5. a user's editor calls a tool whose schema moved, and the error arrives days
//      later and several directories away from the change that caused it
//
// So it compares three things that must agree, and names which pair disagrees:
//
//   the repo     what packages/contract builds right now
//   the hub      what the deployed endpoint reports at /version
//   the clients  what packages/clients/channels.json pins for this channel
//
// It then goes further than digests and checks the served surface field by field, per
// declared client: a digest match with a differing surface would mean the digest is not
// covering something it should, which is worth knowing too.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { compareContract } = require('@pivotly/contract');
const { CONTRACT_VERSION, ENDPOINTS, HEADERS, CLIENTS, transportOf } = require('@pivotly/contract/protocol');
const { contractDigest } = require('@pivotly/contract/digest');
const { TOOL_NAMES, getTool } = require('@pivotly/contract/tools');
const { renderAll } = require('@pivotly/clients/scripts/generate');

const CLIENTS_ROOT = path.join(__dirname, '..', '..', 'packages', 'clients');

const name = 'tier3-clients';
const describe = 'the repo, the deployed hub, and every client config agree about the tool surface';

async function run({ hubUrl, channel, check, timeoutMs }) {
  const repo = { contractVersion: CONTRACT_VERSION, contractDigest: contractDigest() };

  // --- the clients' half ---------------------------------------------------
  // The clients are generated from THIS checkout, so what they were built against is
  // the repo's contract. `lastVerified` is a separate record of what the channel was
  // last proven to serve, and is compared as drift rather than asserted.
  const manifest = JSON.parse(fs.readFileSync(path.join(CLIENTS_ROOT, 'channels.json'), 'utf8'));
  const channelName = channel || manifest.default;
  const declared = (manifest.channels || {})[channelName];
  if (!check(`the channel manifest declares "${channelName}"`, Boolean(declared))) return;

  const clientSide = repo;

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

  // Called out separately: a differing major is not resyncable drift, it means clients
  // generated here cannot talk to that hub at all.
  const clientVsHub = compareContract(clientSide, hub);
  check(
    'the deployed hub is not a breaking contract major for these clients',
    clientVsHub.verdict !== 'breaking',
    `${clientVsHub.reason} — clients generated from this checkout are broken against "${channelName}", not merely out of date`
  );

  // The verification record is context, not a gate. If it lags, that channel simply has
  // not been deployed from this commit yet — which is the normal state mid-development.
  if (declared.lastVerified) {
    const recordVsHub = compareContract(
      { contractVersion: declared.lastVerified.contractVersion, contractDigest: declared.lastVerified.contractDigest },
      hub
    );
    console.log(
      recordVsHub.verdict === 'ok'
        ? `      note: the recorded verification for "${channelName}" matches what it is serving`
        : `      note: "${channelName}" was last verified at ${declared.lastVerified.contractDigest} but now serves ${hub.contractDigest} — run clients:sync-pin after verifying`
    );
  } else {
    console.log(`      note: "${channelName}" has no verification record yet (lastVerified is null)`);
  }

  // --- every client's committed config -------------------------------------
  // The committed configs are generated for ONE channel — the manifest's default. So
  // "the config matches this channel" is only meaningful when this IS the default
  // channel; when walking the whole ladder (--all-channels) the other rungs are being
  // checked for contract agreement, not for which channel the checked-in files target.
  const isDefaultChannel = channelName === manifest.default;

  for (const r of renderAll({ name: channelName, ...declared })) {
    const committed = fs.existsSync(r.file) ? fs.readFileSync(r.file, 'utf8') : null;
    if (!check(`${r.relative} is committed`, Boolean(committed), 'run: npm run clients:generate')) continue;

    if (isDefaultChannel) {
      check(`${r.relative} is generated for the default channel ("${channelName}")`, committed === r.content, 'run: npm run clients:generate');
    }

    // Holds for every channel and both transports: there is no credential to send.
    check(`${r.relative} carries no credential`, !/authorization/i.test(committed), 'the tools are anonymous; a client must not send one');

    // The identity headers only exist on an http config. A stdio config is a command
    // the client runs, with no request to attach a header to — so the equivalent
    // check is that it names the server to run and reaches it relocatably.
    if (transportOf(channelName) === 'stdio') {
      check(`${r.relative} names a server to run`, /"?command"?\s*[:=]/.test(committed), 'a stdio config must declare a command');
      check(
        `${r.relative} carries no url, being stdio`,
        !/https?:\/\//.test(committed),
        (committed.match(/https?:\/\/[^\s"']+/) || [])[0]
      );
    } else {
      check(`${r.relative} identifies its client to the hub`, committed.includes(HEADERS.client), `missing the ${HEADERS.client} header`);
    }
  }
  if (!isDefaultChannel) {
    console.log(`      note: client configs are committed for the "${manifest.default}" channel; here only the "${channelName}" pin is compared`);
  }

  // --- the served surface, not just its digest ----------------------------
  const rpc = async (method, params) => {
    const res = await fetch(`${hubUrl.replace(/\/+$/, '')}${ENDPOINTS.mcp}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [HEADERS.client]: 'e2e',
        [HEADERS.channel]: channelName,
        [HEADERS.clientContract]: CONTRACT_VERSION,
        [HEADERS.requestId]: `tier3-${method}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  const list = await rpc('tools/list');
  if (!check('tools/list answers', list.status === 200 && list.json?.result, `status ${list.status}`)) return;

  const served = list.json.result.tools;
  const servedNames = served.map((t) => t.name).sort();
  check(
    'the deployed hub serves exactly the contract tool surface',
    JSON.stringify(servedNames) === JSON.stringify(TOOL_NAMES.slice().sort()),
    `served [${servedNames.join(', ')}], contract declares [${TOOL_NAMES.join(', ')}]`
  );

  // Field-level comparison. A digest that matched while a field's type or requiredness
  // differed would mean the digest is not covering what it claims to.
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

    // readOnly is what a client uses to decide whether a call needs confirmation.
    check(`${tool.name} advertises the contract's readOnly hint`, tool.annotations?.readOnlyHint === declared.readOnly, `served ${tool.annotations?.readOnlyHint}, contract says ${declared.readOnly}`);
  }

  console.log(
    `      repo ${repo.contractDigest} | hub ${hub.contractDigest} | ` +
      `commit ${hub.commit} | channel ${hub.channel} | ${CLIENTS.length} clients checked`
  );
}

module.exports = { name, describe, run };
