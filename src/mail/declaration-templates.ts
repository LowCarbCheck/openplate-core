/**
 * Finds the declaration letters' templates in the mounted content folder
 * (M246/04). The imperative shell around `mail-template.ts`: it reads files,
 * caches them, and logs; the parsing and the filling are pure and live there.
 *
 * LAYOUT: `<CONTENT_DIR>/<lang>/mail/<template>.md`, the mount root being one
 * instance's tree of the legal file contract (CONTRACT.md section 1). The
 * same folder, and the same env name, the app reads its legal pages from.
 *
 * THIS NEVER THROWS, AND NEVER WAITS ON ANYTHING BUT THE LOCAL DISK. A
 * persisted declaration's receipt must go out without delay whatever state
 * the mount is in. Every failure (no `CONTENT_DIR`, a missing file, an
 * unreadable one, a file the parser refuses) answers `null` for that
 * language, the next language is tried, and when none is left the letter is
 * built from the neutral fallback in `declaration-message.ts`. Each failure
 * with a folder configured is logged at `warn`, naming the template, the
 * language and the rule, never the file's content.
 *
 * CACHED WITH AN MTIME CHECK, like the app's page loader: each lookup costs
 * one `stat`, and the file is read and parsed again only when its mtime or
 * size changed. An operator who edits the mounted file sees the new text on
 * the next declaration, with no restart. A refused file is cached as refused,
 * so a broken template is parsed once per edit, not once per letter.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from '../logger.js';
import { MailTemplateError, parseMailTemplate, type MailTemplate } from './mail-template.js';
import {
  DECLARATION_TEMPLATE_PLACEHOLDERS,
  type DeclarationLanguage,
  type DeclarationTemplateName,
  type FoundMailTemplate,
} from './declaration-message.js';

export interface DeclarationTemplateSource {
  /**
   * The first of `languages` whose file exists and parses, or `null` when
   * none does. The caller lists the order: the reader's language, then `en`.
   */
  find(input: {
    name: DeclarationTemplateName;
    languages: readonly DeclarationLanguage[];
  }): Promise<FoundMailTemplate | null>;
}

type LoadOutcome = { ok: true; template: MailTemplate } | { ok: false; reason: string };

interface CachedFile {
  mtimeMs: number;
  size: number;
  outcome: LoadOutcome;
}

/** The two errors `stat` gives for a path that is not there: no file, or a path segment that is a file rather than a folder. */
const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR']);

function parseFile(input: { bytes: Buffer; name: DeclarationTemplateName }): LoadOutcome {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes);
  } catch {
    return { ok: false, reason: 'the file is not valid UTF-8' };
  }
  try {
    return {
      ok: true,
      template: parseMailTemplate({ source, placeholders: DECLARATION_TEMPLATE_PLACEHOLDERS[input.name] }),
    };
  } catch (cause) {
    if (cause instanceof MailTemplateError) return { ok: false, reason: cause.message };
    throw cause;
  }
}

/**
 * `contentDir` is `CONTENT_DIR`, or `null` when unset. With `null`, every
 * lookup answers `null` at once and logs nothing: an instance with no folder
 * sends the neutral text by design, and `main.ts` says so once at boot.
 */
export function createDeclarationTemplateSource(input: {
  contentDir: string | null;
  logger: Logger;
}): DeclarationTemplateSource {
  const { logger } = input;
  const root = input.contentDir === null ? null : resolve(input.contentDir);
  const cache = new Map<string, CachedFile>();

  async function load(file: { path: string; name: DeclarationTemplateName }): Promise<LoadOutcome> {
    let stats;
    try {
      stats = await stat(file.path);
    } catch (error) {
      cache.delete(file.path);
      const isMissing = error instanceof Error && 'code' in error && MISSING_FILE_CODES.has(String(error.code));
      return { ok: false, reason: isMissing ? 'the file is missing' : 'the file cannot be read' };
    }
    const cached = cache.get(file.path);
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.outcome;

    let bytes: Buffer;
    try {
      bytes = await readFile(file.path);
    } catch {
      cache.delete(file.path);
      return { ok: false, reason: 'the file cannot be read' };
    }
    const outcome = parseFile({ bytes, name: file.name });
    cache.set(file.path, { mtimeMs: stats.mtimeMs, size: stats.size, outcome });
    return outcome;
  }

  return {
    async find({ name, languages }): Promise<FoundMailTemplate | null> {
      if (root === null) return null;
      for (const language of languages) {
        const path = join(root, language, 'mail', `${name}.md`);
        // A defect in the parser is still not a reason to hold a statutory
        // receipt back: it is logged at `error` and the letter falls back.
        const outcome = await load({ path, name }).catch((cause: Error): LoadOutcome => {
          logger.error('Declaration mail template failed to load', { template: name, language, error: cause.name });
          return { ok: false, reason: 'an unexpected error' };
        });
        if (outcome.ok) return { template: outcome.template, language };
        logger.warn('Declaration mail template not used', { template: name, language, reason: outcome.reason });
      }
      return null;
    },
  };
}
