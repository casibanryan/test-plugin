// packages/contract/src/index.js
// The whole contract, re-exported. Consumers should import from here (or from a named
// subpath in package.json#exports) and never reach into a sibling workspace for a
// schema, a scope name, or a version string.

'use strict';

const protocol = require('./protocol');
const errors = require('./errors');
const auth = require('./auth');
const tools = require('./tools');
const zod = require('./zod');
const digest = require('./digest');

// Identity of this contract build. The hub serves this from /version and the Axle
// channel manifest pins it, which is how a client detects it is talking to a hub built
// from a different contract than the one it was shipped against.
function contractIdentity() {
  return {
    contractVersion: protocol.CONTRACT_VERSION,
    contractDigest: digest.contractDigest(),
    mcpProtocolVersion: protocol.MCP_PROTOCOL_VERSION,
    toolNames: tools.TOOL_NAMES,
    clientToolNames: tools.CLIENT_TOOL_NAMES,
    serviceToolNames: tools.SERVICE_TOOL_NAMES,
  };
}

// Compatibility rule between a client and a hub, in one place so the autopatch script,
// the e2e tier-3 check, and the hub's own startup log all agree on the verdict.
//
//   ok        -> identical digests: nothing to do
//   patch     -> same major.minor, different digest: client manifest should be resynced
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
    return {
      verdict: 'breaking',
      reason: `contract major differs: client ${clientSide.contractVersion} vs server ${serverSide.contractVersion}`,
    };
  }
  if (minorOf(clientSide.contractVersion) !== minorOf(serverSide.contractVersion)) {
    return {
      verdict: 'patch',
      reason: `additive contract change: client ${clientSide.contractVersion} vs server ${serverSide.contractVersion}`,
    };
  }
  return {
    verdict: 'patch',
    reason: `same contract version ${serverSide.contractVersion} but digest differs (client ${clientSide.contractDigest}, server ${serverSide.contractDigest})`,
  };
}

module.exports = {
  ...protocol,
  ...errors,
  auth,
  tools,
  zod,
  digest,
  TOOLS: tools.TOOLS,
  TOOL_NAMES: tools.TOOL_NAMES,
  CLIENT_TOOL_NAMES: tools.CLIENT_TOOL_NAMES,
  SERVICE_TOOL_NAMES: tools.SERVICE_TOOL_NAMES,
  toolsForKind: tools.toolsForKind,
  STATELESS_TOOL_NAMES: tools.STATELESS_TOOL_NAMES,
  REQUIRED_SCOPES: tools.REQUIRED_SCOPES,
  getTool: tools.getTool,
  contractDigest: digest.contractDigest,
  contractSurface: digest.contractSurface,
  contractIdentity,
  compareContract,
};
