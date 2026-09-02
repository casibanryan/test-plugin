// packages/contract/src/index.js
// The whole contract, re-exported. Consumers import from here (or a named subpath in
// package.json#exports) and never reach into a sibling workspace for a schema, a
// channel URL, or a version string.

'use strict';

const protocol = require('./protocol');
const errors = require('./errors');
const tools = require('./tools');
const zod = require('./zod');
const digest = require('./digest');

// Identity of this contract build. The hub serves this from /version and every client's
// channel pin records it, which is how a client detects it is talking to a hub built
// from a different contract than the one it shipped against.
function contractIdentity() {
  return {
    contractVersion: protocol.CONTRACT_VERSION,
    contractDigest: digest.contractDigest(),
    mcpProtocolVersion: protocol.MCP_PROTOCOL_VERSION,
    toolNames: tools.TOOL_NAMES,
    clientIds: protocol.CLIENT_IDS,
  };
}

// The compatibility rule between a client and a hub, in one place so the autopatch
// script, the e2e client tier, and the hub's own startup log all reach the same verdict.
//
//   ok        -> identical digests: nothing to do
//   patch     -> same major, different digest: the client manifest should be resynced
//   breaking  -> different major: the client must be upgraded before it will work
function compareContract(clientSide, serverSide) {
  const majorOf = (v) => String(v || '0.0.0').split('.')[0];
  const minorOf = (v) => String(v || '0.0.0').split('.').slice(0, 2).join('.');

  if (!serverSide || !serverSide.contractDigest) {
    return { verdict: 'unknown', reason: 'server did not report a contract digest' };
  }
  if (clientSide.contractDigest === serverSide.contractDigest) {
    return { verdict: 'ok', reason: 'digests match' };
  }
  if (majorOf(clientSide.contractVersion) !== majorOf(serverSide.contractVersion)) {
    return { verdict: 'breaking', reason: `contract major differs: client ${clientSide.contractVersion} vs server ${serverSide.contractVersion}` };
  }
  if (minorOf(clientSide.contractVersion) !== minorOf(serverSide.contractVersion)) {
    return { verdict: 'patch', reason: `additive contract change: client ${clientSide.contractVersion} vs server ${serverSide.contractVersion}` };
  }
  return {
    verdict: 'patch',
    reason: `same contract version ${serverSide.contractVersion} but digest differs (client ${clientSide.contractDigest}, server ${serverSide.contractDigest})`,
  };
}

module.exports = {
  ...protocol,
  ...errors,
  tools,
  zod,
  digest,
  TOOLS: tools.TOOLS,
  TOOL_NAMES: tools.TOOL_NAMES,
  getTool: tools.getTool,
  contractDigest: digest.contractDigest,
  contractSurface: digest.contractSurface,
  contractIdentity,
  compareContract,
};
