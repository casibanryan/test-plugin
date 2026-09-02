// packages/hub/src/tools/index.js
// Tool handlers, keyed by the contract's tool name.
//
// A handler is a plain async function of (args, ctx) -> plain object. It does no
// validation (the contract's zod schema, applied by the SDK, already did) and no
// response shaping (src/mcp.js does that). What is left is the behaviour, which is
// why each one is three lines.
//
// Both tools answer from pure logic in src/lib/greeting.js — no network, no state, no
// clock beyond an optional `hour` argument. That is what makes them safe to serve
// anonymously, and it is also what makes them a useful pipeline canary: if a deployed
// channel can answer these, its transport and routing are working, with nothing else
// in the way to blame.
//
// Every name here must exist in the contract and vice versa; src/mcp.js asserts the
// two sets are equal at boot.

'use strict';

const { buildGreeting, respondToDay } = require('../lib/greeting');

const HANDLERS = {
  greeting_hello: async ({ name, hour }) => {
    const { greeting, question, message } = buildGreeting({ name, hour });
    return { ok: true, greeting, question, message };
  },

  greeting_day_check: async ({ name, answer }) => {
    const { mood, reply } = respondToDay({ name, answer });
    return { ok: true, mood, reply };
  },
};

module.exports = { HANDLERS };
