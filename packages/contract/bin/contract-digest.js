#!/usr/bin/env node
// packages/contract/bin/contract-digest.js
// Prints, writes, or verifies contract.lock.json.
//
//   node bin/contract-digest.js            print the digest
//   node bin/contract-digest.js --json     print the full lock body
//   node bin/contract-digest.js --surface  print the exact JSON that gets hashed
//   node bin/contract-digest.js --write    regenerate the lock file (run after editing tools.js)
//   node bin/contract-digest.js --verify   fail if the lock file drifts from the source (CI)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contractDigest, contractSurface, lockBody } = require('../src/digest');

const LOCK_PATH = path.join(__dirname, '..', 'contract.lock.json');
const serialize = (body) => `${JSON.stringify(body, null, 2)}\n`;

function readLock() {
  if (!fs.existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch (e) {
    console.error(`FAIL  contract.lock.json is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

function verify() {
  const expected = lockBody();
  const actual = readLock();
  if (!actual) {
    console.error('FAIL  contract.lock.json is missing. Run: npm run contract:digest -- --write');
    process.exit(1);
  }
  if (actual.digest !== expected.digest) {
    console.error(`FAIL  contract digest drift: lock says ${actual.digest}, source computes ${expected.digest}`);
    console.error('      The tool surface changed without a lock update. Review the diff, decide whether');
    console.error('      the contract version needs a MAJOR or MINOR bump, then run:');
    console.error('        npm run contract:digest -- --write   (and commit the result)');
    process.exit(1);
  }
  // The lock is also a human-readable summary; a stale summary with a matching digest
  // would mean the summary itself is not derived from the source.
  if (serialize(expected) !== fs.readFileSync(LOCK_PATH, 'utf8')) {
    console.error('FAIL  contract.lock.json digest matches but its body is stale. Run: npm run contract:digest -- --write');
    process.exit(1);
  }
  console.log(`ok    contract ${expected.contractVersion} digest ${expected.digest} (${expected.tools.length} tools)`);
}

function write() {
  const body = lockBody();
  const next = serialize(body);
  const prev = fs.existsSync(LOCK_PATH) ? fs.readFileSync(LOCK_PATH, 'utf8') : null;
  fs.writeFileSync(LOCK_PATH, next);
  const verb = prev === next ? 'unchanged' : prev == null ? 'created' : 'updated';
  console.log(`ok    contract.lock.json ${verb} — ${body.contractVersion} digest ${body.digest}`);
}

const argv = process.argv.slice(2);
if (argv.includes('--verify')) verify();
else if (argv.includes('--write')) write();
else if (argv.includes('--surface')) console.log(JSON.stringify(contractSurface(), null, 2));
else if (argv.includes('--json')) console.log(JSON.stringify(lockBody(), null, 2));
else console.log(contractDigest());
