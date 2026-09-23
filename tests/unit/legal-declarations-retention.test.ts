/**
 * The declarations' retention period (owner's decision, 2026-09-23): deleted
 * at the end of the third calendar year after the year received, in Berlin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalDeclarationsCutoff } from '../../src/legal/legal-declarations-retention.js';

/** Whether a row received at `receivedAt` is deleted by a sweep at `now`. */
function isDeleted(input: { receivedAt: string; now: string }): boolean {
  return new Date(input.receivedAt).getTime() < legalDeclarationsCutoff(new Date(input.now)).getTime();
}

test('received 2026-09-21, deleted from 2030-01-01 00:00 in Berlin and not a minute before', () => {
  // 2030-01-01 00:00 in Berlin is 2029-12-31 23:00 UTC.
  assert.equal(isDeleted({ receivedAt: '2026-09-21T10:00:00Z', now: '2029-12-31T23:00:00Z' }), true);
  // THE CONTROLS: one minute, and one day, inside the period.
  assert.equal(isDeleted({ receivedAt: '2026-09-21T10:00:00Z', now: '2029-12-31T22:59:00Z' }), false);
  assert.equal(isDeleted({ receivedAt: '2026-09-21T10:00:00Z', now: '2029-12-30T23:00:00Z' }), false);
});

test('the year of receipt is the Berlin year, so a New Year night row belongs to the new year', () => {
  // 2026-12-31 23:30 UTC is 2027-01-01 00:30 in Berlin: kept through 2030.
  assert.equal(isDeleted({ receivedAt: '2026-12-31T23:30:00Z', now: '2030-06-01T00:00:00Z' }), false);
  assert.equal(isDeleted({ receivedAt: '2026-12-31T23:30:00Z', now: '2030-12-31T23:00:00Z' }), true);
  // And 22:30 UTC the same night is still 2026 in Berlin.
  assert.equal(isDeleted({ receivedAt: '2026-12-31T22:30:00Z', now: '2030-06-01T00:00:00Z' }), true);
});
