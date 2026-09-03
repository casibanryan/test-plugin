#!/usr/bin/env node
// packages/clients/axle/hooks/version-notice.js
// SessionStart hook. Says one line about which version of this plugin is running, and
// says it differently when the version just changed.
//
// Why a hook and not a skill: the pipeline can deploy, verify, tag and publish
// perfectly and the user still has no way to tell whether the plugin on their machine
// is the new one. Claude Code updates it quietly. This is the one visible confirmation
// that the release reached the machine.
//
// How it knows: the plugin is installed into a version-stamped directory and reads its
// own manifest, so the version reported is the version actually loaded, not one
// compiled in from somewhere else. The last version seen is remembered outside that
// directory — inside it, the record would vanish with the very upgrade it exists to
// detect.
//
// It runs on every session start, so its rules are: never fail, never block, never
// take measurable time. Every failure path here ends in exit code 0 and silence.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The install directory of THIS version of the plugin. The env var is set by Claude
// Code; the fallback keeps the script runnable by hand from the repo.
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');

// Deliberately not under PLUGIN_ROOT: that path contains the version number, so a
// record kept there would be unreadable from the next version and every upgrade would
// look like a first install.
const STATE_FILE = path.join(os.homedir(), '.claude', 'pivotly', 'axle-version.json');

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function emit(message, context) {
  process.stdout.write(
    `${JSON.stringify({
      systemMessage: message,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    })}\n`
  );
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

  let message;
  let context;
  if (!seen) {
    message = `Axle v${version} active — Pivotly hub (${channel})`;
    context = `The Axle plugin is at v${version}, pointed at the ${channel} channel. This is the first session that has recorded a version.`;
  } else if (seen !== version) {
    message = `Axle plugin updated — v${seen} → v${version} (${channel})`;
    context =
      `The Axle plugin was updated between sessions: v${seen} → v${version}, on the ${channel} channel. ` +
      `Open your first reply by telling the user, in one short line, that the plugin updated to v${version}.`;
  } else {
    message = `Axle v${version} (${channel})`;
    context = `The Axle plugin is at v${version} on the ${channel} channel, unchanged since the last session.`;
  }

  // Written after the message is decided, never before: if this throws, the next
  // session should still see the change rather than have silently consumed it.
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      `${JSON.stringify({ version, channel, previousVersion: seen || null, at: new Date().toISOString() }, null, 2)}\n`
    );
  } catch {
    // A read-only home directory costs the "updated" line, not the session.
  }

  emit(message, context);
} catch {
  // Whatever it was, it is not worth a broken session start.
}

process.exit(0);
