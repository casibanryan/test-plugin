// packages/server/test/contract.test.js
// The server and the contract must describe the same tool set.
//
// The hub used to assert this at boot, which turned "declared but not implemented"
// into a crash on deploy that the deploy gate caught. There is no boot to crash any
// more — a stdio server starts inside someone's editor — so the assertion runs here
// instead, which is the earliest point such a mismatch can still be caught.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TOOL_NAMES } = require('@pivotly/contract/tools');
const { contractDigest } = require('@pivotly/contract/digest');
const { CONTRACT_VERSION } = require('@pivotly/contract/protocol');

const { HANDLERS, assertHandlersMatchContract } = require('..');

test('every declared tool has a handler, and every handler is declared', () => {
  const { tools } = assertHandlersMatchContract();
  assert.equal(tools, TOOL_NAMES.length);
  assert.deepEqual(Object.keys(HANDLERS).sort(), TOOL_NAMES.slice().sort());
});

test('requiring the server does not start the transport', () => {
  // The transport is guarded by `require.main === module`. Without that guard this
  // very file would hang: the module would take stdin and never return.
  assert.equal(typeof require('../greeting-stdio').handle, 'function');
});

test('the generated tool surface matches this checkout\'s contract', () => {
  const manifest = require('../tools.json');
  assert.equal(manifest.contractDigest, contractDigest(), 'run: npm run clients:generate');
  assert.equal(manifest.contractVersion, CONTRACT_VERSION, 'run: npm run clients:generate');
  assert.deepEqual(manifest.tools.map((t) => t.name).sort(), TOOL_NAMES.slice().sort());
});

test('every tool is declared read-only, as serving them anonymously requires', () => {
  for (const tool of require('../tools.json').tools) {
    assert.equal(tool.readOnly, true, `${tool.name} is not read-only`);
  }
});
