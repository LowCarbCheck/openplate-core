/**
 * The two declaration letters, asserted as pure strings: no dashes, no named
 * service, and the German statutory subject lines this repo's `strings.ts`
 * suite holds every other letter to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeclarationOperatorAlertMessage,
  buildDeclarationReceiptMessage,
  type DeclarationFields,
} from '../../src/mail/declaration-message.js';

const RECEIVED_AT = new Date('2026-09-21T10:15:00.000Z');

function baseFields(overrides: Partial<DeclarationFields> = {}): DeclarationFields {
  return {
    kind: 'kuendigung',
    name: 'Anna Beispiel',
    email: 'anna@example.org',
    contractReference: 'K-1234',
    terminationType: 'ordentlich',
    reason: null,
    requestedDate: null,
    timing: 'earliest',
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

const BANNED_WORDS = ['Sync', 'sync', 'Gateway', 'gateway', 'AI connection', 'account link'];
const BANNED_DASHES = ['—', '–'];

test('a kuendigung receipt names the kind, every given field, and the outcome, in the requested language', () => {
  const de = buildDeclarationReceiptMessage({ ...baseFields(), language: 'de' });
  assert.equal(de.subject, 'Ihre Kündigung');
  for (const value of ['Anna Beispiel', 'K-1234', 'ordentliche Kündigung']) {
    assert.ok(de.text.includes(value), `missing "${value}" in the German receipt`);
  }
  assert.ok(de.text.includes('Ende Ihres aktuellen Abrechnungszeitraums'), 'must state the cancellation effect');

  const en = buildDeclarationReceiptMessage({ ...baseFields(), language: 'en' });
  assert.equal(en.subject, 'Your cancellation request');
  assert.ok(en.text.includes('end of your current paid period'));
});

test('a widerruf receipt states the 14-day answer, and carries no reason or timing field the form never asked for', () => {
  const message = buildDeclarationReceiptMessage({
    ...baseFields({ kind: 'widerruf', terminationType: null, reason: null, timing: null }),
    language: 'en',
  });
  assert.equal(message.subject, 'Your withdrawal');
  assert.ok(message.text.includes('within 14 days'));
  assert.ok(!message.text.includes('Type of cancellation'), 'widerruf never asked for a termination type');
  assert.ok(!message.text.includes('Timing'), 'widerruf never asked for a timing');
});

test('an optional field the person left out produces no line at all', () => {
  const withReason = buildDeclarationReceiptMessage({ ...baseFields({ reason: 'a stated reason' }), language: 'en' });
  const withoutReason = buildDeclarationReceiptMessage({ ...baseFields({ reason: null }), language: 'en' });
  assert.ok(withReason.text.includes('Reason: a stated reason'));
  assert.ok(!withoutReason.text.includes('Reason:'));
});

test('a declaration receipt carries no link, in either language', () => {
  for (const language of ['de', 'en'] as const) {
    const message = buildDeclarationReceiptMessage({ ...baseFields(), language });
    assert.ok(!message.html.includes('href'), `${language} receipt must carry no link`);
    assert.ok(!message.text.includes('http'), `${language} receipt text must carry no url`);
  }
});

test('neither letter names a service, a gateway or an account link, and neither carries a dash', () => {
  const receiptDe = buildDeclarationReceiptMessage({ ...baseFields(), language: 'de' });
  const receiptEn = buildDeclarationReceiptMessage({ ...baseFields(), language: 'en' });
  const alert = buildDeclarationOperatorAlertMessage({ ...baseFields(), receiptId: 'r-1', matched: true });

  for (const message of [receiptDe, receiptEn, alert]) {
    for (const word of BANNED_WORDS) {
      assert.ok(!message.text.includes(word), `text carries banned word "${word}"`);
      assert.ok(!message.html.includes(word), `html carries banned word "${word}"`);
    }
    for (const dash of BANNED_DASHES) {
      assert.ok(!message.text.includes(dash), 'text carries a dash');
      assert.ok(!message.subject.includes(dash), 'subject carries a dash');
    }
  }
});

test('the operator alert names the receipt id, every field, and whether it matched, in English regardless of the declaration language', () => {
  const matched = buildDeclarationOperatorAlertMessage({ ...baseFields(), receiptId: 'a-receipt-id', matched: true });
  assert.ok(matched.subject.includes('a-receipt-id'));
  assert.ok(matched.text.includes('a-receipt-id'));
  assert.ok(matched.text.includes('yes'));
  assert.ok(matched.text.includes('K-1234'));

  const unmatched = buildDeclarationOperatorAlertMessage({ ...baseFields(), receiptId: 'a-receipt-id', matched: false });
  assert.ok(unmatched.text.includes('no'));
});
