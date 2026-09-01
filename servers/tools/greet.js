// servers/tools/greet.js
// greeting_hello — opens the conversation: a time-appropriate salutation plus the
// "how's your day?" question. No network, no auth, no state.

const { z } = require('zod');
const { buildGreeting } = require('../lib/greeting');
const { asText, asErr } = require('../lib/respond');

function greetingHello({ name, hour } = {}) {
  const { greeting, question, message } = buildGreeting({ name, hour });
  return { ok: true, greeting, question, message };
}

function register(server) {
  server.registerTool('greeting_hello', {
    annotations: { readOnlyHint: true },
    title: 'Greet someone and ask how their day is going',
    description: "Returns a time-of-day salutation (morning/afternoon/evening, or a neutral 'Hello' late at night) followed by 'How's your day going so far?'. Pass a name to personalise it, and an hour (0-23) to greet for a specific time instead of the server clock.",
    inputSchema: {
      name: z.string().optional().describe('Who to greet. Omitted for an impersonal greeting.'),
      hour: z.number().int().min(0).max(23).optional().describe('Hour of day 0-23. Defaults to the server clock.'),
    },
  }, async (args) => { try { return asText(greetingHello(args)); } catch (e) { return asErr(e); } });
}

module.exports = { greetingHello, register };
