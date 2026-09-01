// servers/tools/day-check.js
// greeting_day_check — takes the answer to "how's your day?", classifies the mood, and
// replies in kind. Classification is keyword-based and deliberately dumb; it never
// claims more certainty than 'positive' / 'negative' / 'neutral'.

const { z } = require('zod');
const { respondToDay } = require('../lib/greeting');
const { asText, asErr } = require('../lib/respond');

function greetingDayCheck({ name, answer } = {}) {
  const { mood, reply } = respondToDay({ name, answer });
  return { ok: true, mood, reply };
}

function register(server) {
  server.registerTool('greeting_day_check', {
    annotations: { readOnlyHint: true },
    title: "Respond to how someone's day is going",
    description: "Reads a free-text answer to 'How's your day going?', classifies it as positive, negative, or neutral, and returns a matching reply. Use after greeting_hello.",
    inputSchema: {
      answer: z.string().describe("What they said about their day, e.g. 'pretty good' or 'rough, very tired'."),
      name: z.string().optional().describe('Who answered. Used to personalise the reply.'),
    },
  }, async (args) => { try { return asText(greetingDayCheck(args)); } catch (e) { return asErr(e); } });
}

module.exports = { greetingDayCheck, register };
