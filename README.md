# pivotly-ai

A working reference for shipping an MCP server and its clients: a stateless MCP hub on
Azure App Service, two generated clients, and a shared contract that makes a change to
one fail loudly in the others.

The hub does something deliberately trivial — it says hello and asks how your day is
going. Everything else is **pipeline**, which is the part worth reading.

## The three workspaces

| Workspace | What it is |
| --- | --- |
| [`packages/contract`](packages/contract) | the single source of truth — tool schemas, error codes, protocol, channels, and the list of clients. Imports nothing from its siblings. |
| [`packages/hub`](packages/hub) | the MCP server. Stateless, anonymous, no database, no upstream. |
| [`packages/clients`](packages/clients) | every client, **generated** from one channel manifest: `axle` (Claude Code plugin) and `codex` (Codex CLI). |

Reasoning behind each decision: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Two rules that shape everything

**The hub owns nothing.** No database, no upstream API, no credentials, no state between
requests. Two read-only tools computed from the arguments in the same request. A deploy
is a process restart; there is nothing to migrate and nothing to lose.

**Every client is generated.** A channel URL exists in exactly one place. Repointing
every client at `dev` is one command, hand-edits fail CI, and two clients cannot
disagree about the tool surface — they are the same data through different writers.

### There is no authentication, on purpose

The hub serves data you just sent it. Nothing is stored, nothing belongs to anyone, so a
token would guard a time-of-day greeting. **Anyone who can reach the URL can call these
tools.**

That boundary is enforced rather than remembered — the contract **refuses to build** if
any tool is not read-only:

```
tool danger_write declares readOnly: false — every tool on this hub must be
read-only, because the hub serves them without authentication.
```

No digest, no lock, no CI pass, no artifact. The day a tool needs real data, the build
stops and auth stops being optional.

## Try it

```sh
npm ci
npm run dev:hub     # http://127.0.0.1:8787 — no .env, no token, no setup
```

Then speak MCP to it:

```sh
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"greeting_hello","arguments":{"name":"Resty","hour":9}}}'
```

`GET /healthz`, `/readyz` and `/version` are the three probes the pipeline drives.

## Verify it

```sh
npm run ci:local              # every offline CI job, same job names as the workflow
npm run e2e                   # all three tiers against a hub it starts itself
npm run e2e -- --all-channels # the whole ladder: local, dev, prerelease, production
```

Start with `ci:local` — a red job there is the job that would be red in CI.
`--job=clients` and `--skip=artifact` narrow it down.

`--all-channels` is the one to reach for when you want the state of every deployed rung
at once. Channels that are not deployed are **skipped with a note**, not failed.

Current state: 22 contract self-tests, 39 hub tests over a real socket, 25 client tests,
97 client checks, 28 version checks, ~35 remote smoke checks, 50 e2e checks across three
tiers.

## Install a client

**Claude Code** — the repo is its own marketplace:

```
/plugin marketplace add casibanryan/test-plugin
/plugin install axle@pivotly
```

**Codex CLI** — append the generated block:

```sh
cat packages/clients/codex/config.toml >> ~/.codex/config.toml
```

Neither needs a token. To point every client at a different channel:

```sh
PIVOTLY_CHANNEL=dev npm run clients:generate
```

Switch back to `production` before committing — CI fails on the drift, by design.

## The channel ladder

Four channels, **three different triggers**, which is the point of having four:

```
push to main   ──►  dev          no gate, deploys every merge
tag v*.*.*     ──►  prerelease   verified, then held at an approval
               ──►  production   slot swap from prerelease, verified again
local                            your machine
```

Every deploy job polls `/version` for **its own commit SHA** before declaring success —
an instance can be up, serving the previous build, and answer `200` on `/healthz` the
whole time. Each rung then advances its own channel pin, so `channels.json` records what
each channel is *proven* to be serving.

Stage-by-stage walkthrough, required secrets, and the one-time Azure setup:
**[docs/PIPELINE.md](docs/PIPELINE.md)**.

## The contract digest

One 12-hex string over the whole surface, in three places that must agree: the committed
lock, the deployed hub's `/version`, and the clients' channel pin.

That is the guard against the failure this repository is built around: core changes, the
hub redeploys cleanly, every hub-side check passes, the clients still point at the old
surface, and the breakage arrives days later in someone's editor.
[`tier3-clients.js`](e2e/tiers/tier3-clients.js) compares all three, names which pair
disagrees, then compares the served surface field by field.

## Adding a tool

1. Add a descriptor to [`packages/contract/src/tools.js`](packages/contract/src/tools.js).
   It **must** be `readOnly` — the digest builder refuses anything else.
2. Add a handler in [`packages/hub/src/tools/index.js`](packages/hub/src/tools/index.js).
   The hub asserts the declared and implemented sets match at boot.
3. `npm run contract:digest -- --write` and `npm run clients:generate`.
4. `npm run verify:all`.

## Adding a client

1. Add an entry to `CLIENTS` in [`packages/contract/src/protocol.js`](packages/contract/src/protocol.js).
2. If it needs a new config format, add a writer in
   [`packages/clients/scripts/generate.js`](packages/clients/scripts/generate.js).
3. `npm run clients:generate`.

`verify.js` and the version check iterate the contract's client list, so a new client
comes under every existing check automatically.

## A note on scope

Built from a brief describing five layers: monorepo boundaries, a database and security
layer, an Azure container pipeline, multi-tier testing, and client channel management.
Three deliberate departures, each decided during the work:

- **No database or `SECURITY DEFINER` layer.** An earlier revision had one — PostgreSQL
  schemas, a job-claim mechanism, CSV allow-lists. Removed: a component sitting behind
  an editor plugin should not hold a database credential.
- **No container or registry.** App Service run-from-package deploys the Node app
  directly. The artifact digest in [`scripts/package-hub.js`](scripts/package-hub.js) and
  `npm audit --omit=dev` cover what a layer scan would, for a process with no OS layer.
- **No authentication.** With no stored data there is nothing to protect, and the
  read-only invariant in the contract is what keeps that honest as the surface grows.

The brief also linked a Microsoft Whiteboard board that requires a sign-in and could not
be read, so this is derived from the five written layers rather than the board — worth
checking against it before treating the layout as settled.
