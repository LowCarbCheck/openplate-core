/**
 * The content folder lookup (M246/04) against `tests/fixtures/content/`, a
 * stand-in for an instance's mounted `CONTENT_DIR` holding neutral markers
 * only. See that folder's README for which files are there and which are
 * missing on purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeclarationTemplateSource } from '../../src/mail/declaration-templates.js';
import { renderMailTemplate } from '../../src/mail/mail-template.js';
import type { FoundMailTemplate } from '../../src/mail/declaration-message.js';
import type { LogFields, Logger } from '../../src/logger.js';

const CONTENT = fileURLToPath(new URL('../fixtures/content', import.meta.url));
const CONTENT_REFUSED = fileURLToPath(new URL('../fixtures/content-refused', import.meta.url));

interface CapturedLine {
  level: string;
  message: string;
  fields: LogFields | undefined;
}

interface CapturingLogger {
  logger: Logger;
  lines: CapturedLine[];
}

function capturingLogger(): CapturingLogger {
  const lines: CapturedLine[] = [];
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields });
    };
  return { lines, logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
}

function subjectOf(found: FoundMailTemplate | null): string | null {
  if (found === null) return null;
  const values = {
    inline: new Map([['date', 'D'] as const, ['receiptId', 'R'] as const, ['matched', 'yes'] as const]),
    details: [],
  };
  return renderMailTemplate({ template: found.template, values, language: found.language }).subject;
}

test('the reader language file is used when it exists', async () => {
  const { logger, lines } = capturingLogger();
  const source = createDeclarationTemplateSource({ contentDir: CONTENT, logger });

  const found = await source.find({ name: 'declaration-receipt-kuendigung', languages: ['de', 'en'] });
  assert.equal(found?.language, 'de');
  assert.equal(subjectOf(found), 'Fixture subject receipt kuendigung de');
  assert.deepEqual(lines, []);
});

test('a missing reader language falls back to English, and says so', async () => {
  const { logger, lines } = capturingLogger();
  const source = createDeclarationTemplateSource({ contentDir: CONTENT, logger });

  const found = await source.find({ name: 'declaration-receipt-widerruf', languages: ['de', 'en'] });
  assert.equal(found?.language, 'en');
  assert.equal(subjectOf(found), 'Fixture subject receipt widerruf en');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, 'warn');
  assert.deepEqual(lines[0]?.fields, {
    template: 'declaration-receipt-widerruf',
    language: 'de',
    reason: 'the file is missing',
  });
});

test('a template missing in every language answers null, so the letter falls back to the neutral text', async () => {
  const { logger, lines } = capturingLogger();
  const source = createDeclarationTemplateSource({ contentDir: CONTENT, logger });

  // CONTROL: the kuendigung alert IS in the folder, so a null below is the
  // missing file's doing, not a broken folder path.
  assert.notEqual(await source.find({ name: 'declaration-alert-kuendigung', languages: ['en'] }), null);
  assert.equal(await source.find({ name: 'declaration-alert-widerruf', languages: ['en'] }), null);
  assert.equal(lines.at(-1)?.fields?.reason, 'the file is missing');
});

test('a template with an unknown placeholder is refused and logged with the rule, never its content', async () => {
  const { logger, lines } = capturingLogger();
  const refused = createDeclarationTemplateSource({ contentDir: CONTENT_REFUSED, logger });

  assert.equal(await refused.find({ name: 'declaration-receipt-kuendigung', languages: ['en'] }), null);
  const reason = String(lines[0]?.fields?.reason);
  assert.ok(reason.includes('{{price}} is not a placeholder of this template'), reason);
  assert.ok(!JSON.stringify(lines).includes('which no receipt may use'), 'a log line carries file content');

  // CONTROL: the same template name in the good folder parses.
  const good = createDeclarationTemplateSource({ contentDir: CONTENT, logger });
  assert.notEqual(await good.find({ name: 'declaration-receipt-kuendigung', languages: ['en'] }), null);
});

test('with CONTENT_DIR unset every lookup answers null and logs nothing', async () => {
  const { logger, lines } = capturingLogger();
  const source = createDeclarationTemplateSource({ contentDir: null, logger });

  assert.equal(await source.find({ name: 'declaration-receipt-kuendigung', languages: ['de', 'en'] }), null);
  assert.deepEqual(lines, []);
});

test('an edited file is read again when its mtime moves, and served from the cache while it does not', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'openplate-core-content-'));
  try {
    await cp(CONTENT, scratch, { recursive: true });
    const path = join(scratch, 'en', 'mail', 'declaration-receipt-widerruf.md');
    const { logger } = capturingLogger();
    const source = createDeclarationTemplateSource({ contentDir: scratch, logger });
    const lookup = { name: 'declaration-receipt-widerruf', languages: ['en'] } as const;
    // A whole-second mtime, so restoring it below is exact: a copied file's
    // own mtime carries nanoseconds that `utimes` cannot write back.
    const pinned = new Date('2026-09-23T10:00:00.000Z');
    await utimes(path, pinned, pinned);

    assert.equal(subjectOf(await source.find(lookup)), 'Fixture subject receipt widerruf en');

    // Same size, same mtime: the cache must answer, so the old subject stays.
    // This is what proves a cache exists at all.
    const original = await readFile(path, 'utf8');
    const edited = original.replace('Fixture subject receipt widerruf en', 'Fixture subject receipt widerruf XX');
    assert.equal(edited.length, original.length);
    await writeFile(path, edited);
    await utimes(path, pinned, pinned);
    assert.equal((await stat(path)).mtimeMs, pinned.getTime());
    assert.equal(subjectOf(await source.find(lookup)), 'Fixture subject receipt widerruf en');

    // The mtime moves: the next lookup reads the file again.
    const later = new Date(pinned.getTime() + 5_000);
    await utimes(path, later, later);
    assert.equal(subjectOf(await source.find(lookup)), 'Fixture subject receipt widerruf XX');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
