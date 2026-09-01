# syntax=docker/dockerfile:1

# ---- deps: production dependencies only -------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app/servers
COPY servers/package.json servers/package-lock.json ./
RUN npm ci --omit=dev

# ---- test: full dependencies + the suite ------------------------------------
# Built explicitly (`docker build --target test .`) so the runtime image never
# carries devDependencies or test files. CI builds this stage before publishing.
FROM node:22-alpine AS test
WORKDIR /app/servers
COPY servers/package.json servers/package-lock.json ./
RUN npm ci
COPY servers/ ./
RUN npm test

# ---- runtime: stdio MCP server ----------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/servers/node_modules ./servers/node_modules
COPY servers/ ./servers/
COPY .claude-plugin/ ./.claude-plugin/
COPY skills/ ./skills/
COPY .mcp.json README.md ./

# Drop privileges — the server needs nothing but stdin/stdout.
USER node

# The self-test exercises both tools in-process; if it exits 0 the image is sound.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node /app/servers/greeting-server.js --selftest > /dev/null || exit 1

# Default: speak MCP over stdio (`docker run --rm -i <image>`).
# Diagnostics:  docker run --rm <image> --selftest
ENTRYPOINT ["node", "/app/servers/greeting-server.js"]
