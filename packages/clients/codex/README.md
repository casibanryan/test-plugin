# codex

The Pivotly client for the [Codex CLI](https://github.com/openai/codex).

`config.toml` in this directory is **generated** — see
[`../scripts/generate.js`](../scripts/generate.js). Do not hand-edit it; CI fails if it
drifts from [`../channels.json`](../channels.json).

## Why this exists

It is the second client, and its job is to prove the pattern: one contract and one
channel manifest, several hosts. Axle is a Claude Code plugin with a manifest and
skills; Codex reads TOML from its own config directory. Neither knows about the other,
and neither carries its own copy of the channel list — so a channel URL or a contract
digest can only ever be wrong in one place.

## Using it

Regenerate for the channel you want, then merge the block into your Codex config:

```sh
PIVOTLY_CHANNEL=local npm run clients:generate     # or dev / prerelease / production
cat packages/clients/codex/config.toml >> ~/.codex/config.toml
```

No credential is needed. The hub serves two read-only tools anonymously — there is no
token to set and nothing to authorise.

## A caveat, stated plainly

The exact TOML keys a given Codex version wants for a **remote** MCP server are not
something this repository can verify, so treat the generated block as a starting point
and check it against the version you actually run.

If it needs adjusting, change it in **one place** — the `writeToml` writer in
[`../scripts/generate.js`](../scripts/generate.js). That fixes every channel at once,
which is the whole reason these files are generated rather than written by hand.
