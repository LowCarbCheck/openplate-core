/**
 * The scan trial's pure rules (M253): what the account view says, when the
 * gate applies, and the keyed mailbox hash.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTAKE_ID_PATTERN, isScanGated, trialScansView } from '../../src/accounts/scan-trial.js';
import { createTrialAddressHasher } from '../../src/accounts/trial-address.js';

test('the view is granted and left, never negative, and null without a trial', () => {
  assert.deepEqual(trialScansView({ granted: 10, used: 3 }), { granted: 10, left: 7 });
  assert.deepEqual(trialScansView({ granted: 2, used: 5 }), { granted: 2, left: 0 });
  assert.equal(trialScansView({ granted: null, used: 0 }), null);
});

test('the gate applies to a trial with no date, and a date of any kind lifts it', () => {
  assert.equal(isScanGated({ trialScans: 10, allowanceExpiresAt: null }), true);
  // THE CONTROLS: a paid window, and no trial at all.
  assert.equal(isScanGated({ trialScans: 10, allowanceExpiresAt: new Date('2027-01-01T00:00:00Z') }), false);
  assert.equal(isScanGated({ trialScans: null, allowanceExpiresAt: null }), false);
});

test('an intake id is 16 to 64 URL-safe characters, so a UUID fits with or without dashes', () => {
  assert.equal(INTAKE_ID_PATTERN.test('2f9d0b416c3a4e579f10000000000001'), true);
  assert.equal(INTAKE_ID_PATTERN.test('2f9d0b41-6c3a-4e57-9f10-000000000001'), true);
  assert.equal(INTAKE_ID_PATTERN.test('short'), false);
  assert.equal(INTAKE_ID_PATTERN.test('x'.repeat(65)), false);
  assert.equal(INTAKE_ID_PATTERN.test('has spaces in it here'), false);
});

test('the mailbox hash is keyed, one-way, and shared by every spelling of one mailbox', () => {
  const hash = createTrialAddressHasher('a-pepper-that-is-long-enough-for-this-test');
  const other = createTrialAddressHasher('another-pepper-that-is-long-enough-for-it');
  assert.equal(hash('a.n.n.a+x@gmail.com'), hash('anna@gmail.com'));
  assert.match(hash('anna@gmail.com'), /^[0-9a-f]{64}$/);
  assert.equal(hash('anna@gmail.com').includes('anna'), false);
  // THE CONTROLS: another key gives another hash, and another mailbox too.
  assert.notEqual(other('anna@gmail.com'), hash('anna@gmail.com'));
  assert.notEqual(hash('bert@gmail.com'), hash('anna@gmail.com'));
});
