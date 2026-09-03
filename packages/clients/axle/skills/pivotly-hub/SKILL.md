---
name: pivotly-hub
description: Explains where this client's greeting tools come from — the server bundled in the plugin, or a remote Pivotly hub channel — what they can do, and how to read their errors. Use when the user asks which environment they are connected to, why a Pivotly tool failed, or what the hub is.
---

# Where the tools come from

The same two read-only tools are served in one of two ways, and which one is in play
changes the answer to almost every question a user asks about them.

| Server name in `/mcp` | What it is |
| --- | --- |
| `pivotly-greeting` | **The default.** A server bundled inside this plugin, started over stdio. No network, no host, no account, no credential. Nothing to be down. |
| `pivotly-hub` | A remote MCP server over HTTPS — stateless and anonymous, but deployed somewhere and therefore able to be unreachable. |

Both compute their answers from the arguments you send, using the same logic. Neither
stores anything.

To tell which one is in front of you, read the plugin's `.mcp.json`: a `"type":
"stdio"` server with a `command` is the bundled one, and a `"type": "http"` server with
a `url` is the remote hub. The generated note at the top of that file also records the
channel it was built for.

## What they can do

| Tool | Use it for |
| --- | --- |
| `greeting_hello` | A time-appropriate salutation, plus the "how's your day?" question |
| `greeting_day_check` | Classify a free-text answer about someone's day |

That is the whole surface. There is no tool here that writes anything, reads stored
data, or acts on the user's behalf. If a task seems to need one, say so — do not go
looking for another route through this server.

## Which environment am I talking to?

The config is generated for exactly one **channel**:

| Channel | What it is |
| --- | --- |
| `bundled` | The server inside this plugin. The default, and the only one that cannot be unreachable |
| `local` | A hub the user runs on their own machine (`npm run dev:hub`) |
| `dev` | Redeployed on every push to main — newest, least stable |
| `prerelease` | A verified release candidate |
| `production` | The stable deployment |

For the four http channels the hostname says which: a `-dev` or `-prerelease` hostname
says so directly, and a bare hostname is production.

## When a call fails

**If the server is `pivotly-greeting` and a call fails, the cause is local** — a bad
argument, or a broken install. It cannot be a network or deployment problem, so do not
suggest one, and do not suggest checking a status page.

Tool errors carry a message naming the field that was wrong. For the remote hub, errors
also carry a `code`:

- `invalid_input` — the arguments were wrong. The message says which field; fix it and
  retry. This is the common one.
- `not_found` — no such tool. The client is likely built against a different contract
  version than the hub is serving; report it rather than guessing at another name.
- `unavailable` — the hub cannot serve right now. Worth one retry after a pause.
- `internal` — a bug on the server. Retrying will not help; report it.

There are no authentication errors, because there is no authentication.

## If the remote hub is unreachable

That is expected when nothing is deployed. It is not a reason to stop being useful:
regenerate the client for the channel that always works, which needs no host and no
network.

```
npm run clients:generate -- --channel=bundled
```

Then reload the plugin. The tools answer immediately, from the same logic the hub
would have used.
