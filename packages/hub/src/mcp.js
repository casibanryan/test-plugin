// packages/hub/src/mcp.js
// Builds an McpServer for one request.
//
// Everything registered here comes from the contract: the tool name, the title, the
// description the model reads, and the zod input schema. Nothing is restated locally,
// so the tool a client sees and the tool the hub validates cannot drift apart.
//
// A server is built per request rather than once at boot because the transport is
// stateless (see src/http.js). It is cheap — two tool registrations over pure
// functions — and it is what lets instances be recycled or slot-swapped mid-flight
// without a client noticing.

'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { TOOLS, TOOL_NAMES } = require('@pivotly/contract/tools');
const { zodInputShapeFor, allInputShapes } = require('@pivotly/contract/zod');
const { isPivotlyError, PivotlyError, ERROR_CODES } = require('@pivotly/contract/errors');

const { HANDLERS } = require('./tools');

// Boot-time coherence check: the contract and the implementation must describe exactly
// the same tool set, and every declared schema must actually build. Running this once
// at startup turns "declared but not implemented" into a crash on deploy — which the
// deploy gate catches — instead of a tools/call that fails for one unlucky user.
function assertHandlersMatchContract() {
  const declared = TOOL_NAMES.slice().sort();
  const implemented = Object.keys(HANDLERS).sort();
  const missing = declared.filter((n) => !implemented.includes(n));
  const extra = implemented.filter((n) => !declared.includes(n));
  if (missing.length || extra.length) {
    throw new Error(
      `tool registry does not match the contract — declared but not implemented: [${missing.join(', ')}]; ` +
        `implemented but not declared: [${extra.join(', ')}]`
    );
  }
  // Throws on the first malformed field descriptor.
  allInputShapes();
  return { tools: declared.length };
}

// MCP wants text content. Success is pretty JSON; a refusal is an isError result
// carrying the contract's error code so a client can branch on it.
const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function asError(err, logger, context) {
  if (isPivotlyError(err)) {
    // An expected refusal (bad input) is an answer, not a warning about the server.
    logger.info('tool refused', { ...context, code: err.code, reason: err.message });
    return { content: [{ type: 'text', text: JSON.stringify(err.toJSON(), null, 2) }], isError: true };
  }
  // Anything else is a bug. Log it in full, tell the caller nothing.
  logger.error('tool threw', { ...context, error: err.message, stack: err.stack });
  const safe = new PivotlyError(ERROR_CODES.INTERNAL, 'internal error');
  return { content: [{ type: 'text', text: JSON.stringify(safe.toJSON(), null, 2) }], isError: true };
}

function createMcpServer({ config, logger, requestId, client, channel }) {
  const server = new McpServer({ name: config.identity.server, version: config.identity.serverVersion });

  for (const tool of TOOLS) {
    const handler = HANDLERS[tool.name];

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: { readOnlyHint: tool.readOnly },
        inputSchema: zodInputShapeFor(tool.name),
      },
      async (args) => {
        // `client` and `channel` come from request headers and are logged, not trusted:
        // they say who claims to be calling, which is what makes "who is still on the
        // old contract" answerable before retiring one.
        const context = { requestId, tool: tool.name, client, channel };
        try {
          return asText(await handler(args || {}, { logger, requestId }));
        } catch (err) {
          return asError(err, logger, context);
        }
      }
    );
  }

  return server;
}

// What --selftest reports, and what the pipeline asserts against a freshly packaged
// build. Needs no network, no configuration and no dependency.
function selftest(config) {
  const { tools } = assertHandlersMatchContract();
  return {
    ok: true,
    ...config.identity,
    node: process.version,
    toolCount: tools,
    tools: TOOL_NAMES,
    anonymous: true,
  };
}

module.exports = { createMcpServer, assertHandlersMatchContract, selftest, asText, asError };
