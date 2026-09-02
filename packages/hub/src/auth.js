// packages/hub/src/auth.js
// The request-time authorization chain, in the order it must run.
//
//   1. authenticate   forward the caller's bearer token to the platform API's /v1/me
//                     and take the identity it returns (or 401)
//   2. audience       is this tool even offered to this kind of principal?
//   3. scope          does the principal hold every scope the tool declares?
//
// Two things this file is deliberately NOT:
//
// It is not an identity store. The hub does not know what a token means; it asks the
// platform API and believes the answer. There is no user table here, no token hashing,
// and no way for a hub bug to invent a principal that the API would not have issued.
//
// It is not the security boundary. The API re-authorises every call it receives, with
// the caller's own token, and refuses writes for a client credential regardless of
// what the hub decided. This chain exists to refuse early, to refuse with a message
// that explains itself, and to keep a service tool out of a client's tools/list — not
// to be the only thing standing between a caller and the data.
//
// Order matters for what a caller learns: audience is checked before scope, so a
// client asking after a service tool is told it is not for clients rather than being
// told which scope it lacks — that answer would describe the platform's write surface
// to a credential with no business knowing about it.

'use strict';

const { parseBearer, missingScope, audienceAllows, redactToken } = require('@pivotly/contract/auth');
const { ERROR_CODES, PivotlyError } = require('@pivotly/contract/errors');
const { getTool } = require('@pivotly/contract/tools');

function createAuthenticator({ upstream, logger }) {
  // A short-lived identity cache. A tool call is usually preceded by a tools/list from
  // the same client seconds earlier, and each of those would otherwise be its own
  // round trip to /v1/me. The TTL is deliberately small: revoking a token should take
  // effect in seconds, so this trades a little staleness for a lot less upstream load,
  // and never caches a failure.
  const cache = new Map(); // token -> { principal, at }
  const TTL_MS = 5000;

  async function authenticate(headers, requestId) {
    const token = parseBearer(headers); // throws UNAUTHENTICATED

    const hit = cache.get(token);
    if (hit && Date.now() - hit.at < TTL_MS) {
      return { ...hit.principal, token };
    }

    let principal;
    try {
      principal = await upstream.whoami(token, requestId);
    } catch (err) {
      // A credential refusal from the API is re-worded here, deliberately. The API's
      // own message may distinguish unknown from revoked from expired, and passing
      // that through would let a caller probe which tokens exist. Anything that is
      // NOT a credential problem (the API being down, say) propagates untouched, so
      // an outage is never reported as a bad token.
      if (err.code === ERROR_CODES.TOKEN_INVALID || err.code === ERROR_CODES.UNAUTHENTICATED) {
        logger.warn('token was refused upstream', { requestId, token: redactToken(token), upstreamCode: err.code });
        throw new PivotlyError(ERROR_CODES.TOKEN_INVALID, 'the presented token is not valid');
      }
      throw err;
    }

    if (!principal || principal.disabled) {
      // Unknown, revoked, expired and disabled are all one answer on purpose: a caller
      // must not be able to probe which tokens exist.
      logger.warn('token did not resolve to a principal', { requestId, token: redactToken(token) });
      throw new PivotlyError(ERROR_CODES.TOKEN_INVALID, 'the presented token is not valid');
    }

    cache.set(token, { principal, at: Date.now() });
    // Bounded, so a spray of junk tokens cannot grow this without limit. Junk tokens
    // never reach here anyway — only resolved identities are cached.
    if (cache.size > 500) cache.delete(cache.keys().next().value);

    // The token travels with the principal because every upstream call forwards it.
    // The hub has no credential of its own to fall back on.
    return { ...principal, token };
  }

  function authorizeTool(principal, toolName, requestId) {
    const tool = getTool(toolName);
    if (!tool) throw new PivotlyError(ERROR_CODES.NOT_FOUND, `unknown tool "${toolName}"`);

    if (!audienceAllows(principal.kind, tool.audience)) {
      logger.warn('audience refusal', { requestId, tool: toolName, principalKind: principal.kind, audience: tool.audience });
      throw new PivotlyError(ERROR_CODES.FORBIDDEN_AUDIENCE, `"${toolName}" is a service tool and is not available to a client credential`);
    }

    const missing = missingScope(principal.scopes, tool.scopes);
    if (missing) {
      logger.warn('scope refusal', { requestId, tool: toolName, missing, held: principal.scopes });
      throw new PivotlyError(ERROR_CODES.FORBIDDEN_SCOPE, `"${toolName}" requires the ${missing} scope`);
    }

    logger.debug('authorized', { requestId, tool: toolName, kind: principal.kind });
    return tool;
  }

  return { authenticate, authorizeTool, _cache: cache };
}

module.exports = { createAuthenticator };
