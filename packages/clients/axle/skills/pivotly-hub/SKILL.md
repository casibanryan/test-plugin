---
name: pivotly-hub
description: Read Pivotly platform data through the Pivotly MCP hub. Use when the user asks about a Pivotly USDF record by id, or when a task needs data that lives in the Pivotly platform rather than in the local repository.
---

# Pivotly hub

The `pivotly-hub` MCP server is a remote, HTTPS connection to the Pivotly platform.
Its tools read platform data; none of them change anything.

## What you can do

| Tool | Use it for |
| --- | --- |
| `usdf_record_get` | Fetch one USDF record by id |
| `greeting_hello` | A connectivity check that needs no platform data |
| `greeting_day_check` | Classify a free-text answer about someone's day |

## What you cannot do

**This client is read-only, deliberately.** There is no tool here that writes a
record, enqueues work, or claims a job — the platform issues this connection a
`client` credential, and it refuses every write for one. If a task seems to need a
write, say so and stop; do not look for another route.

## Reading a record

Pass the record id exactly as the user gave it to `usdf_record_get`. Two answers are
normal and mean different things:

- `ok: true` — the record, with its `kind`, `schemaVersion` and `payload`.
- `ok: false, code: "not_found"` — no record with that id **that this account can
  see**. Records are scoped to a tenant, so this is also the answer for a record that
  exists in a different one. Report it as "not found for this account" rather than
  "does not exist", because you cannot tell the two apart and guessing would be wrong.

## When a call fails

Tool errors carry a `code`. Read it before retrying:

- `unauthenticated` / `token_invalid` — `PIVOTLY_MCP_TOKEN` is missing, expired or
  revoked. Retrying will not help; tell the user to refresh it.
- `forbidden_scope` — the account is authenticated but lacks the scope. An access
  request, not a retry.
- `forbidden_audience` — a service-only tool was reached for. Do not try again.
- `unavailable` — the platform API is down or slow. This one is worth retrying once,
  after a pause.
- `invalid_input` — the arguments were wrong. Fix them; the message says what.
