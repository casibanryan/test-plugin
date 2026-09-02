---
name: pivotly-hub
description: Explains the Pivotly MCP hub connection — which channel this client is pointed at, what the hub can do, and how to read its errors. Use when the user asks which environment they are connected to, why a Pivotly tool failed, or what the hub is.
---

# Pivotly hub

`pivotly-hub` is a remote MCP server reached over HTTPS. It is **stateless and
anonymous**: it serves read-only tools computed from the arguments you send it. No
database, no stored data, no credential.

## What it can do

| Tool | Use it for |
| --- | --- |
| `greeting_hello` | A time-appropriate salutation, plus the "how's your day?" question |
| `greeting_day_check` | Classify a free-text answer about someone's day |

That is the whole surface. There is no tool here that writes anything, reads stored
data, or acts on the user's behalf. If a task seems to need one, say so — do not look
for another route through this server.

## Which environment am I talking to?

The connection is pinned to one **channel**, and they are different deployments:

| Channel | What it is |
| --- | --- |
| `local` | A hub on the user's own machine |
| `dev` | Redeployed on every push to main — newest, least stable |
| `prerelease` | A verified release candidate |
| `production` | The stable deployment |

If the user asks which one they are on, the answer is in the connection's configured
URL — a `-dev` or `-prerelease` hostname says so directly, and a bare hostname is
production.

## When a call fails

Tool errors carry a `code`. Read it before retrying:

- `invalid_input` — the arguments were wrong. The message says which field; fix it and
  retry. This is the common one.
- `not_found` — no such tool. The client is likely built against a different contract
  version than the hub is serving; report it rather than guessing at another name.
- `unavailable` — the hub cannot serve right now. Worth one retry after a pause.
- `internal` — a bug on the server. Retrying will not help; report it.

There are no authentication errors, because there is no authentication.
