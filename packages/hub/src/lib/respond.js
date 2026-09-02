// packages/hub/src/lib/respond.js
// MCP tool response shaping: success payloads as pretty JSON text, errors flagged
// with isError so the host surfaces them instead of treating them as content.

const asText = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });

const asErr = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

module.exports = { asText, asErr };
