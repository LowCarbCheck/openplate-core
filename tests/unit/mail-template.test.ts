/**
 * The mail template parser and renderer (M246/04), as pure strings.
 *
 * NEUTRAL TEXT ONLY. This repo is public; the real letters live in a private
 * one. Every template here is a marker sentence that exercises one rule of
 * the legal file contract's markdown subset.
 *
 * EVERY REFUSAL HAS A CONTROL. A refusal test that passes because the base
 * template is itself broken proves nothing, so each case first parses the
 * same template WITHOUT the offending line and requires that to succeed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MailTemplateError,
  parseMailTemplate,
  renderMailTemplate,
  type MailPlaceholder,
  type MailTemplateValues,
} from '../../src/mail/mail-template.js';

const RECEIPT_PLACEHOLDERS: readonly MailPlaceholder[] = ['date', 'details'];
const ALERT_PLACEHOLDERS: readonly MailPlaceholder[] = ['date', 'receiptId', 'details', 'matched'];

function templateSource(input: { body: string; subject?: string }): string {
  return [
    '---',
    'title: Fixture title',
    'updated: 2026-09-23',
    `subject: ${input.subject ?? 'Fixture subject'}`,
    '---',
    '',
    input.body,
    '',
  ].join('\n');
}

function valuesOf(
  entries: ReadonlyArray<readonly ['date' | 'receiptId' | 'matched', string]>,
  details: string[],
): MailTemplateValues {
  return { inline: new Map(entries), details };
}

const BASE_BODY = 'Fixture line on {{date}}.\n\n{{details}}';

test('the subset renders to a text part and an escaped HTML part', () => {
  const template = parseMailTemplate({
    source: templateSource({
      body: [
        '## Fixture heading',
        '',
        'Fixture first line\\',
        'fixture second line',
        'fixture soft line.',
        '',
        '- one **strong**',
        '- two *emphasis*',
        '',
        '1. first',
        '2. second',
        '',
        'Fixture [link](https://example.org/x) and a literal \\* and \\[x\\].',
        '',
        'Term',
        ': definition one',
        ': definition two',
        '',
        '{{details}}',
      ].join('\n'),
    }),
    placeholders: RECEIPT_PLACEHOLDERS,
  });
  const rendered = renderMailTemplate({
    template,
    values: valuesOf([['date', 'D']], ['A: 1', 'B: 2']),
    language: 'en',
  });

  assert.equal(rendered.subject, 'Fixture subject');
  assert.equal(
    rendered.text,
    [
      'Fixture heading',
      'Fixture first line\nfixture second line fixture soft line.',
      '- one strong\n- two emphasis',
      '1. first\n2. second',
      'Fixture link (https://example.org/x) and a literal * and [x].',
      'Term\ndefinition one\ndefinition two',
      'A: 1\n\nB: 2',
    ].join('\n\n'),
  );
  for (const fragment of [
    '<html lang="en">',
    '<h2>Fixture heading</h2>',
    '<p>Fixture first line<br>\nfixture second line\nfixture soft line.</p>',
    '<ul><li>one <strong>strong</strong></li><li>two <em>emphasis</em></li></ul>',
    '<ol><li>first</li><li>second</li></ol>',
    '<a href="https://example.org/x">link</a>',
    '<dl><dt>Term</dt><dd>definition one</dd><dd>definition two</dd></dl>',
    '<p>A: 1</p>\n<p>B: 2</p>',
  ]) {
    assert.ok(rendered.html.includes(fragment), `the HTML part lacks ${fragment}`);
  }
});

test('a filled value is a literal leaf: typed markup stays text and HTML is escaped', () => {
  const template = parseMailTemplate({
    source: templateSource({ body: BASE_BODY }),
    placeholders: RECEIPT_PLACEHOLDERS,
  });
  const hostile = 'Name: **bold** [x](https://evil.example) <b>tag</b> &amp;';
  const rendered = renderMailTemplate({ template, values: valuesOf([['date', 'D']], [hostile]), language: 'en' });

  assert.ok(rendered.text.includes(hostile), 'the text part must carry the value exactly as typed');
  assert.ok(!rendered.html.includes('<strong>'), 'typed ** became markup');
  assert.ok(!rendered.html.includes('<b>'), 'typed HTML reached the HTML part');
  assert.ok(!rendered.html.includes('href'), 'a typed link became an anchor');
  assert.ok(rendered.html.includes('&lt;b&gt;tag&lt;/b&gt; &amp;amp;'));
});

test('placeholders fill in the subject and in a line', () => {
  const template = parseMailTemplate({
    source: templateSource({
      subject: 'Fixture ({{receiptId}})',
      body: 'Seen {{date}}, matched {{matched}}.\n\n{{details}}',
    }),
    placeholders: ALERT_PLACEHOLDERS,
  });
  const rendered = renderMailTemplate({
    template,
    values: valuesOf(
      [
        ['date', 'D'],
        ['receiptId', 'R-1'],
        ['matched', 'no'],
      ],
      ['A: 1'],
    ),
    language: 'en',
  });
  assert.equal(rendered.subject, 'Fixture (R-1)');
  assert.equal(rendered.text, 'Seen D, matched no.\n\nA: 1');
});

const REFUSED_LINES: ReadonlyArray<{ label: string; line: string }> = [
  { label: 'an unknown placeholder', line: 'Fixture {{price}}.' },
  { label: 'a placeholder this template may not use', line: 'Fixture {{receiptId}}.' },
  { label: '{{details}} inside a line', line: 'Fixture {{details}} inline.' },
  { label: 'a malformed placeholder', line: 'Fixture {{date}.' },
  { label: 'raw HTML', line: 'Fixture <b>bold</b>.' },
  { label: 'an HTML comment', line: '<!-- fixture -->' },
  { label: 'a character reference', line: 'Fixture &amp; more.' },
  { label: 'an image', line: 'Fixture ![x](https://example.org/x.png).' },
  { label: 'a code span', line: 'Fixture `code`.' },
  { label: 'a code fence', line: '```' },
  { label: 'a block quote', line: '> fixture' },
  { label: 'a table', line: '| a | b |' },
  { label: 'an h1', line: '# Fixture' },
  { label: 'an h4', line: '#### Fixture' },
  { label: 'an indented line', line: '    fixture' },
  { label: 'a star bullet', line: '* fixture' },
  { label: 'a link to a javascript: target', line: 'Fixture [x](javascript:alert).' },
  { label: 'an unclosed strong run', line: 'Fixture **open.' },
  { label: 'a triple asterisk', line: 'Fixture ***x***.' },
  { label: 'a stray ]', line: 'Fixture ] here.' },
  { label: 'a section', line: ':::section fixture' },
  { label: 'a hard break that ends a paragraph', line: 'Fixture last line\\' },
];

for (const { label, line } of REFUSED_LINES) {
  test(`a template with ${label} is refused, and the same template without it parses`, () => {
    // CONTROL: the base template is valid, so the refusal below is the line's.
    assert.doesNotThrow(() =>
      parseMailTemplate({ source: templateSource({ body: BASE_BODY }), placeholders: RECEIPT_PLACEHOLDERS }),
    );
    assert.throws(
      () =>
        parseMailTemplate({
          source: templateSource({ body: `${BASE_BODY}\n\n${line}` }),
          placeholders: RECEIPT_PLACEHOLDERS,
        }),
      MailTemplateError,
    );
  });
}

test('front matter must be title, updated, subject, in that order, with a real date', () => {
  const valid = templateSource({ body: BASE_BODY });
  assert.doesNotThrow(() => parseMailTemplate({ source: valid, placeholders: RECEIPT_PLACEHOLDERS }));

  const swapped = valid.replace(
    'title: Fixture title\nupdated: 2026-09-23',
    'updated: 2026-09-23\ntitle: Fixture title',
  );
  const noSubject = valid.replace('subject: Fixture subject\n', '');
  const badDate = valid.replace('2026-09-23', '2026-02-30');
  const markupSubject = templateSource({ body: BASE_BODY, subject: 'Fixture **subject**' });
  const crlf = valid.replaceAll('\n', '\r\n');
  const bom = `\uFEFF${valid}`;
  for (const source of [swapped, noSubject, badDate, markupSubject, crlf, bom]) {
    assert.throws(() => parseMailTemplate({ source, placeholders: RECEIPT_PLACEHOLDERS }), MailTemplateError);
  }
});

test('a render with no value for a placeholder the template uses refuses, rather than leaving a hole', () => {
  const template = parseMailTemplate({
    source: templateSource({ body: 'Matched {{matched}}.\n\n{{details}}' }),
    placeholders: ALERT_PLACEHOLDERS,
  });
  // CONTROL: with the value, the same render succeeds.
  assert.doesNotThrow(() =>
    renderMailTemplate({ template, values: valuesOf([['matched', 'yes']], []), language: 'en' }),
  );
  assert.throws(() => renderMailTemplate({ template, values: valuesOf([], []), language: 'en' }), MailTemplateError);
});
