// servers/test/tools.test.js — the MCP tool layer: handler shape, response shape,
// and that the server module loads and self-tests without a transport.

const test = require('node:test');
const assert = require('node:assert/strict');

const { greetingHello } = require('../tools/greet');
const { greetingDayCheck } = require('../tools/day-check');
const { asText, asErr } = require('../lib/respond');
const server = require('../greeting-server');

test('greeting_hello returns an ok payload with the full message', () => {
  const out = greetingHello({ name: 'Resty', hour: 14 });
  assert.equal(out.ok, true);
  assert.equal(out.greeting, 'Good afternoon, Resty!');
  assert.equal(out.message, "Good afternoon, Resty! How's your day going so far?");
});

test('greeting_hello works with no arguments at all', () => {
  const out = greetingHello();
  assert.equal(out.ok, true);
  assert.match(out.message, /How's your day going so far\?$/);
});

test('greeting_day_check returns mood and reply', () => {
  const out = greetingDayCheck({ name: 'Resty', answer: 'not great' });
  assert.equal(out.ok, true);
  assert.equal(out.mood, 'negative');
  assert.match(out.reply, /^Resty,/);
});

test('asText wraps objects as pretty JSON text content', () => {
  const res = asText({ a: 1 });
  assert.equal(res.content[0].type, 'text');
  assert.deepEqual(JSON.parse(res.content[0].text), { a: 1 });
  assert.equal(res.isError, undefined);
});

test('asText passes strings through untouched', () => {
  assert.equal(asText('hi').content[0].text, 'hi');
});

test('asErr flags the response as an error', () => {
  const res = asErr(new Error('boom'));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /boom/);
});

test('server selftest reports both tools and sample output', () => {
  const out = server.selftest();
  assert.equal(out.ok, true);
  assert.deepEqual(out.tools, ['greeting_hello', 'greeting_day_check']);
  assert.equal(out.samples.length, 2);
  assert.equal(out.samples[0].greeting, 'Good morning, World!');
  assert.equal(out.samples[1].mood, 'positive');
});

test('server version matches package.json', () => {
  assert.equal(server.SERVER_INFO.version, require('../package.json').version);
});
