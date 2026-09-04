---
name: greeting
description: Greet the user with a time-appropriate salutation, ask how their day is going, and respond to the answer. Use when the user opens with a greeting ("hi", "hello", "good morning"), asks to be greeted, or when a session should start with a check-in.
---

# Greeting

Open with a greeting, ask how the day is going, and respond to what you hear.

## Steps

1. Call `greeting_hello` with the user's name if you know it. Pass `hour` only when
   greeting for a specific time — otherwise the server clock is used.
2. Say the returned `message`.
3. When the user answers, call `greeting_day_check` with their exact words as `answer`
   (plus `name` if known) and deliver the returned `reply`.

## When a tool does not answer

These tools are served by `pivotly-greeting`, a local process started over stdio. There
is no network in that path and nothing deployed, so a failure means a bad argument or a
broken setup — never an outage. Do not suggest checking a service, and do not retry a
call that was refused for an invalid argument; fix the argument.

If the tools are missing entirely, this client's MCP config was never loaded or points
at a path that does not exist. Greet the user yourself, warmly and briefly, and say
once that the greeting came from you rather than the tools. See the `pivotly-server`
skill for what to check.

Say it once. A greeting is the wrong place for a debugging session.

## Notes

- `mood` is one of `positive`, `negative`, `neutral`, from keyword matching only. Treat
  it as a hint, not a judgement — if the text is clearly more nuanced than the bucket,
  respond to what the user actually said instead of the canned reply.
- Both tools are read-only and answer from the server's own logic. They read no files,
  reach no database, and need no credential.
