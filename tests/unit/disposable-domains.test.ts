/**
 * The throwaway-domain refusal (M253): the vendored snapshot, matched on the
 * domain and every parent of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isDisposableAddress } from '../../src/accounts/disposable-domains.js';
import { DISPOSABLE_DOMAINS, DISPOSABLE_DOMAINS_SOURCE } from '../../src/accounts/disposable-domains.generated.js';

test('a listed domain is refused, and so is any subdomain of it', () => {
  assert.equal(isDisposableAddress('anna@mailinator.com'), true);
  assert.equal(isDisposableAddress('anna@x.mailinator.com'), true);
});

test('an ordinary provider is not refused', () => {
  // THE CONTROL: a matcher that answered `true` for everything passes the test
  // above and fails here.
  assert.equal(isDisposableAddress('anna@gmail.com'), false);
  assert.equal(isDisposableAddress('anna@example.org'), false);
});

test('a parent is matched only down to two labels, so no entry can refuse a whole top-level domain', () => {
  assert.equal(DISPOSABLE_DOMAINS.includes('com'), false, 'the snapshot never lists a bare top-level domain');
  assert.equal(isDisposableAddress('anna@notlisted-mailinator.com'), false);
});

test('the snapshot names its source commit and is not a truncated download', async () => {
  assert.match(DISPOSABLE_DOMAINS_SOURCE.commit, /^[0-9a-f]{40}$/);
  assert.ok(DISPOSABLE_DOMAINS.length > 1000, `only ${DISPOSABLE_DOMAINS.length} entries`);
  const source = await readFile(new URL('../../src/accounts/disposable-domains.generated.ts', import.meta.url), 'utf8');
  // The header a reviewer reads is the header the constant reports.
  assert.ok(source.includes(`Commit: ${DISPOSABLE_DOMAINS_SOURCE.commit}`));
  assert.ok(source.includes('CC0 1.0'));
});
