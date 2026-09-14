/**
 * A stand-in for `openplate-website/app/lib/docs-i18n.server.ts`: the part of it the mail
 * translator needs, done for real, and the part only the documentation pipeline needs, refused.
 *
 * ── WHAT IS REAL HERE, AND WHY IT MUST MATCH UPSTREAM BYTE FOR BYTE ──
 * `hash` is the KEY of the translation memory. Every entry in `src/mail/memory/<locale>.json`
 * is filed under the hash the vendored `translate-ui.ts` computes from a path and its English,
 * and the same function looks a string up. A hash that differed from the website's by one
 * character would not be wrong in any way a test could see: every lookup would miss, every string
 * would be a miss, and the next run would buy the whole dictionary again. `Memo`, `Memory` and
 * `Unit` are the file format and the unit of work, and `fits` is the marker check `fill` runs.
 * All five are the upstream text, unchanged; the upstream module's hash is under `shimmed` in
 * TRANSLATE_SOURCE.json.
 *
 * ── WHAT IS REFUSED, AND WHY IT THROWS RATHER THAN RETURNS ──
 * `collect`, `collectBlock`, `collectDoc` and `collectEntry` walk the website's documentation
 * tree. The vendored `translate.ts` re-exports two of them and calls the rest from
 * `collectUnits`, `pagesOf` and `tablesOf`, none of which the mail path touches: this service
 * has no documentation corpus and nothing here constructs a `Block`. A silent no-op would let a
 * future caller collect nothing, price nothing and report a corpus as fully translated. They
 * throw, naming the reason, so that day is an error with a sentence in it.
 */
import { createHash } from 'node:crypto';

import type { Block, DocEntry, DocFile, Inline } from './docs.js';

/** A `{{n}}` marker stands for a child span the model must not read and must not lose. */
export const MARKER = /\{\{(\d+)\}\}/g;

/** One segment of English, and the key it is remembered under. */
export interface Unit {
  hash: string;
  source: string;
}

/**
 * One remembered sentence, as it is written to the memory file.
 *
 * The target is keyed BY LOCALE CODE rather than by a field called `target`, so a reader opening
 * the memory sees `"fr": "..."` next to the English it stands for. Every value is a string, which
 * is why one index signature covers the three fixed fields and the locale alike.
 */
export interface Memo {
  /** The English template this entry translates, markers and all. */
  en: string;
  /** The model that produced it, or `hand-written`: provenance, and the thing to check after a model change. */
  model: string;
  /** The day it was bought. Absolute, because a relative date in a committed file rots. */
  at: string;
  [locale: string]: string | undefined;
}

export type Memory = Record<string, Memo>;

export function hash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/**
 * Does a translation carry exactly the markers its source did?
 *
 * A SET COMPARISON, NOT A SEQUENCE. Moving `{{0}}` past `{{1}}` is what the marker is for; losing
 * one, inventing one or renumbering them is not.
 */
export function fits(source: string, target: string): boolean {
  const of = (text: string) =>
    [...text.matchAll(MARKER)]
      .map((match) => match[0])
      .toSorted((a, b) => (a < b ? -1 : 1))
      .join();
  return of(source) === of(target);
}

const NO_DOCS =
  'translate: the documentation corpus is not part of openplate-core. This copy of the translator serves ' +
  'src/mail/strings.ts only; see scripts/lib/translate-shims/docs-i18n.server.ts.';

export function collect(_spans: readonly Inline[], _out: Map<string, Unit>): void {
  throw new Error(NO_DOCS);
}

export function collectBlock(_block: Block, _out: Map<string, Unit>): void {
  throw new Error(NO_DOCS);
}

export function collectDoc(_doc: DocFile, _out: Map<string, Unit>): void {
  throw new Error(NO_DOCS);
}

export function collectEntry(_entry: DocEntry, _out: Map<string, Unit>): void {
  throw new Error(NO_DOCS);
}
