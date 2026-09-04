---
name: greeting
clients: [claude, codex, gemini]
<!-- if:claude -->
description: Greet the user with a time-appropriate salutation, ask how their day is going, respond to the answer, and report which version of this plugin is running. Use when the user opens with a greeting ("hi", "hello", "good morning"), asks to be greeted, or when a session should start with a check-in.
<!-- endif -->
<!-- if:codex,gemini -->
description: Greet the user with a time-appropriate salutation, ask how their day is going, and respond to the answer. Use when the user opens with a greeting ("hi", "hello", "good morning"), asks to be greeted, or when a session should start with a check-in.
<!-- endif -->
---

# Greeting

Open with a greeting, ask how the day is going, and respond to what you hear.
<!-- if:claude -->
Sign off with which version of this plugin said it.
<!-- endif -->

## Steps

1. Call `greeting_hello` with the user's name if you know it. Pass `hour` only when
   greeting for a specific time — otherwise the server clock is used.
2. Say the returned `message`.
3. When the user answers, call `greeting_day_check` with their exact words as `answer`
   (plus `name` if known) and deliver the returned `reply`.
<!-- if:claude -->
4. **End the first greeting with the plugin banner** — see below. It goes on its own
   line, in italics, after the greeting text from step 2. The banner belongs on the
   first greeting only; do not repeat it on every turn.

## The plugin banner

The plugin's `SessionStart` hook has already put a line in your context that looks
like:

```
Pivotly plugin updated — v0.3.1 · 2026-09-04 15:02 · a1b2c3d · bundled tools
```

Reproduce that line verbatim. It is the version actually loaded, the moment this
machine took the update, the marketplace commit, and where the tools are served from —
`bundled tools`, for the server inside this plugin. Together they are the whole point:
they are how a user can tell that a green pipeline actually reached their laptop.

Do not invent, round, or reformat any part of it. If no such line is in your context,
say `Pivotly plugin version unavailable — the SessionStart hook did not report` rather
than guessing a version.
<!-- endif -->

## When a tool does not answer

These tools are served by `pivotly-greeting`, a local process started over stdio. There
is no network in that path and nothing deployed, so a failure means a bad argument or a
broken setup — never an outage. Do not suggest checking a service, and do not retry a
call that was refused for an invalid argument; fix the argument.

<!-- if:claude -->
If the tools are missing entirely, the plugin installed without its server. Greet the
user yourself, warmly and briefly, still show the banner (the version is a local fact
and needs no server), and say once that the greeting came from you rather than the
tools. See the `pivotly-server` skill for what to check.
<!-- endif -->
<!-- if:codex,gemini -->
If the tools are missing entirely, this client's MCP config was never loaded or points
at a path that does not exist. Greet the user yourself, warmly and briefly, and say
once that the greeting came from you rather than the tools. See the `pivotly-server`
skill for what to check.
<!-- endif -->

Say it once. A greeting is the wrong place for a debugging session.

## Notes

- `mood` is one of `positive`, `negative`, `neutral`, from keyword matching only. Treat
  it as a hint, not a judgement — if the text is clearly more nuanced than the bucket,
  respond to what the user actually said instead of the canned reply.
- Both tools are read-only and answer from the server's own logic. They read no files,
  reach no database, and need no credential.
