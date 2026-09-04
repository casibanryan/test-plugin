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
// `bundled` is the only channel anything is served on today, and it is the default.
// The four http rungs below are DECLARED but not implemented: the hosted hub was
// removed from this repository while the Azure environment is still being set up (see
// docs/ARCHITECTURE.md). They are kept as data — addresses, transports and the
// promotion order — so that restoring a hosted server is adding a package back, not
// redesigning the ladder. Nothing generates a client for them by default, and
// `lastVerified` is null for all four because none has ever been deployed.
//
//   bundled      no host at all: the server runs as a child process of the client,
//                spoken to over stdio. The DEFAULT, and the reason a plugin works the
//                moment it is installed, with no network, no account, nothing deployed.
//   local        your machine, once there is a hub to run again.
//   dev          intended to redeploy on every push to main, no gate.
//   prerelease   intended to deploy on a version tag, fully verified.
//   production   an approval, then a slot swap from prerelease.
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
    id: 'claude',
    title: 'Claude Code',
    host: 'Claude Code',
    format: 'mcp-json',
    configPath: '.mcp.json',
    // Where this host discovers SKILL.md directories, relative to the client directory.
    // All three hosts read the same open SKILL.md format, so the skills are compiled
    // from ONE source in packages/skills — only the destination differs. A client with
    // no skillsPath simply receives none.
    skillsPath: 'skills',
    // Installed as a Claude Code plugin, so it also carries a plugin manifest, skills,
    // and its own copy of the server — a marketplace install cannot reach this repo.
    plugin: true,
  },
  {
    id: 'codex',
    title: 'Codex CLI',
    host: 'Codex CLI',
    format: 'toml',
    configPath: 'config.toml',
    // Codex reads project skills from .codex/skills. Unlike the plugin client, nothing
    // installs these for the user: they are generated here and have to be copied into
    // the project (or ~/.codex/skills), the same reach limit as this client's config.
    skillsPath: '.codex/skills',
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
    // Same story as Codex: .gemini/skills is a directory in the user's project, not
    // something this package installs.
    skillsPath: '.gemini/skills',
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
  client: 'x-pivotly-client',       // which client is calling: claude, codex, ...
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
