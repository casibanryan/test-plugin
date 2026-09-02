# The pipeline

Two workflows and one shared definition of "is this good".

| File | Runs on | Does |
| --- | --- | --- |
| [`_verify.yml`](../.github/workflows/_verify.yml) | called by both | everything provable without a deployed environment |
| [`ci.yml`](../.github/workflows/ci.yml) | push to `main`, every PR | calls `_verify.yml`; needs no cloud credentials |
| [`cd.yml`](../.github/workflows/cd.yml) | `v*.*.*` tags, manual | verify → pre-release → verify → swap → verify → sync the client |

CD calls `_verify.yml` again rather than trusting that CI ran. A tag is permanent and
installable, and may point at a commit whose CI run predates a change to the workflow
itself.

## `_verify.yml` — the offline gate

Five jobs. `contract` runs first and alone, because everything else derives from it: if
the tool surface and its lock disagree, no other result means anything.

```
contract ──┬── unit (Node 20, 22)  ──┬── e2e-local
           ├── client               ─┘
           └── artifact  ─► uploads hub-<sha>
```

| Job | What it proves |
| --- | --- |
| `contract` | the committed digest matches the source; every version string in the repo agrees; the contract's own 22 self-tests pass |
| `unit` | all workspace tests on Node 20 **and** 22 — 20 is the declared `engines` floor, 22 is what runs deployed. The hub suite boots a real HTTP server against the fake API on ephemeral ports, so there are no service containers and nothing to wait for |
| `client` | `claude plugin validate` passes; the Axle manifests, channels and skills are valid; `.mcp.json` has not drifted from `channels.json`; and a `git archive` export — exactly what a marketplace install copies — yields a working plugin with an `https` URL and no literal credential |
| `artifact` | `npm audit --omit=dev --audit-level=high` on the hub's production tree; the artifact builds; the test double and test code are **not** in it; and it boots and self-tests **from the packaged tree** with nothing reachable |
| `e2e-local` | all three tiers against a locally booted stack, using the identical tier code that runs against production |

The artifact is uploaded so CD deploys the exact bytes that were scanned and
self-tested — not a rebuild that is hopefully identical.

### Why `npm audit` and not an image scan

The hub is a Node process on App Service with no OS layer of its own, so the dependency
tree *is* the surface worth scanning. `--omit=dev` is deliberate: a devDependency
advisory is not a deployed risk, and failing on one trains everyone to ignore the step.

## The three test tiers

Each tier checks one boundary, so a failure says **where** it broke.

| Tier | Checks | Implemented by |
| --- | --- | --- |
| 1 · platform | the platform API behaves as the hub assumes: identity shape, a client credential refused on every write, 404 for a missing record, an empty queue answering 200, idempotent writes | [`verify-upstream.js`](../packages/hub/scripts/verify-upstream.js) |
| 2 · protocol | the deployed hub speaks correct MCP: `initialize`, `tools/list`, `tools/call`, 401 with a challenge, contract-schema input rejection | [`smoke-remote.js`](../packages/hub/scripts/smoke-remote.js) |
| 3 · client | the repo, the deployed hub and the Axle pin all agree — field by field, not just by digest | [`tier3-client.js`](../e2e/tiers/tier3-client.js) |

Tiers 1 and 2 both pass while users are broken, because neither looks at the client.
Tier 3 closes that gap; see **The contract digest** in [ARCHITECTURE.md](ARCHITECTURE.md).

Tiers 1 and 2 are driven by the same scripts the deploy jobs run directly — one
definition of each check, rather than a copy in the suite that nobody runs.

## `cd.yml` — the deploy

```
verify
  └─► deploy-prerelease      artifact ─► App Service STAGING SLOT
        └─► verify-prerelease   tiers 1-3 against the slot's real URL   ◄── THE GATE
              └─► promote          slot swap into production   [approval]
                    └─► verify-production   tiers 2-3 against production
                          ├─► rollback      (only if verification failed after the swap)
                          └─► sync-client   advance the pin, publish the release
```

**Why a slot swap and not a redeploy.** The instances that just passed every check are
the instances that start taking production traffic — already warmed. And the previous
production build lands in the slot, so rollback is another swap: seconds, not a rebuild.

**Why the gate is where it is.** Everything above `promote` is invisible to production.
Add a required reviewer to the `production` GitHub Environment to make promotion a human
decision; putting the approval earlier would gate something that is already reversible.

### Two details that are easy to get wrong

**App Settings before the deploy, not after.** New code must never start against the
previous configuration.

**`HUB_CHANNEL` is set on the slot *before* the swap.** App Service swaps
slot-specific settings along with the slot unless they are marked sticky. Setting
`HUB_CHANNEL=production` on the thing that is about to *become* production is what stops
production coming up believing it is pre-release. The slot is then re-checked for
readiness against the production API before the swap proceeds — a slot healthy against
the pre-release API is not evidence about the production one.

### The deploy is never trusted

`deploy-prerelease` polls `/version` until it reports **the commit just pushed** *and*
`/readyz` returns 200. An instance can be up, serving the previous build, and answer
`200` on `/healthz` the entire time. On timeout the job prints `/readyz`, which says
why — usually an unreachable platform API.

The two probes are split on purpose:

- `/healthz` never calls upstream. If liveness depended on the API, an API outage would
  make App Service conclude every instance was broken and restart the fleet — turning
  someone else's incident into ours.
- `/readyz` does call upstream, so an instance that cannot reach its only data source
  stops taking traffic.

### Client sync is last

`sync-client` advances the `production` channel pin **after** production verification
passes, then commits it to `main` and publishes the release. So the pin always trails a
verified deploy and can never point at a build that was deployed and rolled back.

`autopatch --sync-pin` refuses to advance a pin if the deployed digest is not the one
this checkout builds — that would record a mid-rollout state, or a hub deployed from
another commit.

## Required configuration

Set per GitHub Environment (`prerelease`, `production`), not repo-wide, so a
pre-release run cannot reach production.

### Secrets

| Secret | Used by | Notes |
| --- | --- | --- |
| `AZURE_CLIENT_ID` | deploy, promote, rollback | OIDC federated credential — **no stored client secret** |
| `AZURE_TENANT_ID` | deploy, promote, rollback | |
| `AZURE_SUBSCRIPTION_ID` | deploy, promote, rollback | |
| `SMOKE_TOKEN` | verify-prerelease | a **read-only client** token |
| `VERIFY_SERVICE_TOKEN` | verify-prerelease | a service token; tier 1 writes one record with an idempotency key — point it at pre-release, never production |
| `SMOKE_TOKEN_PRODUCTION` | verify-production | a **read-only client** token |

The smoke token must never be a service credential. A smoke test that could write would
be writing to production on every deploy.

### Variables

| Variable | Example |
| --- | --- |
| `AZURE_RESOURCE_GROUP` | `rg-pivotly-ai` |
| `AZURE_WEBAPP_NAME` | `pivotly-hub` |
| `HUB_PRERELEASE_URL` | `https://pivotly-hub-prerelease.azurewebsites.net` |
| `HUB_PRODUCTION_URL` | `https://pivotly-hub.azurewebsites.net` |
| `PIVOTLY_API_URL` | the platform API the pre-release slot uses |
| `PIVOTLY_API_URL_PRODUCTION` | the platform API production uses |

### Azure, one-time

```sh
RG=rg-pivotly-ai
APP=pivotly-hub

az webapp create --resource-group $RG --plan $APP-plan --name $APP --runtime 'NODE:22-lts'
az webapp deployment slot create --resource-group $RG --name $APP --slot prerelease

# Sticky settings stay with the slot across a swap. Everything else swaps with it,
# which is why cd.yml sets HUB_CHANNEL on the slot immediately before swapping.
az webapp config appsettings set --resource-group $RG --name $APP \
  --slot-settings WEBSITE_HOSTNAME

# App Service's own health check stops routing to an instance that cannot serve.
az webapp config set --resource-group $RG --name $APP --health-check-path /readyz
```

Then add a federated credential on the app registration for
`repo:<owner>/<repo>:environment:prerelease` and `:environment:production`, and give the
service principal **Website Contributor** on the resource group. No client secret is
stored anywhere.

## Cutting a release

Versions are bumped together — `verify-versions.js` fails on any drift.

```sh
npm version 0.3.0 --workspaces --include-workspace-root --no-git-tag-version
# CONTRACT_VERSION in packages/contract/src/protocol.js, and plugin.json + marketplace.json
npm run contract:digest -- --write
npm run axle:autopatch -- --write
npm run verify:all

git commit -am 'Release v0.3.0'
git tag v0.3.0 && git push origin main --tags
```

CD takes it from the tag. `--tag=` makes `verify-versions.js` require the tag to match
the repo version, so a mistyped tag fails before anything is deployed.

## Running it locally

```sh
npm ci
npm run dev:api          # the fake platform API on 8790
npm run dev:hub          # the hub on 8787
npm run e2e              # all three tiers against a stack it boots itself
npm run verify:all       # what CI's offline jobs check
```

`npm run e2e` needs neither of the first two — with no `--hub-url` it boots the whole
stack on ephemeral ports itself.

To point the tiers at a deployed channel:

```sh
SMOKE_TOKEN=... VERIFY_SERVICE_TOKEN=... npm run e2e -- \
  --hub-url=https://pivotly-hub-prerelease.azurewebsites.net \
  --api-url=https://api-prerelease.pivotly.com \
  --channel=prerelease
```
