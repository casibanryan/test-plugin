#!/usr/bin/env node
// packages/clients/axle/scripts/verify-manifest.js
// Validates everything a marketplace install of the Axle plugin depends on.
//
//   node scripts/verify-manifest.js
//
// A plugin install copies these files as-is: no build step, no npm install, and no
// chance to fix anything afterwards. So the failures worth catching here are the ones
// that only appear on someone else's machine — a manifest that does not parse, a
// version that disagrees with its siblings, a skill whose front matter is malformed,
// or a credential accidentally committed into `.mcp.json`.
//
// `claude plugin validate` checks the manifest against Claude Code's own schema. This
// checks the things that are specific to Axle and that no generic schema could know.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CHANNELS, HARDENED_CHANNELS, ENDPOINTS } = require('@pivotly/contract/protocol');
const { HEADERS } = require('@pivotly/contract/auth');
const { CLIENT_TOOL_NAMES, SERVICE_TOOL_NAMES } = require('@pivotly/contract/tools');

const ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(ROOT, '..', '..', '..');

const results = [];
const ok = (label, condition, detail) => {
  const passed = Boolean(condition);
  results.push({ label, passed, detail: passed ? undefined : detail });
  console.log(`${passed ? 'ok   ' : 'FAIL '} ${label}${passed || detail == null ? '' : `\n        ${detail}`}`);
  return passed;
};
const equal = (label, actual, expected) => ok(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function readJson(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    ok(`${rel} exists`, false);
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    ok(`${rel} parses`, true);
    return parsed;
  } catch (err) {
    ok(`${rel} parses`, false, err.message);
    return null;
  }
}

const plugin = readJson('.claude-plugin/plugin.json');
const mcp = readJson('.mcp.json');
const channelsManifest = readJson('channels.json');
const pkg = readJson('package.json');

// --- versions -------------------------------------------------------------
// Three files carry a version and all three end up visible to a user. Drift between
// them means "which version am I running" has no single answer.
if (plugin && pkg) {
  ok('plugin.json has a semver version', /^\d+\.\d+\.\d+$/.test(plugin.version || ''), plugin.version);
  equal('plugin.json and package.json agree on version', plugin.version, pkg.version);
  ok('plugin.json has a name', Boolean(plugin.name));
  ok('plugin.json has a description a user can act on', (plugin.description || '').length > 30, plugin.description);
  // The token requirement belongs in the description: without it the plugin installs
  // cleanly and then fails every call with a 401, which is a miserable first run.
  ok('plugin.json mentions the token the plugin needs', /PIVOTLY_MCP_TOKEN/.test(plugin.description || ''), plugin.description);
  equal('plugin.json points at ./.mcp.json', plugin.mcpServers, './.mcp.json');
}

// --- .mcp.json ------------------------------------------------------------
if (mcp) {
  const servers = Object.entries(mcp.mcpServers || {});
  ok('.mcp.json declares exactly one server', servers.length === 1, `declares ${servers.length}`);

  for (const [name, cfg] of servers) {
    equal(`${name} uses the http transport`, cfg.type, 'http');
    ok(`${name} has a url`, Boolean(cfg.url));
    ok(`${name} url ends with the contract's MCP path`, String(cfg.url || '').endsWith(ENDPOINTS.mcp), cfg.url);

    const auth = (cfg.headers || {})[HEADERS.auth];
    ok(`${name} sends an Authorization header`, Boolean(auth), JSON.stringify(cfg.headers));

    // The single most damaging thing that could be committed here. A ${VAR} reference
    // is fine; a literal token is not, and it would be public the moment the repo is.
    ok(
      `${name} references its token by environment variable, not by value`,
      /^Bearer \$\{[A-Z_][A-Z0-9_]*\}$/.test(auth || ''),
      `Authorization is "${auth}" — it must be exactly "Bearer \${SOME_ENV_VAR}"`
    );

    // Belt and braces: scan the whole file for anything token-shaped.
    const raw = fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf8');
    const suspicious = raw.match(/\b(?:[A-Za-z0-9_-]{32,})\b/g) || [];
    ok('.mcp.json contains nothing that looks like a secret', suspicious.length === 0, `suspicious literals: ${suspicious.slice(0, 3).join(', ')}`);

    // Only local may be plaintext; the bearer token is on the wire otherwise.
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(cfg.url || '');
    ok(
      `${name} uses https unless it is loopback`,
      String(cfg.url || '').startsWith('https://') || isLoopback,
      `${cfg.url} would put the bearer token on the wire in clear`
    );
  }
}

// --- channels.json --------------------------------------------------------
if (channelsManifest) {
  ok('channels.json names a default channel', Boolean(channelsManifest.default));
  ok(
    `the default channel "${channelsManifest.default}" is one the contract declares`,
    CHANNELS.includes(channelsManifest.default),
    `contract declares ${CHANNELS.join(', ')}`
  );

  for (const name of CHANNELS) {
    const channel = (channelsManifest.channels || {})[name];
    if (!ok(`channels.json declares the "${name}" channel`, Boolean(channel))) continue;

    ok(`${name} has a url`, Boolean(channel.url));
    ok(`${name} has a description`, (channel.description || '').length > 10);
    ok(`${name} pins a 12-hex contract digest`, /^[0-9a-f]{12}$/.test(channel.contractDigest || ''), channel.contractDigest);
    ok(`${name} pins a semver contract version`, /^\d+\.\d+\.\d+$/.test(channel.contractVersion || ''), channel.contractVersion);
    ok(`${name} names the env var holding its token`, /^[A-Z_][A-Z0-9_]*$/.test(channel.tokenEnv || ''), channel.tokenEnv);

    if (HARDENED_CHANNELS.includes(name)) {
      ok(`${name} is https, being a hardened channel`, String(channel.url || '').startsWith('https://'), channel.url);
      ok(`${name} does not opt out of https`, channel.requireHttps !== false);
    }
  }

  // The production URL must not be a staging slot. A slot's hostname carries the slot
  // name, so a copy-paste from the prerelease entry is detectable — and would send
  // every production client to the slot that is about to be overwritten.
  const production = (channelsManifest.channels || {}).production;
  if (production) {
    ok(
      'the production channel does not point at a staging slot',
      !/-(prerelease|staging|stage|dev)\./.test(production.url || ''),
      `production points at ${production.url}`
    );
  }

  // Every channel must be distinct: two channels sharing a URL means promoting one
  // silently promotes the other.
  const urls = Object.values(channelsManifest.channels || {}).map((ch) => ch.url);
  ok('every channel has a distinct url', new Set(urls).size === urls.length, urls.join(', '));
}

// --- skills ---------------------------------------------------------------
const skillsDir = path.join(ROOT, 'skills');
if (ok('skills/ exists', fs.existsSync(skillsDir))) {
  const skills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  ok('at least one skill is shipped', skills.length > 0);

  for (const entry of skills) {
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!ok(`skills/${entry.name}/SKILL.md exists`, fs.existsSync(file))) continue;

    const body = fs.readFileSync(file, 'utf8');
    // Front matter is what makes a skill discoverable. Malformed front matter does not
    // error — the skill just never triggers, which is far harder to notice.
    const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!ok(`skills/${entry.name} has YAML front matter`, Boolean(match))) continue;

    const front = match[1];
    ok(`skills/${entry.name} front matter has a name`, /^name:\s*\S+/m.test(front));
    const description = (front.match(/^description:\s*(.+)$/m) || [])[1] || '';
    ok(`skills/${entry.name} front matter has a description`, description.length > 20, description);
    // The description is the only thing the model sees when deciding whether to load
    // the skill, so it has to say when to use it, not just what it is.
    ok(`skills/${entry.name} description says when to use it`, /\buse\b|\bwhen\b/i.test(description), description);

    // A skill must not tell the model to call a tool a client will never be offered.
    for (const serviceTool of SERVICE_TOOL_NAMES) {
      ok(
        `skills/${entry.name} does not instruct the model to call the service tool ${serviceTool}`,
        !new RegExp(`\`?${serviceTool}\`?`).test(body),
        `${serviceTool} is service-only and is never registered for this client — a skill referencing it sends the model after a tool that does not exist`
      );
    }
  }
}

// --- the repo marketplace entry ------------------------------------------
const marketplacePath = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
if (ok('the repo marketplace manifest exists', fs.existsSync(marketplacePath))) {
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  const entry = (marketplace.plugins || []).find((p) => p.name === (plugin && plugin.name));
  if (ok(`marketplace.json lists "${plugin && plugin.name}"`, Boolean(entry))) {
    equal('marketplace.json and plugin.json agree on version', entry.version, plugin.version);
    ok('the marketplace entry points at this package', String(entry.source || '').includes('clients/axle'), entry.source);
  }
}

// --- summary --------------------------------------------------------------
const failures = results.filter((r) => !r.passed);
console.log('');
console.log(
  failures.length
    ? `FAIL  ${failures.length} of ${results.length} manifest checks failed`
    : `ok    all ${results.length} manifest checks passed (client surface: ${CLIENT_TOOL_NAMES.join(', ')})`
);
if (failures.length) process.exitCode = 1;
