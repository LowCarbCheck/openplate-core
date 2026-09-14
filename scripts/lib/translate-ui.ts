/**
 * The decisions `translate-ui` makes, cut out of the CLI so a test can call them.
 *
 * Same cut, and for the same reason, as `scripts/lib/translate.ts`: a file whose
 * body runs on import cannot be imported by a test without spending money and
 * calling `process.exit`. The CLI keeps the arguments, the gates and the
 * reporting; everything with a decision in it lives here.
 *
 * ── WHAT IS NEVER SENT TO THE MODEL, AND WHY ──
 * A catalog leaf is not a sentence. Some of them are a product name, a version,
 * a diagram edge that is one placeholder. Sending those buys nothing and can
 * lose something: "openplate" has come back from a translator as "Offener
 * Teller" before, and a value that is only `{{price}}` has nothing in it to
 * translate at all. `skipReason` answers with the reason, and `null` when the
 * leaf is prose:
 *
 *   'placeholder-only'  Strip every `{{placeholder}}` and every `<tag>`, and
 *                       nothing is left. There are no words to buy.
 *   'number'            What is left has no letter in it, in any script:
 *                       "2026", "16:8", "1.6 g/kg". A number is the same number
 *                       in every language this site ships.
 *   'proper-noun'       Every word of it is a term `KEEP` already tells the
 *                       model to leave in English: "openplate", "openplate-core",
 *                       "GitHub". One ordinary word anywhere in the value and it
 *                       is prose again, which is why "openplate app server" is
 *                       sent and "openplate-core" is not.
 *
 * A skipped leaf keeps whatever the target bundle already holds, and that is
 * almost always the English, which is what a reader should see for these.
 *
 * ── INTERPOLATION SAFETY ──
 * `{{price}}` is a value i18next substitutes and `<selfHosting>` is an element
 * `<Trans>` maps to a component. A translation that renames, drops or invents
 * one of those does not fail loudly: the placeholder renders as literal braces,
 * or the link disappears and takes its words with it, and the page still reads
 * as a page. `carriesTokens` compares the two SETS, because moving a link to the
 * other end of a German sentence is exactly what the tag is for, and losing it
 * is not.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type Memo, type Memory, type Unit, hash } from './translate-shims/docs-i18n.server.js';
import { type Usage, DASH, KEEP, MODEL, translate } from './translate.js';

/** A catalog as it exists on disk: a tree of names whose leaves are sentences. */
export interface CatalogTree {
  readonly [name: string]: string | CatalogTree;
}

/** One sentence of a catalog, under the dotted path i18next names it by. */
export interface Leaf {
  /** The dotted path, `pages.home.hero.body`. */
  key: string;
  /** The string at that path, in whichever language the tree was read from. */
  value: string;
}

/**
 * Every leaf of a catalog, depth first, in the file's own order.
 *
 * `instanceof Object` and not a `typeof` check: a JSON leaf is a string and a
 * JSON branch is a plain object, that is the whole taxonomy, and
 * `anti-slop/no-runtime-typeof` bans the other spelling anyway.
 */
export function leaves(tree: CatalogTree, prefix = ''): Leaf[] {
  return Object.entries(tree).flatMap(([name, child]) => {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    if (child instanceof Object) return leaves(child, key);
    return [{ key, value: child }];
  });
}

/** `{{price}}`, `<selfHosting>`, `</selfHosting>`: everything a translation must carry across untouched. */
const TOKEN = /\{\{[^}]+\}\}|<\/?[a-zA-Z][^>]*>/g;

/** The tokens of a string, sorted, because a translation may move one and may not lose one. */
export function tokens(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((match) => match[0]).toSorted((a, b) => (a < b ? -1 : 1));
}

/** Does a translation carry exactly the placeholders and tags its English did? */
export function carriesTokens(source: string, target: string): boolean {
  return tokens(source).join('\u0000') === tokens(target).join('\u0000');
}

/** Why a leaf is not worth a request, or `null` when it is prose and is sent. */
export type SkipReason = 'placeholder-only' | 'number' | 'proper-noun';

/** The terms the style prompt already pins to English, lower-cased once for the word test below. */
const PROPER = new Set(KEEP.map((term) => term.toLowerCase()));

/** A word with its surrounding punctuation taken off, so "openplate-core." is still "openplate-core". */
function word(raw: string): string {
  return raw.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
}

export function skipReason(value: string): SkipReason | null {
  const bare = value.replaceAll(TOKEN, ' ').trim();
  if (bare === '') return 'placeholder-only';
  if (!/\p{L}/u.test(bare)) return 'number';

  const words = bare.split(/\s+/).map(word).filter((candidate) => candidate !== '');
  if (words.length > 0 && words.every((candidate) => PROPER.has(candidate))) return 'proper-noun';
  return null;
}

/** An answer worth storing: the right tokens, and no dash the house style bans. */
export function usable(source: string, target: string): boolean {
  return target !== '' && carriesTokens(source, target) && !DASH.test(target);
}

// ── the catalogs on disk ─────────────────────────────────────────────────────

/** Where the hand-written bundles live, relative to the repository root. */
export const LOCALES = 'app/i18n/locales';

/**
 * The namespaces, read off the source language's directory rather than listed.
 *
 * A third namespace must not need an edit here to be translated, because this is
 * exactly the edit that would be forgotten, and what it ships is a body of
 * strings that is silently English in every language.
 */
export function namespacesOf(root: string, source: string): string[] {
  return readdirSync(resolve(root, LOCALES, source))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .toSorted((a, b) => (a < b ? -1 : 1));
}

export function catalogPath(root: string, locale: string, namespace: string): string {
  return resolve(root, LOCALES, locale, `${namespace}.json`);
}

/**
 * Which register a namespace's strings are bought in: `'legal'` for a
 * `legal` namespace, `'common'` for every other one.
 *
 * A NAMED, EXPORTED FUNCTION rather than an inline check, because this site's
 * own namespaces (`common`, `docs`) never touch the `legal` branch -- it has
 * no `legal.json` -- so nothing here proves the rule is right. The proof is
 * that the app repo, which vendors this library and does carry a
 * `legal.json`, can import this same function rather than restate it, so the
 * two copies cannot answer the one question that matters differently.
 */
export function bundleForNamespace(namespace: string): string {
  return namespace === 'legal' ? 'legal' : 'common';
}

export function readCatalog(file: string): CatalogTree {
  // SAFETY: a hand-written bundle, and the only thing claimed about it is the
  // one thing JSON guarantees, that a value is a string or a further object.
  // `leaves` branches on that with `instanceof` and never on the declared type,
  // and a file that is neither throws in `JSON.parse` rather than being trusted.
  return JSON.parse(readFileSync(file, 'utf8')) as CatalogTree;
}

/**
 * The English tree with each leaf replaced by the best answer there is for it.
 *
 * ── THE ENGLISH TREE IS THE ORDER, ALWAYS ──
 * Rebuilding from the source keeps every bundle in one key order, so a diff of a
 * translated file shows changed VALUES and nothing else. It is also what stops a
 * key that left the English bundle from surviving in the other two.
 *
 * ── THREE ANSWERS, IN THIS ORDER ──
 * The memory first, because that is what this run bought. Then whatever the
 * target bundle already holds, which is how a hand-written translation and a
 * skipped proper noun both survive a run that did not buy them. The English
 * last, so a brand new key renders its source rather than a blank.
 *
 * The memory is read by `unitKey(path, english)`, never by the English alone;
 * see "keyed by path and English" below for why.
 */
export function rebuildByPath(
  namespace: string,
  english: CatalogTree,
  memory: Map<string, string>,
  existing: CatalogTree,
): CatalogTree {
  const held = new Map(leaves(existing).map((leaf) => [leaf.key, leaf.value]));
  return rebuildTree(namespace, english, memory, held, '');
}

function rebuildTree(
  namespace: string,
  english: CatalogTree,
  memory: Map<string, string>,
  held: Map<string, string>,
  prefix: string,
): CatalogTree {
  const out: Record<string, string | CatalogTree> = {};
  for (const [name, child] of Object.entries(english)) {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    if (child instanceof Object) {
      out[name] = rebuildTree(namespace, child, memory, held, key);
      continue;
    }
    out[name] = memory.get(unitKey(pathOf(namespace, key), child)) ?? held.get(key) ?? child;
  }
  return out;
}

/**
 * The catalog, in the repository's own formatting, written only where it differs.
 *
 * Two spaces and a trailing newline is what every bundle in `app/i18n/locales`
 * already is, byte for byte, so a run that changes one sentence writes one line.
 */
export function saveCatalog(file: string, tree: CatalogTree, writable: boolean): 'unchanged' | 'written' | 'refused' {
  const next = `${JSON.stringify(tree, null, 2)}\n`;
  // COMPARED FIRST, and that order matters twice, exactly as it does in
  // `saveMemory`: a run with nothing to write has no business being refused
  // permission to write it, so a dry laptop run over an unchanged bundle ends
  // green rather than at an exit code.
  if (next === readFileSync(file, 'utf8')) return 'unchanged';
  if (!writable) return 'refused';
  writeFileSync(file, next, 'utf8');
  return 'written';
}

// ── what the CLI collects ────────────────────────────────────────────────────

/** One catalog leaf that is prose, ready to be looked up or bought. */
export interface UnitOfLeaf extends Unit {
  /** The full path it came from, `common:pages.home.hero.body`. Part of the memory key, see `unitKey`. */
  key: string;
}

/** One prose leaf of one namespace. `leaf` is the dotted key inside its own catalog, which is what the target catalog is read by. */
export interface CatalogUnit extends UnitOfLeaf {
  leaf: string;
}

/**
 * ── KEYED BY PATH AND ENGLISH, NOT BY ENGLISH ALONE ──
 * This memory used to be keyed by `hash(english)`, the bargain the docs pipeline
 * makes: two keys carrying one English sentence were one unit, bought once. On a
 * catalog that is right until it is not, and the app's catalog showed when: 2130
 * strings, and 26 of them changed value when a rebuild put one entry's answer
 * under every key with that English. `nav.fasting` ("Fasten") became "Fasten
 * läuft", the eyebrow of the active-fast card; `scan.capture.takePhoto` became
 * the landing headline. Those are not splits to unify. They are one English word
 * doing two jobs, and German has two words for them. This site's own catalog
 * carries eleven such pairs today ("App", "Docs", "Privacy", "Documentation" as
 * a nav label and as a page title) and every one of them happened to agree, so
 * the defect had nowhere to show; the app's did not, and the same code path ran.
 *
 * So the key is `hash(path + english)`, the app's keying, brought back into the
 * library the app vendors. A key keeps its own translation, an English edit still
 * invalidates exactly that one key, and the price is that an English sentence
 * written under two paths is bought twice, which at a hundred strings is cents.
 * `path` is written into every memo beside the English, because a person greps
 * the memory by what they can read and a hash is not that.
 */

/** `common:nav.docs`: the namespace and the dotted path, which together name one leaf. */
export function pathOf(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

/**
 * The key one leaf is remembered under. The newline is the separator because it
 * cannot occur in a path, and a leaf that carried one would be two lines of
 * JSON, not a catalog string.
 */
export function unitKey(path: string, source: string): string {
  return hash(`${path}\n${source}`);
}

/** Every leaf of one namespace that is prose, keyed for the memory. */
export function collectByPath(namespace: string, tree: CatalogTree): CatalogUnit[] {
  return leaves(tree)
    .filter((leaf) => skipReason(leaf.value) === null)
    .map((leaf) => {
      const path = pathOf(namespace, leaf.key);
      return { hash: unitKey(path, leaf.value), source: leaf.value, key: path, leaf: leaf.key };
    });
}

/** One remembered leaf. `path` is what a person greps for; the memory is keyed by its hash with the English. */
export function memoAt(entry: { unit: UnitOfLeaf; target: string; locale: string; at: string; model?: string }): Memo {
  const { unit, target, locale, at, model = MODEL } = entry;
  return { en: unit.source, path: unit.key, model, at, [locale]: target };
}

/**
 * An entry written under the old keying, `hash(english)` with no `path`, as
 * `rekeyByPath` finds it and as nothing else should ever see it again.
 */
export function isKeyedByEnglish(entry: Memo): boolean {
  return entry.path === undefined;
}

/**
 * The memory as it stands, moved from `hash(english)` to `hash(path + english)`,
 * without losing one translation.
 *
 * ── THE BUNDLE IS THE VALUE, THE OLD ENTRY IS THE PROVENANCE ──
 * The old memory was keyed by English alone, so a leaf whose English is written
 * under two paths had one entry, and which path's translation it held was
 * decided by directory order. The target bundle on disk is the one record that
 * has a value PER PATH, and it is what a reader has been seeing, so every new
 * entry takes the bundle's value at its own path. The old entry contributes the
 * `model` and `at` where its answer is the same string, which is what keeps
 * `hand-written` on the strings a person wrote; a bundle value the old memory
 * did not have is a hand edit that the old keying would have undone on the next
 * run, and it is recorded as `hand-written` today rather than lost.
 *
 * Entries written under the old keying are DROPPED from the result, because a
 * memory holding both keyings answers nothing twice and grows forever. An entry
 * that already carries a `path` is kept as it is.
 */
export function rekeyByPath(
  memory: Memory,
  locale: string,
  catalogs: { namespace: string; english: CatalogTree; target: CatalogTree }[],
  today: string,
): Memory {
  const out: Memory = {};
  for (const [key, entry] of Object.entries(memory)) {
    if (!isKeyedByEnglish(entry)) out[key] = entry;
  }
  for (const { namespace, english, target } of catalogs) {
    const held = new Map(leaves(target).map((leaf) => [leaf.key, leaf.value]));
    for (const unit of collectByPath(namespace, english)) {
      if (out[unit.hash] !== undefined) continue;
      const value = held.get(unit.leaf);
      if (value === undefined || value === '') continue;
      const old = memory[hash(unit.source)];
      const inherited = old !== undefined && old[locale] === value;
      out[unit.hash] = memoAt({
        unit,
        target: value,
        locale,
        at: inherited ? old.at : today,
        model: inherited ? old.model : 'hand-written',
      });
    }
  }
  return out;
}

// ── what the CLI buys ────────────────────────────────────────────────────────

/** The shape of `translate`: the seam a test replaces to prove a call count and a bundle argument without spending money. */
export type TranslateFn = (
  units: Unit[],
  locale: string,
  bundle: string,
  key: string,
  total: Usage,
  notes?: readonly string[],
) => Promise<string[] | undefined>;

/**
 * One answer, sorted: a usable string is recorded in `store`, the rest is
 * handed back to the caller to retry.
 *
 * ── REJECTION IS PER STRING, NOT PER BATCH ──
 * `fill` in the docs pipeline rejects the whole chunk on one bad answer and then
 * bisects, which is right for thirty sentences of a paragraph where one awkward
 * one spoils its neighbours. A catalog is thirty unrelated labels: one dropped
 * `{{price}}` says nothing about the twenty-nine beside it, and discarding them
 * would pay for them twice. So the good answers are stored here, the rejected
 * ones are asked for again on their own by the caller's retry, and whatever is
 * still wrong after that is LEFT OUT of the memory. i18next answers a missing
 * key from the English bundle, so the page shows an English label rather than
 * braces, and the next run picks it up again for free.
 */
export function sortAnswer(pending: UnitOfLeaf[], text: string[] | undefined, store: Map<string, string>): UnitOfLeaf[] {
  // The whole answer was unusable, short or unparseable. `translate` has
  // already reported why; the caller's retry is the same request again.
  if (text === undefined) return pending;
  const rejected: UnitOfLeaf[] = [];
  pending.forEach((unit, index) => {
    const target = text[index] ?? '';
    if (usable(unit.source, target)) store.set(unit.hash, target);
    else rejected.push(unit);
  });
  if (rejected.length > 0) {
    console.warn(`\n  rejected ${rejected.length}: ${rejected.map((unit) => unit.key).join(', ')}`);
  }
  return rejected;
}

/**
 * One batch, bought under one bundle: two attempts, then whatever is still
 * wrong is left in English.
 *
 * ONE FUNCTION for every bundle -- `common`, `legal`, or a third one the app
 * repo's copy adds -- because `bundle` is an argument that travels with the
 * batch as data, not the name of a function that happened to be called for
 * it. `translateFn` is the injectable seam behind the network call: it
 * defaults to the real `translate`, and a test passes a stub and reads its
 * call log instead of spending money. See "one translate call per bundle"
 * in `tests/unit/translate-ui.test.ts`.
 */
export async function buy(
  batch: UnitOfLeaf[],
  bundle: string,
  key: string,
  locale: string,
  done: Map<string, string>,
  total: Usage,
  notes: readonly string[] = [],
  translateFn: TranslateFn = translate,
): Promise<void> {
  let pending = batch;
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
    pending = sortAnswer(pending, await translateFn(pending, locale, bundle, key, total, notes), done);
  }
  for (const unit of pending) console.warn(`  left in English: ${unit.key}  ${unit.source.slice(0, 70)}`);
}
