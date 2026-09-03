# LOCAL.RUN.md

How to run the pipeline on this machine, and how to watch a version bump reach the
plugin in your Claude Code — ending with a greeting that answers from the plugin's own
MCP server and reports its own version.

Nothing here needs Azure, a host, an account or a token.

| | |
|---|---|
| this branch | `without-azure`, version **0.3.1** |
| `main` | version **0.3.0** |
| plugin installed in your Claude Code | **0.3.0** |
| where the tools come from | `pivotly-greeting` — a stdio server **inside the plugin** |

---

## Part 1 — Prove the tools work, right now

No install, no server, no network:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"greeting_hello","arguments":{"name":"Resty","hour":9}}}' \
  | node packages/clients/axle/server/greeting-stdio.js
```

You get back the greeting as JSON-RPC. That is the same process Claude Code spawns when
the plugin loads, so if this answers, the plugin's tools will answer.

---

## Part 2 — Run CI locally

```bash
npm run ci:local
```

The same five jobs `_verify.yml` runs, under the same job names, in about 45 seconds.
Ends with:

```
ok    every offline CI job passes on this machine
```

The `client` job includes the one that matters most here: it exports the repo the way a
marketplace install copies it, then **spawns the bundled server from that export** and
checks it answers. A missing file or a stray dependency fails there rather than on
someone's laptop.

Faster subsets:

```bash
npm run ci:local -- --list
npm run ci:local -- --skip=artifact   # skips the slow job (~21s)
npm run ci:local -- --job=client
npm run verify:all
npm run e2e                           # 3 tiers against a hub the suite starts
```

---

## Part 3 — Bump the version

The plugin only looks "updated" when the version moves, because Claude Code compares
`marketplace.json`'s version against the one it has cached.

**Let CD do it:** Actions → **Bump version** → Run workflow → branch `without-azure`,
`patch`. It verifies, bumps every version in lockstep, verifies again, and pushes.

**Or locally:**

```bash
npm run version:bump -- patch
npm run verify:all
git commit -a -m "chore(release): 0.3.2"
git push
```

Never edit versions by hand. One script owns all eight files plus the contract digest,
both client configs, the bundled server's `tools.json` and `package-lock.json`.

---

## Part 4 — Point your Claude Code at this branch

Your marketplace tracks the repo's default branch (`main`), still 0.3.0.

**Step 1.** In `~/.claude/settings.json`:

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

**Step 2.**

```
/plugin marketplace update Test-Plugin
/plugin update axle@Test-Plugin
```

If it ignores the new `ref`, remove and re-add — the old install location is cached:

```
/plugin marketplace remove Test-Plugin
/plugin marketplace add casibanryan/test-plugin
```

**Step 3.** Restart Claude Code. Check `/mcp` — `pivotly-greeting` should be connected.
There is no `pivotly-hub` any more; that was the one that could not connect.

---

## Part 5 — Say hi

```
hi
```

The greeting skill calls `greeting_hello` on the bundled server, delivers the reply, and
signs off with:

```
Axle plugin updated — v0.3.2 · 2026-09-04 15:12 · 17f41af · bundled tools
```

That is: the version actually loaded · when this machine took the update · the
marketplace commit · where the tools came from.

Bump again, update, restart, greet — the line changes. That is CD reaching your laptop,
visible in one sentence, with a real MCP tool call behind it.

---

## Optional — run against the hosted hub instead

The hub still exists and still deploys; the bundled server did not replace it.

```bash
npm run dev:hub                                 # terminal 1
npm run clients:generate -- --channel=local     # terminal 2
```

`--channel` works in PowerShell and bash alike; the `PIVOTLY_CHANNEL=local` env form is
bash-only. Switch back with `--channel=bundled`.

Both rewrite the shipped `.mcp.json`, so **do not commit** a config generated for
anything but `bundled` — `npm run clients:check` will fail, which is the point.

---

## Checking and resetting

```bash
cat ~/.claude/plugins/installed_plugins.json    # version, lastUpdated, commit
ls ~/.claude/plugins/cache/Test-Plugin/axle/    # one directory per version
cat ~/.claude/pivotly/axle-version.json         # what the hook last saw
node packages/clients/scripts/generate.js --print   # the resolved channel and transport
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
| `pivotly-greeting` fails to connect | run Part 1. If that answers, the plugin's copy is incomplete — reinstall it |
| the banner never appears | the hook did not run. Check `/plugin` shows axle enabled, then run `node packages/clients/axle/hooks/version-notice.js` by hand — it prints JSON |
| the banner shows an old version | Claude Code was not restarted. `SessionStart` only fires on a new session |
| a tool call is refused | read the message — it names the field. On the bundled server this is never a network problem |
| `clients:check` fails | a config was generated for a non-default channel, or hand-edited. `npm run clients:generate` |
| `versions:verify` fails | something was edited by hand. Use `npm run version:bump -- <version>` |
