---
name: greeting
description: Greet the user with a time-appropriate salutation, ask how their day is going, respond to the answer, and report which version of this plugin is running. Use when the user opens with a greeting ("hi", "hello", "good morning"), asks to be greeted, or when a session should start with a check-in.
---

# Greeting

Open with a greeting, ask how the day is going, respond to what you hear, and sign off
with which version of this plugin said it.

## Steps

1. Call `greeting_hello` with the user's name if you know it. Pass `hour` only when
   greeting for a specific time — otherwise the server clock is used.
2. Say the returned `message`.
3. **End the greeting with the plugin banner** — see below. It goes on its own line, in
   italics, after the greeting text.
4. When the user answers, call `greeting_day_check` with their exact words as `answer`
   (plus `name` if known) and deliver the returned `reply`. The banner belongs on the
   first greeting only; do not repeat it on every turn.

## The plugin banner

The plugin's `SessionStart` hook has already put a line in your context that looks
like:

```
Axle plugin updated — v0.3.1 · 2026-09-04 15:02 · a1b2c3d · production channel
```

Reproduce that line verbatim. It is the version actually loaded, the moment this
machine took the update, the marketplace commit, and the hub channel this build talks
to — which together are the whole point: they are how a user can tell that a green
pipeline actually reached their laptop.

Do not invent, round, or reformat any part of it. If no such line is in your context,
say `Axle plugin version unavailable — the SessionStart hook did not report` rather
than guessing a version.

## When the hub does not answer

`greeting_hello` and `greeting_day_check` live on the Pivotly hub. If the call fails —
DNS failure, connection refused, a channel that is not deployed — do not retry and do
not present the failure as the plugin being broken:

1. Greet the user yourself, warmly and briefly, and ask how their day is going.
2. Still show the banner. The plugin's version is a local fact and does not depend on
   the hub being up.
3. Add one line naming what happened, including the channel from the banner, e.g.
   `The greeting tools are on the production channel, which is not answering — that
   greeting came from me, not the hub.`

Say it once. A greeting is the wrong place for a debugging session.

## Notes

- `mood` is one of `positive`, `negative`, `neutral`, from keyword matching only. Treat
  it as a hint, not a judgement — if the text is clearly more nuanced than the bucket,
  respond to what the user actually said instead of the canned reply.
- Both tools are read-only and answer from the server's own logic. They read no files,
  reach no database, and need no credential.
