#!/usr/bin/env node
// packages/clients/scripts/verify.js
// Validates everything each client depends on, for every declared client.
//
//   node scripts/verify.js
//
// A plugin install copies these files as-is: no build step, no npm install, no chance
// to fix anything afterwards. So the failures worth catching here are the ones that
// only appear on someone else's machine — a manifest that does not parse, a version
// that disagrees with its siblings, a skill whose front matter is malformed, or a
// config pointing at a channel that does not exist.
//
// It iterates the contract's CLIENTS list rather than a list of its own, so adding a
// client automatically brings it under these checks. A client declared but not present
// on disk is a failure, not a silent skip.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CHANNELS, HARDENED_CHANNELS, ENDPOINTS, HEADERS, CLIENTS, CONTRACT_VERSION } = require('@pivotly/contract/protocol');
const { TOOL_NAMES } = require('@pivotly/contract/tools');
const { contractDigest } = require('@pivotly/contract/digest');

const ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(ROOT, '..', '..');

const results = [];
const ok = (label, condition, detail) => {
  const passed = Boolean(condition);
  results.push({ label, passed, detail: passed ? undefined : detail });
  console.log(`${passed ? 'ok   ' : 'FAIL '} ${label}${passed || detail == null ? '' : `\n        ${detail}`}`);
  return passed;
};
const equal = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function readJson(abs, label) {
  if (!fs.existsSync(abs)) {
    ok(`${label} exists`, false, abs);
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    ok(`${label} parses`, true);
    return parsed;
  } catch (err) {
    ok(`${label} parses`, false, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The shared channel manifest
// ---------------------------------------------------------------------------
const manifest = readJson(path.join(ROOT, 'channels.json'), 'channels.json');
const pkg = readJson(path.join(ROOT, 'package.json'), 'package.json');

if (manifest) {
  ok('channels.json names a default channel', Boolean(manifest.default));
  ok(
    `the default channel "${manifest.default}" is one the contract declares`,
    CHANNELS.includes(manifest.default),
    `contract declares ${CHANNELS.join(', ')}`
  );

  for (const name of CHANNELS) {
    const channel = (manifest.channels || {})[name];
    if (!ok(`channels.json declares the "${name}" channel`, Boolean(channel))) continue;

    ok(`${name} has a url`, Boolean(channel.url));
    ok(`${name} has a description`, (channel.description || '').length > 10);
    ok(`${name} url targets the contract MCP path`, String(channel.url || '').endsWith(ENDPOINTS.mcp), channel.url);
    // lastVerified is a RECORD of what this channel was last proven to serve, not a
    // requirement. It is null until that channel has been deployed, and it is allowed
    // to lag this checkout — that is the normal state while a version is in progress.
    if (channel.lastVerified == null) {
      ok(`${name} has no stale verification record`, true);
    } else {
      const lv = channel.lastVerified;
      ok(`${name} lastVerified has a 12-hex digest`, /^[0-9a-f]{12}$/.test(lv.contractDigest || ''), lv.contractDigest);
      ok(`${name} lastVerified has a semver contract version`, /^\d+\.\d+\.\d+$/.test(lv.contractVersion || ''), lv.contractVersion);
      ok(`${name} lastVerified records a timestamp`, Boolean(lv.at), JSON.stringify(lv));
    }

    if (HARDENED_CHANNELS.includes(name)) {
      ok(`${name} is https, being a hardened channel`, String(channel.url || '').startsWith('https://'), channel.url);
      ok(`${name} does not opt out of https`, channel.requireHttps !== false);
    }

    // No credential belongs in a committed manifest, and there is none to need.
    const raw = JSON.stringify(channel);
    ok(`${name} declares no token or credential`, !/token|secret|password|apikey/i.test(raw), raw.slice(0, 160));
  }

  // The production URL must not be a staging slot. A slot's hostname carries the slot
  // name, so a copy-paste from the prerelease entry is detectable — and would send
  // every production client to the slot that is about to be overwritten.
  const production = (manifest.channels || {}).production;
  if (production) {
    ok(
      'the production channel does not point at a staging slot',
      !/-(prerelease|staging|stage|dev)\./.test(production.url || ''),
      `production points at ${production.url}`
    );
  }

  // Two channels sharing a URL means promoting one silently promotes the other.
  const urls = Object.values(manifest.channels || {}).map((c) => c.url);
  ok('every channel has a distinct url', new Set(urls).size === urls.length, urls.join(', '));
}

if (pkg) equal('package.json version tracks the contract version', pkg.version, CONTRACT_VERSION);

// ---------------------------------------------------------------------------
// Every declared client
// ---------------------------------------------------------------------------
for (const client of CLIENTS) {
  console.log(`\n-- ${client.id} (${client.host})`);

  const dir = path.join(ROOT, client.id);
  if (!ok(`${client.id}/ exists`, fs.existsSync(dir), `the contract declares client "${client.id}" but ${dir} is missing`)) continue;

  const configPath = path.join(dir, client.configPath);
  if (!ok(`${client.id}/${client.configPath} exists`, fs.existsSync(configPath), 'run: npm run clients:generate')) continue;

  const raw = fs.readFileSync(configPath, 'utf8');

  // Generated files must say so, or someone will hand-edit one and lose the change on
  // the next generate.
  ok(`${client.id} config is marked GENERATED`, /GENERATED/.test(raw), 'a generated file must announce itself');

  // The single most damaging thing that could be committed. There is no token in this
  // design at all, so anything token-shaped is either a mistake or a leak.
  const suspicious = raw.match(/\b[A-Za-z0-9_-]{32,}\b/g) || [];
  ok(`${client.id} config contains nothing that looks like a secret`, suspicious.length === 0, `suspicious literals: ${suspicious.slice(0, 3).join(', ')}`);
  ok(`${client.id} config declares no Authorization header`, !/authorization/i.test(raw), 'the hub is anonymous; no auth header should be emitted');

  // The URL must be the resolved channel's, and https unless loopback.
  const urlMatch = raw.match(/https?:\/\/[^\s"']+/);
  if (ok(`${client.id} config carries a hub url`, Boolean(urlMatch), raw.slice(0, 200))) {
    const url = urlMatch[0];
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url);
    ok(`${client.id} url is https unless loopback`, url.startsWith('https://') || isLoopback, url);
    ok(`${client.id} url targets the contract MCP path`, url.endsWith(ENDPOINTS.mcp), url);
  }

  // The identity headers are what make "which client is still on the old contract"
  // answerable. A client that does not send them is invisible in the hub's logs.
  for (const key of ['client', 'channel', 'clientContract']) {
    ok(`${client.id} config sends the ${HEADERS[key]} header`, raw.includes(HEADERS[key]), `missing ${HEADERS[key]}`);
  }
  ok(`${client.id} identifies itself as "${client.id}"`, raw.includes(client.id), 'the client header must carry this client id');

  // --- plugin clients carry a manifest and skills -------------------------
  if (client.plugin) {
    const plugin = readJson(path.join(dir, '.claude-plugin', 'plugin.json'), `${client.id}/.claude-plugin/plugin.json`);
    if (plugin) {
      ok(`${client.id} plugin.json has a semver version`, /^\d+\.\d+\.\d+$/.test(plugin.version || ''), plugin.version);
      equal(`${client.id} plugin.json version tracks the contract version`, plugin.version, CONTRACT_VERSION);
      ok(`${client.id} plugin.json has a description a user can act on`, (plugin.description || '').length > 30, plugin.description);
      equal(`${client.id} plugin.json points at ./${client.configPath}`, plugin.mcpServers, `./${client.configPath}`);
      // No setup is needed, so the description must not send users looking for a
      // credential. Checked by looking for an ENV VAR NAME rather than the word
      // "token" — "no token required" is exactly the sentence we want to allow, and a
      // naive word match rejects it.
      ok(
        `${client.id} plugin.json names no credential env var`,
        !/\b[A-Z][A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD)\b/.test(plugin.description || ''),
        'the hub is anonymous; pointing users at a credential variable would be wrong'
      );
    }

    const skillsDir = path.join(dir, 'skills');
    if (ok(`${client.id}/skills exists`, fs.existsSync(skillsDir))) {
      const skills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      ok(`${client.id} ships at least one skill`, skills.length > 0);

      for (const entry of skills) {
        const file = path.join(skillsDir, entry.name, 'SKILL.md');
        if (!ok(`${client.id}/skills/${entry.name}/SKILL.md exists`, fs.existsSync(file))) continue;

        const body = fs.readFileSync(file, 'utf8');
        // Malformed front matter does not error — the skill just never triggers, which
        // is far harder to notice than a crash.
        const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!ok(`${client.id}/${entry.name} has YAML front matter`, Boolean(match))) continue;

        const front = match[1];
        ok(`${client.id}/${entry.name} front matter has a name`, /^name:\s*\S+/m.test(front));
        const description = (front.match(/^description:\s*(.+)$/m) || [])[1] || '';
        ok(`${client.id}/${entry.name} front matter has a description`, description.length > 20, description);
        // The description is all the model sees when deciding whether to load the skill,
        // so it must say when to use it, not just what it is.
        ok(`${client.id}/${entry.name} description says when to use it`, /\buse\b|\bwhen\b/i.test(description), description);

        // A skill must not send the model after a tool that does not exist.
        const mentioned = body.match(/`([a-z][a-z0-9_]*)`/g) || [];
        for (const token of mentioned) {
          const name = token.replace(/`/g, '');
          if (!/^greeting_|^usdf_|^job_/.test(name)) continue;
          ok(`${client.id}/${entry.name} only references tools that exist (${name})`, TOOL_NAMES.includes(name), `${name} is not in the contract`);
        }
      }
    }

    // The repo marketplace entry, which is how the plugin is installed.
    const marketplace = readJson(path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'repo marketplace.json');
    if (marketplace && plugin) {
      const entry = (marketplace.plugins || []).find((p) => p.name === plugin.name);
      if (ok(`marketplace.json lists "${plugin.name}"`, Boolean(entry))) {
        equal('marketplace.json and plugin.json agree on version', entry.version, plugin.version);
        ok('the marketplace entry points at this client', String(entry.source || '').includes(`clients/${client.id}`), entry.source);
      }
    }
  }
}

// ---------------------------------------------------------------------------
const failures = results.filter((r) => !r.passed);
console.log('');
console.log(
  failures.length
    ? `FAIL  ${failures.length} of ${results.length} client checks failed`
    : `ok    all ${results.length} client checks passed — ${CLIENTS.length} clients, ${CHANNELS.length} channels, tools: ${TOOL_NAMES.join(', ')}`
);
if (failures.length) process.exitCode = 1;
