// packages/contract/src/tools.js
// The tool surface, declared as DATA rather than as zod objects.
//
// Why data: the declaration is what gets hashed into the contract digest, published on
// the hub's /version endpoint, and pinned by the shared channel manifest. A digest over
// plain JSON is stable, language-neutral, and diffable in review; a digest over live
// zod objects is none of those. `./zod.js` derives the validators from these
// descriptors, so there is still exactly one definition of every field.
//
// Every tool here is read-only and answers from pure logic in this process. The hub has
// no database, no upstream API and no credentials, so there is no write path to declare
// and no access rules to encode — `readOnly: true` is asserted for every tool by
// digest.js rather than being a per-tool decision.
//
// Editing rules (CI enforces the consequences, not the intent):
//   * adding a tool, or an optional field to a tool  -> MINOR contract bump
//   * removing either, or making an optional field required, or renaming anything
//                                                     -> MAJOR contract bump
//   * any edit at all -> re-run `npm run contract:digest -- --write` and commit the lock

'use strict';

// Field descriptor vocabulary. Anything not listed here is rejected by the digest
// builder, so a typo in a descriptor fails CI instead of silently loosening a schema.
const FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'enum', 'object', 'string[]'];

const TOOLS = [
  {
    name: 'greeting_hello',
    title: 'Greet someone and ask how their day is going',
    description:
      "Returns a time-of-day salutation (morning/afternoon/evening, or a neutral 'Hello' late at night) followed by \"How's your day going so far?\". Pass a name to personalise it, and an hour (0-23) to greet for a specific time instead of the server clock.",
    readOnly: true,
    input: {
      name: { type: 'string', optional: true, max: 60, describe: 'Who to greet. Omitted for an impersonal greeting.' },
      hour: { type: 'integer', optional: true, min: 0, max: 23, describe: 'Hour of day 0-23. Defaults to the server clock.' },
    },
    output: {
      ok: { type: 'boolean' },
      greeting: { type: 'string' },
      question: { type: 'string' },
      message: { type: 'string' },
    },
  },
  {
    name: 'greeting_day_check',
    title: "Respond to how someone's day is going",
    description:
      "Reads a free-text answer to 'How's your day going?', classifies it as positive, negative, or neutral, and returns a matching reply. Use after greeting_hello.",
    readOnly: true,
    input: {
      answer: { type: 'string', min: 1, max: 2000, describe: "What they said about their day, e.g. 'pretty good' or 'rough, very tired'." },
      name: { type: 'string', optional: true, max: 60, describe: 'Who answered. Used to personalise the reply.' },
    },
    output: {
      ok: { type: 'boolean' },
      mood: { type: 'enum', values: ['positive', 'negative', 'neutral'] },
      reply: { type: 'string' },
    },
  },
];

const TOOL_NAMES = TOOLS.map((t) => t.name).sort();

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const getTool = (name) => byName.get(name) || null;

module.exports = { FIELD_TYPES, TOOLS, TOOL_NAMES, getTool };
