# Architecture

Three workspaces, one dependency direction, and two rules that decide most of the
design: **the server owns nothing, and everything a client ships is generated.**

```
                    ┌──────────────────────────┐
                    │  packages/contract       │   the single source of truth
                    │  tool schemas · errors   │   nothing here imports a sibling
                    │  protocol · channels     │
                    │  the client list         │
                    └────────────┬─────────────┘
                                 │  everything derives from it
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
   ┌──────────────────────────┐    ┌──────────────────────────────┐
   │ packages/clients         │    │ packages/server              │
   │   channels.json (shared) │    │ the MCP server               │
   │   claude/  Claude Code   │    │ zero dependencies            │
   │   codex/   Codex CLI     │    │ stdio · hand-rolled JSON-RPC │
   │   gemini/  Gemini CLI    │    │ two pure functions           │
   └───────────┬──────────────┘    └───────────────┬──────────────┘
               │                                   │
               │      generate.js copies the       │
               └───────────◄───────────────────────┘
                    server into claude/server/
```

Dependencies point **inward only**. `contract` imports nothing from `server` or
`clients`; if it ever needed to, the thing it needed does not belong in the contract.

## What the server is

Two read-only tools — `greeting_hello` and `greeting_day_check` — computed from the
arguments in the same request. No database. No upstream API. No credentials. No state
between calls. A client spawns it as a child process and speaks newline-delimited
JSON-RPC 2.0 to it over stdin and stdout.

That is not a placeholder for something bigger; it is the whole point. With nothing to
connect to and nothing to protect, every remaining moving part is **pipeline**: build,
generate, verify, publish. Anything that fails is a pipeline problem, which is what
makes this repository a useful reference rather than a demo with a pipeline bolted on.

## Why stdio, and why the plugin carries a copy

A plugin whose tools live behind a URL is only as available as that URL. Until something
is deployed — or when a free tier sleeps, or DNS is wrong, or a demo happens on a train
— an install produces a plugin whose tools do not answer, which reads to a user as a
broken plugin rather than a missing deployment. For tools that are pure functions of
their own arguments, the network hop buys nothing and costs exactly that.

So the server runs locally, and the client starts it. That creates one constraint worth
understanding, because it shapes the layout:

> A Claude Code marketplace install copies **only the plugin directory**. No
> `npm install`, no build step, no way to require anything outside it.

Hence the copy. `packages/server` is canonical; `npm run clients:generate` writes three
files into [`packages/clients/claude/server/`](../packages/clients/claude/server):

| File | How it gets there |
| --- | --- |
| `greeting-stdio.js` | copied byte for byte from `packages/server` |
| `greeting.js` | copied byte for byte from `packages/server` |
| `tools.json` | compiled from the contract's `TOOLS` into JSON Schema |

Codex and Gemini are not plugins and have no such constraint, so their configs name
`packages/server/greeting-stdio.js` directly. Only a client marked `plugin: true` in the
contract gets a copy.

**What stops the copies diverging.** Everything about them is derived, not duplicated:

- Both copied files are compared **byte for byte** against `packages/server` by
  `clients:verify`, and both are pinned to LF in `.gitattributes` so the comparison
  means the same thing on Windows and Linux.
- `tools.json` is generated from the contract, so no copy can advertise a surface the
  contract does not declare. It also records the contract digest and version.
- The server may `require` nothing outside its own directory, which is checked on the
  shipped copy. A dependency there would be a crash on someone else's machine rather
  than a build failure here.
- The e2e protocol tier spawns **every** copy, including the plugin's, and drives the
  full MCP exchange against each.

The cost is a hand-rolled JSON-RPC loop instead of the MCP SDK. That is deliberate: the
SDK and zod are 10.5 MB across 1,289 files, and vendoring them into a plugin to serve
two pure functions would trade a small amount of protocol code for a large amount of
someone else's.

### Why there is no authentication

The server answers with data the caller just sent it. There is no tenant data, no stored
record, nothing that belongs to anyone. A token would have to be distributed to every
client and would guard a time-of-day greeting.

The boundary is enforced rather than remembered. `packages/contract/src/digest.js`
refuses to build a contract in which any tool is not `readOnly`:

```
tool danger_write declares readOnly: false — every tool must be read-only,
because they are served without authentication.
```

No digest means no lock and no CI pass. So the day a tool needs to touch real data, the
build stops and auth stops being optional — you cannot drift into serving a write
endpoint anonymously.

## What was removed, and what comes back with it

There used to be a fourth workspace, `packages/hub`: the same two tools served over
Streamable HTTP from Azure App Service, with health probes, structured logging, a
packaged run-from-package artifact, and a four-rung deploy ladder.

**It was removed while the Azure environment is still being set up by the DevOps team.**
The reasoning was that scaffolding around a service that does not exist is worse than an
honest absence: a deploy pipeline with nothing to deploy goes stale, and the checks that
guard it pass vacuously.

Removed with it:

| What | Why it could not stay |
| --- | --- |
| `packages/hub` | the server itself, its HTTP layer, probes and logging |
| `scripts/package-hub.js` | built the App Service artifact — nothing to package |
| the `artifact` CI job | scanned, booted and uploaded that artifact |
| `e2e/tiers/tier3-clients.js` | compared the repo, the **deployed** hub and the clients |
| tier 2's old body | ran `smoke-remote.js` against a URL; it now drives stdio |
| `npm run dev:hub`, `hub:selftest`, `smoke`, `package:hub` | all needed the hub |

**Deliberately kept**, because they are data rather than machinery and cost nothing:

- the four http channels in `CHANNELS` and `channels.json`, with their addresses,
  transports, promotion order and `lastVerified` slots (all `null` — none was ever
  deployed)
- `ENDPOINTS`, `HEADERS` and `VERSION_PAYLOAD_KEYS` in the contract
- `HARDENED_CHANNELS` and the https enforcement in the generator
- the generator's `--sync-pin` path and its http config writers, with the tests that
  drive them against a fake hub

So restoring a hosted server is **adding a package back**, not redesigning the ladder.
What would have to come with it: an HTTP transport that registers the same `HANDLERS`,
the `/healthz`, `/readyz` and `/version` endpoints the contract already declares, a
packaging step, the deploy jobs, and a tier that compares the deployed digest against
the built one.

## What a client is

The word is overloaded, so: in this repository a **client** is a *host application* that
speaks MCP — Claude Code, Codex CLI, Gemini CLI, and whatever comes next. Not a user,
and not a kind of credential.

`packages/contract/src/protocol.js` declares them as data:

```js
{ id: 'claude', host: 'Claude Code', format: 'mcp-json',   configPath: '.mcp.json',   plugin: true  }
{ id: 'codex',  host: 'Codex CLI',   format: 'toml',       configPath: 'config.toml', plugin: false }
{ id: 'gemini', host: 'Gemini CLI',  format: 'gemini-json', configPath: 'settings.json', plugin: false }
```

`packages/clients/scripts/generate.js` turns one channel manifest into one config per
client, in the format that client wants. Adding a fourth is a data change plus a writer
function — never a second copy of the channel list.

`format` is not cosmetic. Gemini's shape looks close enough to Claude Code's to tempt a
shared writer, and is not: Gemini names an HTTP server with `httpUrl` (a plain `url`
means SSE there) and has no `type` discriminator. A shared writer would emit a config
Gemini reads as a different transport — a failure that surfaces at connect time rather
than at generate time.

Consequences worth naming:

- **A channel's address exists in exactly one place.** Repointing every client is one
  command.
- **The configs are generated, so they can be verified.** CI regenerates and compares;
  a hand-edit fails the build rather than surviving until someone notices.
- **Clients cannot disagree with each other.** They are the same data through different
  writers.

## Channels

Five, declared in the contract and mapped in `packages/clients/channels.json`. **One is
implemented.**

| Channel | Transport | State |
| --- | --- | --- |
| `bundled` | stdio | the default, and the only one served today |
| `local` | http | declared; needs a hub to run |
| `dev` | http | declared; intended to redeploy on every push to `main` |
| `prerelease` | http | declared; intended to deploy on a `v*.*.*` tag |
| `production` | http | declared; an approval, then a slot swap |

`prerelease` and `production` are **hardened**: the generator refuses a non-https URL for
them and refuses to serve them over stdio. `local` is the only channel allowed plaintext.

`lastVerified` records what a channel was last *proven* to be serving. It is `null` for
all five and is written only by CD after a deploy passes — never inferred, never
advanced by a run that deployed nothing.

## The contract digest

One 12-hex string derived from the entire surface — tool names, descriptions, every
input field's type and requiredness, error codes, endpoint paths, header names, the
channel list, and the client list.

| Where | What it means |
| --- | --- |
| `packages/contract/contract.lock.json` | what this repository builds |
| `packages/server/tools.json` and each plugin's copy | what the server advertises |
| `packages/clients/channels.json` | what a channel was last proven to serve |

This is the cascade guard. The failure it exists to catch is a tool surface that changes
in one place and lags in another — historically, a redeployed hub whose clients still
pinned the old digest, with the breakage arriving days later in someone's editor.

With everything served from this checkout that particular gap is closed by construction:
the tool surface every server answers with is generated from the contract and
drift-checked, so it cannot lag. `clients:check` reports exactly that rather than
implying it probed something:

```
ok    channel "bundled" is served over stdio from this checkout,
      so its contract is 9056dac5f839 by construction
```

The digest still earns its place — it is what makes a surface change a reviewed lock
diff, and what a restored hosted channel would be checked against.

## Tools as data, not as code

`packages/contract/src/tools.js` declares tools as plain descriptors:

```js
{ name: 'greeting_hello', readOnly: true,
  input: { hour: { type: 'integer', optional: true, min: 0, max: 23, describe: '…' } } }
```

`src/zod.js` derives validators from those descriptors, and `generate.js` derives JSON
Schema from the same ones, so the schema advertised to a client and the schema the
server validates against are the same definition — not two that happen to agree today.

Declaring them as data is what makes the digest possible: a hash over plain JSON is
stable, language-neutral, and diffable in review.

Adding a tool means adding a descriptor and a handler in `packages/server`. The two sets
must be equal, and `assertHandlersMatchContract` in `packages/server/index.js` says so —
called from that package's own tests and again from e2e tier 1. The hub used to run it
at boot, which turned a mismatch into a crash the deploy gate caught; with no boot to
crash, the tests are the earliest point it can still be caught.

## Layout

```
packages/contract/          @pivotly/contract — the source of truth
  src/protocol.js           versions, channels, endpoints, headers, the client list
  src/tools.js              the tool surface, as data
  src/zod.js                descriptors -> zod validators
  src/errors.js             shared error codes and their HTTP statuses
  src/digest.js             the digest, and the read-only invariant it enforces
  contract.lock.json        committed; CI fails on drift

packages/server/            @pivotly/server — the MCP server, canonical copy
  greeting-stdio.js         JSON-RPC over stdio; zero dependencies
  greeting.js               the pure logic everything else is scaffolding around
  tools.json                GENERATED from the contract
  index.js                  the contract-aware face: assertHandlersMatchContract
  test/                     greeting unit tests, and contract coherence

packages/skills/            the canonical skills, one copy of each
  <name>/SKILL.md           prose + host-conditional blocks, rendered per client

packages/clients/           @pivotly/clients — every client, generated
  channels.json             SHARED: channel -> address + what it last served
  scripts/generate.js       one manifest -> every client config, and the copies
  scripts/verify.js         what a marketplace install depends on
  claude/                   Claude Code plugin (manifest + skills/ + hooks + server/)
  codex/                    Codex CLI (config.toml + .codex/skills/)
  gemini/                   Gemini CLI (settings.json + .gemini/skills/)

e2e/                        tier 1 contract, tier 2 protocol over a real pipe
scripts/verify-versions.js  one check: every version and channel pin agrees
scripts/ci-local.js         runs CI on your machine, under the same job names
```
