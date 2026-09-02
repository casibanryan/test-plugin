// packages/hub/src/mcp.js
// Builds an McpServer for one authenticated session.
//
// The server is built PER PRINCIPAL, not once at boot, and that is the point: it
// registers only the tools that principal's kind is entitled to. A client session's
// `tools/list` therefore does not mention `usdf_record_put` at all — it is not
// described, not schema'd, and not callable. There is nothing for a model to be talked
// into trying and nothing for a prompt injection to name.
//
// Everything registered here comes from the contract: the name, the title, the
// description the model reads, and the zod input schema. Nothing is restated locally,
// so the tool a client sees and the tool the hub validates cannot drift apart.

'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { TOOLS, TOOL_NAMES, toolsForKind } = require('@pivotly/contract/tools');
const { zodInputShapeFor } = require('@pivotly/contract/zod');
const { isPivotlyError, PivotlyError, ERROR_CODES } = require('@pivotly/contract/errors');

const { HANDLERS } = require('./tools');

// Boot-time coherence check: the contract and the implementation must describe exactly
// the same tool set. Running this once at startup turns "declared but not implemented"
// into a crash on deploy — which the pipeline's health gate catches — instead of a
// tools/call that fails for one unlucky user.
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
}

// MCP wants text content. Success is pretty JSON; a refusal is an isError result
// carrying the contract's error code so a client can branch on it.
const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function asError(err, logger, context) {
  if (isPivotlyError(err)) {
    // Expected refusals (auth, scope, allow-list, bad input) are not warnings about
    // the server; they are answers. Log at info and return the code.
    logger.info('tool refused', { ...context, code: err.code, reason: err.message });
    return { content: [{ type: 'text', text: JSON.stringify(err.toJSON(), null, 2) }], isError: true };
  }
  // Anything else is a bug or an outage. Log it in full, tell the caller nothing.
  logger.error('tool threw', { ...context, error: err.message, stack: err.stack });
  const safe = new PivotlyError(ERROR_CODES.INTERNAL, 'internal error');
  return { content: [{ type: 'text', text: JSON.stringify(safe.toJSON(), null, 2) }], isError: true };
}

function createMcpServer({ principal, upstream, config, logger, authenticator, requestId }) {
  const server = new McpServer({ name: config.identity.server, version: config.identity.serverVersion });

  const visible = toolsForKind(principal.kind);

  for (const tool of visible) {
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
        const context = { requestId, tool: tool.name, principal: principal.email, kind: principal.kind };
        try {
          // Re-run authorization at call time even though registration already
          // filtered by audience. Registration is a convenience for the model;
          // authorizeTool is the decision, and it is cheap enough to repeat.
          authenticator.authorizeTool(principal, tool.name, requestId);
          const result = await handler(args || {}, { principal, upstream, logger, requestId });
          return asText(result);
        } catch (err) {
          return asError(err, logger, context);
        }
      }
    );
  }

  logger.debug('built mcp server for session', {
    requestId,
    kind: principal.kind,
    tools: visible.map((t) => t.name),
  });

  return server;
}

// What the stateless self-test reports, and what the container smoke test asserts.
// Uses the stateless client-surface tools only, so it needs no database and no token.
function selftest(config) {
  assertHandlersMatchContract();
  return {
    ok: true,
    ...config.identity,
    node: process.version,
    upstream: config.upstream.baseUrl,
    tools: {
      all: TOOL_NAMES,
      client: toolsForKind('client').map((t) => t.name),
      service: TOOLS.filter((t) => t.audience === 'service').map((t) => t.name),
    },
    samples: {
      greeting_hello: { greeting: 'Good morning, World!', hour: 9 },
    },
  };
}

module.exports = { createMcpServer, assertHandlersMatchContract, selftest, asText, asError };
