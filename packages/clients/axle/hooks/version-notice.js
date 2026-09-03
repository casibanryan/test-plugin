#!/usr/bin/env node
// packages/clients/axle/hooks/version-notice.js
// SessionStart hook. Works out which version of this plugin is running and when it
// landed on this machine, and hands both to the session as a one-line banner the
// greeting skill appends to what it says.
//
// Why this is a hook and not a tool: the pipeline can verify, tag and publish
// perfectly and the user still has no way to tell whether the plugin in front of them
// is the new one — Claude Code updates it quietly. Doing it here rather than in the
// skill means the banner costs no tool call, no permission prompt and no round trip to
// the hub, and it is present before the user has typed anything.
//
// How it knows the VERSION: the plugin is installed into a version-stamped directory
// and reads its own manifest, so the version is the one actually loaded, not one
// compiled in somewhere else.
//
// How it knows the TIME: Claude Code records `lastUpdated` per installed plugin, which
// is the moment this machine took the update — the honest answer to "when did it
// change for me". If that record cannot be read, the hook falls back to the first time
// it saw this version itself, which is close enough and never wrong by more than one
// session.
//
// It runs on every session start, so its rules are: never fail, never block, never
// take measurable time. Every failure path ends in exit code 0 and silence.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The install directory of THIS version. The env var is set by Claude Code; the
// fallback keeps the script runnable by hand from the repo.
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Deliberately not under PLUGIN_ROOT: that path contains the version number, so a
// record kept there would be unreadable from the next version and every upgrade would
// look like a first install.
const STATE_FILE = path.join(CLAUDE_DIR, 'pivotly', 'axle-version.json');
const INSTALL_RECORD = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// "2026-09-04 15:02" in local time. Deliberately not an ISO string: this is read by a
// person mid-demo, and the seconds and the timezone offset are noise.
function stamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// What Claude Code recorded when it installed or updated this plugin. Best effort: the
// file is Claude Code's, not ours, so every field is treated as optional.
function installRecord(version) {
  const record = readJson(INSTALL_RECORD);
  const entries = (record && record.plugins && record.plugins['axle@Test-Plugin']) || [];
  const match = entries.find((e) => e && e.version === version) || entries[0] || null;
  if (!match) return {};
  return {
    updatedAt: match.lastUpdated || match.installedAt || null,
    commit: typeof match.gitCommitSha === 'string' ? match.gitCommitSha.slice(0, 7) : null,
  };
}

try {
  const manifest = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  const version = manifest && manifest.version;
  // No manifest means something is wrong with the install, and a session start is the
  // wrong moment to argue about it. Stay quiet.
  if (!version) process.exit(0);

  // Which hub this build was generated against. Read rather than assumed: a config
  // pointing at dev while the user believes they are on production is exactly the kind
  // of thing worth having on screen during a demo.
  const mcp = readJson(path.join(PLUGIN_ROOT, '.mcp.json'));
  const server = mcp && mcp.mcpServers && Object.values(mcp.mcpServers)[0];
  const channel = (server && server.headers && server.headers['x-pivotly-channel']) || 'unknown';

  const previous = readJson(STATE_FILE);
  const seen = previous && previous.version;
  const changed = Boolean(seen) && seen !== version;

  const { updatedAt, commit } = installRecord(version);
  // Whichever record exists. `firstSeen` is this hook's own note of when it first saw
  // the version, used only when Claude Code's install record is unreadable.
  const when =
    stamp(updatedAt) || stamp(previous && previous.version === version ? previous.firstSeen || previous.at : null) || stamp(new Date().toISOString());

  // The line the greeting appends. One line, past tense, facts only — version, when it
  // landed, which hub it talks to, and the commit if we have it.
  const banner = `Axle plugin updated — v${version} · ${when}${commit ? ` · ${commit}` : ''} · ${channel} channel`;

  const context = [
    `Axle plugin status, from the plugin's own SessionStart hook:`,
    `  version: ${version}`,
    `  updated on this machine: ${when}`,
    commit ? `  marketplace commit: ${commit}` : null,
    `  hub channel: ${channel}`,
    changed ? `  changed since the last session: yes, was v${seen}` : `  changed since the last session: no`,
    ``,
    `When you greet the user — the axle greeting skill — end the greeting with exactly`,
    `this line, in italics, on its own line:`,
    ``,
    `  ${banner}`,
    ``,
    `That line is the demo's proof that CD reached this machine, so do not paraphrase`,
    `it, and do not print it in replies that are not greetings.`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  // systemMessage is shown to the user directly; additionalContext is what the model
  // reads. The banner needs to reach both — the first so a session start alone shows
  // the version, the second so the greeting can repeat it verbatim.
  const message = changed ? `${banner}  (was v${seen})` : banner;

  // Written after the message is decided, never before: if this throws, the next
  // session should still see the change rather than have silently consumed it.
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      `${JSON.stringify(
        {
          version,
          channel,
          previousVersion: seen || null,
          // Preserved across sessions of the SAME version, so the fallback timestamp
          // stays the moment the version arrived rather than creeping forward to now.
          firstSeen: (previous && previous.version === version && (previous.firstSeen || previous.at)) || new Date().toISOString(),
          at: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    );
  } catch {
    // A read-only home directory costs the banner's fallback timestamp, not the session.
  }

  process.stdout.write(
    `${JSON.stringify({
      systemMessage: message,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    })}\n`
  );
} catch {
  // Whatever it was, it is not worth a broken session start.
}

process.exit(0);
