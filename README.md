# pivotly-ai

A working reference for the Pivotly Claude client and the pipeline that ships it:
a cloud-hosted MCP server on Azure App Service, a Claude Code plugin that talks to it,
and a shared contract that makes a change to one fail loudly in the other.

Small enough to read in a sitting. The interesting parts are the contract, the
client/service split, and the three test tiers.

## The three workspaces

| Workspace | What it is |
| --- | --- |
| [`packages/contract`](packages/contract) | the single source of truth — tool schemas, types, auth conventions, protocol and channel versions. Imports nothing from its siblings. |
| [`packages/hub`](packages/hub) | the cloud MCP server. Stateless, no database; reads and writes through the Pivotly platform API. |
| [`packages/clients/axle`](packages/clients/axle) | the Claude Code plugin. Connects over HTTPS and exposes a **read-only** surface. |

Full picture, and the reasoning behind each decision:
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Two rules that shape everything

**The plugin cannot write.** The tool surface is split by audience. Client tools are
read-only; write and queue tools are service-only and are refused three independent
ways — the contract will not build a writable client tool, the hub never registers one
for a client session (`tools/list` does not mention it), and the platform API rejects a
client credential on every write endpoint. Only the last of those is out of reach of a
bug in this repository, which is why it is the platform's job.

**The hub owns no data.** No connection string, no schema, no migrations, no state. It
is a protocol adapter: MCP in, HTTPS out, forwarding the caller's own bearer token so
the API authorises the end user rather than the hub. A deploy is a process restart.

## Try it

```sh
npm ci
npm run dev:api     # a fake platform API on 8790 — a test double, not the platform
npm run dev:hub     # the hub on 8787
```

Then speak MCP to it. `dev-token` is a **client** credential; `worker-token` is a
service one:

```sh
# a client is served three read-only tools
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer dev-token' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# and cannot reach the write tool, even by name
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer dev-token' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"usdf_record_put","arguments":{"kind":"greeting.session","payload":{}}}}'
# -> "Tool usdf_record_put not found"
```

`GET /healthz`, `/readyz` and `/version` are the three probes the pipeline drives.

## Verify it

```sh
npm run verify:all   # contract lock, version coherence, all tests, client manifests
npm run e2e          # all three tiers against a stack it boots itself
```

`npm run e2e` needs nothing running — with no `--hub-url` it stands up the fake API and
the hub on ephemeral ports and runs the identical tier code that runs against
production.

Current state: 22 contract self-tests, 49 hub tests over a real socket, 22 client tests,
70 manifest checks, 34 remote smoke checks, 40 upstream assumptions, 30 e2e checks
across three tiers.

## Install the plugin

The repo is its own marketplace. In Claude Code:

```
/plugin marketplace add OWNER/REPO
/plugin install axle@pivotly
```

Set `PIVOTLY_MCP_TOKEN` to a Pivotly **client** token first. To point at a different
channel:

```sh
PIVOTLY_CHANNEL=prerelease npm run axle:autopatch -- --write
```

Private repos work — Claude Code clones with your existing git credentials. Background
auto-updates cannot authenticate to private *HTTPS* remotes, so prefer SSH or run
`gh auth setup-git` once.

## The pipeline

[**docs/PIPELINE.md**](docs/PIPELINE.md) has the stage-by-stage walkthrough, the
required secrets and variables, and the one-time Azure setup.

```
CI   contract ─► unit (Node 20, 22) ─► client ─► artifact ─► e2e (3 tiers)

CD   verify ─► pre-release slot ─► verify the slot ─► [approval] ─► slot swap
            ─► verify production ─► sync the client pin ─► release
                                 └─► roll back (another swap) if production fails
```

Three things worth knowing about it:

- **The artifact is built once**, scanned, self-tested from the packaged tree, and then
  deployed byte for byte. No rebuild that is hopefully identical.
- **The deploy is never trusted.** It polls `/version` for the commit it just pushed and
  `/readyz` for actual readiness. An instance can be up, serving the previous build, and
  answer `200` on `/healthz` the whole time.
- **The client's channel pin moves last**, after production verification, so it always
  trails a verified deploy and can never name a build that was rolled back.

## The contract digest

One 12-hex string over the whole tool surface. It lives in three places that must agree:
the committed lock, the deployed hub's `/version`, and the client's channel pin.

That is the guard against the failure this repository is really built around: core
changes, the hub redeploys cleanly, every hub-side check passes, the client manifest
still pins the old surface, and the breakage arrives days later in someone's editor.
`e2e/tiers/tier3-client.js` compares all three, names which pair disagrees, and then
compares the served surface field by field.

## Adding a tool

1. Add a descriptor to [`packages/contract/src/tools.js`](packages/contract/src/tools.js).
   Pick its `audience` — `client` tools **must** be `readOnly`, and the digest builder
   refuses to build a contract that breaks that.
2. Add a handler in [`packages/hub/src/tools/index.js`](packages/hub/src/tools/index.js).
   The hub asserts the declared and implemented sets are equal at boot, so a mismatch is
   a startup failure rather than a broken tool call.
3. `npm run contract:digest -- --write` and commit the lock — the diff is the review.
4. `npm run verify:all`.

## A note on scope

This was built from a written brief describing five layers: the monorepo boundaries, a
database and security layer, an Azure container pipeline, multi-tier testing, and client
channel management. Two deliberate departures, both discussed and decided during the
work:

- **No database or `SECURITY DEFINER` layer in this repo.** An earlier revision had one,
  including PostgreSQL schemas, a job-claim mechanism and CSV-driven allow-lists. It was
  removed because a component sitting behind an editor plugin should not hold a database
  credential — the platform API already owns the schema and the access rules. What
  survives is [`verify-upstream.js`](packages/hub/scripts/verify-upstream.js), which
  asserts the API behaviours the hub depends on, including that a client credential is
  refused on every write.
- **No container or registry.** App Service run-from-package deploys the Node app
  directly. A container image bought an immutable artifact and a layer scan; the
  artifact digest in [`scripts/package-hub.js`](scripts/package-hub.js) and
  `npm audit --omit=dev` cover the same ground for a Node process with no OS layer of
  its own.

The brief also linked a Microsoft Whiteboard board. That link requires a Microsoft
account sign-in and could not be read, so the architecture here is derived from the five
written layers rather than the board — worth a check against it before this is treated
as settled.
