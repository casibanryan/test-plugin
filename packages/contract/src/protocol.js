// packages/contract/src/protocol.js
// Protocol, channel and client constants. THE source of truth — the hub, every client
// generator, CI, and the deployed /version endpoint all read these, so a bump here is
// the single event that ripples outward. Nothing in this file may import a sibling
// workspace.

'use strict';

// MCP wire protocol the hub speaks. CI cross-checks it against what the deployed hub
// reports, so a client pinning an older version finds out here rather than at runtime.
const MCP_PROTOCOL_VERSION = '2025-06-18';

// Protocol versions the hub will still accept from an older client. The oldest entry is
// the compatibility floor; dropping one is a breaking contract change.
const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// The Pivotly contract: the tool surface plus the conventions around it.
// MAJOR = a tool or field was removed, or its meaning changed (clients must update).
// MINOR = additive only (older clients keep working).
const CONTRACT_VERSION = '0.3.1';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
// The promotion ladder, ordered from least to most protected. Promotion always moves
// left to right and the pipeline refuses a skip.
//
// Each rung has a different trigger, which is the point of having four:
//
//   local        your machine. `npm run dev:hub`.
//   dev          redeployed on every push to main, no gate. There is always something
//                live to point a client at that is newer than the last release.
//   prerelease   deployed on a version tag and fully verified. What production is
//                about to become.
//   production   an approval, then a slot swap from prerelease.
//   bundled      no host at all: the greeting server ships inside the plugin and the
//                client spawns it over stdio. It is first on the list because it is
//                the DEFAULT — a plugin that works the moment it is installed, with
//                no network, no account and nothing deployed.
const CHANNELS = ['bundled', 'local', 'dev', 'prerelease', 'production'];

// How a client reaches each channel. Two answers, and the difference is not cosmetic:
// an `http` channel is a URL someone has to deploy and keep up, and a `stdio` channel
// is a process the client starts itself. Every check that asserts something about a
// URL has to consult this first, or it will demand an https address from a channel
// that has no address at all.
const CHANNEL_TRANSPORTS = {
  bundled: 'stdio',
  local: 'http',
  dev: 'http',
  prerelease: 'http',
  production: 'http',
};

const transportOf = (channel) => CHANNEL_TRANSPORTS[channel] || null;
const HTTP_CHANNELS = CHANNELS.filter((c) => CHANNEL_TRANSPORTS[c] === 'http');
const STDIO_CHANNELS = CHANNELS.filter((c) => CHANNEL_TRANSPORTS[c] === 'stdio');

// Channels that must never run on plaintext HTTP. `local` and `dev` may; the two below
// carry real traffic and are held to https. `bundled` is absent because it never
// touches a network — there is no transport to secure.
const HARDENED_CHANNELS = ['prerelease', 'production'];

// Which channel a push to main keeps current, and which one a tag deploys to. Read by
// the workflows so the ladder is declared here rather than buried in YAML.
const CONTINUOUS_CHANNEL = 'dev';
const RELEASE_CHANNEL = 'prerelease';
const PRODUCTION_CHANNEL = 'production';

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
// The host applications that connect to the hub. Every one of them is generated from
// this repository's contract and channel manifest, which is the whole reason this list
// lives in the contract: adding a client is a data change, and CI then verifies the new
// client's config the same way it verifies the others.
//
// `configPath` is relative to packages/clients/<id>/ and is GENERATED — never
// hand-edited. `format` tells the generator which writer to use.
const CLIENTS = [
  {
    id: 'axle',
    title: 'Axle (Claude Code)',
    host: 'Claude Code',
    format: 'mcp-json',
    configPath: '.mcp.json',
    // Installed as a Claude Code plugin, so it also carries a plugin manifest and skills.
    plugin: true,
  },
  {
    id: 'codex',
    title: 'Codex CLI',
    host: 'Codex CLI',
    format: 'toml',
    configPath: 'config.toml',
    plugin: false,
  },
  {
    id: 'gemini',
    title: 'Gemini CLI',
    host: 'Gemini CLI',
    // Near enough to Claude Code's mcp-json to be tempting to share a writer with,
    // and deliberately not: Gemini names an HTTP server with `httpUrl` (a plain
    // `url` means SSE there) and has no `type` discriminator. A shared writer would
    // emit a config Gemini reads as a different transport — a failure that surfaces
    // at connect time rather than at generate time.
    format: 'gemini-json',
    configPath: 'settings.json',
    plugin: false,
  },
];

const CLIENT_IDS = CLIENTS.map((c) => c.id).sort();
const getClient = (id) => CLIENTS.find((c) => c.id === id) || null;

// ---------------------------------------------------------------------------
// The hub's HTTP surface
// ---------------------------------------------------------------------------
// The pipeline probes these by name, so they are contract rather than implementation
// detail.
const ENDPOINTS = {
  mcp: '/mcp',
  health: '/healthz',  // liveness: the process is up
  ready: '/readyz',    // readiness: this build is internally coherent and can serve
  version: '/version', // build identity, used by the deploy gate and client autopatch
};

// Non-secret request metadata clients send. There is no Authorization header: the hub
// serves two pure functions and holds nothing worth protecting, so it is anonymous by
// design (see docs/ARCHITECTURE.md). These exist so the hub's logs can answer "which
// client, on which channel, built against which contract" — the question you have to
// answer before retiring a contract version.
const HEADERS = {
  client: 'x-pivotly-client',       // which client is calling: axle, codex, ...
  channel: 'x-pivotly-channel',     // which channel that client is configured for
  clientContract: 'x-pivotly-contract', // the contract version it was built against
  requestId: 'x-request-id',
};

// The exact keys ENDPOINTS.version must expose. The deploy gate and the client
// autopatch both read them, so a missing one is a contract break, not a cosmetic gap.
const VERSION_PAYLOAD_KEYS = [
  'server',
  'serverVersion',
  'contractVersion',
  'contractDigest',
  'mcpProtocolVersion',
  'channel',
  'commit',
  'builtAt',
];

module.exports = {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  CONTRACT_VERSION,
  CHANNELS,
  CHANNEL_TRANSPORTS,
  HTTP_CHANNELS,
  STDIO_CHANNELS,
  transportOf,
  HARDENED_CHANNELS,
  CONTINUOUS_CHANNEL,
  RELEASE_CHANNEL,
  PRODUCTION_CHANNEL,
  CLIENTS,
  CLIENT_IDS,
  getClient,
  ENDPOINTS,
  HEADERS,
  VERSION_PAYLOAD_KEYS,
};
