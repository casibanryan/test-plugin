# LOCAL.RUN.md

How to run the pipeline on this machine, and how to watch a CD version bump actually
reach the plugin in your Claude Code — ending with a greeting that reports its own
version.

Where things stand right now:

| | |
|---|---|
| this branch | `without-azure`, version **0.3.1** |
| `main` | version **0.3.0** |
| plugin installed in your Claude Code | **0.3.0** |
| the hub | not deployed — `pivotly-hub.azurewebsites.net` does not resolve |

That gap is the demo: 0.3.0 installed, 0.3.1 on the branch.

---

## Part 1 — Run CI locally

```bash
npm run ci:local
```

Runs the same five jobs `_verify.yml` runs, and prints them under the same job names.
Takes about 45 seconds.

Expected last line:

```
ok    every offline CI job passes on this machine
```

Faster subsets while you work:

```bash
npm run ci:local -- --list           # what would run
npm run ci:local -- --skip=artifact  # skip the slow job (~27s)
npm run ci:local -- --job=client
npm run verify:all                   # contract + versions + tests + clients
npm run e2e                          # 3 tiers against a hub the suite starts
```

This proves the **steps**. It cannot prove the workflow wiring (job `needs`, the
matrix, artifact upload) — only GitHub runs that.

---

## Part 2 — Make CD bump the version

The plugin only looks "updated" when the version number moves, because Claude Code
compares `marketplace.json`'s version against the one it has cached.

### Option A — let CD do it (this is the demo)

1. Go to **Actions → Bump version → Run workflow**.
2. Pick the branch `without-azure`, choose `patch`, run it.
3. It verifies, bumps every version in lockstep, verifies again, and pushes the commit
   to that branch. 0.3.1 becomes 0.3.2.

Both jobs run every time — nothing is skipped.

### Option B — bump locally

```bash
npm run version:bump -- patch
npm run verify:all
git commit -a -m "chore(release): 0.3.2"
git push
```

Never edit versions by hand. One script owns all eight files plus the contract digest,
both client configs and `package-lock.json`; `npm run versions:verify` fails the build
if any one disagrees.

---

## Part 3 — Point your Claude Code at this branch

Your marketplace tracks the repo's default branch (`main`), which is still 0.3.0. Point
it at the branch you are working on instead.

**Step 1.** Edit `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "Test-Plugin": {
    "source": {
      "source": "git",
      "url": "https://github.com/casibanryan/test-plugin.git",
      "ref": "without-azure"
    },
    "autoUpdate": true
  }
}
```

- `ref` takes a branch or a tag.
- `autoUpdate: true` refreshes the marketplace and its plugins at startup. It defaults
  to **false** for non-Anthropic marketplaces — this is why nothing updated on its own
  before.

**Step 2.** In Claude Code:

```
/plugin marketplace update Test-Plugin
/plugin update axle@Test-Plugin
```

If it ignores the new `ref`, remove and re-add — the old install location is cached:

```
/plugin marketplace remove Test-Plugin
/plugin marketplace add casibanryan/test-plugin
```

**Step 3.** Restart Claude Code.

---

## Part 4 — See it in a greeting

Type:

```
hi
```

The greeting skill runs and ends with the plugin's own banner:

```
Axle plugin updated — v0.3.2 · 2026-09-04 15:12 · 17f41af · production channel
```

That is: the version actually loaded · when this machine took the update · the
marketplace commit · which hub the build talks to.

The numbers come from the plugin's `SessionStart` hook, which reads its own manifest
and Claude Code's install record. So bump the version again, update, restart, greet —
and the line changes. That is CD reaching your laptop, visible in a sentence.

**The greeting tools themselves will not answer**, because the hub is not deployed.
The skill handles that: it greets you directly and says so once. The banner still
shows — the plugin's version is a local fact and does not need the hub.

### Want the tools to work too

```bash
npm run dev:hub                                    # terminal 1
npm run clients:generate -- --channel=local        # terminal 2
```

The `--channel` flag works in PowerShell and bash alike; the `PIVOTLY_CHANNEL=local`
env form in the README is bash-only.

This rewrites the shipped `.mcp.json` to point at `127.0.0.1`. Useful locally, **do not
commit it** — `npm run clients:check` will fail if you do.

---

## Checking and resetting

What is actually installed:

```bash
cat ~/.claude/plugins/installed_plugins.json    # version, lastUpdated, commit
ls ~/.claude/plugins/cache/Test-Plugin/axle/    # one directory per version
cat ~/.claude/pivotly/axle-version.json         # what the hook last saw
```

To replay the "updated" wording without a real bump, rewind the hook's record and
restart Claude Code:

```bash
echo '{"version":"0.3.0"}' > ~/.claude/pivotly/axle-version.json
```

---

## If something looks wrong

| Symptom | Cause |
|---|---|
| `/plugin update` says nothing to do | the version did not move. Bump it — the cache is keyed by version |
| the banner never appears | the hook did not run. Check `/plugin` shows axle enabled, then `node packages/clients/axle/hooks/version-notice.js` by hand — it prints JSON |
| the banner shows an old version | Claude Code was not restarted. `SessionStart` only fires on a new session |
| MCP shows `pivotly-hub` failed | expected. The hub is not deployed on this branch |
| `versions:verify` fails | something was edited by hand. Run `npm run version:bump -- <version>` instead |
