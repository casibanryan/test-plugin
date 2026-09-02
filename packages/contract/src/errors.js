// packages/contract/src/errors.js
// Error codes shared by hub and clients. The code is the stable API; the message is
// not. Clients branch on `code`, so adding one is minor and renaming one is major.

'use strict';

const ERROR_CODES = {
  UNAUTHENTICATED: 'unauthenticated',       // no/!parseable credential
  TOKEN_INVALID: 'token_invalid',           // credential presented but unknown/expired
  FORBIDDEN_SCOPE: 'forbidden_scope',       // authenticated, lacks the tool's scope
  FORBIDDEN_ALLOWLIST: 'forbidden_allowlist', // scope ok, MCP allow-list says no
  FORBIDDEN_AUDIENCE: 'forbidden_audience',   // a client principal reached for a service-only tool
  INVALID_INPUT: 'invalid_input',           // failed the contract input schema
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',                     // e.g. job already claimed
  UNAVAILABLE: 'unavailable',               // database/dependency down
  INTERNAL: 'internal',
};

// HTTP status used when the failure happens before MCP framing (transport-level auth).
const HTTP_STATUS_FOR_CODE = {
  [ERROR_CODES.UNAUTHENTICATED]: 401,
  [ERROR_CODES.TOKEN_INVALID]: 401,
  [ERROR_CODES.FORBIDDEN_SCOPE]: 403,
  [ERROR_CODES.FORBIDDEN_ALLOWLIST]: 403,
  [ERROR_CODES.FORBIDDEN_AUDIENCE]: 403,
  [ERROR_CODES.INVALID_INPUT]: 400,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.CONFLICT]: 409,
  [ERROR_CODES.UNAVAILABLE]: 503,
  [ERROR_CODES.INTERNAL]: 500,
};

class PivotlyError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'PivotlyError';
    this.code = code;
    this.details = details;
    this.httpStatus = HTTP_STATUS_FOR_CODE[code] || 500;
  }

  // Wire shape. Deliberately narrow: never leak a stack or a SQL message to a client.
  toJSON() {
    return { ok: false, code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

const isPivotlyError = (e) => e instanceof PivotlyError || (e && typeof e.code === 'string' && e.name === 'PivotlyError');

module.exports = { ERROR_CODES, HTTP_STATUS_FOR_CODE, PivotlyError, isPivotlyError };
