// packages/hub/src/logging.js
// Structured JSON logs on stderr.
//
// stderr, not stdout, is deliberate: in stdio mode stdout IS the MCP wire, and one
// stray log line there corrupts the protocol. Writing everything to stderr means the
// same logger is safe in both transports, and App Service picks stderr up as-is.

'use strict';

const { LOG_LEVELS } = require('./config');

// Keys whose values must never reach a log sink, whatever nesting they appear at.
//
// The hub currently handles no credentials at all, so in principle this scrub has
// nothing to do. It stays because a log call is written once and lives for years: the
// day something sensitive does pass through here, the default should already be to
// drop it rather than to print it.
const SECRET_KEYS = new Set(['token', 'authorization', 'password', 'secret', 'connectionstring', 'databaseurl', 'apikey']);

function scrub(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k.toLowerCase())) out[k] = '[redacted]';
    else out[k] = scrub(v, depth + 1);
  }
  return out;
}

function createLogger({ level = 'info', channel = 'local', commit = 'dev' } = {}) {
  const threshold = LOG_LEVELS.indexOf(level);

  const emit = (lvl, msg, fields) => {
    if (LOG_LEVELS.indexOf(lvl) < threshold) return;
    const line = { ts: new Date().toISOString(), level: lvl, channel, commit, msg, ...scrub(fields || {}) };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  };

  return {
    debug: (msg, f) => emit('debug', msg, f),
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
    // A child logger carries request-scoped fields (request id, principal) so a tool
    // handler does not have to thread them through every call.
    child: (bound) => {
      const parent = { channel, commit, level };
      const inner = createLogger(parent);
      return {
        debug: (msg, f) => inner.debug(msg, { ...bound, ...f }),
        info: (msg, f) => inner.info(msg, { ...bound, ...f }),
        warn: (msg, f) => inner.warn(msg, { ...bound, ...f }),
        error: (msg, f) => inner.error(msg, { ...bound, ...f }),
        child: (more) => createLogger(parent).child({ ...bound, ...more }),
      };
    },
  };
}

module.exports = { createLogger, scrub, SECRET_KEYS };
