// packages/clients/test/bundled-server.test.js
// The bundled stdio server, driven as a client drives it: spawned as a child process,
// spoken to over a pipe in newline-delimited JSON-RPC.
//
// Why a subprocess rather than requiring the module: the thing most likely to break
// here is not the greeting logic — that has its own tests in packages/server — but the
// transport. A stray console.log, a missing newline, a response to a notification, or
// a require of something a plugin install does not have are all invisible to an
// in-process test and fatal in a real client. Only spawning it catches those.
//
// This drives the COPY inside the plugin, not the canonical source: the copy is what a
// marketplace install actually launches.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { TOOL_NAMES } = require('@pivotly/contract/tools');
const { CONTRACT_VERSION } = require('@pivotly/contract/protocol');
const { contractDigest } = require('@pivotly/contract/digest');

const SERVER = path.join(__dirname, '..', 'claude', 'server', 'greeting-stdio.js');
const TOOLS_JSON = path.join(__dirname, '..', 'claude', 'server', 'tools.json');

// Sends every request, then reads until the child closes its stdout. The server exits
// on end-of-input, so closing stdin is what ends the exchange.
function exchange(requests, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the server did not finish within ${timeoutMs}ms; stdout so far: ${out}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const messages = out
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (e) {
            // A single unparseable line means the stream is corrupt, which is the
            // failure this whole file exists to catch. Say which line it was.
            throw new Error(`the server wrote a line that is not JSON: ${JSON.stringify(line)}`);
          }
        });
      resolve({ code, messages, stderr: err });
    });

    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

const byId = (messages, id) => messages.find((m) => m.id === id);

test('the bundled server initializes and reports the contract version', async () => {
  const { messages, stderr } = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
  ]);
  const res = byId(messages, 1).result;
  assert.equal(res.protocolVersion, '2025-06-18', 'a supported protocol version must be echoed back');
  assert.equal(res.serverInfo.version, CONTRACT_VERSION);
  assert.ok(res.capabilities.tools, 'it must advertise the tools capability');
  assert.equal(stderr, '', 'nothing should be written to stderr on a clean exchange');
});

test('an unsupported protocol version gets the server’s own, not an echo', async () => {
  const { messages } = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {} } },
  ]);
  assert.equal(byId(messages, 1).result.protocolVersion, require(TOOLS_JSON).protocolVersion);
});

test('tools/list serves exactly the contract’s tools, all read-only', async () => {
  const { messages } = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const tools = byId(messages, 1).result.tools;
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    TOOL_NAMES.slice().sort()
  );
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be advertised read-only`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20, `${tool.name} needs a description a model can act on`);
  }
});

test('both tools answer, with matching text and structured content', async () => {
  const { messages } = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greeting_hello', arguments: { name: 'Ada', hour: 9 } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'greeting_day_check', arguments: { name: 'Ada', answer: 'pretty good' } } },
  ]);

  const hello = byId(messages, 1).result;
  assert.equal(hello.isError, undefined);
  assert.match(hello.structuredContent.message, /Good morning, Ada!/);
  // The two representations must agree, or a client that reads one shows something
  // different from a client that reads the other.
  assert.deepEqual(JSON.parse(hello.content[0].text), hello.structuredContent);

  const day = byId(messages, 2).result;
  assert.equal(day.structuredContent.mood, 'positive');
  assert.ok(day.structuredContent.reply.includes('Ada'));
});

test('an hour outside 0-23 is refused as a tool error, not a protocol error', async () => {
  const { messages } = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greeting_hello', arguments: { hour: 99 } } },
  ]);
  const message = byId(messages, 1);
  // A refusal is a successful call with an error result. Reporting it as a JSON-RPC
  // error would make a client retry or drop the connection.
  assert.equal(message.error, undefined);
  assert.equal(message.result.isError, true);
  assert.match(JSON.parse(message.result.content[0].text).error, /hour must be <= 23/);
});

test('a required argument cannot be omitted', async () => {
  const { messages } = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greeting_day_check', arguments: {} } },
  ]);
  assert.match(JSON.parse(byId(messages, 1).result.content[0].text).error, /answer is required/);
});

test('an unknown tool and an unknown field are both named, not swallowed', async () => {
  const { messages } = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greeting_farewell', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'greeting_hello', arguments: { nickname: 'Ada' } } },
  ]);
  assert.match(JSON.parse(byId(messages, 1).result.content[0].text).error, /unknown tool "greeting_farewell"/);
  assert.match(JSON.parse(byId(messages, 2).result.content[0].text).error, /nickname is not a field/);
});

test('a notification gets no reply, and an unknown method gets a JSON-RPC error', async () => {
  const { messages } = await exchange([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 7, method: 'resources/list' },
  ]);
  // Answering a notification is a protocol violation; some clients disconnect on it.
  assert.equal(messages.length, 1, `expected exactly one response, got ${JSON.stringify(messages)}`);
  assert.equal(messages[0].id, 7);
  assert.equal(messages[0].error.code, -32601);
});

test('unparseable input is answered and does not kill the server', async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  child.stdin.write('this is not json\n');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));

  const messages = out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  assert.equal(messages[0].error.code, -32700);
  // The point: it kept going and answered the next message.
  assert.equal(messages[1].id, 1);
});

test('the generated tool surface matches this checkout’s contract', () => {
  const manifest = JSON.parse(fs.readFileSync(TOOLS_JSON, 'utf8'));
  assert.equal(manifest.contractDigest, contractDigest(), 'run: npm run clients:generate');
  assert.equal(manifest.contractVersion, CONTRACT_VERSION);
  assert.deepEqual(
    manifest.tools.map((t) => t.name).sort(),
    TOOL_NAMES.slice().sort()
  );
});

test('the bundled server needs nothing installed', () => {
  // A marketplace install copies the plugin directory with no npm install, so a
  // require of anything outside it is a crash on someone else's machine.
  for (const file of ['greeting-stdio.js', 'greeting.js']) {
    const source = fs.readFileSync(path.join(path.dirname(SERVER), file), 'utf8');
    const external = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).filter((r) => !r.startsWith('.') && !r.startsWith('node:'));
    assert.deepEqual(external, [], `${file} requires ${external.join(', ')}`);
  }
});

test('every file the plugin ships is byte-identical to packages/server', () => {
  // Not merely similar. There is one server in this repository and the plugin carries
  // a copy of it; the moment a copy differs, "the plugin works here" stops being
  // evidence about what a user installed.
  for (const file of ['greeting-stdio.js', 'greeting.js']) {
    const shipped = fs.readFileSync(path.join(path.dirname(SERVER), file), 'utf8');
    const canonical = fs.readFileSync(path.join(__dirname, '..', '..', 'server', file), 'utf8');
    assert.equal(shipped, canonical, `${file} has drifted — run: npm run clients:generate`);
  }
});
