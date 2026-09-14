/**
 * The decisions `scripts/translate-mail.ts` makes that are this service's and not the library's.
 *
 * The library under `scripts/lib/translate*.ts` is a vendored copy of the website's and may not be
 * edited here (see `scripts/sync-translate-lib.ts`). What the service decides for itself lives in
 * this file, where a test can call it without a paid call: which languages are bought and which
 * are hand-written, where the memory is kept, what a placeholder looks like in a letter, and what
 * the generated module says.
 *
 * ── TWO HAND-WRITTEN, FOUR BOUGHT ──
 * `en` and `de` in `src/mail/strings.ts` came out of a wordsmith pass and are final; nothing here
 * touches them. Every other `InstanceLanguage` is a generated module, `src/mail/strings.<lang>.ts`,
 * rebuilt from the English and the memory on every run. The list of bought languages is DERIVED
 * from `INSTANCE_LANGUAGES` minus the hand-written two, so a seventh language added to the
 * protocol is a language this script knows about on the same day.
 *
 * ── A LETTER'S PLACEHOLDER IS `{date}`, NOT `{{date}}` ──
 * `fill()` in `strings.ts` substitutes single-brace names. The library's token check knows
 * i18next's double braces and HTML tags, and would wave through a French sentence that lost
 * `{date}`. So the placeholder set is compared HERE, after the buy and before anything is written,
 * and a string that lost one is a failed run rather than a letter with no expiry in it.
 *
 * ── A MISS IS A FAILED RUN, NOT AN ENGLISH FALLBACK ──
 * The website leaves a sentence the model would not answer cleanly in English and moves on: a page
 * in mixed English is a smaller failure than a page missing a sentence. A letter is the opposite
 * case. `strings.ts` says it in its header: the failure mode the type exists to prevent is "a
 * German letter with an English paragraph in the middle of it". So `renderModule` throws on a
 * missing translation, and the CLI writes nothing for that language.
 */
import { INSTANCE_LANGUAGES, type InstanceLanguage } from '../../src/protocol.js';
import type { MailStrings } from '../../src/mail/strings.js';
import { type CatalogTree, type CatalogUnit, collectByPath, leaves, unitKey } from './translate-ui.js';

/** The two languages a person wrote and wordsmith judged. Never generated, never bought. */
export const HAND_WRITTEN_LANGUAGES: readonly InstanceLanguage[] = ['en', 'de'];

/** Every language `scripts/translate-mail.ts` buys: the protocol's list minus the hand-written two. */
export const GENERATED_LANGUAGES: readonly InstanceLanguage[] = INSTANCE_LANGUAGES.filter(
  (language) => !HAND_WRITTEN_LANGUAGES.includes(language),
);

/** The English every other letter is made from, and the key the memory is filed under. */
export const SOURCE_LANGUAGE = 'en' satisfies InstanceLanguage;

/** The namespace half of every memory path: `mail:invite.subject`. */
export const NAMESPACE = 'mail';

/**
 * Where the per-language translation memory lives, relative to the repository root.
 *
 * Beside the dictionary, because the person who wants to change one French sentence must find the
 * memory before they find the generated module: an edit to `strings.fr.ts` is undone by the next
 * run, an edit to `memory/fr.json` is what sticks. Nothing under `src/` reaches the build unless
 * `src/main.ts` imports it, and nothing imports this directory.
 */
export const MEMORY_DIR = 'src/mail/memory';

export function memoryFile(language: InstanceLanguage): string {
  return `${MEMORY_DIR}/${language}.json`;
}

export function moduleFile(language: InstanceLanguage): string {
  return `src/mail/strings.${language}.ts`;
}

/** The exported name a generated module carries, `MAIL_STRINGS_FR`, which `strings.ts` imports by. */
export function exportName(language: InstanceLanguage): string {
  return `MAIL_STRINGS_${language.toUpperCase()}`;
}

/**
 * The dictionary as the library reads a catalog: a tree of names whose leaves are sentences.
 *
 * Spread field by field rather than passed through, because `MailStrings` is an interface with
 * three named members and `CatalogTree` is an index signature; the spread makes a fresh literal
 * the compiler is happy to call either, and lists the three letters where a fourth would have to
 * be added by hand, which is what `mail-messages.test.ts` counts too.
 */
export function treeOf(strings: MailStrings): CatalogTree {
  return {
    invite: { ...strings.invite },
    reset: { ...strings.reset },
    accountNotice: { ...strings.accountNotice },
  };
}

/** Every string of the English dictionary, keyed for the memory by path and English. */
export function unitsOf(strings: MailStrings): CatalogUnit[] {
  return collectByPath(NAMESPACE, treeOf(strings));
}

/** The `{name}` a letter interpolates. The same expression `fill()` in `strings.ts` substitutes. */
const PLACEHOLDER = /\{(\w+)\}/g;

/** The placeholders of a string, sorted, because a translation may move one and may not lose one. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[0]).toSorted((a, b) => (a < b ? -1 : 1));
}

/**
 * Does a translation carry exactly the `{name}` placeholders its English did, and no brace beyond
 * them?
 *
 * The brace count is the second half of the question. `{{date}}` still matches the placeholder
 * expression, and `fill()` would render it as `{11 September 2026}`, a date wearing a stray pair
 * of braces in somebody's inbox. So a translation may not add or drop a brace either.
 */
export function carriesPlaceholders(source: string, target: string): boolean {
  if (placeholders(source).join(' ') !== placeholders(target).join(' ')) return false;
  return braces(source) === braces(target);
}

/** How many brace characters a string carries, of either kind. */
function braces(text: string): number {
  return text.split('').filter((character) => character === '{' || character === '}').length;
}

/** One bought string whose placeholders are not the English's, named by its path. */
export interface PlaceholderOffender {
  path: string;
  source: string;
  target: string;
}

/** Every unit whose remembered translation lost, invented or renamed a placeholder. */
export function placeholderOffenders(
  units: readonly CatalogUnit[],
  memory: Map<string, string>,
): PlaceholderOffender[] {
  const out: PlaceholderOffender[] = [];
  for (const unit of units) {
    const target = memory.get(unit.hash);
    if (target === undefined || carriesPlaceholders(unit.source, target)) continue;
    out.push({ path: unit.key, source: unit.source, target });
  }
  return out;
}

/** What `renderModule` needs to say about where the strings came from. */
export interface ModuleProvenance {
  language: InstanceLanguage;
  /** The model every remembered string names, or the set of them if a memory carries more than one. */
  models: readonly string[];
  /** The day the run that wrote the module ran. */
  at: string;
}

/**
 * A TypeScript string literal, quoted the way prettier quotes one in this repo: single quotes
 * (`.prettierrc`), unless the text carries more single quotes than double ones, in which case the
 * quote that escapes less wins. That is prettier's own rule, and French is where it matters:
 * "l'appareil" in single quotes is a backslash prettier would rewrite.
 */
export function quote(text: string): string {
  const singles = text.split("'").length - 1;
  const doubles = text.split('"').length - 1;
  const mark = singles > doubles ? '"' : "'";
  const escaped = text.replaceAll('\\', '\\\\').replaceAll(mark, `\\${mark}`).replaceAll('\n', '\\n');
  return `${mark}${escaped}${mark}`;
}

/** The width prettier wraps this repo at (`.prettierrc`), so a generated line is one it would leave alone. */
const PRINT_WIDTH = 120;

/**
 * One `key: 'value',` line at the given indent, broken after the colon where prettier would break it.
 *
 * Prettier's rule for a property whose string does not fit: the value moves to its own line, one
 * indent deeper. Reproduced here so `pnpm format:check` is clean over a generated module and a
 * later hand run of prettier changes nothing.
 */
export function propertyLine(indent: string, key: string, value: string): string {
  const literal = quote(value);
  const inline = `${indent}${key}: ${literal},`;
  if (inline.length <= PRINT_WIDTH) return inline;
  return `${indent}${key}:\n${indent}  ${literal},`;
}

/**
 * The generated module for one language: a header that says it is generated and how, a type
 * import, and one `MailStrings`-shaped const built from the English tree's key order and the
 * memory's answers.
 *
 * KEY ORDER IS THE ENGLISH TREE'S, always, so a diff of a generated module shows changed values
 * and nothing else. A leaf the memory cannot answer throws: see the module note on misses.
 */
export function renderModule(input: {
  english: MailStrings;
  memory: Map<string, string>;
  provenance: ModuleProvenance;
}): string {
  const { english, memory, provenance } = input;
  const tree = treeOf(english);
  const lines: string[] = [];
  for (const [letter, strings] of Object.entries(tree)) {
    if (!(strings instanceof Object)) throw new Error(`translate-mail: ${letter} is not a letter`);
    lines.push(`  ${letter}: {`);
    for (const leaf of leaves(strings)) {
      const path = `${NAMESPACE}:${letter}.${leaf.key}`;
      const target = memory.get(unitKey(path, leaf.value));
      if (target === undefined) {
        throw new Error(
          `translate-mail: ${provenance.language} has no translation for ${path}. ` +
            'A letter with an English paragraph in it is not written; buy the string first.',
        );
      }
      lines.push(propertyLine('    ', leaf.key, target));
    }
    lines.push('  },');
  }
  return [
    '/**',
    ` * GENERATED. The ${languageName(provenance.language)} mail strings, bought by`,
    ` * \`pnpm translate:mail --locale ${provenance.language}\` on ${provenance.at} from`,
    ` * \`${memoryFile(provenance.language)}\` (model: ${provenance.models.join(', ')}).`,
    ' *',
    ' * DO NOT EDIT THIS FILE. The next run rebuilds it from the English in',
    ' * `strings.ts` and the memory, memory first, and puts any hand edit back.',
    ' * To change a sentence, edit its entry in the memory (find it by the `path`',
    ' * field), or delete the entry and re-run to buy that one string again.',
    ' *',
    " * The key order is the English dictionary's, so a diff shows changed values",
    ' * and nothing else. `satisfies MailStrings` is what makes a key the generator',
    ' * dropped a compile error rather than a letter missing a paragraph.',
    ' */',
    "import type { MailStrings } from './strings.js';",
    '',
    `export const ${exportName(provenance.language)} = {`,
    ...lines,
    '} satisfies MailStrings;',
    '',
  ].join('\n');
}

/** The language as its header names it, in English, for a reader who opens the file. */
export function languageName(language: InstanceLanguage): string {
  const names = {
    en: 'English',
    de: 'German',
    fr: 'French',
    it: 'Italian',
    es: 'Spanish',
    tr: 'Turkish',
  } satisfies Record<InstanceLanguage, string>;
  return names[language];
}
