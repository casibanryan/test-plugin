# The pipeline

> **Nothing is deployed, and nothing needs to be.** The hosted hub was removed while the
> Azure environment is still being set up — see *What was removed* in
> [ARCHITECTURE.md](ARCHITECTURE.md). Every client config is generated for the `bundled`
> channel, whose MCP server ships inside the plugin and is started over stdio.
>
> So this pipeline verifies and publishes; it does not deploy. It is split one workflow
> per trigger, which means every job in every run actually runs, and a green run is
> green all the way across rather than green with three skips.
>
> The full Azure ladder — dev slot, prerelease slot, approval gate, swap into
> production, rollback, and every secret and variable they need — is preserved on the
> **`with-azure`** branch and is what comes back when that `cd.yml` is restored. The
> reference for it is kept at the end of this file.

One shared definition of "is this good", called by every workflow that has an opinion
about whether the tree is shippable.

| File | Runs on | Does |
| --- | --- | --- |
| [`_verify.yml`](../.github/workflows/_verify.yml) | called by all of the below | everything provable without a deployed environment |
| [`ci.yml`](../.github/workflows/ci.yml) | every PR, push to `main` | calls `_verify.yml`; needs no cloud credentials |
| [`cd.yml`](../.github/workflows/cd.yml) | push to `main` | verify, then report what main serves |
| [`bump.yml`](../.github/workflows/bump.yml) | manual | verify, bump every version, verify again, push — **the button that makes an installed plugin see an update** |
| [`release.yml`](../.github/workflows/release.yml) | `v*.*.*` tags | verify against the tag, then publish the GitHub release |

Every job runs on Node 22 and 24. Node 20 is end-of-life and its action runtime is
deprecated on the runners, so every action is pinned to a major that declares
`using: node24` — `checkout@v7`, `setup-node@v7`, `action-gh-release@v3`. Those major
numbers do not move together across repos, so check each one against its own
`action.yml` rather than assuming.

`cd.yml` calls `_verify.yml` again rather than trusting CI. A tag is permanent and
installable, and may point at a commit whose CI run predates a change to the workflow.

## `_verify.yml` — the gate

```
contract ──┬── unit (Node 22, 24)  ──┬── e2e-local
           ├── clients              ─┘
           └── audit
```

| Job | What it proves |
| --- | --- |
| `contract` | the committed digest matches the source; every version and every channel record agrees; the contract's own self-tests pass |
| `unit` | all workspace tests on Node 22 **and** 24 — 22 is the oldest still supported on the runners, 24 is what every action's own runtime uses. The `>=20.18.0` floor in `package.json` is no longer covered by anything: Node 20 is end-of-life, so either raise the floor or accept the gap knowingly |
| `clients` | `claude plugin validate` passes; every declared client's config, server copy and skills are valid; nothing has drifted from the manifest; and a `git archive` export yields a working plugin with **no credential** |
| `audit` | `npm audit --omit=dev --audit-level=high` over the production dependency tree |
| `e2e-local` | both tiers, including the protocol tier against every copy of the server |

### The check that matters most here

Inside `clients`, this is the one that stands in for a deploy gate:

```
git archive HEAD | tar -x -C /tmp/installed
cd /tmp/installed/packages/clients/claude
… assert the files are present …
printf '…tools/call…' | node server/greeting-stdio.js
```

It exports the repository exactly the way a marketplace install copies it — no
`npm install`, no build step — then **spawns the plugin's own copy of the server from
that export** and asserts it answers a real tool call. A missing file, a stray
`require` of something that needs installing, or a drifted copy fails there rather than
on a user's machine.

That is the same class of proof the old `artifact` job gave: build the thing a user
receives, then run it *from* that build rather than from the checkout.

### Why `npm audit` and not an image scan

Two workspaces of plain Node with one runtime dependency between them, and no OS layer
of its own — so the dependency tree *is* the surface worth scanning. `--omit=dev` is
deliberate: a devDependency advisory is not a shipped risk, and failing on one trains
everyone to ignore the step.

## The two test tiers

Each checks one boundary, so a failure says **where** it broke.

| Tier | Checks | Implemented by |
| --- | --- | --- |
| 1 · contract | this checkout is coherent: lock matches source, every tool is read-only, handlers match the contract, every channel is declared, every client renders as committed | [`tier1-contract.js`](../e2e/tiers/tier1-contract.js) |
| 2 · protocol | every copy of the server speaks correct MCP over a real pipe: `initialize` negotiation, notifications go unanswered, `ping`, `tools/list`, `tools/call`, schema rejection as a result rather than a transport error, unknown tools refused, and a clean stderr | [`tier2-protocol.js`](../e2e/tiers/tier2-protocol.js) |

Tier 1 can pass while users are broken, because it never runs the server. Tier 2 closes
that gap by **spawning** it — in-process requiring would be faster and would test less.
A stray `console.log`, a missing newline, a response sent to a notification, or a
`require` of something a plugin install does not have are all invisible in-process and
fatal in a real client.

Tier 2 iterates the contract's `CLIENTS` list, so it drives `packages/server` *and* the
copy inside every plugin client. Adding a plugin client brings its copy under the tier
automatically.

There used to be a third tier comparing the repo, the deployed hub and the channel pin
field by field. With no deployed endpoint there is nothing for it to compare against,
and the gap it guarded is closed by construction — the tool surface every server answers
with is generated from this checkout's contract and drift-checked.

## Running the pipeline's checks locally

```sh
npm run ci:local     # every CI job, under the same job names
```

A red job here is the job that would be red in CI. `--job=client`, `--skip=audit` (that
one hits the network), `--list`.

It proves the **steps**, not the workflow wiring.

## Cutting a release

Versions are bumped together — `verify-versions.js` fails on any drift. The scripted
path is the `bump.yml` workflow; by hand it is:

```sh
npm run version:bump -- minor      # rewrites every version in lockstep
npm run contract:digest -- --write
npm run clients:generate
npm run verify:all

git commit -am 'Release v0.4.0'
git tag v0.4.0 && git push origin main --tags
```

`release.yml` takes it from the tag. `--tag=` makes `verify-versions.js` require the tag
to match the repo version, so a mistyped tag fails before anything is published.

An installed plugin sees the new version on its next marketplace refresh; the plugin's
`SessionStart` hook is what tells the user it moved.

---

# Reference: the Azure ladder, for when it comes back

None of this runs today. It is kept so restoring the hosted path is a restore rather
than a redesign, and it matches the four http channels the contract still declares.

## The ladder

```
push to main   ──►  dev          no gate, deploys every merge
tag v*.*.*     ──►  prerelease   verified, then held at an approval
               ──►  production   slot swap from prerelease, verified again
local                            your machine; CD never touches it
```

| Rung | What it buys |
| --- | --- |
| `dev` | catches "works on my laptop, not on App Service" minutes after merging, with zero blast radius and nobody's approval |
| `prerelease` | a full copy of what production is about to become, verified by the same script that will verify production. If it fails, nothing has moved |
| `production` | a **swap, not a redeploy** — the instances that passed every check are the ones that take traffic, already warm, and the previous build lands in the slot as the rollback |

Every rung's deploy job must end by **polling `/version` for its own commit SHA** and
`/readyz` for actual readiness. An instance can be up, serving the previous build, and
answer `200` on `/healthz` the whole time — so the deploy API's word is never enough.

Each rung then advances its own `lastVerified` record via `npm run clients:sync-pin`,
which refuses to write anything unless the channel answered and served this checkout's
digest.

## Required configuration

Set per GitHub Environment (`dev`, `prerelease`, `production`), not repo-wide, so a dev
run cannot reach production.

| Secret | Notes |
| --- | --- |
| `AZURE_CLIENT_ID` | OIDC federated credential — **no stored client secret** |
| `AZURE_TENANT_ID` | |
| `AZURE_SUBSCRIPTION_ID` | |

That is the entire list. There is no smoke token and no API credential — the tools are
anonymous, so the pipeline has nothing to authenticate with and nothing to leak.

| Variable | Example |
| --- | --- |
| `AZURE_RESOURCE_GROUP` | `rg-pivotly-ai` |
| `AZURE_WEBAPP_NAME` | `pivotly-hub` |
| `HUB_DEV_URL` | `https://pivotly-hub-dev.azurewebsites.net` |
| `HUB_PRERELEASE_URL` | `https://pivotly-hub-prerelease.azurewebsites.net` |
| `HUB_PRODUCTION_URL` | `https://pivotly-hub.azurewebsites.net` |

These must match the URLs in [`packages/clients/channels.json`](../packages/clients/channels.json).

## Azure, one-time

One web app, two slots. `dev` and `prerelease` are independent, so promoting one never
touches the other.

```sh
RG=rg-pivotly-ai
APP=pivotly-hub

az webapp create --resource-group $RG --plan $APP-plan --name $APP --runtime 'NODE:22-lts'
az webapp deployment slot create --resource-group $RG --name $APP --slot dev
az webapp deployment slot create --resource-group $RG --name $APP --slot prerelease

# App Service's own health check stops routing to an instance that cannot serve.
az webapp config set --resource-group $RG --name $APP --health-check-path /readyz
```

Then add federated credentials on the app registration for
`repo:<owner>/<repo>:environment:dev`, `:environment:prerelease` and
`:environment:production`, and give the service principal **Website Contributor** on the
resource group.

## The one App Service detail that bites

`HUB_CHANNEL` is set on the **prerelease slot immediately before the swap**, not on
production. App Service swaps slot settings along with the slot unless they are marked
sticky, so the value has to be set on the thing that is about to *become* production —
otherwise production comes up reporting `prerelease`, and the post-swap smoke test
catches it after the fact instead of before.

## What has to be rebuilt alongside it

Restoring `cd.yml` alone is not enough. The hosted path also needs:

- a `packages/hub` workspace with an HTTP transport registering the same `HANDLERS`
- the `/healthz`, `/readyz` and `/version` endpoints the contract already declares in
  `ENDPOINTS`, returning every key in `VERSION_PAYLOAD_KEYS`
- a packaging step (`scripts/package-hub.js` on the `with-azure` branch) and the
  `artifact` job that scanned, booted and uploaded its output
- a `smoke-remote.js` for the deploy jobs to run against each channel
- a third e2e tier comparing the repo, the deployed digest and the channel record
