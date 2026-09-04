// packages/server/index.js
// The contract-aware face of this package.
//
// greeting.js and greeting-stdio.js deliberately know nothing about @pivotly/contract:
// they are copied verbatim into every plugin client, where no node_modules exists. So
// the check that the two sides agree lives HERE, one directory up from the files that
// ship, where depending on the contract costs nothing.

'use strict';

const { TOOL_NAMES } = require('@pivotly/contract/tools');
const { allInputShapes } = require('@pivotly/contract/zod');

const { HANDLERS } = require('./greeting-stdio');
const greeting = require('./greeting');

// The contract and the implementation must describe exactly the same tool set, and
// every declared schema must actually build. Previously the hub asserted this at boot,
// which turned "declared but not implemented" into a crash on deploy. With no hub to
// boot there is no deploy to crash, so this is called from the test suites instead —
// the earliest moment such a mismatch can still be caught.
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

module.exports = { HANDLERS, assertHandlersMatchContract, ...greeting };
