# The pipeline

> **This branch runs CD in no-Azure mode.** Everything below about the ladder — the
> dev slot, the prerelease slot, the approval gate, the swap into production, the
> rollback, and every secret and variable they need — describes the pipeline preserved
> on the **`with-azure`** branch, and is what comes back when that `cd.yml` is
> restored. What `cd.yml` does on this branch is narrower and needs no cloud at all:
>
> | Trigger | Does |
> | --- | --- |
> | push to `main` | `_verify.yml`, then reports the plugin version main now serves |
> | manual, `bump` = patch/minor/major | `npm run version:bump`, verifies the bumped tree, pushes it to `main` — the button that makes an installed plugin see an update |
> | tag `v*.*.*` | `_verify.yml`, then publishes the GitHub release |
>
> Nothing is deployed, so the client configs still point at a production URL that will
> not answer, and `channels.json` keeps the `lastVerified` records it has — a run that
> deploys nothing may not claim a channel was verified.

Two workflows and one shared definition of "is this good".

| File | Runs on | Does |
| --- | --- | --- |
| [`_verify.yml`](../.github/workflows/_verify.yml) | called by both | everything provable without a deployed environment |
| [`ci.yml`](../.github/workflows/ci.yml) | every PR, push to `main` | calls `_verify.yml`; needs no cloud credentials |
| [`cd.yml`](../.github/workflows/cd.yml) | push to `main`, `v*.*.*` tags, manual | the channel ladder |

CD calls `_verify.yml` again rather than trusting CI. A tag is permanent and
installable, and may point at a commit whose CI run predates a change to the workflow.

## The ladder

Four channels, **three different triggers**. That is the point of having four.

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

Every rung's deploy job ends by **polling `/version` for its own commit SHA** and
`/readyz` for actual readiness. An instance can be up, serving the previous build, and
answer `200` on `/healthz` the whole time — so the deploy API's word is never enough.

Each rung also advances its **own channel pin** after verification, and commits it. So
`channels.json` always records what each channel is proven to be serving.

## `_verify.yml` — the offline gate

```
contract ──┬── unit (Node 20, 22)  ──┬── e2e-local
           ├── clients              ─┘
           └── artifact  ─► uploads hub-<sha>
```

| Job | What it proves |
| --- | --- |
| `contract` | the committed digest matches the source; every version **and every channel pin** agrees; the contract's own self-tests pass |
| `unit` | all workspace tests on Node 20 **and** 22 — 20 is the declared `engines` floor, 22 is what runs deployed |
| `clients` | `claude plugin validate` passes; every declared client's config, channel pins and skills are valid; nothing has drifted from the manifest; and a `git archive` export — exactly what a marketplace install copies — yields a working plugin with an `https` URL and **no credential** |
| `artifact` | `npm audit --omit=dev --audit-level=high`; the artifact builds; tests and clients are **not** in it; and it boots and self-tests **from the packaged tree** with no configuration |
| `e2e-local` | all three tiers against a hub the suite starts itself |

The artifact is uploaded so CD deploys the exact bytes that were scanned and
self-tested, not a rebuild that is hopefully identical.

### Why `npm audit` and not an image scan

The hub is a Node process on App Service with no OS layer of its own, so the dependency
tree *is* the surface worth scanning. `--omit=dev` is deliberate: a devDependency
advisory is not a deployed risk, and failing on one trains everyone to ignore the step.

## The three test tiers

Each checks one boundary, so a failure says **where** it broke.

| Tier | Checks | Implemented by |
| --- | --- | --- |
| 1 · contract | this checkout is coherent: lock matches source, every tool is read-only, handlers match the contract, every channel pin is current, every client renders as committed | [`tier1-contract.js`](../e2e/tiers/tier1-contract.js) |
| 2 · protocol | a deployed endpoint speaks correct MCP: `initialize`, `tools/list`, `tools/call`, schema rejection, anonymous access, request-id echo | [`smoke-remote.js`](../packages/hub/scripts/smoke-remote.js) |
| 3 · clients | the repo, the deployed hub and the channel pin all agree — field by field, not just by digest | [`tier3-clients.js`](../e2e/tiers/tier3-clients.js) |

Tiers 1 and 2 both pass while users are broken, because neither looks at what the clients
shipped with. Tier 3 closes that gap — see **The contract digest** in
[ARCHITECTURE.md](ARCHITECTURE.md).

Tier 2 drives the same script the deploy jobs run directly, so there is one definition
of each check rather than a copy in the suite that nobody runs.

### Checking the whole ladder at once

```sh
npm run e2e -- --all-channels
```

Walks every channel in the manifest, runs tiers 2 and 3 against each one that answers,
and **skips the rest with a note** rather than failing. One command tells you the state
of local, dev, prerelease and production — including whether any has drifted from what
the clients were generated against.

## Required configuration

Set per GitHub Environment (`dev`, `prerelease`, `production`), not repo-wide, so a dev
run cannot reach production.

### Secrets

| Secret | Used by | Notes |
| --- | --- | --- |
| `AZURE_CLIENT_ID` | every deploy job | OIDC federated credential — **no stored client secret** |
| `AZURE_TENANT_ID` | every deploy job | |
| `AZURE_SUBSCRIPTION_ID` | every deploy job | |

That is the entire list. There is no smoke token, no service token, no API credential —
the hub is anonymous, so the pipeline has nothing to authenticate with and nothing to
leak.

### Variables

| Variable | Example |
| --- | --- |
| `AZURE_RESOURCE_GROUP` | `rg-pivotly-ai` |
| `AZURE_WEBAPP_NAME` | `pivotly-hub` |
| `HUB_DEV_URL` | `https://pivotly-hub-dev.azurewebsites.net` |
| `HUB_PRERELEASE_URL` | `https://pivotly-hub-prerelease.azurewebsites.net` |
| `HUB_PRODUCTION_URL` | `https://pivotly-hub.azurewebsites.net` |

These must match the URLs in [`packages/clients/channels.json`](../packages/clients/channels.json).
Tier 3 compares them, so a mismatch fails rather than silently deploying somewhere the
clients do not point.

### Azure, one-time

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

### The one App Service detail that bites

`HUB_CHANNEL` is set on the **prerelease slot immediately before the swap**, not on
production. App Service swaps slot settings along with the slot unless they are marked
sticky, so the value has to be set on the thing that is about to *become* production —
otherwise production comes up reporting `prerelease`, and the post-swap smoke test
catches it after the fact instead of before.

## Running the pipeline's checks locally

```sh
npm run ci:local     # every offline CI job, same job names
```

A red job here is the job that would be red in CI. `--job=clients`, `--skip=artifact`
(that one runs `npm ci`), `--list`.

It proves the **steps**, not the workflow wiring, and nothing about Azure.

## Cutting a release

Versions are bumped together — `verify-versions.js` fails on any drift.

```sh
# CONTRACT_VERSION in packages/contract/src/protocol.js, then:
npm version 0.4.0 --workspaces --include-workspace-root --no-git-tag-version
# and plugin.json + marketplace.json
npm run contract:digest -- --write
npm run clients:generate
npm run verify:all

git commit -am 'Release v0.4.0'
git tag v0.4.0 && git push origin main --tags
```

CD takes it from the tag. `--tag=` makes `verify-versions.js` require the tag to match
the repo version, so a mistyped tag fails before anything is deployed.

## A safe first CD run

Actions → CD → Run workflow → channel `prerelease`, `skip-promotion: ✓`. That deploys to
the slot and runs all three tiers against it, stopping before the swap. Production is
never touched. When that is green, tag for real.
