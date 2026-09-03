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

const { CHANNELS, HARDENED_CHANNELS, ENDPOINTS, HEADERS, CLIENTS, CONTRACT_VERSION, transportOf } = require('@pivotly/contract/protocol');
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

    const transport = transportOf(name);
    ok(`${name} has a transport the contract declares`, Boolean(transport), `contract declares no transport for "${name}"`);
    ok(`${name} agrees with the contract about its transport`, !channel.transport || channel.transport === transport, `${channel.transport} vs ${transport}`);
    ok(`${name} has a description`, (channel.description || '').length > 10);

    if (transport === 'stdio') {
      // A stdio channel is a process the client starts, so what has to be true of it
      // is completely different: a command to run, arguments to run it with, and no
      // address at all. Checking it for an https url would fail a channel that
      // correctly has none.
      ok(`${name} declares a command to run`, Boolean(channel.command), JSON.stringify(channel));
      ok(`${name} declares args`, Array.isArray(channel.args) && channel.args.length > 0, JSON.stringify(channel.args));
      ok(`${name} declares no url, having no address`, !channel.url, channel.url);
      // The install directory carries the version number, so an absolute path here
      // would work exactly once and break on the next update.
      ok(
        `${name} locates its server through a placeholder, not an absolute path`,
        (channel.args || []).every((a) => !/^([A-Za-z]:[\\/]|\/)/.test(String(a))),
        JSON.stringify(channel.args)
      );
    } else {
      ok(`${name} has a url`, Boolean(channel.url));
      ok(`${name} url targets the contract MCP path`, String(channel.url || '').endsWith(ENDPOINTS.mcp), channel.url);
    }
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
      ok(`${name} is not served over stdio, being a hardened channel`, transport === 'http', `transport is ${transport}`);
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

  // Two channels sharing a URL means promoting one silently promotes the other. Only
  // the http channels take part: a stdio channel has no url, and several `undefined`
  // entries would collapse into one and fail this for no reason.
  const urls = Object.values(manifest.channels || {})
    .map((c) => c.url)
    .filter(Boolean);
  ok('every channel with a url has a distinct one', new Set(urls).size === urls.length, urls.join(', '));
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

  // Which channel this config was generated for decides what has to be true of it.
  // Read from the config's own GENERATED note rather than from channels.json's current
  // default: the question here is whether the COMMITTED file is coherent, and a file
  // left behind from a channel nobody selects any more is exactly the drift worth
  // catching.
  const generatedFor = (raw.match(/channel: ([a-z]+)\)/) || [])[1] || null;
  const transport = generatedFor ? transportOf(generatedFor) : null;
  ok(`${client.id} config records which channel it was generated for`, Boolean(generatedFor), raw.slice(0, 200));
  ok(`${client.id} was generated for a channel the contract declares`, Boolean(transport), `channel "${generatedFor}"`);

  if (transport === 'stdio') {
    // No url and no headers, and both absences are the point: nothing is reached over a
    // network, so there is no address to get wrong and no caller identity to send.
    ok(`${client.id} config declares a stdio server`, /stdio|command/.test(raw), raw.slice(0, 200));
    ok(`${client.id} config carries no url, being stdio`, !/https?:\/\//.test(raw), (raw.match(/https?:\/\/[^\s"']+/) || [])[0]);
    ok(`${client.id} config names a command to run`, /"?command"?\s*[:=]/.test(raw), raw.slice(0, 200));
  } else {
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
  }

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

    // --- the bundled stdio server -----------------------------------------
    // Only when this client's config actually points at it. The three files below are
    // what makes an install work with nothing deployed, and each fails silently in a
    // different way: a missing server means the tools never appear, a drifted
    // tools.json means it answers with a surface the hub does not have, and a drifted
    // greeting.js means the same tool call returns different answers depending on
    // which server took it.
    if (transport === 'stdio') {
      const serverDir = path.join(dir, 'server');
      const entry = path.join(serverDir, 'greeting-stdio.js');
      ok(`${client.id} ships the bundled server`, fs.existsSync(entry), entry);

      if (ok(`${client.id} ships the generated tool surface`, fs.existsSync(path.join(serverDir, 'tools.json')))) {
        const tools = readJson(path.join(serverDir, 'tools.json'), `${client.id}/server/tools.json`);
        if (tools) {
          equal(
            `${client.id} bundled tools are exactly the contract's tools`,
            (tools.tools || []).map((t) => t.name).sort(),
            TOOL_NAMES.slice().sort()
          );
          equal(`${client.id} bundled tool surface is this checkout's contract`, tools.contractDigest, contractDigest());
          equal(`${client.id} bundled tool surface is this checkout's version`, tools.contractVersion, CONTRACT_VERSION);
          ok(
            `${client.id} every bundled tool is declared read-only, as the contract requires`,
            (tools.tools || []).every((t) => t.readOnly === true),
            JSON.stringify((tools.tools || []).map((t) => [t.name, t.readOnly]))
          );
        }
      }

      // Byte-identical, not merely similar. The bundled server and the hub must answer
      // the same, or "it works locally" stops being evidence about the deployed one.
      const shipped = path.join(serverDir, 'greeting.js');
      const canonical = path.join(REPO_ROOT, 'packages', 'hub', 'src', 'lib', 'greeting.js');
      if (ok(`${client.id} ships the greeting logic`, fs.existsSync(shipped), shipped)) {
        ok(
          `${client.id} greeting logic is byte-identical to the hub's`,
          fs.readFileSync(shipped, 'utf8') === fs.readFileSync(canonical, 'utf8'),
          `cp packages/hub/src/lib/greeting.js ${path.relative(REPO_ROOT, shipped)}`
        );
      }

      // A plugin gets no npm install, so a require of anything outside its own
      // directory is a crash on someone else's machine.
      for (const file of ['greeting-stdio.js', 'greeting.js']) {
        const abs = path.join(serverDir, file);
        if (!fs.existsSync(abs)) continue;
        const requires = [...fs.readFileSync(abs, 'utf8').matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
        const external = requires.filter((r) => !r.startsWith('.') && !r.startsWith('node:'));
        ok(`${client.id} server/${file} requires nothing that needs installing`, external.length === 0, external.join(', '));
      }
    }

    // --- the hooks the plugin ships ---------------------------------------
    // The version notice is the only thing that tells a user their plugin moved, so a
    // hook that silently fails to load is a release that looks like it never shipped.
    // A hook is also the one part of a plugin that RUNS on every session start, which
    // makes a bad path here more expensive than a bad path anywhere else.
    if (plugin && plugin.hooks) {
      const hooksRel = String(plugin.hooks).replace(/^\.\//, '');
      const hooksFile = readJson(path.join(dir, hooksRel), `${client.id}/${hooksRel}`);
      if (hooksFile) {
        const events = Object.keys(hooksFile.hooks || {});
        ok(`${client.id} hooks declare at least one event`, events.length > 0);
        ok(`${client.id} hooks run on SessionStart`, events.includes('SessionStart'), `declares: ${events.join(', ') || 'nothing'}`);

        const commands = events
          .flatMap((event) => hooksFile.hooks[event] || [])
          .flatMap((matcher) => matcher.hooks || [])
          .map((entry) => entry.command)
          .filter(Boolean);
        ok(`${client.id} every declared hook has a command`, commands.length > 0);

        for (const command of commands) {
          // The install path carries the version number, so it is different for every
          // release. A hook that hardcodes one works exactly until the next update —
          // the single upgrade it most needs to survive.
          ok(
            `${client.id} hook resolves its path through CLAUDE_PLUGIN_ROOT (${command.slice(0, 48)})`,
            command.includes('CLAUDE_PLUGIN_ROOT'),
            command
          );

          // Every plugin-relative script the command names must actually be in the
          // tree that gets copied on install.
          for (const match of command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/g)) {
            ok(`${client.id} hook script ${match[1]} is present`, fs.existsSync(path.join(dir, match[1])), path.join(dir, match[1]));
          }
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
