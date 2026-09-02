// packages/contract/src/tools.js
// The tool surface, declared as DATA rather than as zod objects.
//
// Why data: the declaration is what gets hashed into the contract digest, published on
// the hub's /version endpoint, and pinned by the Axle channel manifest. A digest over
// plain JSON is stable, language-neutral, and diffable in review; a digest over live
// zod objects is neither. `./zod.js` derives the zod schemas from these descriptors, so
// there is still exactly one definition of every field.
//
// The surface is split by AUDIENCE, and the split is the platform's main safety rail:
//
//   audience: 'client'   reachable by an end-user client such as the Axle plugin.
//                        MUST be readOnly — digest.js refuses to build a contract
//                        where a client tool can write, so "the plugin cannot change
//                        platform data" is a CI-enforced invariant, not a convention.
//   audience: 'service'  reachable only by a principal whose credential was issued as
//                        kind 'service' (a queue worker, an ingest job). Refused for a
//                        client principal in three independent places: the hub never
//                        registers the tool for that session, the scope is never
//                        granted to a client principal, and the platform API rejects a
//                        client credential on every write endpoint. Any one would be
//                        enough; all three means a bug in one does not become a write
//                        path — and only the last is out of reach of a bug in this
//                        repository, which is why it is the platform's job.
//
// Editing rules (CI enforces the consequences, not the intent):
//   * adding a tool, or an optional field to a tool  -> MINOR contract bump
//   * removing either, or making an optional field required, or changing a scope
//     or an audience                                 -> MAJOR contract bump
//   * any edit at all -> re-run `npm run contract:digest -- --write` and commit the lock

'use strict';

const { SCOPES } = require('./auth');

// Field descriptor vocabulary. Anything not listed here is rejected by the digest
// builder, so a typo in a descriptor fails CI instead of silently loosening a schema.
const FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'enum', 'object', 'string[]'];

const TOOLS = [
  {
    name: 'greeting_hello',
    audience: 'client',
    title: 'Greet someone and ask how their day is going',
    description:
      "Returns a time-of-day salutation (morning/afternoon/evening, or a neutral 'Hello' late at night) followed by \"How's your day going so far?\". Pass a name to personalise it, and an hour (0-23) to greet for a specific time instead of the server clock.",
    scopes: [SCOPES.GREETING_READ],
    readOnly: true,
    // Reference tool: no database, no tenant data. It is the canary the pipeline uses
    // to prove the transport and auth chain work before touching anything stateful.
    touchesDatabase: false,
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
    audience: 'client',
    title: "Respond to how someone's day is going",
    description:
      "Reads a free-text answer to 'How's your day going?', classifies it as positive, negative, or neutral, and returns a matching reply. Use after greeting_hello.",
    scopes: [SCOPES.GREETING_READ],
    readOnly: true,
    touchesDatabase: false,
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
  {
    name: 'usdf_record_put',
    // SERVICE ONLY. This is the platform's only write path into USDF, and it is not
    // reachable by a client: a worker with a service credential calls it, an editor
    // plugin cannot. Deliberately not part of the Axle surface.
    audience: 'service',
    title: 'Store a USDF record',
    description:
      'Validates a payload against the registered USDF (Unified Structured Data Format) schema for `kind` and stores it against the caller tenant. Returns the record id and checksum. Service-only write path: requires a service principal, the usdf:write scope, and an MCP allow-list entry.',
    scopes: [SCOPES.USDF_WRITE],
    readOnly: false,
    touchesDatabase: true,
    input: {
      kind: { type: 'string', min: 1, max: 64, describe: 'Registered USDF kind, e.g. `greeting.session`.' },
      payload: { type: 'object', describe: 'The record body. Must satisfy the registered schema for `kind`.' },
      idempotencyKey: { type: 'string', optional: true, max: 128, describe: 'Repeat a call safely; the same key returns the original record id.' },
    },
    output: {
      ok: { type: 'boolean' },
      recordId: { type: 'string' },
      kind: { type: 'string' },
      schemaVersion: { type: 'integer' },
      checksum: { type: 'string' },
      deduplicated: { type: 'boolean' },
    },
  },
  {
    name: 'usdf_record_get',
    audience: 'client',
    title: 'Read a USDF record',
    description: 'Fetches one USDF record by id. Scoped to the caller tenant by the database, not by this server.',
    scopes: [SCOPES.USDF_READ],
    readOnly: true,
    touchesDatabase: true,
    input: {
      recordId: { type: 'string', min: 1, max: 64, describe: 'Record id returned by usdf_record_put.' },
    },
    output: {
      ok: { type: 'boolean' },
      recordId: { type: 'string' },
      kind: { type: 'string' },
      schemaVersion: { type: 'integer' },
      payload: { type: 'object' },
      createdAt: { type: 'string' },
    },
  },
  {
    name: 'job_claim',
    // SERVICE ONLY. Claiming mutates queue state and takes a lease; that is a worker's
    // job, never an interactive session's.
    audience: 'service',
    title: 'Claim the next queued job',
    description:
      'Atomically claims the highest-priority runnable job of one of `kinds` and holds a lease on it for `leaseSeconds`. Returns null when the queue is empty. Concurrent callers never receive the same job.',
    scopes: [SCOPES.JOBS_CLAIM],
    readOnly: false,
    touchesDatabase: true,
    input: {
      worker: { type: 'string', min: 1, max: 128, describe: 'Stable identifier for the claiming worker, e.g. `axle@host`.' },
      kinds: { type: 'string[]', optional: true, describe: 'Job kinds to consider. Omitted means any kind the caller may run.' },
      leaseSeconds: { type: 'integer', optional: true, min: 5, max: 3600, describe: 'How long the claim is held before the job becomes re-claimable. Default 60.' },
    },
    output: {
      ok: { type: 'boolean' },
      claimed: { type: 'boolean' },
      jobId: { type: 'string', optional: true },
      kind: { type: 'string', optional: true },
      payload: { type: 'object', optional: true },
      attempt: { type: 'integer', optional: true },
      leaseExpiresAt: { type: 'string', optional: true },
    },
  },
];

const TOOL_NAMES = TOOLS.map((t) => t.name).sort();

// The two halves of the surface. The hub registers only the half a session is entitled
// to, so a client's `tools/list` does not even mention a service tool — it cannot call
// what it was never told about, and it cannot be prompt-injected into trying.
const CLIENT_TOOL_NAMES = TOOLS.filter((t) => t.audience === 'client').map((t) => t.name).sort();
const SERVICE_TOOL_NAMES = TOOLS.filter((t) => t.audience === 'service').map((t) => t.name).sort();

// Tools visible to a given principal kind.
const toolsForKind = (kind) => TOOLS.filter((t) => (t.audience === 'client' ? true : kind === 'service'));

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const getTool = (name) => byName.get(name) || null;

// Tools that never touch the database — the subset a smoke test can call against a
// freshly deployed container before its database wiring has been proven.
const STATELESS_TOOL_NAMES = TOOLS.filter((t) => !t.touchesDatabase).map((t) => t.name);

// Every scope actually referenced by a tool. The DB verifier cross-checks that each of
// these is grantable, so a scope can't be required by a tool but unissuable in practice.
const REQUIRED_SCOPES = [...new Set(TOOLS.flatMap((t) => t.scopes))].sort();

module.exports = {
  FIELD_TYPES,
  TOOLS,
  TOOL_NAMES,
  CLIENT_TOOL_NAMES,
  SERVICE_TOOL_NAMES,
  STATELESS_TOOL_NAMES,
  REQUIRED_SCOPES,
  toolsForKind,
  getTool,
};
