// packages/hub/test/greeting.test.js — unit tests for the pure logic in lib/greeting.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  salutationFor, normalizeName, buildGreeting, classifyMood, respondToDay,
} = require('../src/lib/greeting');

test('salutationFor picks the bucket for each hour of the day', () => {
  const cases = [
    [5, 'Good morning'], [9, 'Good morning'], [11, 'Good morning'],
    [12, 'Good afternoon'], [15, 'Good afternoon'], [17, 'Good afternoon'],
    [18, 'Good evening'], [21, 'Good evening'],
    [22, 'Hello'], [23, 'Hello'], [0, 'Hello'], [4, 'Hello'],
  ];
  for (const [hour, expected] of cases) {
    assert.equal(salutationFor(hour), expected, `hour ${hour}`);
  }
});

test('salutationFor covers all 24 hours without a gap', () => {
  for (let h = 0; h < 24; h += 1) assert.ok(salutationFor(h).length > 0, `hour ${h}`);
});

test('salutationFor rejects hours outside 0-23 and non-integers', () => {
  for (const bad of [-1, 24, 9.5, '9', null, undefined, NaN]) {
    assert.throws(() => salutationFor(bad), RangeError, `input ${String(bad)}`);
  }
});

test('normalizeName trims, collapses whitespace, and strips newlines', () => {
  assert.equal(normalizeName('  Resty  '), 'Resty');
  assert.equal(normalizeName('Resty   Ochea'), 'Resty Ochea');
  assert.equal(normalizeName('Resty\nOchea'), 'Resty Ochea');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
});

test('normalizeName caps absurdly long names at 60 characters', () => {
  assert.equal(normalizeName('a'.repeat(500)).length, 60);
});

test('buildGreeting personalises when given a name', () => {
  const out = buildGreeting({ name: 'Resty', hour: 9 });
  assert.equal(out.greeting, 'Good morning, Resty!');
  assert.equal(out.question, "How's your day going so far?");
  assert.equal(out.message, "Good morning, Resty! How's your day going so far?");
});

test('buildGreeting stays impersonal without a name and never repeats it', () => {
  const out = buildGreeting({ hour: 19 });
  assert.equal(out.message, "Good evening! How's your day going so far?");
  assert.equal(out.message.match(/Resty/g), null);
});

test('buildGreeting falls back to the server clock when hour is omitted', () => {
  const out = buildGreeting({ name: 'Resty' });
  assert.equal(out.greeting, `${salutationFor(new Date().getHours())}, Resty!`);
});

test('classifyMood reads positive answers', () => {
  for (const a of ['great', 'pretty good', 'Amazing day!', 'so far so good', 'feeling productive']) {
    assert.equal(classifyMood(a), 'positive', a);
  }
});

test('classifyMood reads negative answers', () => {
  for (const a of ['rough', 'terrible', 'very tired', 'stressed out', 'could be better', 'meh']) {
    assert.equal(classifyMood(a), 'negative', a);
  }
});

test('classifyMood lets a negation beat the positive word inside it', () => {
  assert.equal(classifyMood('not great'), 'negative');
  assert.equal(classifyMood('not good, honestly'), 'negative');
  assert.equal(classifyMood("I'm not okay"), 'negative');
});

test('classifyMood is neutral on empty or unrecognised input', () => {
  for (const a of ['', '   ', null, undefined, 'the sky is blue']) {
    assert.equal(classifyMood(a), 'neutral', String(a));
  }
});

test('respondToDay replies in kind and echoes the mood', () => {
  assert.equal(respondToDay({ answer: 'great' }).mood, 'positive');
  assert.equal(respondToDay({ answer: 'rough' }).mood, 'negative');
  assert.equal(respondToDay({ answer: 'hmm' }).mood, 'neutral');
});

test('respondToDay lowercases the reply when prefixing a name', () => {
  const out = respondToDay({ name: 'Resty', answer: 'rough day' });
  assert.match(out.reply, /^Resty, sorry/);
});

test('respondToDay omits the prefix entirely when no name is given', () => {
  const out = respondToDay({ answer: 'rough day' });
  assert.match(out.reply, /^Sorry/);
});
