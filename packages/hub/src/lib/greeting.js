// packages/hub/src/lib/greeting.js
// Pure greeting logic — no I/O, no MCP, no clock reads. Everything the tools say is
// derived here from explicit inputs so the whole surface is unit-testable in CI.

// Hour buckets are inclusive on both ends; 22..04 wraps midnight and is handled last.
const SALUTATIONS = [
  { from: 5, to: 11, text: 'Good morning' },
  { from: 12, to: 17, text: 'Good afternoon' },
  { from: 18, to: 21, text: 'Good evening' },
];

const NIGHT_SALUTATION = 'Hello';

function assertHour(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`hour must be an integer 0-23, got ${JSON.stringify(hour)}`);
  }
}

// "Good morning" / "Good afternoon" / "Good evening", or a neutral "Hello" at night.
function salutationFor(hour) {
  assertHour(hour);
  const match = SALUTATIONS.find((s) => hour >= s.from && hour <= s.to);
  return match ? match.text : NIGHT_SALUTATION;
}

// Trim, collapse whitespace, and drop anything that would let a name break the sentence.
function normalizeName(name) {
  if (name == null) return '';
  return String(name).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function buildGreeting({ name, hour } = {}) {
  const who = normalizeName(name);
  const salutation = salutationFor(hour == null ? new Date().getHours() : hour);
  const greeting = who ? `${salutation}, ${who}!` : `${salutation}!`;
  // The name is already in the greeting — repeating it in the question reads like a robot.
  const question = "How's your day going so far?";
  return { greeting, question, message: `${greeting} ${question}` };
}

// Keyword buckets, longest-intent-first: a negation like "not great" must win over "great".
const NEGATIVE_PATTERNS = [
  /\bnot (?:great|good|well|okay|ok|fine)\b/i,
  /\b(?:bad|rough|awful|terrible|tough|stressful|stressed|tired|exhausted|sad|down|hard|busy|overwhelmed|sick|frustrat\w*|annoy\w*)\b/i,
  /\bcould be better\b/i,
  /\bmeh\b/i,
];

const POSITIVE_PATTERNS = [
  /\b(?:great|good|well|fine|amazing|awesome|excellent|fantastic|wonderful|happy|productive|lovely|nice|better|excited|grateful)\b/i,
  /\bpretty good\b/i,
  /\bso far so good\b/i,
];

// 'positive' | 'negative' | 'neutral' — neutral is the honest answer when nothing matches.
function classifyMood(answer) {
  const text = String(answer == null ? '' : answer);
  if (!text.trim()) return 'neutral';
  if (NEGATIVE_PATTERNS.some((re) => re.test(text))) return 'negative';
  if (POSITIVE_PATTERNS.some((re) => re.test(text))) return 'positive';
  return 'neutral';
}

const REPLIES = {
  positive: "That's great to hear! Glad the day is treating you well.",
  negative: "Sorry it's been a rough one. I hope the rest of the day is kinder to you.",
  neutral: 'Thanks for sharing — hope the day turns out well for you.',
};

function respondToDay({ name, answer } = {}) {
  const who = normalizeName(name);
  const mood = classifyMood(answer);
  const reply = who ? `${who}, ${REPLIES[mood][0].toLowerCase()}${REPLIES[mood].slice(1)}` : REPLIES[mood];
  return { mood, reply };
}

module.exports = {
  SALUTATIONS,
  NIGHT_SALUTATION,
  REPLIES,
  salutationFor,
  normalizeName,
  buildGreeting,
  classifyMood,
  respondToDay,
};
