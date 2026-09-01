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

## Notes

- `mood` is one of `positive`, `negative`, `neutral`, from keyword matching only.
  Treat it as a hint, not a judgement — if the text is clearly more nuanced than the
  bucket, respond to what the user actually said instead of the canned reply.
- Both tools are read-only: no network, no auth, no stored state.
