#!/usr/bin/env node
// packages/clients/axle/server/greeting-stdio.js
// The MCP server that ships INSIDE the plugin. The client spawns it over stdio, so it
// needs no host, no network, no account and no credential — an install works
// immediately, and offline.
//
// ZERO DEPENDENCIES, and that is a requirement rather than a preference: a marketplace
// install copies this directory as-is, with no `npm install` and no build step. The
// hub's own server uses the MCP SDK and zod, which together are 10.5 MB across 1,289
// files; vendoring that into a plugin to serve two pure functions would be absurd. So
// the wire protocol is implemented here directly — it is newline-delimited JSON-RPC
// 2.0, and the three methods a client actually needs are below.
//
// What it is NOT: a replacement for packages/hub. The hub is the hosted, multi-client,
// logged, health-checked service, and it stays the thing a deployment serves. This is
// the same tool surface with the transport swapped for a pipe, so the plugin works
// whether or not anything is deployed.
//
// Its two halves are both derived, never hand-written:
//   ./tools.json     GENERATED from the contract by `npm run clients:generate`
//   ./greeting.js    a byte-identical copy of packages/hub/src/lib/greeting.js
// `npm run clients:verify` fails if either drifts, so this server cannot answer with a
// surface or a behaviour that differs from the hub's.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { buildGreeting, respondToDay } = require('./greeting');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'tools.json'), 'utf8'));
const TOOLS = MANIFEST.tools;

// Same shape as the hub's handlers, and deliberately the same three lines each: the
// behaviour lives in greeting.js, which both servers share.
const HANDLERS = {
  greeting_hello: ({ name, hour }) => {
    const { greeting, question, message } = buildGreeting({ name, hour });
    return { ok: true, greeting, question, message };
  },
  greeting_day_check: ({ name, answer }) => {
    const { mood, reply } = respondToDay({ name, answer });
    return { ok: true, mood, reply };
  },
};

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
// The hub gets this from zod via the SDK. Here it is done by hand against the same
// generated JSON Schema, because a tool that throws a stack trace at a model on bad
// input is worse than one that says what was wrong.
function validate(schema, args) {
  const errors = [];
  const props = schema.properties || {};
  const required = schema.required || [];

  for (const key of required) {
    if (args[key] === undefined || args[key] === null) errors.push(`${key} is required`);
  }

  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    // additionalProperties is false in the generated schema, so an unknown key is a
    // caller bug worth naming rather than ignoring.
    if (!spec) {
      errors.push(`${key} is not a field this tool accepts`);
      continue;
    }
    if (value === undefined || value === null) continue;

    if (spec.type === 'string') {
      if (typeof value !== 'string') errors.push(`${key} must be a string`);
      else {
        if (spec.enum && !spec.enum.includes(value)) errors.push(`${key} must be one of ${spec.enum.join(', ')}`);
        if (spec.minLength != null && value.length < spec.minLength) errors.push(`${key} must be at least ${spec.minLength} characters`);
        if (spec.maxLength != null && value.length > spec.maxLength) errors.push(`${key} must be at most ${spec.maxLength} characters`);
      }
    } else if (spec.type === 'integer' || spec.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`${key} must be a number`);
      else {
        if (spec.type === 'integer' && !Number.isInteger(value)) errors.push(`${key} must be a whole number`);
        if (spec.minimum != null && value < spec.minimum) errors.push(`${key} must be >= ${spec.minimum}`);
        if (spec.maximum != null && value > spec.maximum) errors.push(`${key} must be <= ${spec.maximum}`);
      }
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`${key} must be true or false`);
    } else if (spec.type === 'array') {
      if (!Array.isArray(value)) errors.push(`${key} must be an array`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

// A tool that failed is NOT a protocol error: the call succeeded and the answer is a
// refusal. Reporting it as a JSON-RPC error would make the client retry or disconnect.
const toolError = (id, message) =>
  reply(id, { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }], isError: true });

function handle(request) {
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      // Echo the client's protocol version when it is one we speak, so a client on an
      // older revision is not forced to reconnect. Otherwise state our own and let it
      // decide.
      const asked = params && params.protocolVersion;
      const version = MANIFEST.supportedProtocolVersions.includes(asked) ? asked : MANIFEST.protocolVersion;
      return reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MANIFEST.serverName, version: MANIFEST.contractVersion },
        instructions: MANIFEST.instructions,
      });
    }

    // Sent by the client after initialize. No response is allowed for a notification.
    case 'notifications/initialized':
    case 'initialized':
      return undefined;

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: tool.readOnly === true, title: tool.title },
        })),
      });

    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return toolError(id, `unknown tool "${name}" — this server serves ${TOOLS.map((t) => t.name).join(', ')}`);

      const args = (params && params.arguments) || {};
      const errors = validate(tool.inputSchema, args);
      if (errors.length) return toolError(id, `invalid arguments for ${name}: ${errors.join('; ')}`);

      try {
        const value = HANDLERS[tool.name](args);
        // Both shapes, deliberately: `content` is what every client renders, and
        // `structuredContent` is what a client that reads output schemas prefers.
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
        });
      } catch (err) {
        return toolError(id, err && err.message ? err.message : 'the tool failed');
      }
    }

    default:
      if (isNotification) return undefined;
      return fail(id, -32601, `method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// stdin: newline-delimited JSON, one message per line. Buffered because a single read
// can split a message or carry several.
// ---------------------------------------------------------------------------
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      // No id is recoverable from unparseable input, so this is the one case that has
      // to answer with a null id per the JSON-RPC spec.
      fail(null, -32700, 'parse error');
      continue;
    }

    try {
      handle(request);
    } catch (err) {
      if (request && request.id != null) fail(request.id, -32603, err && err.message ? err.message : 'internal error');
    }
  }
});

process.stdin.on('end', () => process.exit(0));

// stdout is the transport. Anything written to it that is not a JSON-RPC message
// corrupts the stream, which is why there is not a single console.log in this file —
// diagnostics go to stderr, where the client shows them as server logs.
process.on('uncaughtException', (err) => {
  process.stderr.write(`greeting-stdio: ${err && err.stack ? err.stack : err}\n`);
});
