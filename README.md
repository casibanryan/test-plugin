# pivotly-ai

A working reference for shipping an MCP server and its clients: one server, three
generated clients, and a shared contract that makes a change to one fail loudly in the
others.

The tools do something deliberately trivial — they say hello and ask how your day is
going. Everything else is **pipeline**, which is the part worth reading.

**Nothing is deployed, and nothing needs to be.** The server runs as a child process of
whatever client is talking to it, over stdio. Install the plugin and the tools answer:
offline, with no host, no account and no token.

## The workspaces

| Workspace | What it is |
| --- | --- |
| [`packages/contract`](packages/contract) | the single source of truth — tool schemas, error codes, protocol, channels, and the list of clients. Imports nothing from its siblings. |
| [`packages/server`](packages/server) | **the** MCP server. Zero runtime dependencies, spoken to over stdio, hand-rolled JSON-RPC. |
| [`packages/clients`](packages/clients) | every client, **generated** from one channel manifest: `claude` (Claude Code plugin), `codex` (Codex CLI), `gemini` (Gemini CLI). |
| [`e2e`](e2e) | two tiers: the checkout is coherent, and every copy of the server speaks correct MCP over a pipe. |

Reasoning behind each decision: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

### Why the plugin carries a copy of the server

A Claude Code marketplace install copies **only the plugin directory**, with no
`npm install` and no build step. It cannot require its way back into this repository, so
[`packages/clients/claude/server/`](packages/clients/claude/server) holds a copy of
`packages/server`, written by `npm run clients:generate` and compared byte for byte by
`npm run clients:verify`. Codex and Gemini have no such constraint and point straight at
the canonical path.

That is also why the server has **zero dependencies**: the MCP SDK and zod are 10.5 MB
across 1,289 files, and vendoring them into a plugin to serve two pure functions would
trade a little protocol code for a lot of someone else's.

## Two rules that shape everything

**The server owns nothing.** No database, no upstream API, no credentials, no state
between calls. Two read-only tools computed from the arguments in the same request.

**Everything a client ships is generated.** Its config, its tool surface, and its copy
of the server all come from one contract and one channel manifest. Hand-edits fail CI,
and two clients cannot disagree about what the tools are — they are the same data
through different writers.

### There is no authentication, on purpose

The server answers with data you just sent it. Nothing is stored and nothing belongs to
anyone, so a token would be guarding a time-of-day greeting.

That boundary is enforced rather than remembered — the contract **refuses to build** if
any tool is not read-only:

```
tool danger_write declares readOnly: false — every tool must be read-only,
because they are served without authentication.
```

No digest, no lock, no CI pass. The day a tool needs real data, the build stops and auth
stops being optional.

## Try it

No install, no server, no port — pipe a call straight into it:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"greeting_hello","arguments":{"name":"you","hour":9}}}' | node packages/server/greeting-stdio.js
```

## Verify it

```sh
npm ci
npm run ci:local     # every CI job, under the same job names as the workflow
npm run e2e          # both tiers, against every copy of the server
npm run verify:all   # lock, versions, unit tests, client checks, drift
```

Start with `ci:local` — a red job there is the job that would be red in CI.
`--job=client` and `--skip=audit` narrow it down.

Current state: 83 unit tests (22 contract, 19 server, 42 clients), 132 client checks,
28 version checks, and 52 e2e checks across two tiers.

## Install a client

**Claude Code** — the repo is its own marketplace:

```
/plugin marketplace add casibanryan/test-plugin
/plugin install claude@Test-Plugin
```

**Codex CLI** — append the generated block:

```sh
cat packages/clients/codex/config.toml >> ~/.codex/config.toml
```

**Gemini CLI** — merge `packages/clients/gemini/settings.json` into `~/.gemini/settings.json`.

None needs a token. The Codex and Gemini configs name a repo-relative path, so they
assume you have this checkout; the Claude Code plugin is self-contained.

## The channel ladder

Five channels are declared. **One of them is real.**

| Channel | State |
| --- | --- |
| `bundled` | The default, and the only one anything is served on. Needs no host: the client spawns the server over stdio. |
| `local`, `dev`, `prerelease`, `production` | **Declared, not implemented.** Addresses and promotion order for a hosted server that is not in this repository. |

The hosted hub was removed while the Azure environment is still being set up. What is
left of it is data — the four addresses, their transports, the promotion order, and the
`lastVerified` slots (all `null`, because none has ever been deployed) — so restoring a
hosted server is adding a package back, not redesigning the ladder. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for what was removed and what has to come
back with it.

## The contract digest

One 12-hex string over the whole surface. Every generated artifact records it, so a tool
surface cannot change without a reviewed lock diff, and no client can ship a surface the
contract does not declare.

With everything served from this checkout, the digest cannot lag the way it could when a
deployed hub was in the picture. `clients:check` says so in as many words:

```
ok    channel "bundled" is served over stdio from this checkout,
      so its contract is 9056dac5f839 by construction
```

## Adding a tool

1. Add a descriptor to [`packages/contract/src/tools.js`](packages/contract/src/tools.js).
   It **must** be `readOnly` — the digest builder refuses anything else.
2. Add a handler to `HANDLERS` in
   [`packages/server/greeting-stdio.js`](packages/server/greeting-stdio.js).
3. `npm run contract:digest -- --write` and `npm run clients:generate`.
4. `npm run verify:all`.

Step 3 is what copies the change into every plugin. Skip it and `clients:verify` fails,
naming the file that drifted.

## Adding a client

1. Add an entry to `CLIENTS` in [`packages/contract/src/protocol.js`](packages/contract/src/protocol.js).
2. If it needs a new config format, add a writer in
   [`packages/clients/scripts/generate.js`](packages/clients/scripts/generate.js).
3. Mark it `plugin: true` only if it has to carry its own copy of the server.
4. `npm run clients:generate`.

`verify.js`, the version check and the e2e protocol tier all iterate the contract's
client list, so a new client comes under every existing check automatically.

## A note on scope

Built from a brief describing five layers: monorepo boundaries, a database and security
layer, an Azure container pipeline, multi-tier testing, and client channel management.
Four deliberate departures, each decided during the work:

- **No database or `SECURITY DEFINER` layer.** An earlier revision had one — PostgreSQL
  schemas, a job-claim mechanism, CSV allow-lists. Removed: a component sitting behind
  an editor plugin should not hold a database credential.
- **No container or registry**, and now no hosted server at all. The Azure environment
  is still being set up, so the hub and its packaging step were removed rather than
  left as scaffolding around nothing.
- **No authentication.** With no stored data there is nothing to protect, and the
  read-only invariant in the contract is what keeps that honest as the surface grows.
- **stdio rather than HTTP.** For tools that are pure functions of their arguments, the
  network hop bought nothing and cost availability.

The brief also linked a Microsoft Whiteboard board that requires a sign-in and could not
be read, so this is derived from the five written layers rather than the board — worth
checking against it before treating the layout as settled.
