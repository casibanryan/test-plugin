// packages/contract/src/errors.js
// Error codes shared by the hub and every client. The code is the stable API; the
// message is not. Clients branch on `code`, so adding one is minor and renaming one is
// major.
//
// Deliberately small. There are no auth codes because the hub is anonymous — it serves
// two pure functions and holds nothing worth protecting, so there is no credential to
// be missing, invalid, or insufficiently scoped.

'use strict';

const ERROR_CODES = {
  INVALID_INPUT: 'invalid_input', // failed the contract's input schema
  NOT_FOUND: 'not_found',         // no such tool or route
  UNAVAILABLE: 'unavailable',     // the server cannot serve right now
  INTERNAL: 'internal',           // a bug; the caller is told nothing more
};

// HTTP status used when a failure happens before MCP framing, i.e. at the transport.
const HTTP_STATUS_FOR_CODE = {
  [ERROR_CODES.INVALID_INPUT]: 400,
  [ERROR_CODES.NOT_FOUND]: 404,
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

  // The wire shape. Deliberately narrow: never leak a stack to a caller.
  toJSON() {
    return { ok: false, code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

const isPivotlyError = (e) => e instanceof PivotlyError || (e && typeof e.code === 'string' && e.name === 'PivotlyError');

module.exports = { ERROR_CODES, HTTP_STATUS_FOR_CODE, PivotlyError, isPivotlyError };
