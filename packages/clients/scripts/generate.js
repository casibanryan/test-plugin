#!/usr/bin/env node
// packages/clients/scripts/generate.js
// Generates every client's config from ONE channel manifest and ONE contract.
//
//   node scripts/generate.js --print                     show the resolved channel
//   node scripts/generate.js --write                     regenerate every client config
//   node scripts/generate.js --write --client=axle       just one
//   node scripts/generate.js --check                     CI: fail on any drift (no writes)
//   node scripts/generate.js --sync-pin --channel=production
//                                                        CD: record what that channel is
//                                                        now verified to be serving
//
// This is the multi-client story in one file. `CLIENTS` in the contract declares which
// clients exist and what format each one wants; a writer below turns the resolved
// channel into that format. Adding a client is a data change in the contract plus a
// writer here — never a second copy of the channel list, and never a hand-maintained
// config that can disagree with its siblings.
//
// TWO DIFFERENT FACTS, deliberately kept apart — conflating them is the mistake this
// file is written to avoid:
//
//   what this checkout BUILDS      packages/contract/contract.lock.json. One value.
//   what a channel SERVES          channels.json -> lastVerified. Per channel, written
//                                  by CD after a deploy passes, null until then.
//
// They are allowed to differ, and normally do: while you develop the next version,
// production is still serving the last one. So `lastVerified` is a RECORD, never a
// requirement — nothing local ever asserts it equals the current build.
//
//   CI   --check     configs must match what the generator produces, and (when the
//                    channel answers) the DEPLOYED digest must match this checkout.
//                    Read-only, so a pull request cannot pass by rewriting the evidence.
//   CD   --sync-pin  after a deploy passes its checks, record what that channel is now
//                    verified to serve.
//   dev  --write     regenerate after switching channels locally.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { compareContract } = require('@pivotly/contract');
const {
  CONTRACT_VERSION,
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  ENDPOINTS,
  HEADERS,
  CHANNELS,
  HARDENED_CHANNELS,
  CLIENTS,
  getClient,
  transportOf,
} = require('@pivotly/contract/protocol');
const { TOOLS } = require('@pivotly/contract/tools');
const { contractDigest } = require('@pivotly/contract/digest');

// Normally the package directory. PIVOTLY_CLIENTS_DIR redirects what it reads and
// writes, which is how the tests drive the real script against a scratch copy instead
// of the committed files.
const ROOT = process.env.PIVOTLY_CLIENTS_DIR ? path.resolve(process.env.PIVOTLY_CLIENTS_DIR) : path.join(__dirname, '..');
const CHANNELS_PATH = path.join(ROOT, 'channels.json');
const SERVER_NAME = 'pivotly-hub';
// A different name on purpose: `/mcp` should not label a server "pivotly-hub" when it
// is neither the hub nor remote. When someone reports a problem, the name they read off
// their screen should say which of the two they are talking about.
const BUNDLED_SERVER_NAME = 'pivotly-greeting';
// Where the bundled server sits relative to the REPO root. The clients with no
// plugin-root placeholder of their own (Codex, Gemini) have to name it this way, so
// it is spelled out here once instead of once per writer.
const BUNDLED_STDIO_ENTRY = 'packages/clients/axle/server/greeting-stdio.js';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function resolveChannel(manifest) {
  const name = arg('channel') || process.env.PIVOTLY_CHANNEL || manifest.default;
  if (!CHANNELS.includes(name)) throw new Error(`unknown channel "${name}" — the contract declares ${CHANNELS.join(', ')}`);
  const channel = manifest.channels[name];
  if (!channel) throw new Error(`channel "${name}" is declared by the contract but missing from channels.json`);
  // The contract is the authority on how a channel is reached, not the manifest entry:
  // a manifest that claimed a transport the contract does not declare would be exactly
  // the drift this file exists to prevent.
  const transport = transportOf(name);
  if (!transport) throw new Error(`channel "${name}" has no declared transport in the contract`);
  if (channel.transport && channel.transport !== transport) {
    throw new Error(`channel "${name}" says transport "${channel.transport}" but the contract declares "${transport}"`);
  }
  return { name, ...channel, transport };
}

// The headers every client sends. No credential: the hub is anonymous by design. These
// are identity-of-caller metadata the hub logs, and they are what make "which client,
// on which channel, built against which contract" answerable — the question you have to
// answer before retiring a contract version, and with several clients you need to know
// which of them to chase.
const headersFor = (client, channel) => ({
  [HEADERS.client]: client.id,
  [HEADERS.channel]: channel.name,
  // The contract this client was GENERATED from — always the current build, never a
  // per-channel value. It is what lets the hub answer "which clients are still on the
  // old contract" from its logs.
  [HEADERS.clientContract]: CONTRACT_VERSION,
});

const GENERATED_NOTE = (client, channel) =>
  `GENERATED by packages/clients/scripts/generate.js from channels.json (client: ${client.id}, channel: ${channel.name}). ` +
  `Do not hand-edit — run \`npm run clients:generate\` instead. CI fails if this drifts from channels.json. ` +
  (channel.transport === 'stdio'
    ? `No credential and no network: the two read-only greeting tools are served by a process inside this plugin.`
    : `No credential is needed: the hub serves two read-only tools anonymously.`);

// --- writers, one per declared format --------------------------------------

// The server entry itself, in the two shapes the two transports need. They are
// genuinely different things rather than a formatting choice: an http channel is a URL
// someone deployed, and the identity headers matter because the hub logs them. A stdio
// channel is a process the client starts from inside the plugin — no URL, and no
// headers, because there is no request. The transport is a pipe.
function serverFor(client, channel) {
  if (channel.transport === 'stdio') {
    return {
      type: 'stdio',
      command: channel.command,
      // ${CLAUDE_PLUGIN_ROOT} is substituted by the client at spawn time, and has to
      // stay a placeholder: the install directory carries the version number, so any
      // absolute path baked in here would break on the next update.
      args: channel.args,
    };
  }
  return { type: 'http', url: channel.url, headers: headersFor(client, channel) };
}

// Claude Code / Claude Desktop style: an mcpServers object.
function writeMcpJson(client, channel) {
  return `${JSON.stringify(
    {
      _comment: GENERATED_NOTE(client, channel),
      mcpServers: { [channel.transport === 'stdio' ? BUNDLED_SERVER_NAME : SERVER_NAME]: serverFor(client, channel) },
    },
    null,
    2
  )}\n`;
}

// Codex CLI style: TOML.
//
// Caveat worth stating rather than hiding: the exact key names a given Codex version
// wants for a REMOTE MCP server are not something this repository can verify, so treat
// the shape below as a starting point and check it against the version you run. That
// this is the only place to change it is the point of generating rather than
// hand-writing: one edit here fixes every channel at once.
function writeToml(client, channel) {
  // Only simple string values are emitted, so basic double-quoting is sufficient. A
  // value needing escapes would be a bug in the manifest, not something to paper over.
  const quote = (v) => {
    const s = String(v);
    if (/["\\\n]/.test(s)) throw new Error(`value ${JSON.stringify(s)} needs TOML escaping; the manifest should not contain it`);
    return `"${s}"`;
  };
  // A stdio server in Codex is a command it launches, not a url with headers. The
  // bundled greeting server lives inside the Claude plugin directory, though, so this
  // client cannot point at it by a placeholder the way Claude Code can — Codex has no
  // CLAUDE_PLUGIN_ROOT. It gets the repo-relative path instead, which is honest about
  // what it is: a config for someone who has this repository checked out.
  if (channel.transport === 'stdio') {
    const key = BUNDLED_SERVER_NAME.replace(/-/g, '_');
    return [
      `# ${GENERATED_NOTE(client, channel)}`,
      '#',
      '# This server is a process Codex starts. `command`/`args` below assume you have',
      '# this repository checked out; adjust the path if you moved it. Nothing is',
      '# fetched and no port is opened.',
      '',
      `[mcp_servers.${key}]`,
      `command = ${quote(channel.command)}`,
      `args = [${quote(BUNDLED_STDIO_ENTRY)}]`,
      '',
    ].join('\n');
  }

  const key = SERVER_NAME.replace(/-/g, '_');
  const lines = [
    `# ${GENERATED_NOTE(client, channel)}`,
    '',
    `[mcp_servers.${key}]`,
    `url = ${quote(channel.url)}`,
    '',
    `[mcp_servers.${key}.http_headers]`,
  ];
  for (const [h, v] of Object.entries(headersFor(client, channel))) lines.push(`${quote(h)} = ${quote(v)}`);
  lines.push('');
  return lines.join('\n');
}

// Gemini CLI style: settings.json, also an mcpServers object — near enough to Claude
// Code's to look like the same writer, and different in two ways that would fail
// silently if it were:
//
//   http    the key is `httpUrl`. Gemini reads a plain `url` as an SSE endpoint, so
//           the mcp-json shape would point it at a transport the hub does not serve.
//   stdio   no `type` field. The key you use IS the transport.
//
// The block belongs in .gemini/settings.json (this project only) or
// ~/.gemini/settings.json (every project).
function writeGeminiJson(client, channel) {
  const server =
    channel.transport === 'stdio'
      ? {
          command: channel.command,
          // Gemini has no CLAUDE_PLUGIN_ROOT, so — as with Codex — the bundled server
          // is named by a repo-relative path. That is honest about what this is: a
          // config for someone who has this repository checked out.
          args: [BUNDLED_STDIO_ENTRY],
        }
      : { httpUrl: channel.url, headers: headersFor(client, channel) };

  return `${JSON.stringify(
    {
      _comment: GENERATED_NOTE(client, channel),
      mcpServers: { [channel.transport === 'stdio' ? BUNDLED_SERVER_NAME : SERVER_NAME]: server },
    },
    null,
    2
  )}
`;
}

const WRITERS = { 'mcp-json': writeMcpJson, toml: writeToml, 'gemini-json': writeGeminiJson };

// The config every declared client should currently have, as text.
function renderAll(channel, only = null) {
  const out = [];
  for (const client of CLIENTS) {
    if (only && client.id !== only) continue;
    const writer = WRITERS[client.format];
    if (!writer) throw new Error(`client "${client.id}" declares format "${client.format}", which has no writer in generate.js`);
    out.push({
      client,
      file: path.join(ROOT, client.id, client.configPath),
      relative: `${client.id}/${client.configPath}`,
      content: writer(client, channel),
    });
  }
  if (only && out.length === 0) throw new Error(`unknown client "${only}" — the contract declares ${CLIENTS.map((c) => c.id).join(', ')}`);
  return out;
}

// --- the bundled server's tool surface -------------------------------------
// The stdio server that ships inside the plugin cannot `require` the contract: a
// marketplace install copies the plugin directory with no node_modules and no build
// step. So the contract's tool descriptors are compiled to JSON Schema here and
// written next to that server, which makes them a GENERATED artifact under the same
// drift check as every client config. Hand-maintaining a second copy of the tool
// surface is exactly the cascade this repository is built to prevent.
function jsonSchemaFor(field) {
  const out = {};
  switch (field.type) {
    case 'string':
      out.type = 'string';
      break;
    case 'integer':
      out.type = 'integer';
      break;
    case 'number':
      out.type = 'number';
      break;
    case 'boolean':
      out.type = 'boolean';
      break;
    case 'enum':
      out.type = 'string';
      out.enum = field.values;
      break;
    case 'object':
      out.type = 'object';
      break;
    case 'string[]':
      out.type = 'array';
      out.items = { type: 'string' };
      break;
    default:
      throw new Error(`no JSON Schema mapping for field type "${field.type}"`);
  }
  // `min`/`max` mean length on a string and value on a number — the same two contract
  // keys, two different JSON Schema keywords.
  if (field.min != null) out[field.type === 'string' ? 'minLength' : 'minimum'] = field.min;
  if (field.max != null) out[field.type === 'string' ? 'maxLength' : 'maximum'] = field.max;
  if (field.minItems != null) out.minItems = field.minItems;
  if (field.maxItems != null) out.maxItems = field.maxItems;
  if (field.describe) out.description = field.describe;
  return out;
}

function bundledToolManifest(channel) {
  return `${JSON.stringify(
    {
      _comment:
        `GENERATED by packages/clients/scripts/generate.js from the contract's TOOLS (channel: ${channel.name}). ` +
        'Do not hand-edit — run `npm run clients:generate`. CI fails if this drifts from the contract, which is what ' +
        'stops the bundled server from answering with a tool surface the hub does not have.',
      serverName: BUNDLED_SERVER_NAME,
      contractVersion: CONTRACT_VERSION,
      contractDigest: contractDigest(),
      protocolVersion: MCP_PROTOCOL_VERSION,
      supportedProtocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      instructions:
        'Two read-only greeting tools, answered from pure local logic. No network, no state, no credential. ' +
        'Call greeting_hello to open, then greeting_day_check with what the user said back.',
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        readOnly: tool.readOnly === true,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(tool.input).map(([key, field]) => [key, jsonSchemaFor(field)])),
          required: Object.entries(tool.input)
            .filter(([, field]) => !field.optional)
            .map(([key]) => key),
          additionalProperties: false,
        },
      })),
    },
    null,
    2
  )}\n`;
}

// Artifacts that exist only for a stdio channel. Returned in the same shape as
// renderAll's entries so the write and drift paths treat them identically.
function bundledArtifacts(channel, only = null) {
  if (channel.transport !== 'stdio') return [];
  const client = getClient('axle');
  if (!client || (only && only !== client.id)) return [];
  const relative = `${client.id}/server/tools.json`;
  return [{ client, file: path.join(ROOT, client.id, 'server', 'tools.json'), relative, content: bundledToolManifest(channel) }];
}

const originOf = (url) => {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
};

async function fetchDeployedIdentity(channel, timeoutMs) {
  const versionUrl = `${originOf(channel.url)}${ENDPOINTS.version}`;
  try {
    const res = await fetch(versionUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, reason: `${versionUrl} returned ${res.status}` };
    return { reachable: true, identity: await res.json(), versionUrl };
  } catch (err) {
    return { reachable: false, reason: `${versionUrl}: ${err.message}` };
  }
}

async function main() {
  const manifest = readJson(CHANNELS_PATH);
  const channel = resolveChannel(manifest);
  const only = arg('client');
  const timeoutMs = Number(arg('timeout-ms', '10000'));
  const problems = [];

  // --- structural checks, no network needed -------------------------------
  // Split by transport, because the two have nothing in common to check. Asking a
  // stdio channel for an https url would fail a channel that has no url at all, and
  // asking an http channel for a command would do the reverse.
  if (channel.transport === 'stdio') {
    if (!channel.command) problems.push(`channel "${channel.name}" is a stdio channel and must declare a command`);
    if (!Array.isArray(channel.args) || channel.args.length === 0) {
      problems.push(`channel "${channel.name}" is a stdio channel and must declare args`);
    }
    if (channel.url) problems.push(`channel "${channel.name}" is a stdio channel and must not declare a url`);
    if (HARDENED_CHANNELS.includes(channel.name)) {
      problems.push(`channel "${channel.name}" is hardened, so it cannot be served over stdio`);
    }
  } else {
    if (channel.requireHttps !== false && !channel.url.startsWith('https://')) {
      problems.push(`channel "${channel.name}" requires https but its url is ${channel.url}`);
    }
    if (HARDENED_CHANNELS.includes(channel.name) && channel.requireHttps === false) {
      problems.push(`channel "${channel.name}" is hardened and must not set requireHttps: false`);
    }
    if (!channel.url.endsWith(ENDPOINTS.mcp)) {
      problems.push(`channel "${channel.name}" url should end with the contract's MCP path (${ENDPOINTS.mcp}): ${channel.url}`);
    }
  }
  // lastVerified is optional (null until that channel has been deployed), but if it is
  // present it has to be well formed, or the record is worse than useless.
  if (channel.lastVerified != null) {
    const lv = channel.lastVerified;
    if (!/^[0-9a-f]{12}$/.test(lv.contractDigest || '')) {
      problems.push(`channel "${channel.name}" has a malformed lastVerified.contractDigest: ${lv.contractDigest}`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(lv.contractVersion || '')) {
      problems.push(`channel "${channel.name}" has a malformed lastVerified.contractVersion: ${lv.contractVersion}`);
    }
  }

  // The bundled server's generated tool surface is checked and written exactly like a
  // client config, so it cannot drift from the contract unnoticed.
  const rendered = [...renderAll(channel, only), ...bundledArtifacts(channel, only)];
  const drifted = rendered.filter((r) => !fs.existsSync(r.file) || fs.readFileSync(r.file, 'utf8') !== r.content);

  if (flag('print')) {
    console.log(
      JSON.stringify(
        {
          channel: channel.name,
          transport: channel.transport,
          ...(channel.transport === 'stdio' ? { command: channel.command, args: channel.args } : { url: channel.url }),
          lastVerified: channel.lastVerified,
          thisCheckout: { version: CONTRACT_VERSION, digest: contractDigest() },
          clients: rendered.map((r) => ({ id: r.client.id, host: r.client.host, config: r.relative, inSync: !drifted.includes(r) })),
        },
        null,
        2
      )
    );
    return;
  }

  // --- write --------------------------------------------------------------
  if (flag('write')) {
    if (problems.length) {
      for (const p of problems) console.error(`FAIL  ${p}`);
      process.exitCode = 1;
      return;
    }
    for (const r of rendered) {
      fs.mkdirSync(path.dirname(r.file), { recursive: true });
      fs.writeFileSync(r.file, r.content);
      const target = channel.transport === 'stdio' ? `${channel.command} ${channel.args.join(' ')}` : channel.url;
      console.log(`ok    ${r.relative} ${drifted.includes(r) ? 'updated' : 'unchanged'} -> ${target}`);
    }
    console.log(`ok    ${rendered.length} client config(s) generated for channel "${channel.name}"`);
    return;
  }

  // --- sync-pin (CD, after a verified deploy) -----------------------------
  if (flag('sync-pin')) {
    // A stdio channel is not deployed anywhere, so there is nothing to read and
    // nothing that could have been verified. Recording a pin for it would be inventing
    // evidence — the one thing --sync-pin must never do.
    if (channel.transport === 'stdio') {
      console.error(`FAIL  channel "${channel.name}" is served over stdio, so it has no deployment to pin.`);
      console.error('      --sync-pin applies to http channels only.');
      process.exitCode = 1;
      return;
    }
    const deployed = await fetchDeployedIdentity(channel, timeoutMs);
    if (!deployed.reachable) {
      console.error(`FAIL  cannot read the deployed contract: ${deployed.reason}`);
      console.error('      --sync-pin must never guess. A pin is only advanced from a hub that answered.');
      process.exitCode = 1;
      return;
    }

    const { contractVersion, contractDigest: deployedDigest } = deployed.identity;
    if (!/^[0-9a-f]{12}$/.test(deployedDigest || '')) {
      console.error(`FAIL  the deployed hub reported a malformed contract digest: ${deployedDigest}`);
      process.exitCode = 1;
      return;
    }
    // The deployed hub must be serving THIS checkout's contract. If not, the pipeline is
    // mid-rollout or someone deployed another commit, and advancing the pin would record
    // a contract these clients were never generated from.
    if (deployedDigest !== contractDigest()) {
      console.error(`FAIL  the deployed hub serves contract ${deployedDigest} but this checkout builds ${contractDigest()}`);
      console.error('      Refusing to pin a contract these clients were not generated from.');
      process.exitCode = 1;
      return;
    }

    const previous = channel.lastVerified;
    const record = {
      contractVersion,
      contractDigest: deployedDigest,
      commit: deployed.identity.commit ?? null,
      at: new Date().toISOString(),
    };
    const unchanged = previous && previous.contractDigest === record.contractDigest && previous.commit === record.commit;

    manifest.channels[channel.name].lastVerified = record;
    fs.writeFileSync(CHANNELS_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(
      unchanged
        ? `ok    channel "${channel.name}" already recorded at ${record.contractDigest} (commit ${record.commit}) — nothing to commit`
        : `ok    channel "${channel.name}" now verified at contract ${record.contractDigest} (${contractVersion}), commit ${record.commit}`
    );
    return;
  }

  // --- check (CI) ---------------------------------------------------------
  // Read-only by design: a check that repaired what it was checking would let a pull
  // request pass by rewriting the evidence.
  for (const r of drifted) {
    problems.push(`${r.relative} has drifted from channels.json (channel "${channel.name}"). Run \`npm run clients:generate\` and commit.`);
  }

  // NOT checked here: whether lastVerified equals what this checkout builds. Those are
  // different facts (see the note at the top), and production legitimately lags while
  // the next version is in development. Asserting equality would deadlock every
  // contract change behind a deploy.
  if (channel.lastVerified) {
    const drift = compareContract(
      { contractVersion: channel.lastVerified.contractVersion, contractDigest: channel.lastVerified.contractDigest },
      { contractVersion: CONTRACT_VERSION, contractDigest: contractDigest() }
    );
    console.log(
      drift.verdict === 'ok'
        ? `note  channel "${channel.name}" was last verified serving this exact contract (${channel.lastVerified.contractDigest})`
        : `note  channel "${channel.name}" was last verified serving ${channel.lastVerified.contractDigest}; this checkout builds ${contractDigest()} — normal until it is deployed`
    );
  } else {
    console.log(`note  channel "${channel.name}" has never been verified (lastVerified is null)`);
  }

  // If the channel answers, the DEPLOYED hub must be serving what this checkout builds.
  // That is the real cascade check, and it is the one that matters before a promotion.
  // Unreachable is NOT a failure: a fork's pull request has no route to Azure, and CI
  // must not depend on one.
  // A stdio channel has no endpoint to probe. It also cannot drift the way a deployed
  // one can: the tool surface it serves is generated from this checkout's contract and
  // drift-checked above, so it is the ONE channel whose contract is guaranteed current.
  const deployed = channel.transport === 'stdio' ? { reachable: false, stdio: true } : await fetchDeployedIdentity(channel, timeoutMs);
  if (deployed.stdio) {
    console.log(`ok    channel "${channel.name}" is served over stdio from this checkout, so its contract is ${contractDigest()} by construction`);
  } else if (!deployed.reachable) {
    console.log(`note  channel "${channel.name}" is not reachable from here, so the deployed contract was not checked (${deployed.reason})`);
  } else {
    const verdict = compareContract({ contractVersion: CONTRACT_VERSION, contractDigest: contractDigest() }, deployed.identity);
    if (verdict.verdict === 'breaking') {
      problems.push(`BREAKING: ${deployed.versionUrl} — ${verdict.reason}. Clients generated here cannot talk to that hub.`);
    } else if (verdict.verdict !== 'ok') {
      problems.push(
        `channel "${channel.name}" serves contract ${deployed.identity.contractDigest} but this checkout builds ${contractDigest()} — ` +
          `${verdict.reason}. Deploy this commit to that channel before shipping clients generated from it.`
      );
    } else {
      console.log(`ok    deployed hub at ${deployed.versionUrl} serves this checkout's contract ${deployed.identity.contractDigest}`);
      console.log(`ok    deployed commit ${deployed.identity.commit} on channel ${deployed.identity.channel}`);
    }
  }

  if (problems.length) {
    for (const p of problems) console.error(`FAIL  ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok    channel "${channel.name}" is in sync across ${rendered.length} client(s) — contract ${contractDigest()} (${CONTRACT_VERSION})`);
}

module.exports = { renderAll, headersFor, resolveChannel, writeMcpJson, writeToml, writeGeminiJson, WRITERS, SERVER_NAME, CHANNELS_PATH, getClient };

if (require.main === module) {
  main().catch((err) => {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  });
}
