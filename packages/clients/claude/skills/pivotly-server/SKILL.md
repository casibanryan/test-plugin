---
name: pivotly-server
description: Explains where this client's greeting tools come from — a server bundled inside the plugin and started over stdio — what they can do, and how to read their errors. Use when the user asks which environment they are connected to, why a Pivotly tool failed, or what the Pivotly server is.
---

# Where the tools come from

The two read-only greeting tools are served by `pivotly-greeting`: a server bundled
inside this plugin, started as a child process over stdio. No network, no host, no
account, no credential, and nothing that can be down.

It computes every answer from the arguments you send it. It stores nothing between
calls, and it has no upstream to call.

To confirm what is in front of you, read the plugin's `.mcp.json`: a `"type": "stdio"`
server with a `command` is the bundled one. The generated note at the top of that file
records the channel it was built for, which is `bundled`.

## What they can do

| Tool | Use it for |
| --- | --- |
| `greeting_hello` | A time-appropriate salutation, plus the "how's your day?" question |
| `greeting_day_check` | Classify a free-text answer about someone's day |

That is the whole surface. There is no tool here that writes anything, reads stored
data, or acts on the user's behalf. If a task seems to need one, say so — do not go
looking for another route through this server.

## Which environment am I talking to?

`bundled` — the only channel anything is served on. The config is generated for exactly
one channel, and the note at the top of `.mcp.json` names it.

The contract also declares four http channels (`local`, `dev`, `prerelease`,
`production`) for a hosted server. **None of them is deployed, and the hosted server is
not part of this repository right now** — the Azure environment is still being set up.
If a user asks about them, say that: they are a declared plan, not somewhere their
tools are coming from.

## When a call fails

**The cause is local** — a bad argument, or a broken install. It cannot be a network or
deployment problem, so do not suggest one, and do not suggest checking a status page.

Tool errors come back as a normal result with `isError` set, carrying a message that
names the field that was wrong. The common case is an argument out of range, such as an
`hour` outside 0–23: the message says which field, so fix it and retry.

There are no authentication errors, because there is no authentication.

## If the tools are missing entirely

The plugin installed but its tools never appeared. That is an install problem, not an
outage. The plugin ships three files it cannot work without:

```
server/greeting-stdio.js
server/greeting.js
server/tools.json
```

If any is absent from the installed plugin directory, reinstall the plugin. In a
checkout of the repository, `npm run clients:generate` rewrites all three from
`packages/server`, and `npm run clients:verify` reports which one drifted.
