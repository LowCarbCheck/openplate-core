/**
 * The trial key (M253): one string per mailbox, so the one address, one trial
 * rule cannot be walked around with a dot or a tag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialKeyFor } from '../../src/accounts/trial-key.js';

test('a tag and Gmail dots collapse onto one key', () => {
  const key = trialKeyFor('anna@gmail.com');
  assert.equal(trialKeyFor('anna+x@gmail.com'), key);
  assert.equal(trialKeyFor('a.n.n.a@gmail.com'), key);
  assert.equal(trialKeyFor('a.n.n.a+diet.plan@gmail.com'), key);
});

test('googlemail.com and gmail.com are one mailbox', () => {
  assert.equal(trialKeyFor('a.nna@googlemail.com'), trialKeyFor('anna@gmail.com'));
});

test('dots count everywhere but Google, so two mailboxes keep two keys', () => {
  // THE CONTROL: a key function that dropped dots for every domain would pass
  // the two tests above and fail here.
  assert.notEqual(trialKeyFor('a.nna@example.org'), trialKeyFor('anna@example.org'));
});

test('a tag is removed for every domain, and the domain is never touched', () => {
  assert.equal(trialKeyFor('anna+work@example.org'), 'anna@example.org');
  assert.equal(trialKeyFor('anna@mail.example.org'), 'anna@mail.example.org');
  assert.notEqual(trialKeyFor('anna@example.org'), trialKeyFor('anna@example.com'));
});
