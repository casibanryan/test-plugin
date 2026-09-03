# gemini

The Pivotly client for the [Gemini CLI](https://github.com/google-gemini/gemini-cli).

`settings.json` in this directory is **generated** — see
[`../scripts/generate.js`](../scripts/generate.js). Do not hand-edit it; CI fails if it
drifts from [`../channels.json`](../channels.json).

## Why this exists

It is the third client, and it is the one that shows the pattern is not just "two files
that happen to look alike". Axle is a Claude Code plugin, Codex reads TOML, Gemini reads
JSON that *resembles* Claude Code's and is not the same — see the caveat below. None of
them carries its own copy of the channel list, so a channel URL or a contract digest can
only ever be wrong in one place.

## Using it

Regenerate for the channel you want, then merge the `mcpServers` block into your Gemini
settings — `.gemini/settings.json` for this project only, or `~/.gemini/settings.json`
for every project:

```sh
PIVOTLY_CHANNEL=bundled npm run clients:generate   # or local / dev / prerelease / production
cat packages/clients/gemini/settings.json          # merge the mcpServers block into yours
```

Then confirm the CLI picked it up:

```sh
gemini
> /mcp
```

No credential is needed. On the default `bundled` channel nothing is reached over a
network at all — the two read-only greeting tools are served by a process the CLI
starts. On an http channel the hub serves them anonymously, so there is still no token
to set and nothing to authorise.

Two notes about the file itself:

- The **stdio** entry names the bundled server by a **repo-relative** path. Gemini has
  no `CLAUDE_PLUGIN_ROOT`, so this config assumes you run the CLI from this checkout;
  point `args` at an absolute path if you run it from elsewhere.
- `_comment` is not a Gemini setting. It is there so the file announces that it is
  generated; the CLI ignores keys it does not know. Drop it if you would rather your
  own settings file stayed strictly to the schema — but drop it *after* copying, not
  here, or the next `clients:generate` puts it back.

## Free tier

Adding this server needs no paid plan. MCP is a **client-side** feature of the Gemini
CLI: the CLI reads `settings.json`, starts or connects to the server, and exposes its
tools to the model. Signing in with a personal Google account gets you the free tier
(60 requests/minute, 1,000 requests/day at the time of writing), and that quota governs
*model* calls, not how many MCP servers you may configure.

The one thing to know is that every tool result is sent to the model as part of a turn,
so a chatty MCP server spends the free quota faster. These two tools return a sentence
each, so it will not be this one.

## The same caveat as Codex, in a different place

Gemini's `mcpServers` object looks like Claude Code's and differs where it counts:

| | Claude Code | Gemini CLI |
|---|---|---|
| http | `"type": "http"`, `"url"` | `"httpUrl"` — a plain `url` means **SSE** |
| stdio | `"type": "stdio"` | no `type`; the key you use *is* the transport |

That is why `writeGeminiJson` exists rather than reusing `writeMcpJson`. If a future
Gemini version wants different keys, change them in **one place** — that writer in
[`../scripts/generate.js`](../scripts/generate.js) — and every channel is fixed at once.
