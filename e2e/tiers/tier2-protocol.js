// e2e/tiers/tier2-protocol.js
// Tier 2 — the protocol tier: does the server speak correct MCP over a real pipe?
//
// Driven exactly as a client drives it: the server is SPAWNED as a child process and
// spoken to in newline-delimited JSON-RPC over stdin/stdout. In-process requiring
// would be faster and would test less — a stray console.log, a missing newline, a
// response sent to a notification, or a require of something a plugin install does
// not have are all invisible to an in-process test and fatal in a real client.
//
// It runs against EVERY copy of the server: the canonical one in packages/server and
// the copy inside each plugin. They are byte-identical (clients:verify proves that),
// so this is belt and braces — but the copy is what a user actually launches, and a
// suite that only ever ran the source would not notice if the copying broke.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { TOOL_NAMES } = require('@pivotly/contract/tools');
const { CLIENTS, MCP_PROTOCOL_VERSION, CONTRACT_VERSION } = require('@pivotly/contract/protocol');

const REPO_ROOT = path.join(__dirname, '..', '..');

const name = 'tier2-protocol';
const describe = 'every copy of the server speaks correct MCP over a pipe and needs no credential';

// Where a server should be found, and under what label. The plugin copies are derived
// from the contract's CLIENTS rather than listed here, so adding a plugin client
// automatically brings its copy under this tier.
function serverPaths() {
  const paths = [{ label: 'packages/server', file: path.join(REPO_ROOT, 'packages', 'server', 'greeting-stdio.js') }];
  for (const client of CLIENTS) {
    if (!client.plugin) continue;
    paths.push({
      label: `packages/clients/${client.id}/server`,
      file: path.join(REPO_ROOT, 'packages', 'clients', client.id, 'server', 'greeting-stdio.js'),
    });
  }
  return paths;
}

// Sends every request, then reads until the child closes stdout. The server exits on
// end-of-input, so closing stdin is what ends the exchange.
function exchange(server, requests, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
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
      resolve({ code, err, raw: out, messages: out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) });
    });

    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

async function run({ check, timeoutMs }) {
  for (const { label, file } of serverPaths()) {
    if (!check(`${label} exists`, fs.existsSync(file), 'run: npm run clients:generate')) continue;

    let result;
    try {
      result = await exchange(
        file,
        [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } },
          // A notification. Answering it would be a protocol violation, and the check
          // below counts responses to prove it was not answered.
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'ping' },
          { jsonrpc: '2.0', id: 3, method: 'tools/list' },
          { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'greeting_hello', arguments: { name: 'e2e', hour: 9 } } },
          // Deliberately invalid: hour is out of range. A refusal is an ANSWER, not a
          // transport error, so this must come back as a result with isError set.
          { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'greeting_hello', arguments: { hour: 99 } } },
          { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
        ],
        timeoutMs
      );
    } catch (err) {
      check(`${label} completes an exchange`, false, err.message);
      continue;
    }

    const byId = new Map(result.messages.map((m) => [m.id, m]));

    check(`${label} exits cleanly`, result.code === 0, `exit code ${result.code}`);
    // stdout is the transport: anything on it that is not a JSON-RPC message corrupts
    // the stream. Every line parsed above, so reaching here already proves it.
    check(`${label} answers every request and nothing else`, result.messages.length === 6, `${result.messages.length} messages for 6 requests`);
    check(`${label} does not answer the notification`, !result.messages.some((m) => m.id === undefined || m.id === null), result.raw.slice(0, 160));

    const init = byId.get(1);
    check(`${label} negotiates the protocol version`, init?.result?.protocolVersion === MCP_PROTOCOL_VERSION, JSON.stringify(init?.result?.protocolVersion));
    check(`${label} identifies itself with the contract version`, init?.result?.serverInfo?.version === CONTRACT_VERSION, JSON.stringify(init?.result?.serverInfo));
    check(`${label} declares tool capability`, Boolean(init?.result?.capabilities?.tools), JSON.stringify(init?.result?.capabilities));

    check(`${label} answers ping`, byId.get(2)?.result !== undefined, JSON.stringify(byId.get(2)));

    const listed = (byId.get(3)?.result?.tools || []).map((t) => t.name).sort();
    check(`${label} lists exactly the contract's tools`, JSON.stringify(listed) === JSON.stringify(TOOL_NAMES.slice().sort()), listed.join(', '));
    check(
      `${label} annotates every tool read-only`,
      (byId.get(3)?.result?.tools || []).every((t) => t.annotations?.readOnlyHint === true),
      'a writable tool cannot be served without authentication'
    );

    const called = byId.get(4)?.result;
    check(`${label} answers a tool call`, called?.structuredContent?.ok === true, JSON.stringify(called).slice(0, 200));
    check(`${label} greets for the hour it was given`, called?.structuredContent?.greeting === 'Good morning, e2e!', JSON.stringify(called?.structuredContent));

    const refused = byId.get(5)?.result;
    check(`${label} refuses bad input as a result, not a transport error`, refused?.isError === true && byId.get(5)?.error === undefined, JSON.stringify(byId.get(5)).slice(0, 200));

    const unknown = byId.get(6)?.result;
    check(`${label} refuses an unknown tool by name`, unknown?.isError === true, JSON.stringify(byId.get(6)).slice(0, 200));

    check(`${label} writes nothing to stderr on a clean run`, result.err === '', result.err.slice(0, 200));
  }
}

module.exports = { name, describe, run };
