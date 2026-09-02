# Architecture

Three workspaces, one dependency direction, and one rule that decides most of the
design: **the client cannot write, and the hub owns no data.**

```
                    ┌──────────────────────────┐
                    │  packages/contract       │   the single source of truth
                    │  tool schemas · types    │   nothing here imports a sibling
                    │  auth conventions        │
                    │  protocol + channels     │
                    └────────────┬─────────────┘
                                 │  both sides derive from it
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
   ┌──────────────────────────┐    ┌──────────────────────────────┐
   │ packages/clients/axle    │    │ packages/hub                 │
   │ the Claude Code plugin   │    │ stateless MCP adapter        │
   │ channel manifest         │    │ Azure App Service            │
   │ read-only surface        │    │ no database, no state        │
   └────────────┬─────────────┘    └──────────────┬───────────────┘
                │  MCP over HTTPS                 │  HTTPS, forwarding
                │  (Streamable HTTP)              │  the caller's token
                └────────────────►────────────────┘
                                                  ▼
                                  ┌──────────────────────────────┐
                                  │  Pivotly platform API        │
                                  │  owns PostgreSQL, USDF       │
                                  │  schemas, job queue, and     │
                                  │  every access decision       │
                                  └──────────────────────────────┘
```

Dependencies point **inward only**. `contract` imports nothing from `hub` or `axle`;
if it ever needed to, the thing it needed does not belong in the contract.

## Why the hub has no database

An earlier draft of this repository gave the hub its own PostgreSQL connection, schema
migrations, and `SECURITY DEFINER` functions. That was wrong, and it was removed.

The platform API already owns the schema, the tenancy rules, the job queue and the
audit trail. A second component holding a database credential would mean two places
that can write the same rows, two places to keep the access rules correct, and two
places to review when they change. It also gave a component sitting directly behind an
editor plugin a credential that could mutate tenant data.

So the hub holds **no connection string, no schema, no migrations and no state**. It is
a protocol adapter: MCP in, HTTPS out. That decision buys:

- **Nothing to migrate on deploy.** A deploy is a process restart. No migration
  ordering, no backward-compatibility window between schema and code.
- **Free horizontal scale and painless slot swaps.** Every request is independent, so
  instances can be added, recycled, or swapped mid-flight with no sticky routing.
- **One authority on access.** The API authorises every call, so the hub cannot widen
  anyone's permissions — the worst a hub bug can do is fail a request.

What it costs, stated plainly: the hub cannot act without a live caller, so it has no
background work. Workers call the platform API directly rather than through here.

## Token flow

The hub holds **no credential of its own**. It forwards the caller's bearer token
upstream, verbatim:

```
Claude Code ──Bearer <user token>──► hub ──Bearer <same token>──► platform API
```

- The API authorises the **end user**, not the hub.
- There is no ambient service credential to steal from a compromised instance.
- Every upstream audit row names the real caller.

`packages/hub/src/auth.js` resolves identity by calling the API's `/v1/me` and believing
the answer. It caches the result for five seconds — long enough to spare a burst of
identity calls, short enough that a revoked token stops working in seconds.

## The client/service split

The tool surface is divided by **audience**, and this is the platform's main safety rail.

| | client surface | service surface |
| --- | --- | --- |
| Tools | `greeting_hello`, `greeting_day_check`, `usdf_record_get` | `usdf_record_put`, `job_claim` |
| Who | the Axle plugin, and anything else a person runs | platform workers with their own credential |
| Writes | never | yes |

**A client credential cannot cause a write.** Three independent barriers, and any one
would be sufficient:

1. **The contract refuses to build.** `packages/contract/src/digest.js` throws if a
   client-audience tool is not `readOnly`. No digest, no lock, no CI pass, no artifact.
2. **The hub never registers it.** `packages/hub/src/mcp.js` builds the MCP server per
   principal, so a client session's `tools/list` does not mention a service tool at
   all. It is not described, not schema'd, and not callable — there is nothing for a
   prompt injection to name. Calling it by name returns *"Tool not found"*.
3. **The API refuses it.** A client credential is rejected on every write endpoint with
   `403 forbidden_audience`, regardless of what the hub decided.

Only (3) is out of reach of a hub bug, a bad deploy, or a stolen client token — which
is exactly why it is the platform's job and not the adapter's.
`packages/hub/scripts/verify-upstream.js` asserts it against a live API, because if
that barrier were ever missing the split would be cosmetic.

## The contract digest

One 12-hex string derived from the entire tool surface — names, descriptions, every
input field's type and requiredness, scopes, audiences, auth conventions, error codes,
protocol version. It appears in exactly three places, and they must agree:

| Where | What it means |
| --- | --- |
| `packages/contract/contract.lock.json` | what this repository builds |
| the hub's `GET /version` | what the deployed endpoint is serving |
| `packages/clients/axle/channels.json` | what the shipped client was built against |

This is the cascade guard. The failure it exists to catch:

1. the tool surface changes in `packages/contract`
2. the hub is rebuilt and deployed — internally consistent, so every hub check passes
3. the Axle channel manifest still pins the **old** digest
4. nothing fails anywhere in the pipeline
5. a user's editor calls a tool whose schema moved, days later and two repositories
   away from the change that caused it

`e2e/tiers/tier3-client.js` compares all three and names which pair disagrees. It then
goes further than the digest and compares the actual served surface field by field — a
digest match with a differing surface would mean the digest is not covering something
it should.

## Tools as data, not as code

`packages/contract/src/tools.js` declares tools as plain descriptors:

```js
{
  name: 'greeting_hello',
  audience: 'client',
  readOnly: true,
  input: { hour: { type: 'integer', optional: true, min: 0, max: 23, describe: '…' } },
}
```

`src/zod.js` derives the zod validators from those descriptors. So the schema advertised
to a client and the schema the server validates against are the same definition, not two
that agree today.

Declaring them as data (rather than as live zod objects) is what makes the digest
possible: a hash over plain JSON is stable, language-neutral and diffable in review.

Adding a tool means adding a descriptor and a handler in `packages/hub/src/tools/index.js`.
The hub asserts the two sets are equal **at boot**, so a tool declared but not
implemented is a startup failure the deploy gate catches — not a `tools/call` that
fails for one unlucky user.

## Channels

`local → dev → prerelease → production`, declared in the contract and mapped to URLs in
the Axle channel manifest. Promotion is left to right.

`prerelease` and `production` are **hardened**: `packages/hub/src/config.js` refuses to
start on either with a plaintext upstream URL, and the client manifest verifier refuses
a non-https URL for them. Only `local` may be plaintext, and only on loopback.

## The fake platform API

`packages/hub/scripts/fake-platform-api.js` is a **test double**, not a second
implementation. It serves the endpoints the contract declares so the hub can be
exercised end to end with no real API — and critically, the hub uses its **one real HTTP
client** against it. There is no in-process shortcut and no second code path to drift.

It models faithfully only the behaviours the hub's own logic depends on: identity
resolution and kind, a write refused for a client credential, tenant-scoped reads
answering 404 rather than 403, idempotent writes, and an empty queue answering 200.

It models **nothing** about the real access rules, schema registry, durability or
concurrency. Its job queue is a JavaScript array. Anything depending on those properties
belongs in `verify-upstream.js`, which the pipeline runs against a deployed API. The
`_verify.yml` workflow asserts the double is not present in the deployable artifact — a
test double that ships is a test double that can be reached.

## Layout

```
packages/contract/          @pivotly/contract — the source of truth
  src/protocol.js           versions, channels, MCP + upstream endpoint paths
  src/tools.js              the tool surface, as data
  src/zod.js                descriptors -> zod validators
  src/auth.js               headers, scope grammar, principal kinds, audiences
  src/errors.js             shared error codes and their HTTP statuses
  src/digest.js             the contract digest, and the invariants it enforces
  contract.lock.json        committed; CI fails on drift

packages/hub/               @pivotly/hub — the cloud MCP adapter
  src/index.js              composition root; --http | --stdio | --selftest
  src/http.js               Streamable HTTP MCP + /healthz /readyz /version
  src/mcp.js                builds an McpServer per principal
  src/auth.js               identity via the API, then audience and scope
  src/upstream/client.js    the ONLY path to data
  src/tools/index.js        the handlers
  scripts/smoke-remote.js   smoke test for any deployed endpoint
  scripts/verify-upstream.js  asserts the API behaves as assumed
  scripts/fake-platform-api.js  the test double
  testkit/harness.js        boots a real hub over a real socket for tests

packages/clients/axle/      @pivotly/axle — the Claude Code plugin
  channels.json             channel -> url + pinned contract
  .mcp.json                 GENERATED from channels.json
  scripts/autopatch.js      channel selection, drift check, pin sync
  scripts/verify-manifest.js  what a marketplace install depends on
  skills/                   when and how Claude should use the tools

e2e/                        the three-tier suite
scripts/package-hub.js      builds the deployable App Service artifact
scripts/verify-versions.js  one check: every version string agrees
```
