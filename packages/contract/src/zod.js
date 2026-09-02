// packages/contract/src/zod.js
// Derives zod schemas from the declarative field descriptors in ./tools.js.
// This is the ONLY place descriptors turn into runtime validators — the hub calls this
// rather than writing its own zod, which is what keeps "validated on the server" and
// "advertised to the client" the same thing.

'use strict';

const { z } = require('zod');
const { TOOLS, FIELD_TYPES, getTool } = require('./tools');

function baseFor(field, path) {
  switch (field.type) {
    case 'string': {
      let s = z.string();
      if (field.min != null) s = s.min(field.min);
      if (field.max != null) s = s.max(field.max);
      return s;
    }
    case 'integer': {
      let n = z.number().int();
      if (field.min != null) n = n.min(field.min);
      if (field.max != null) n = n.max(field.max);
      return n;
    }
    case 'number': {
      let n = z.number();
      if (field.min != null) n = n.min(field.min);
      if (field.max != null) n = n.max(field.max);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum(field.values);
    case 'object':
      return z.record(z.unknown());
    case 'string[]': {
      let a = z.array(z.string());
      if (field.minItems != null) a = a.min(field.minItems);
      if (field.maxItems != null) a = a.max(field.maxItems);
      return a;
    }
    default:
      // Unreachable once the digest builder has validated the descriptors, but a
      // descriptor typo should fail loudly at boot rather than silently skip validation.
      throw new Error(`unsupported contract field type "${field.type}" at ${path} (allowed: ${FIELD_TYPES.join(', ')})`);
  }
}

function zodFieldFor(field, path) {
  let schema = baseFor(field, path);
  if (field.describe) schema = schema.describe(field.describe);
  if (field.optional) schema = schema.optional();
  return schema;
}

// The shape the MCP SDK's registerTool() wants: a flat object of zod validators.
function zodInputShapeFor(toolName) {
  const tool = getTool(toolName);
  if (!tool) throw new Error(`unknown tool: ${toolName}`);
  const shape = {};
  for (const [key, field] of Object.entries(tool.input)) {
    shape[key] = zodFieldFor(field, `${toolName}.input.${key}`);
  }
  return shape;
}

// A standalone validator, used by tests and by the stdio path where the SDK is not
// doing the validating for us.
const zodInputFor = (toolName) => z.object(zodInputShapeFor(toolName)).strict();

function zodOutputFor(toolName) {
  const tool = getTool(toolName);
  if (!tool) throw new Error(`unknown tool: ${toolName}`);
  const shape = {};
  for (const [key, field] of Object.entries(tool.output || {})) {
    shape[key] = zodFieldFor(field, `${toolName}.output.${key}`);
  }
  return z.object(shape);
}

// Every tool's input shape, built once. Throws on the first bad descriptor.
const allInputShapes = () => Object.fromEntries(TOOLS.map((t) => [t.name, zodInputShapeFor(t.name)]));

module.exports = { zodFieldFor, zodInputShapeFor, zodInputFor, zodOutputFor, allInputShapes };
