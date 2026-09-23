/**
 * The two declaration letters (M246/04): the neutral fallback this public
 * repo keeps, and the fill of a template from the mounted content folder.
 *
 * The templates here are neutral markers built inline; the real text lives in
 * a private repo. The fallback's exact lines ARE pinned: they are code-owned
 * labels copied from the app's confirmation page, not wordsmith-owned prose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeclarationOperatorAlertMessage,
  buildDeclarationReceiptMessage,
  DECLARATION_TEMPLATE_PLACEHOLDERS,
  type DeclarationFields,
  type DeclarationTemplateName,
  type FoundMailTemplate,
} from '../../src/mail/declaration-message.js';
import { parseMailTemplate } from '../../src/mail/mail-template.js';

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

function foundTemplate(input: {
  name: DeclarationTemplateName;
  language: 'de' | 'en';
  subject: string;
  body: string;
}): FoundMailTemplate {
  const source = [
    '---',
    'title: Fixture',
    'updated: 2026-09-23',
    `subject: ${input.subject}`,
    '---',
    '',
    input.body,
    '',
  ].join('\n');
  return {
    template: parseMailTemplate({ source, placeholders: DECLARATION_TEMPLATE_PLACEHOLDERS[input.name] }),
    language: input.language,
  };
}

const BANNED_WORDS = ['Sync', 'sync', 'Gateway', 'gateway', 'AI connection', 'account link'];
const BANNED_DASHES = ['\u2014', '\u2013'];

test('with no template, the receipt is the neutral fallback: kind, receipt number, time, every field, nothing else', () => {
  const en = buildDeclarationReceiptMessage({
    declaration: { ...baseFields(), receiptId: 'r-1', language: 'en' },
    template: null,
  });
  assert.equal(en.origin, 'fallback');
  assert.equal(en.subject, 'Cancellation confirmed');
  assert.deepEqual(en.text.split('\n\n'), [
    'Type: Cancellation',
    'Receipt no.: r-1',
    'Received at: 21 September 2026 at 12:15 CEST',
    'Name: Anna Beispiel',
    'Email: anna@example.org',
    'Contract or customer number: K-1234',
    'Type of cancellation: regular notice',
    'Timing: as soon as legally possible',
  ]);

  const de = buildDeclarationReceiptMessage({
    declaration: {
      ...baseFields({ kind: 'widerruf', terminationType: null, timing: null }),
      receiptId: 'r-2',
      language: 'de',
    },
    template: null,
  });
  assert.equal(de.subject, 'Widerruf bestätigt');
  assert.deepEqual(de.text.split('\n\n'), [
    'Art: Widerruf',
    'Beleg-Nr.: r-2',
    'Eingegangen am: 21. September 2026 um 12:15 MESZ',
    'Name: Anna Beispiel',
    'E-Mail: anna@example.org',
    'Vertrags- oder Kundennummer: K-1234',
  ]);
});

test('an optional field the person left out produces no line at all', () => {
  const withReason = buildDeclarationReceiptMessage({
    declaration: { ...baseFields({ reason: 'a stated reason' }), receiptId: 'r', language: 'en' },
    template: null,
  });
  const withoutReason = buildDeclarationReceiptMessage({
    declaration: { ...baseFields({ reason: null }), receiptId: 'r', language: 'en' },
    template: null,
  });
  assert.ok(withReason.text.includes('Reason: a stated reason'));
  assert.ok(!withoutReason.text.includes('Reason:'));
});

test('neither fallback carries a link, names a service, or carries a dash', () => {
  const receipts = (['de', 'en'] as const).map((language) =>
    buildDeclarationReceiptMessage({ declaration: { ...baseFields(), receiptId: 'r', language }, template: null }),
  );
  const alert = buildDeclarationOperatorAlertMessage({
    declaration: { ...baseFields(), receiptId: 'r', matched: true },
    template: null,
  });
  for (const message of [...receipts, alert]) {
    assert.ok(!message.html.includes('href'), 'a fallback carries a link');
    assert.ok(!message.text.includes('http'), 'a fallback carries a url');
    for (const word of BANNED_WORDS) {
      assert.ok(!message.text.includes(word), `text carries banned word "${word}"`);
      assert.ok(!message.subject.includes(word), `subject carries banned word "${word}"`);
    }
    for (const dash of BANNED_DASHES) {
      assert.ok(!message.text.includes(dash), 'text carries a dash');
      assert.ok(!message.subject.includes(dash), 'subject carries a dash');
    }
  }
});

test('the operator alert fallback names the receipt id, every field, and whether it matched, in English', () => {
  const matched = buildDeclarationOperatorAlertMessage({
    declaration: { ...baseFields({ kind: 'widerruf' }), receiptId: 'a-receipt-id', matched: true },
    template: null,
  });
  assert.equal(matched.origin, 'fallback');
  assert.equal(matched.subject, 'New declaration: withdrawal (a-receipt-id)');
  assert.ok(matched.text.includes('Receipt no.: a-receipt-id'));
  assert.ok(matched.text.includes('Contract or customer number: K-1234'));
  assert.ok(matched.text.endsWith('Matched to an existing account: yes.'));

  const unmatched = buildDeclarationOperatorAlertMessage({
    declaration: { ...baseFields(), receiptId: 'a-receipt-id', matched: false },
    template: null,
  });
  assert.ok(unmatched.text.endsWith('Matched to an existing account: no.'));
});

test('a found template is filled, in the TEMPLATE language, with the details as one paragraph each', () => {
  const template = foundTemplate({
    name: 'declaration-receipt-kuendigung',
    language: 'en',
    subject: 'Fixture subject',
    body: 'Fixture received on {{date}}.\n\n{{details}}\n\nFixture closing.',
  });
  // A German reader, and an English file: the fallback language of the
  // lookup. The labels and the date follow the file, so the letter is in one
  // language throughout.
  const message = buildDeclarationReceiptMessage({
    declaration: { ...baseFields(), receiptId: 'r', language: 'de' },
    template,
  });
  assert.equal(message.origin, 'template');
  assert.equal(message.subject, 'Fixture subject');
  assert.deepEqual(message.text.split('\n\n'), [
    'Fixture received on 21 September 2026 at 12:15 CEST.',
    'Name: Anna Beispiel',
    'Email: anna@example.org',
    'Contract or customer number: K-1234',
    'Type of cancellation: regular notice',
    'Timing: as soon as legally possible',
    'Fixture closing.',
  ]);
  assert.ok(message.html.includes('<html lang="en">'));
});

test('an alert template fills the receipt id and the match in subject and body', () => {
  const template = foundTemplate({
    name: 'declaration-alert-kuendigung',
    language: 'en',
    subject: 'Fixture alert ({{receiptId}})',
    body: 'Fixture {{receiptId}} on {{date}}.\n\n{{details}}\n\nFixture matched: {{matched}}.',
  });
  const message = buildDeclarationOperatorAlertMessage({
    declaration: { ...baseFields(), receiptId: 'a-9', matched: false },
    template,
  });
  assert.equal(message.origin, 'template');
  assert.equal(message.subject, 'Fixture alert (a-9)');
  assert.ok(message.text.startsWith('Fixture a-9 on 21 September 2026'));
  assert.ok(message.text.endsWith('Fixture matched: no.'));
});

test('a template that needs a value this letter lacks sends the fallback, never a half-filled letter', () => {
  // An ALERT template handed to the RECEIPT builder: it needs {{matched}},
  // which a receipt has no value for.
  const alertTemplate = foundTemplate({
    name: 'declaration-alert-kuendigung',
    language: 'en',
    subject: 'Fixture subject',
    body: 'Fixture matched: {{matched}}.\n\n{{details}}',
  });
  const message = buildDeclarationReceiptMessage({
    declaration: { ...baseFields(), receiptId: 'r', language: 'en' },
    template: alertTemplate,
  });
  assert.equal(message.origin, 'fallback');
  assert.equal(message.subject, 'Cancellation confirmed');
  assert.ok(!message.text.includes('Fixture'), 'a line of the unusable template reached the letter');

  // CONTROL: the alert builder, which HAS the value, uses the same template.
  const alert = buildDeclarationOperatorAlertMessage({
    declaration: { ...baseFields(), receiptId: 'r', matched: true },
    template: alertTemplate,
  });
  assert.equal(alert.origin, 'template');
});
