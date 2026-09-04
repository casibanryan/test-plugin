#!/usr/bin/env node
// packages/clients/scripts/generate.js
// Generates every client's config, tool surface and skills from ONE channel manifest,
// ONE contract and ONE set of skills.
//
//   node scripts/generate.js --print                     show the resolved channel
//   node scripts/generate.js --write                     regenerate everything
//   node scripts/generate.js --write --client=claude     just one client
//   node scripts/generate.js --check                     CI: fail on any drift (no writes)
//   node scripts/generate.js --sync-pin --channel=production
//                                                        CD: record what that channel is
//                                                        now verified to be serving
//
// This is the multi-client story in one file. `CLIENTS` in the contract declares which
// clients exist and what format each one wants; a ConfigWriter subclass below turns the
// resolved channel into that format. Adding a client is a data change in the contract
// plus, if it needs a format nobody else uses, one more subclass — never a second copy
// of the channel list, and never a hand-maintained config that can disagree with its
// siblings.
//
// HOW IT IS PUT TOGETHER. Everything this script emits is an Artifact: a path, the text
// that belongs at it, and the client it belongs to. Four sources produce them, and the
// write / drift / check paths then treat all four identically, which is the point — a
// skill is under exactly the same drift check as a config.
//
//   ConfigWriter   one subclass per declared format, chosen by client.format
//   ToolSurface    the contract's TOOLS compiled to dependency-free JSON Schema
//   ServerCopy     packages/server, copied byte for byte into each plugin client
//   Skill          packages/skills, rendered per host from one source
//
//   Channel        the resolved channel, and every structural rule about it
//   ClientTarget   one declared client, and the artifacts it should receive
//   Generator      collects all of them, then prints / writes / checks / pins
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
// A different name on purpose: a hosted `/mcp` should not label a server
// "pivotly-hub" when it is neither hosted nor remote. When someone reports a problem,
// the name they read off their screen should say which of the two they mean.
const BUNDLED_SERVER_NAME = 'pivotly-greeting';

// The CANONICAL server and skills, and the files a plugin client receives a copy of.
// Everything else here writes text it composed; these are copied byte for byte, which
// is what lets `clients:verify` compare a plugin's copy against its source and fail on
// any difference at all.
//
// PIVOTLY_CLIENTS_DIR redirects where copies are WRITTEN (the tests drive the real
// script against a scratch tree) but never where they are READ FROM: the source is
// always this checkout.
const SERVER_SRC = path.join(__dirname, '..', '..', 'server');
const SKILLS_SRC = path.join(__dirname, '..', '..', 'skills');
const COPIED_SERVER_FILES = ['greeting-stdio.js', 'greeting.js'];

// Where that server sits relative to the REPO root. The clients with no plugin-root
// placeholder of their own (Codex, Gemini) have to name it this way, so it is spelled
// out once here instead of once per writer. They point at the canonical copy rather
// than at another client's, which is why this is not a path into packages/clients.
const BUNDLED_STDIO_ENTRY = 'packages/server/greeting-stdio.js';

const KNOWN_CLIENT_IDS = CLIENTS.map((c) => c.id);

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

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
    ? `No credential and no network: the two read-only greeting tools are served by a local process.`
    : `No credential is needed: the hub serves two read-only tools anonymously.`);

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------
// One generated file. Every producer below returns these, so `--write`, `--check` and
// `--print` never need to know what kind of thing they are handling.
class Artifact {
  constructor({ client, file, relative, content }) {
    this.client = client;
    this.file = file;
    this.relative = relative;
    this.content = content;
  }

  // Missing counts as drifted. A config that was deleted rather than edited is the same
  // problem to the person running CI: what is committed is not what this checkout builds.
  get drifted() {
    return !fs.existsSync(this.file) || fs.readFileSync(this.file, 'utf8') !== this.content;
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, this.content);
    return this;
  }
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------
// The resolved channel plus every rule about what a channel of that transport is
// allowed to say. Instances keep `name`, `transport`, `command`, `args` and `url` as
// plain own properties on purpose: the writers below take either a Channel or a plain
// object, which is what lets the tests exercise a writer without building one.
class Channel {
  static resolve(manifest, name) {
    if (!CHANNELS.includes(name)) throw new Error(`unknown channel "${name}" — the contract declares ${CHANNELS.join(', ')}`);
    const entry = manifest.channels[name];
    if (!entry) throw new Error(`channel "${name}" is declared by the contract but missing from channels.json`);
    // The contract is the authority on how a channel is reached, not the manifest entry:
    // a manifest that claimed a transport the contract does not declare would be exactly
    // the drift this file exists to prevent.
    const transport = transportOf(name);
    if (!transport) throw new Error(`channel "${name}" has no declared transport in the contract`);
    if (entry.transport && entry.transport !== transport) {
      throw new Error(`channel "${name}" says transport "${entry.transport}" but the contract declares "${transport}"`);
    }
    return new Channel(name, entry, transport);
  }

  constructor(name, entry, transport) {
    Object.assign(this, entry);
    this.name = name;
    this.transport = transport;
  }

  get isStdio() {
    return this.transport === 'stdio';
  }

  // What to show in a log line about where a generated file now points.
  get target() {
    return this.isStdio ? `${this.command} ${(this.args || []).join(' ')}` : this.url;
  }

  get origin() {
    const u = new URL(this.url);
    return `${u.protocol}//${u.host}`;
  }

  // Structural rules, no network needed. Split by transport, because the two have
  // nothing in common to check: asking a stdio channel for an https url would fail a
  // channel that has no url at all, and asking an http channel for a command would do
  // the reverse.
  problems() {
    const out = [];
    if (this.isStdio) {
      if (!this.command) out.push(`channel "${this.name}" is a stdio channel and must declare a command`);
      if (!Array.isArray(this.args) || this.args.length === 0) {
        out.push(`channel "${this.name}" is a stdio channel and must declare args`);
      }
      if (this.url) out.push(`channel "${this.name}" is a stdio channel and must not declare a url`);
      if (HARDENED_CHANNELS.includes(this.name)) {
        out.push(`channel "${this.name}" is hardened, so it cannot be served over stdio`);
      }
    } else {
      if (this.requireHttps !== false && !this.url.startsWith('https://')) {
        out.push(`channel "${this.name}" requires https but its url is ${this.url}`);
      }
      if (HARDENED_CHANNELS.includes(this.name) && this.requireHttps === false) {
        out.push(`channel "${this.name}" is hardened and must not set requireHttps: false`);
      }
      if (!this.url.endsWith(ENDPOINTS.mcp)) {
        out.push(`channel "${this.name}" url should end with the contract's MCP path (${ENDPOINTS.mcp}): ${this.url}`);
      }
    }
    // lastVerified is optional (null until that channel has been deployed), but if it is
    // present it has to be well formed, or the record is worse than useless.
    if (this.lastVerified != null) {
      const lv = this.lastVerified;
      if (!/^[0-9a-f]{12}$/.test(lv.contractDigest || '')) {
        out.push(`channel "${this.name}" has a malformed lastVerified.contractDigest: ${lv.contractDigest}`);
      }
      if (!/^\d+\.\d+\.\d+$/.test(lv.contractVersion || '')) {
        out.push(`channel "${this.name}" has a malformed lastVerified.contractVersion: ${lv.contractVersion}`);
      }
    }
    return out;
  }

  async fetchDeployedIdentity(timeoutMs) {
    const versionUrl = `${this.origin}${ENDPOINTS.version}`;
    try {
      const res = await fetch(versionUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { reachable: false, reason: `${versionUrl} returned ${res.status}` };
      return { reachable: true, identity: await res.json(), versionUrl };
    } catch (err) {
      return { reachable: false, reason: `${versionUrl}: ${err.message}` };
    }
  }
}

// ---------------------------------------------------------------------------
// ConfigWriter
// ---------------------------------------------------------------------------
// One subclass per declared format. The base class holds what every format agrees on —
// the generated note, which server name to use, and the two shapes a server entry can
// take — so a new client that wants a new file format overrides `render` and nothing
// else.
class ConfigWriter {
  // Filled by register() below. A format with no writer is a hard error rather than a
  // skipped client: a declared client that silently receives nothing is the failure
  // this whole script exists to prevent.
  static registry = new Map();

  static register(subclass) {
    ConfigWriter.registry.set(subclass.format, subclass);
    return subclass;
  }

  static for(client) {
    const subclass = ConfigWriter.registry.get(client.format);
    if (!subclass) throw new Error(`client "${client.id}" declares format "${client.format}", which has no writer in generate.js`);
    return new subclass(client);
  }

  constructor(client) {
    this.client = client;
  }

  serverName(channel) {
    return channel.transport === 'stdio' ? BUNDLED_SERVER_NAME : SERVER_NAME;
  }

  // The server entry itself, in the two shapes the two transports need. They are
  // genuinely different things rather than a formatting choice: an http channel is a URL
  // someone deployed, and the identity headers matter because the hub logs them. A stdio
  // channel is a process the client starts from inside the plugin — no URL, and no
  // headers, because there is no request. The transport is a pipe.
  serverFor(channel) {
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
    return { type: 'http', url: channel.url, headers: headersFor(this.client, channel) };
  }

  render() {
    throw new Error(`${this.constructor.name} must implement render(channel)`);
  }

  artifact(channel) {
    return new Artifact({
      client: this.client,
      file: path.join(ROOT, this.client.id, this.client.configPath),
      relative: `${this.client.id}/${this.client.configPath}`,
      content: this.render(channel),
    });
  }
}

// Claude Code / Claude Desktop style: an mcpServers object.
class McpJsonWriter extends ConfigWriter {
  static format = 'mcp-json';

  render(channel) {
    return `${JSON.stringify(
      {
        _comment: GENERATED_NOTE(this.client, channel),
        mcpServers: { [this.serverName(channel)]: this.serverFor(channel) },
      },
      null,
      2
    )}\n`;
  }
}

// Codex CLI style: TOML.
//
// Caveat worth stating rather than hiding: the exact key names a given Codex version
// wants for a REMOTE MCP server are not something this repository can verify, so treat
// the shape below as a starting point and check it against the version you run. That
// this is the only place to change it is the point of generating rather than
// hand-writing: one edit here fixes every channel at once.
class TomlWriter extends ConfigWriter {
  static format = 'toml';

  // Only simple string values are emitted, so basic double-quoting is sufficient. A
  // value needing escapes would be a bug in the manifest, not something to paper over.
  quote(v) {
    const s = String(v);
    if (/["\\\n]/.test(s)) throw new Error(`value ${JSON.stringify(s)} needs TOML escaping; the manifest should not contain it`);
    return `"${s}"`;
  }

  render(channel) {
    // A stdio server in Codex is a command it launches, not a url with headers. The
    // bundled greeting server lives inside the Claude plugin directory, though, so this
    // client cannot point at it by a placeholder the way Claude Code can — Codex has no
    // CLAUDE_PLUGIN_ROOT. It gets the repo-relative path instead, which is honest about
    // what it is: a config for someone who has this repository checked out.
    if (channel.transport === 'stdio') {
      const key = BUNDLED_SERVER_NAME.replace(/-/g, '_');
      return [
        `# ${GENERATED_NOTE(this.client, channel)}`,
        '#',
        '# This server is a process Codex starts. `command`/`args` below assume you have',
        '# this repository checked out; adjust the path if you moved it. Nothing is',
        '# fetched and no port is opened.',
        '',
        `[mcp_servers.${key}]`,
        `command = ${this.quote(channel.command)}`,
        `args = [${this.quote(BUNDLED_STDIO_ENTRY)}]`,
        '',
      ].join('\n');
    }

    const key = SERVER_NAME.replace(/-/g, '_');
    const lines = [
      `# ${GENERATED_NOTE(this.client, channel)}`,
      '',
      `[mcp_servers.${key}]`,
      `url = ${this.quote(channel.url)}`,
      '',
      `[mcp_servers.${key}.http_headers]`,
    ];
    for (const [h, v] of Object.entries(headersFor(this.client, channel))) lines.push(`${this.quote(h)} = ${this.quote(v)}`);
    lines.push('');
    return lines.join('\n');
  }
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
class GeminiJsonWriter extends ConfigWriter {
  static format = 'gemini-json';

  serverFor(channel) {
    if (channel.transport === 'stdio') {
      return {
        command: channel.command,
        // Gemini has no CLAUDE_PLUGIN_ROOT, so — as with Codex — the bundled server is
        // named by a repo-relative path. That is honest about what this is: a config
        // for someone who has this repository checked out.
        args: [BUNDLED_STDIO_ENTRY],
      };
    }
    return { httpUrl: channel.url, headers: headersFor(this.client, channel) };
  }

  render(channel) {
    return `${JSON.stringify(
      {
        _comment: GENERATED_NOTE(this.client, channel),
        mcpServers: { [this.serverName(channel)]: this.serverFor(channel) },
      },
      null,
      2
    )}\n`;
  }
}

ConfigWriter.register(McpJsonWriter);
ConfigWriter.register(TomlWriter);
ConfigWriter.register(GeminiJsonWriter);

// ---------------------------------------------------------------------------
// ToolSurface
// ---------------------------------------------------------------------------
// The stdio server that ships inside the plugin cannot `require` the contract: a
// marketplace install copies the plugin directory with no node_modules and no build
// step. So the contract's tool descriptors are compiled to JSON Schema here and written
// next to that server, which makes them a GENERATED artifact under the same drift check
// as every client config. Hand-maintaining a second copy of the tool surface is exactly
// the cascade this repository is built to prevent.
class ToolSurface {
  static jsonSchemaFor(field) {
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

  render(channel) {
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
            properties: Object.fromEntries(Object.entries(tool.input).map(([key, field]) => [key, ToolSurface.jsonSchemaFor(field)])),
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
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------
// The tool surface says what a client CAN call; a skill says when calling it is the
// right move, and what to do when it fails. Both are cross-client facts, so both are
// generated from one source — the alternative is three prose copies that drift apart
// silently, which is worse than a drifted config because nothing crashes.
//
// What must NOT be shared is the part that is true of one host only: Claude Code has a
// SessionStart hook and a plugin install to be broken, Codex and Gemini have neither.
// Shipping one file everywhere would tell two clients to reproduce a banner that will
// never exist. So the source carries host-conditional blocks:
//
//   <!-- if:claude -->        ...only claude keeps these lines...
//   <!-- endif -->
//   <!-- if:codex,gemini -->  ...comma-separated, no negation on purpose...
//   <!-- endif -->
//
// Filtering runs over the WHOLE file, front matter included, which is how a skill can
// carry a different `description:` per host — the one line the model reads when
// deciding whether to load the skill at all.
class Skill {
  static OPEN = /^\s*<!--\s*if:([a-z0-9,\s-]+?)\s*-->\s*$/;
  static CLOSE = /^\s*<!--\s*endif\s*-->\s*$/;

  static names() {
    if (!fs.existsSync(SKILLS_SRC)) return [];
    return fs
      .readdirSync(SKILLS_SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  static all() {
    return Skill.names().map((name) => new Skill(name));
  }

  constructor(name) {
    this.name = name;
    this.file = path.join(SKILLS_SRC, name, 'SKILL.md');
    this.label = `packages/skills/${name}/SKILL.md`;
    if (!fs.existsSync(this.file)) throw new Error(`${this.label} is missing — a skill directory must contain SKILL.md`);
    this.source = fs.readFileSync(this.file, 'utf8');
  }

  static assertKnown(id, where) {
    if (!KNOWN_CLIENT_IDS.includes(id)) {
      throw new Error(`${where} names unknown client "${id}" — the contract declares ${KNOWN_CLIENT_IDS.join(', ')}`);
    }
  }

  // The `clients:` line is the skill's own declaration of reach. It is required rather
  // than defaulted to "everyone": a new skill is usually about one host, and silently
  // shipping a Claude-specific one to Gemini is the failure this mechanism exists to
  // prevent.
  get reach() {
    const front = this.source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!front) throw new Error(`${this.label} has no YAML front matter`);
    const declared = front[1].match(/^clients:\s*\[(.*)\]\s*$/m);
    if (!declared) {
      throw new Error(`${this.label} front matter must declare which clients receive it, e.g. clients: [claude, codex, gemini]`);
    }
    const ids = declared[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) throw new Error(`${this.label} declares clients: [] — a skill nobody receives should be deleted, not shipped`);
    for (const id of ids) Skill.assertKnown(id, this.label);
    return ids;
  }

  reaches(clientId) {
    return this.reach.includes(clientId);
  }

  renderFor(clientId) {
    const kept = [];
    const open = [];
    this.source.split(/\r?\n/).forEach((line, i) => {
      const start = line.match(Skill.OPEN);
      if (start) {
        const ids = start[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        // A typo'd client id would silently drop a block from every client — the exact
        // kind of quiet nothing this repository generates configs to avoid.
        for (const id of ids) Skill.assertKnown(id, `${this.label}:${i + 1}`);
        open.push({ ids, line: i + 1 });
        return;
      }
      if (Skill.CLOSE.test(line)) {
        if (!open.length) throw new Error(`${this.label}:${i + 1} has an <!-- endif --> with no matching <!-- if: -->`);
        open.pop();
        return;
      }
      if (open.every((frame) => frame.ids.includes(clientId))) kept.push(line);
    });
    if (open.length) throw new Error(`${this.label}:${open[open.length - 1].line} opens <!-- if: --> and never closes it`);

    // Removing a block leaves the blank lines that surrounded it, so collapse runs. The
    // front matter's build-only `clients:` line goes too: it says who receives the
    // skill, which is meaningless once the skill has been delivered.
    return `${kept
      .join('\n')
      .replace(/^clients:.*\n/m, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()}\n`;
  }
}

// ---------------------------------------------------------------------------
// ClientTarget
// ---------------------------------------------------------------------------
// One declared client, and everything that should end up in its directory. Which
// artifacts it receives is decided by what the contract says about it — `format`,
// `plugin`, `skillsPath` — never by a list kept here that could fall out of step.
class ClientTarget {
  static all(only = null) {
    const targets = CLIENTS.filter((c) => !only || c.id === only).map((c) => new ClientTarget(c));
    if (only && targets.length === 0) throw new Error(`unknown client "${only}" — the contract declares ${KNOWN_CLIENT_IDS.join(', ')}`);
    return targets;
  }

  constructor(descriptor) {
    this.descriptor = descriptor;
    this.id = descriptor.id;
    this.dir = path.join(ROOT, descriptor.id);
  }

  get isPlugin() {
    return this.descriptor.plugin === true;
  }

  configArtifact(channel) {
    return ConfigWriter.for(this.descriptor).artifact(channel);
  }

  // Only a plugin client needs its own copy of the server. Codex and Gemini name the
  // canonical path in their config, so duplicating it for them would be dead weight and
  // a second thing to keep in step.
  //
  // Two kinds, and the distinction matters when one fails:
  //
  //   tools.json   COMPILED from the contract's TOOLS.
  //   the server   COPIED byte for byte out of packages/server, because a marketplace
  //                install receives only the plugin directory and cannot require its
  //                way back into this repository.
  serverArtifacts(channel, toolSurface) {
    if (!channel.isStdio || !this.isPlugin) return [];
    const dir = path.join(this.dir, 'server');
    const out = [
      new Artifact({
        client: this.descriptor,
        file: path.join(dir, 'tools.json'),
        relative: `${this.id}/server/tools.json`,
        content: toolSurface,
      }),
    ];
    for (const name of COPIED_SERVER_FILES) {
      out.push(
        new Artifact({
          client: this.descriptor,
          file: path.join(dir, name),
          relative: `${this.id}/server/${name}`,
          content: fs.readFileSync(path.join(SERVER_SRC, name), 'utf8'),
        })
      );
    }
    return out;
  }

  // Skills are not channel-dependent — they describe a tool surface that is the same on
  // every channel — so unlike the bundled server they are emitted whatever the transport.
  skillArtifacts(skills) {
    if (!this.descriptor.skillsPath) return [];
    return skills
      .filter((skill) => skill.reaches(this.id))
      .map(
        (skill) =>
          new Artifact({
            client: this.descriptor,
            file: path.join(this.dir, this.descriptor.skillsPath, skill.name, 'SKILL.md'),
            relative: `${this.id}/${this.descriptor.skillsPath}/${skill.name}/SKILL.md`,
            content: skill.renderFor(this.id),
          })
      );
  }

  // Generated skills are the first artifact here that can go stale by SUBTRACTION:
  // narrow a skill's `clients:` list and the file it used to write is simply left
  // behind, still loaded by that host, now describing a client it no longer belongs to.
  // Configs cannot do this — there is one per client, always rewritten — so nothing
  // looked for it before.
  staleSkillDirs(skills) {
    if (!this.descriptor.skillsPath) return [];
    const dir = path.join(this.dir, this.descriptor.skillsPath);
    if (!fs.existsSync(dir)) return [];
    const expected = new Set(skills.filter((s) => s.reaches(this.id)).map((s) => s.name));
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !expected.has(e.name))
      .map((e) => ({ dir: path.join(dir, e.name), relative: `${this.id}/${this.descriptor.skillsPath}/${e.name}` }));
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------
// Collects every artifact for the resolved channel, then does one of four things with
// them. The four modes share the same collection so they cannot disagree about what
// should exist — the reason `--check` is trustworthy is that it asks the same object
// `--write` would have used.
class Generator {
  constructor({ manifest, channel, only = null, timeoutMs = 10000 }) {
    this.manifest = manifest;
    this.channel = channel;
    this.only = only;
    this.timeoutMs = timeoutMs;
    this.targets = ClientTarget.all(only);
    this.skills = Skill.all();
  }

  get artifacts() {
    if (!this._artifacts) {
      const toolSurface = new ToolSurface().render(this.channel);
      const out = this.targets.map((t) => t.configArtifact(this.channel));

      // The canonical tool surface, next to the server that reads it. Not tied to any
      // one client: Codex and Gemini run this copy directly. Skipped when targeting a
      // single client, since it belongs to none of them.
      if (!this.only && this.channel.isStdio) {
        out.push(
          new Artifact({
            client: { id: 'server' },
            file: path.join(SERVER_SRC, 'tools.json'),
            relative: 'packages/server/tools.json',
            content: toolSurface,
          })
        );
      }

      for (const t of this.targets) out.push(...t.serverArtifacts(this.channel, toolSurface));
      for (const t of this.targets) out.push(...t.skillArtifacts(this.skills));
      this._artifacts = out;
    }
    return this._artifacts;
  }

  get drifted() {
    return this.artifacts.filter((a) => a.drifted);
  }

  get stale() {
    return this.targets.flatMap((t) => t.staleSkillDirs(this.skills));
  }

  // `clients` stays ONE ENTRY PER DECLARED CLIENT even though a client now receives
  // several files. It is the answer to "who is configured, and where do they point",
  // which is what a human runs --print to ask; the per-file view is `generated` below.
  // Folding skills into `clients` would have made a client appear three times and quietly
  // broken every reader that counted them.
  print() {
    const drifted = new Set(this.drifted);
    console.log(
      JSON.stringify(
        {
          channel: this.channel.name,
          transport: this.channel.transport,
          ...(this.channel.isStdio ? { command: this.channel.command, args: this.channel.args } : { url: this.channel.url }),
          lastVerified: this.channel.lastVerified,
          thisCheckout: { version: CONTRACT_VERSION, digest: contractDigest() },
          clients: this.targets.map((t) => {
            const config = t.configArtifact(this.channel);
            return {
              id: t.id,
              host: t.descriptor.host,
              config: config.relative,
              inSync: !config.drifted,
              skills: t.skillArtifacts(this.skills).map((a) => a.relative),
            };
          }),
          generated: this.artifacts.map((a) => ({ id: a.client.id, file: a.relative, inSync: !drifted.has(a) })),
        },
        null,
        2
      )
    );
  }

  write() {
    const problems = this.channel.problems();
    if (problems.length) return problems;

    const drifted = new Set(this.drifted);
    for (const a of this.artifacts) {
      a.write();
      console.log(`ok    ${a.relative} ${drifted.has(a) ? 'updated' : 'unchanged'} -> ${this.channel.target}`);
    }
    for (const s of this.stale) {
      fs.rmSync(s.dir, { recursive: true, force: true });
      console.log(`ok    ${s.relative} removed — no longer declared for this client`);
    }
    console.log(`ok    ${this.artifacts.length} generated file(s) for channel "${this.channel.name}"`);
    return [];
  }

  // Read-only by design: a check that repaired what it was checking would let a pull
  // request pass by rewriting the evidence.
  async check() {
    const problems = this.channel.problems();

    for (const a of this.drifted) {
      problems.push(`${a.relative} has drifted from channels.json (channel "${this.channel.name}"). Run \`npm run clients:generate\` and commit.`);
    }
    for (const s of this.stale) {
      problems.push(`${s.relative} is not declared by any skill in packages/skills. Run \`npm run clients:generate\` to remove it, and commit.`);
    }

    // NOT checked here: whether lastVerified equals what this checkout builds. Those are
    // different facts (see the note at the top), and production legitimately lags while
    // the next version is in development. Asserting equality would deadlock every
    // contract change behind a deploy.
    if (this.channel.lastVerified) {
      const drift = compareContract(
        { contractVersion: this.channel.lastVerified.contractVersion, contractDigest: this.channel.lastVerified.contractDigest },
        { contractVersion: CONTRACT_VERSION, contractDigest: contractDigest() }
      );
      console.log(
        drift.verdict === 'ok'
          ? `note  channel "${this.channel.name}" was last verified serving this exact contract (${this.channel.lastVerified.contractDigest})`
          : `note  channel "${this.channel.name}" was last verified serving ${this.channel.lastVerified.contractDigest}; this checkout builds ${contractDigest()} — normal until it is deployed`
      );
    } else {
      console.log(`note  channel "${this.channel.name}" has never been verified (lastVerified is null)`);
    }

    // If the channel answers, the DEPLOYED hub must be serving what this checkout builds.
    // That is the real cascade check, and it is the one that matters before a promotion.
    // Unreachable is NOT a failure: a fork's pull request has no route to Azure, and CI
    // must not depend on one.
    // A stdio channel has no endpoint to probe. It also cannot drift the way a deployed
    // one can: the tool surface it serves is generated from this checkout's contract and
    // drift-checked above, so it is the ONE channel whose contract is guaranteed current.
    const deployed = this.channel.isStdio ? { reachable: false, stdio: true } : await this.channel.fetchDeployedIdentity(this.timeoutMs);
    if (deployed.stdio) {
      console.log(
        `ok    channel "${this.channel.name}" is served over stdio from this checkout, so its contract is ${contractDigest()} by construction`
      );
    } else if (!deployed.reachable) {
      console.log(`note  channel "${this.channel.name}" is not reachable from here, so the deployed contract was not checked (${deployed.reason})`);
    } else {
      const verdict = compareContract({ contractVersion: CONTRACT_VERSION, contractDigest: contractDigest() }, deployed.identity);
      if (verdict.verdict === 'breaking') {
        problems.push(`BREAKING: ${deployed.versionUrl} — ${verdict.reason}. Clients generated here cannot talk to that hub.`);
      } else if (verdict.verdict !== 'ok') {
        problems.push(
          `channel "${this.channel.name}" serves contract ${deployed.identity.contractDigest} but this checkout builds ${contractDigest()} — ` +
            `${verdict.reason}. Deploy this commit to that channel before shipping clients generated from it.`
        );
      } else {
        console.log(`ok    deployed hub at ${deployed.versionUrl} serves this checkout's contract ${deployed.identity.contractDigest}`);
        console.log(`ok    deployed commit ${deployed.identity.commit} on channel ${deployed.identity.channel}`);
      }
    }

    if (!problems.length) {
      console.log(
        `ok    channel "${this.channel.name}" is in sync across ${this.artifacts.length} generated file(s) — contract ${contractDigest()} (${CONTRACT_VERSION})`
      );
    }
    return problems;
  }

  // CD, after a verified deploy.
  async syncPin() {
    // A stdio channel is not deployed anywhere, so there is nothing to read and nothing
    // that could have been verified. Recording a pin for it would be inventing evidence
    // — the one thing --sync-pin must never do.
    if (this.channel.isStdio) {
      return [
        `channel "${this.channel.name}" is served over stdio, so it has no deployment to pin.`,
        '      --sync-pin applies to http channels only.',
      ];
    }
    const deployed = await this.channel.fetchDeployedIdentity(this.timeoutMs);
    if (!deployed.reachable) {
      return [`cannot read the deployed contract: ${deployed.reason}`, '      --sync-pin must never guess. A pin is only advanced from a hub that answered.'];
    }

    const { contractVersion, contractDigest: deployedDigest } = deployed.identity;
    if (!/^[0-9a-f]{12}$/.test(deployedDigest || '')) {
      return [`the deployed hub reported a malformed contract digest: ${deployedDigest}`];
    }
    // The deployed hub must be serving THIS checkout's contract. If not, the pipeline is
    // mid-rollout or someone deployed another commit, and advancing the pin would record
    // a contract these clients were never generated from.
    if (deployedDigest !== contractDigest()) {
      return [
        `the deployed hub serves contract ${deployedDigest} but this checkout builds ${contractDigest()}`,
        '      Refusing to pin a contract these clients were not generated from.',
      ];
    }

    const previous = this.channel.lastVerified;
    const record = {
      contractVersion,
      contractDigest: deployedDigest,
      commit: deployed.identity.commit ?? null,
      at: new Date().toISOString(),
    };
    const unchanged = previous && previous.contractDigest === record.contractDigest && previous.commit === record.commit;

    this.manifest.channels[this.channel.name].lastVerified = record;
    fs.writeFileSync(CHANNELS_PATH, `${JSON.stringify(this.manifest, null, 2)}\n`);

    console.log(
      unchanged
        ? `ok    channel "${this.channel.name}" already recorded at ${record.contractDigest} (commit ${record.commit}) — nothing to commit`
        : `ok    channel "${this.channel.name}" now verified at contract ${record.contractDigest} (${contractVersion}), commit ${record.commit}`
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// The function facade
// ---------------------------------------------------------------------------
// The tests and the e2e tiers drive these directly, with plain objects rather than
// Channel instances. Keeping them as functions is deliberate: a test that wants to know
// what a Codex config looks like for a hypothetical channel should not have to build a
// manifest to ask.
const resolveChannel = (manifest) => Channel.resolve(manifest, arg('channel') || process.env.PIVOTLY_CHANNEL || manifest.default);

const writeMcpJson = (client, channel) => new McpJsonWriter(client).render(channel);
const writeToml = (client, channel) => new TomlWriter(client).render(channel);
const writeGeminiJson = (client, channel) => new GeminiJsonWriter(client).render(channel);

// The config every declared client should currently have, as text.
const renderAll = (channel, only = null) => ClientTarget.all(only).map((t) => t.configArtifact(channel));

const skillNames = () => Skill.names();
const renderSkill = (source, clientId, label) => {
  const skill = Object.create(Skill.prototype);
  Object.assign(skill, { name: label, file: label, label, source });
  return skill.renderFor(clientId);
};
const skillReach = (source, label) => {
  const skill = Object.create(Skill.prototype);
  Object.assign(skill, { name: label, file: label, label, source });
  return skill.reach;
};

// Formats keyed the way the old module exposed them, for anything that introspects
// which formats have a writer.
const WRITERS = Object.fromEntries(
  [...ConfigWriter.registry.entries()].map(([format, subclass]) => [format, (client, channel) => new subclass(client).render(channel)])
);

async function main() {
  const manifest = readJson(CHANNELS_PATH);
  const channel = resolveChannel(manifest);
  const generator = new Generator({
    manifest,
    channel,
    only: arg('client'),
    timeoutMs: Number(arg('timeout-ms', '10000')),
  });

  const fail = (problems) => {
    for (const p of problems) console.error(`FAIL  ${p}`);
    process.exitCode = 1;
  };

  if (flag('print')) return generator.print();
  if (flag('write')) {
    const problems = generator.write();
    if (problems.length) fail(problems);
    return;
  }
  if (flag('sync-pin')) {
    const problems = await generator.syncPin();
    if (problems.length) fail(problems);
    return;
  }

  const problems = await generator.check();
  if (problems.length) fail(problems);
}

module.exports = {
  // classes
  Artifact,
  Channel,
  ConfigWriter,
  McpJsonWriter,
  TomlWriter,
  GeminiJsonWriter,
  ToolSurface,
  Skill,
  ClientTarget,
  Generator,
  // the function facade
  renderAll,
  headersFor,
  resolveChannel,
  writeMcpJson,
  writeToml,
  writeGeminiJson,
  renderSkill,
  skillReach,
  skillNames,
  WRITERS,
  SERVER_NAME,
  CHANNELS_PATH,
  SKILLS_SRC,
  getClient,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  });
}
