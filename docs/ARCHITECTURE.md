# Architecture

Three workspaces, one dependency direction, and two rules that decide most of the
design: **the hub owns nothing, and every client is generated.**

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
   │ packages/clients         │    │ packages/hub                 │
   │   channels.json (shared) │    │ stateless MCP server         │
   │   axle/   Claude Code    │◄──►│ Azure App Service            │
   │   codex/  Codex CLI      │MCP │ two pure functions           │
   └──────────────────────────┘    └──────────────────────────────┘
```

Dependencies point **inward only**. `contract` imports nothing from `hub` or `clients`;
if it ever needed to, the thing it needed does not belong in the contract.

## What the hub is

Two read-only tools — `greeting_hello` and `greeting_day_check` — computed from the
arguments in the same request. No database. No upstream API. No credentials. No state
between requests.

That is not a placeholder for something bigger; it is the whole point. With nothing to
connect to and nothing to protect, every remaining moving part is **pipeline**: build,
package, deploy, promote, verify. Anything that fails is a pipeline problem, which is
what makes this repository a useful reference rather than a demo with a pipeline
bolted on.

## Two transports for one tool surface

Those two tools are served two ways, and a client picks one by naming a channel:

| Channel | Transport | Served by |
| --- | --- | --- |
| `bundled` (default) | stdio | [`packages/clients/axle/server`](../packages/clients/axle/server) — a zero-dependency server inside the plugin |
| `local`, `dev`, `prerelease`, `production` | http | `packages/hub`, deployed |

**Why bundle one at all.** A plugin whose tools live behind a URL is only as available
as that URL. Until something is deployed — or when a free tier sleeps, or DNS is
wrong, or a demo happens on a train — an install produces a plugin whose tools do not
answer, which reads to a user as a broken plugin rather than a missing deployment. The
bundled server removes that dependency for the case that does not need it.

**Why keep the hub.** stdio only works where the client can start a process on the
same machine. Anything served centrally — shared state, credentials, rate limits,
logging, several editors on several laptops — needs the hosted path, and that is what
the channel ladder and the deploy pipeline are for.

**What stops them diverging.** Everything either server answers with is derived, not
duplicated:

- `server/greeting.js` is a **byte-identical** copy of `packages/hub/src/lib/greeting.js`.
  `clients:verify` fails if the two differ, so a tool call cannot answer differently
  depending on which server took it.
- `server/tools.json` is **generated** from the contract's `TOOLS`, so the bundled
  server cannot advertise a surface the hub does not have.
- The bundled server may `require` nothing outside its own directory, which is checked.
  A marketplace install copies the plugin with no `npm install`, so a dependency there
  would be a crash on someone else's machine rather than a build failure here.

The cost is a hand-rolled JSON-RPC loop instead of the MCP SDK. That is deliberate: the
SDK and zod are 10.5 MB across 1,289 files, and vendoring them into a plugin to serve
two pure functions would trade a small amount of protocol code for a large amount of
someone else's.

### Why there is no authentication

The hub serves data the caller just sent it. There is no tenant data, no stored record,
nothing that belongs to anyone. A token would have to be distributed to every client and
would guard a time-of-day greeting — theatre, and theatre that makes every channel
harder to test.

Stated plainly so nobody is surprised later: **anyone who can reach the URL can call
these tools.**

The boundary is enforced rather than remembered. `packages/contract/src/digest.js`
refuses to build a contract in which any tool is not `readOnly`:

```
tool danger_write declares readOnly: false — every tool on this hub must be
read-only, because the hub serves them without authentication.
```

No digest means no lock, no CI pass, and no artifact. So the day a tool needs to touch
real data, the build stops and auth stops being optional — you cannot drift into
serving a write endpoint anonymously.

## What a client is

The word is overloaded, so: in this repository a **client** is a *host application* that
speaks MCP — Claude Code, Codex CLI, and whatever comes next. Not a user, and not a kind
of credential.

`packages/contract/src/protocol.js` declares them as data:

```js
{ id: 'axle',  host: 'Claude Code', format: 'mcp-json', configPath: '.mcp.json', plugin: true }
{ id: 'codex', host: 'Codex CLI',   format: 'toml',     configPath: 'config.toml', plugin: false }
```

`packages/clients/scripts/generate.js` turns one channel manifest into one config per
client, in the format that client wants. Adding a third is a data change plus a writer
function — never a second copy of the channel list.

Consequences worth naming:

- **A channel URL exists in exactly one place.** Repointing every client at `dev` is one
  command.
- **The configs are generated, so they can be verified.** CI regenerates and compares;
  a hand-edit fails the build rather than surviving until someone notices.
- **Clients cannot disagree with each other.** They are the same data through different
  writers.

## Channels

`local → dev → prerelease → production`, declared in the contract and mapped to URLs in
`packages/clients/channels.json`. Promotion moves left to right.

| Channel | Trigger | Gate | What it is for |
| --- | --- | --- | --- |
| `local` | you | — | your machine |
| `dev` | every push to `main` | none | always-live, newer than the last release |
| `prerelease` | a `v*.*.*` tag | verified | what production is about to become |
| `production` | a slot swap | approval | the stable deployment |

`prerelease` and `production` are **hardened**: the client generator refuses a non-https
URL for them, and `local` is the only channel allowed plaintext — loopback only.

Each channel carries its own pinned contract digest, advanced by CD only after that
channel's deploy has been verified. So a pin always trails a proven deploy.

## The contract digest

One 12-hex string derived from the entire surface — tool names, descriptions, every
input field's type and requiredness, error codes, endpoint paths, header names, the
channel list, and the client list. It appears in three places that must agree:

| Where | What it means |
| --- | --- |
| `packages/contract/contract.lock.json` | what this repository builds |
| the hub's `GET /version` | what the deployed endpoint serves |
| `packages/clients/channels.json` | what the clients were generated against |

This is the cascade guard. The failure it exists to catch:

1. the tool surface changes in `packages/contract`
2. the hub is rebuilt and deployed — internally consistent, so every hub-side check passes
3. the channel manifest still pins the **old** digest
4. nothing fails anywhere in the pipeline
5. a user's editor calls a tool whose schema moved, days later and several directories
   from the change that caused it

`e2e/tiers/tier3-clients.js` compares all three, names which pair disagrees, and then
compares the served surface field by field — because a digest match with a differing
surface would mean the digest is not covering something it should.

Because every client is generated from the same contract, **one digest covers all of
them**: Axle and Codex cannot disagree about the tool surface without the digest saying
so.

## Tools as data, not as code

`packages/contract/src/tools.js` declares tools as plain descriptors:

```js
{ name: 'greeting_hello', readOnly: true,
  input: { hour: { type: 'integer', optional: true, min: 0, max: 23, describe: '…' } } }
```

`src/zod.js` derives the validators from those descriptors, so the schema advertised to
a client and the schema the server validates against are the same definition — not two
that happen to agree today.

Declaring them as data is what makes the digest possible: a hash over plain JSON is
stable, language-neutral, and diffable in review.

Adding a tool means adding a descriptor and a handler in `packages/hub/src/tools/`. The
hub asserts the two sets are equal **at boot**, so a tool declared but not implemented is
a startup failure the deploy gate catches — not a `tools/call` that fails for one user.

## The two probes

They answer different questions, and the split is load-bearing.

`/healthz` — is the process alive? Never checks anything else.
`/readyz` — can this build serve? Re-verifies that the contract and the handler registry
still agree and that every declared schema still builds.

With no external dependency the two nearly converge, and `/readyz` says so honestly by
reporting `dependencies: []` rather than implying it probed something. They stay separate
because App Service points its health check at one and the deploy gate polls it — and
because the day a dependency appears, there is already a right place to put it.

## Layout

```
packages/contract/          @pivotly/contract — the source of truth
  src/protocol.js           versions, channels, endpoints, headers, the client list
  src/tools.js              the tool surface, as data
  src/zod.js                descriptors -> zod validators
  src/errors.js             shared error codes and their HTTP statuses
  src/digest.js             the digest, and the read-only invariant it enforces
  contract.lock.json        committed; CI fails on drift

packages/hub/               @pivotly/hub — the MCP server
  src/index.js              composition root; --http | --stdio | --selftest
  src/http.js               Streamable HTTP MCP + /healthz /readyz /version
  src/mcp.js                builds an McpServer per request from the contract
  src/tools/index.js        the two handlers
  src/lib/greeting.js       the pure logic everything else is scaffolding around
  scripts/smoke-remote.js   smoke test for any deployed channel
  testkit/harness.js        boots a real hub over a real socket for tests

packages/clients/           @pivotly/clients — every client, generated
  channels.json             SHARED: channel -> url + pinned contract
  scripts/generate.js       one manifest -> every client config
  scripts/verify.js         what a marketplace install depends on
  axle/                     Claude Code plugin (manifest + skills + .mcp.json)
  codex/                    Codex CLI (config.toml)

e2e/                        contract, protocol and client tiers
scripts/package-hub.js      builds the deployable App Service artifact
scripts/verify-versions.js  one check: every version and channel pin agrees
scripts/ci-local.js         runs the offline half of CI on your machine
```
