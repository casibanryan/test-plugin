// packages/hub/src/upstream/client.js
// The hub's only way to reach data: HTTPS calls to the Pivotly platform API.
//
// There is no database driver in this package and no connection string in its config.
// Records, jobs and identity all live behind the API, which already owns the schema,
// the access rules and the audit trail — so the hub stays a stateless protocol
// adapter that can be scaled, recycled or slot-swapped without anything to migrate.
//
// The token handling is the part worth being deliberate about: the hub forwards the
// CALLER'S bearer token upstream and holds no credential of its own. Consequences,
// all of them intended:
//
//   * the API authorises the end user, not the hub, so a bug here cannot widen
//     anyone's access — the worst it can do is fail a call;
//   * there is no ambient service credential to steal from a compromised instance;
//   * every upstream audit row names the real caller.
//
// Trade-off, stated plainly: the hub cannot do anything on its own behalf, so it has
// no background work and no way to act without a live caller. That is the right shape
// for an MCP adapter and the wrong shape for a worker, which is why workers call the
// API directly rather than going through here.

'use strict';

const { UPSTREAM_ENDPOINTS } = require('@pivotly/contract/protocol');
const { HEADERS, AUTH_SCHEME, normalizePrincipal } = require('@pivotly/contract/auth');
const { ERROR_CODES, PivotlyError } = require('@pivotly/contract/errors');

// Upstream HTTP status -> contract error code. The API's own JSON error body is
// preferred when it carries a recognised code; this is the fallback.
const STATUS_TO_CODE = {
  400: ERROR_CODES.INVALID_INPUT,
  401: ERROR_CODES.TOKEN_INVALID,
  403: ERROR_CODES.FORBIDDEN_SCOPE,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  422: ERROR_CODES.INVALID_INPUT,
  429: ERROR_CODES.UNAVAILABLE,
  500: ERROR_CODES.INTERNAL,
  502: ERROR_CODES.UNAVAILABLE,
  503: ERROR_CODES.UNAVAILABLE,
  504: ERROR_CODES.UNAVAILABLE,
};

const KNOWN_CODES = new Set(Object.values(ERROR_CODES));

// Only these are worth retrying: a transient upstream problem or a squeezed pool.
// A 4xx is the API's considered answer and retrying it just doubles the load.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

const fillPath = (template, params = {}) =>
  template.replace(/:([a-zA-Z]+)/g, (_, key) => {
    if (params[key] == null) throw new PivotlyError(ERROR_CODES.INVALID_INPUT, `missing path parameter "${key}"`);
    return encodeURIComponent(String(params[key]));
  });

function createUpstreamClient(config, logger) {
  const base = config.upstream.baseUrl.replace(/\/+$/, '');

  async function request({ method, endpoint, params, body, token, requestId, expectAbsent = false }) {
    const url = `${base}${fillPath(endpoint, params)}`;
    const headers = {
      accept: 'application/json',
      [HEADERS.requestId]: requestId || 'hub',
      [HEADERS.channel]: config.channel,
      [HEADERS.clientContract]: config.identity.contractVersion,
      'user-agent': `pivotly-hub/${config.identity.serverVersion} (${config.channel})`,
    };
    // The caller's token, verbatim. The hub never substitutes its own.
    if (token) headers[HEADERS.auth] = `${AUTH_SCHEME} ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let lastError;
    for (let attempt = 1; attempt <= config.upstream.maxAttempts; attempt += 1) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.upstream.timeoutMs);

      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await res.text();
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            // A non-JSON body from a JSON API is itself the problem; do not surface
            // whatever HTML a proxy decided to return.
            logger.error('upstream returned a non-JSON body', { url, status: res.status, requestId });
            throw new PivotlyError(ERROR_CODES.UNAVAILABLE, 'the platform API returned an unreadable response');
          }
        }

        logger.debug('upstream call', { method, url, status: res.status, ms: Date.now() - started, attempt, requestId });

        if (res.ok) return payload;

        // 404 is a legitimate answer for a read, not a failure.
        if (res.status === 404 && expectAbsent) return null;

        if (RETRYABLE_STATUS.has(res.status) && attempt < config.upstream.maxAttempts) {
          lastError = new PivotlyError(ERROR_CODES.UNAVAILABLE, `platform API returned ${res.status}`);
          await new Promise((r) => setTimeout(r, config.upstream.retryDelayMs * attempt));
          continue;
        }

        // Prefer the API's own error code when it speaks the shared vocabulary — that
        // is what lets a client branch on `forbidden_audience` rather than on a status.
        const upstreamCode = payload && typeof payload.code === 'string' && KNOWN_CODES.has(payload.code) ? payload.code : null;
        const code = upstreamCode || STATUS_TO_CODE[res.status] || ERROR_CODES.INTERNAL;
        const message =
          code === ERROR_CODES.INTERNAL || code === ERROR_CODES.UNAVAILABLE
            ? 'the platform API could not complete the request'
            : (payload && payload.message) || `platform API returned ${res.status}`;

        logger.warn('upstream refused', { method, url, status: res.status, code, requestId });
        throw new PivotlyError(code, message, payload && payload.details ? payload.details : undefined);
      } catch (err) {
        if (err instanceof PivotlyError) throw err;

        const aborted = err.name === 'AbortError';
        lastError = new PivotlyError(
          ERROR_CODES.UNAVAILABLE,
          aborted ? 'the platform API did not respond in time' : 'the platform API is unreachable'
        );
        logger.warn('upstream call failed', { method, url, attempt, aborted, error: err.message, requestId });
        if (attempt >= config.upstream.maxAttempts) throw lastError;
        await new Promise((r) => setTimeout(r, config.upstream.retryDelayMs * attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new PivotlyError(ERROR_CODES.UNAVAILABLE, 'the platform API is unreachable');
  }

  return {
    kind: 'api',
    baseUrl: base,

    // Identity. The API is the authority on who a token belongs to, what kind of
    // principal it is, and which scopes it holds; the hub only reads the answer.
    async whoami(token, requestId) {
      const payload = await request({ method: 'GET', endpoint: UPSTREAM_ENDPOINTS.whoami, token, requestId });
      if (!payload || !payload.principalId) return null;
      return normalizePrincipal({ ...payload, source: 'api' });
    },

    async recordGet({ recordId, token, requestId }) {
      return request({ method: 'GET', endpoint: UPSTREAM_ENDPOINTS.recordGet, params: { recordId }, token, requestId, expectAbsent: true });
    },

    async recordPut({ kind, payload, idempotencyKey, token, requestId }) {
      return request({
        method: 'POST',
        endpoint: UPSTREAM_ENDPOINTS.recordPut,
        body: { kind, payload, idempotencyKey: idempotencyKey ?? null },
        token,
        requestId,
      });
    },

    async jobClaim({ worker, kinds, leaseSeconds, token, requestId }) {
      return request({
        method: 'POST',
        endpoint: UPSTREAM_ENDPOINTS.jobClaim,
        body: { worker, kinds: kinds ?? null, leaseSeconds: leaseSeconds ?? 60 },
        token,
        requestId,
      });
    },

    // Drives /readyz. Unauthenticated on purpose: readiness must not depend on the
    // hub holding a valid token, or a token rotation would take the fleet down.
    async health(requestId) {
      return request({ method: 'GET', endpoint: UPSTREAM_ENDPOINTS.health, requestId });
    },

    async close() {},
  };
}

module.exports = { createUpstreamClient, fillPath, STATUS_TO_CODE, RETRYABLE_STATUS };
