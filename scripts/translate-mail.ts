/**
 * translate-mail, buy the invite and reset letters in one language and write its module.
 *
 * The service's entry over the translator this workspace already runs for its website and its
 * app. The library under `scripts/lib/translate*.ts` is a vendored copy of `openplate-website`'s
 * (see `scripts/sync-translate-lib.ts` and `scripts/lib/TRANSLATE_SOURCE.json`); this file and
 * `scripts/lib/translate-mail.ts` name what differs: the source is `MAIL_STRINGS.en` in
 * `src/mail/strings.ts`, the memory is `src/mail/memory/<lang>.json`, and the output is not a JSON
 * catalog but a TypeScript module, `src/mail/strings.<lang>.ts`, that `strings.ts` imports so the
 * compiler checks it with the hand-written two.
 *
 *   pnpm translate:mail --locale fr --dry              # count and price the misses, spend nothing
 *   pnpm translate:mail --locale fr --local            # buy them, from a laptop
 *   pnpm translate:mail --locale fr --local --budget 0.02
 *
 * ── A LOCAL TOOL, NOT A BOT ──
 * The website and the app run their translators from a workflow on a schedule. There are about
 * forty strings here and they change when a letter is reworded, which is rarely; a person buys
 * them at a keyboard and commits the module, and this repo's pre-push hook is the gate. The key
 * is `OPENROUTER_API_KEY` in the environment, read here and nowhere else in this repo.
 *
 * ── EXIT CODES ──
 *   0  done, or nothing to do
 *   1  broken: no key, no rate, a memory it may not write, a string that lost its placeholder,
 *      a banned dash, or a string the model would not answer (no module is written then)
 *   2  refused on cost. Nothing was sent, or what was sent is saved and the rest is not coming.
 *
 * ── THE MEMORY IS THE RECORD, AND THE MODULE IS ITS OUTPUT ──
 * The module is rebuilt from the English and the memory on every run, memory first. A French
 * sentence changed by hand in `strings.fr.ts` is put back by the next run. Change it in
 * `src/mail/memory/fr.json` (find the entry by its `path` field), or delete that entry to have
 * the string bought again. `src/mail/memory/README.md` says the same thing next to the file.
 *
 * ── A NEW LANGUAGE ──
 * Add it to `InstanceLanguage` and `INSTANCE_LANGUAGES` in `src/protocol.ts`, and to
 * `MAIL_STRINGS` in `strings.ts` with an import of the module this script will write. That
 * import must resolve before this script can load the English, so seed the module first by
 * copying any generated one (`cp src/mail/strings.fr.ts src/mail/strings.xx.ts`), then run this
 * for `xx` and the copy is overwritten with the bought strings.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MAIL_STRINGS } from '../src/mail/strings.js';
import { INSTANCE_LANGUAGES, type InstanceLanguage, isInstanceLanguage } from '../src/protocol.js';
import { type Memory } from './lib/translate-shims/docs-i18n.server.js';
import {
  CHUNK,
  MODEL,
  type Usage,
  chunk,
  dashOffenders,
  loadMemory,
  lookup,
  price,
  read,
  saveMemory,
} from './lib/translate.js';
import {
  GENERATED_LANGUAGES,
  HAND_WRITTEN_LANGUAGES,
  SOURCE_LANGUAGE,
  memoryFile,
  moduleFile,
  placeholderOffenders,
  renderModule,
  unitsOf,
} from './lib/translate-mail.js';
import { buy, memoAt } from './lib/translate-ui.js';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

const ROOT = resolve(import.meta.dirname, '..');
const LOCALE = flag('locale');
const DRY = args.includes('--dry') || args.includes('--dry-run');
/**
 * The spend ceiling for ONE RUN. Forty strings from nothing is under a cent; a run that wants more
 * than this is a reworded dictionary or a new language, which is the moment to look before paying.
 */
const BUDGET = Number(flag('budget') ?? '0.02');
/** The exit code for "the run was refused on cost", distinct from "the run broke". */
const OVER_BUDGET = 2;
/** The one-writer rule the website and the app keep: a run outside CI says so with `--local`. */
const WRITABLE = process.env.CI !== undefined || process.env.GITHUB_ACTIONS !== undefined || args.includes('--local');

/**
 * What the letters need said that the library's documentation prompt does not.
 *
 * The vendored `style()` describes a technical guide read by a self-hoster. These are two short
 * letters to a person who was invited to a food diary or asked for a new password, and the
 * hand-written German says "du" to them. The register is the `common` bundle's (informal), and
 * these lines put the reader, the placeholder and the one rule the letters are tested for in front
 * of the model, because `tests/unit/mail-messages.test.ts` bans every word that names a service.
 */
const NOTES = [
  'These strings are not documentation. They are two short emails, an invitation and a password',
  'reset, and one notice, written to a person who was invited to a food diary or asked for a new',
  'password. Write to that reader: plain, warm, one instruction or fact per sentence. Address the',
  'reader informally (the German original says "du").',
  'A {date} placeholder, with single braces, is a date the application fills in. Keep it exactly',
  'as written, in English, inside single braces, and put it where the target grammar wants a date.',
  'Do not add the name of any product, service, server, gateway, connection or link that the',
  'English does not name. "openplate" is the only product name and stays as written.',
];

if (LOCALE === undefined || !isInstanceLanguage(LOCALE)) {
  console.error(`translate-mail: --locale must be one of ${INSTANCE_LANGUAGES.join(', ')}.`);
  process.exit(1);
}
if (HAND_WRITTEN_LANGUAGES.includes(LOCALE)) {
  console.error(
    `translate-mail: ${LOCALE} is hand-written in src/mail/strings.ts and is not bought. ` +
      `The generated languages are ${GENERATED_LANGUAGES.join(', ')}.`,
  );
  process.exit(1);
}
/** The locale, typed, for the hoisted functions below that the guard's narrowing does not reach. */
const LANGUAGE: InstanceLanguage = LOCALE;

const FILE = resolve(ROOT, memoryFile(LANGUAGE));
const MODULE = resolve(ROOT, moduleFile(LANGUAGE));

const units = unitsOf(MAIL_STRINGS[SOURCE_LANGUAGE]);
const memory: Memory = loadMemory(FILE);
const done = lookup(memory, LANGUAGE);
const misses = units.filter((unit) => !done.has(unit.hash));
const words = misses.reduce((sum, unit) => sum + unit.source.split(/\s+/).length, 0);

console.log(
  `translate-mail: ${LANGUAGE}, ${units.length} strings, ${done.size} in memory, ${misses.length} misses (~${words} words).`,
);

const quote = await price(misses);
if (quote === null) {
  console.error(`translate-mail: could not read ${MODEL}'s rate. An unpriced run is an unbounded one.`);
  process.exit(1);
}
if (quote.requests > 0) {
  console.log(
    `translate-mail: ${quote.requests} requests, ~${quote.promptTokens} prompt tokens, ` +
      `~${quote.completionTokens} completion tokens, estimated ${quote.cost.toFixed(4)} USD.`,
  );
} else {
  console.log('translate-mail: nothing to translate, 0.0000 USD.');
}

if (DRY) {
  for (const unit of misses) console.log(`  miss  ${unit.key}  ${unit.source.slice(0, 80)}`);
  console.log('translate-mail: dry run, nothing was sent and nothing was written.');
  process.exit(0);
}

const total: Usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };
let refused = false;

if (misses.length > 0) {
  // EVERY REFUSAL COMES BEFORE THE FIRST REQUEST. Reaching one later means the run already paid
  // for strings it is about to throw away.
  if (!WRITABLE) {
    console.error('translate-mail: there is work to buy, but the memory is not writable here.');
    console.error('  Pass --local to say this laptop is the writer today.');
    process.exit(1);
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (key === undefined || key === '') {
    console.error('translate-mail: OPENROUTER_API_KEY is not set.');
    process.exit(1);
  }
  if (quote.cost > BUDGET) {
    console.error(
      `translate-mail: ${quote.cost.toFixed(4)} USD is over the ${BUDGET.toFixed(2)} USD budget. Nothing was sent.`,
    );
    console.error(`  Re-run with --budget ${(Math.ceil(quote.cost * 100) / 100).toFixed(2)} to approve it.`);
    process.exit(OVER_BUDGET);
  }

  const batches = chunk(misses, CHUNK);
  for (const [index, batch] of batches.entries()) {
    const before = total.cost;
    await buy(batch, 'common', key, LANGUAGE, done, total, NOTES);
    console.log(
      `  ${LANGUAGE} ${index + 1}/${batches.length} (${batch.length} strings) ... ${(total.cost - before).toFixed(6)} USD  ` +
        `(running ${total.cost.toFixed(4)} USD)`,
    );
    // WRITTEN AFTER EVERY CHUNK. A stall or a Ctrl-C must not throw away the strings already bought.
    save();
    // THE SECOND CEILING, against money actually spent rather than money predicted.
    if (total.cost <= BUDGET) continue;
    console.error(
      `translate-mail: spent ${total.cost.toFixed(4)} USD against a ${BUDGET.toFixed(2)} USD budget. ` +
        'Stopping. What was bought is saved.',
    );
    refused = true;
    break;
  }
  console.log(
    `translate-mail: ${total.prompt_tokens} prompt tokens, ${total.completion_tokens} completion tokens, ` +
      `${total.cost.toFixed(4)} USD total.`,
  );
}

// THE PLACEHOLDER PASS, over every string the memory answers and not only what was bought: the
// library's own check knows `{{name}}` and would let a `{date}` go. An offender is dropped from
// the memory so the next run buys it again, and this run writes no module.
const lost = placeholderOffenders(units, done);
for (const offender of lost) {
  console.error(`translate-mail: ${offender.path} lost a placeholder: "${offender.target}"`);
  done.delete(unitKeyOf(offender.path));
  delete memory[unitKeyOf(offender.path)];
}
save();

// THE DASH PASS, over the whole memory: a hand edit, a model swap. It names the hash, because the
// hash is what you delete from the file to buy the string again.
const dashes = dashOffenders(memory, LANGUAGE);
if (dashes.length > 0) {
  console.error(`translate-mail: ${dashes.length} translations carry a banned dash. Delete these hashes and re-run:`);
  for (const hash of dashes) console.error(`  ${hash}  ${memory[hash]?.[LANGUAGE]?.slice(0, 90) ?? ''}`);
  process.exit(1);
}

if (lost.length > 0) {
  console.error(
    `translate-mail: ${lost.length} strings were dropped for a lost placeholder. Re-run to buy them again.`,
  );
  process.exit(1);
}

write();
if (refused) process.exit(OVER_BUDGET);

/** The memory key of one unit, by its path: what `placeholderOffenders` reports and `done` is keyed by. */
function unitKeyOf(path: string): string {
  const unit = units.find((candidate) => candidate.key === path);
  if (unit === undefined) throw new Error(`translate-mail: no unit at ${path}`);
  return unit.hash;
}

/** The memory as it stands: what was on disk, plus what this run bought. */
function save(): void {
  const today = new Date().toISOString().slice(0, 10);
  for (const unit of units) {
    const target = done.get(unit.hash);
    if (target === undefined || memory[unit.hash] !== undefined) continue;
    memory[unit.hash] = memoAt({ unit, target, locale: LANGUAGE, at: today });
  }
  mkdirSync(resolve(ROOT, 'src/mail/memory'), { recursive: true });
  if (saveMemory(FILE, memory, WRITABLE) !== 'refused') return;
  console.error('translate-mail: refusing to write the memory outside CI. Pass --local to override.');
  process.exit(1);
}

/**
 * The module, rebuilt from the English and the memory, written only where it differs. A string
 * the memory cannot answer throws inside `renderModule`, and that is the run's exit: no module
 * with an English paragraph in it is ever written.
 */
function write(): void {
  const today = new Date().toISOString().slice(0, 10);
  const models = [...new Set(units.map((unit) => memory[unit.hash]?.model).filter((model) => model !== undefined))];
  let next: string;
  try {
    next = renderModule({
      english: MAIL_STRINGS[SOURCE_LANGUAGE],
      memory: done,
      provenance: { language: LANGUAGE, models, at: dateOf(MODULE) ?? today },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const current = read(MODULE);
  // COMPARED WITH THE DATE HELD, so a run that buys nothing rewrites nothing: the header's date
  // is the day the strings last changed, not the day somebody last ran the script.
  if (current === next) {
    console.log(`translate-mail: ${moduleFile(LANGUAGE)} unchanged.`);
    return;
  }
  const fresh = renderModule({
    english: MAIL_STRINGS[SOURCE_LANGUAGE],
    memory: done,
    provenance: { language: LANGUAGE, models, at: today },
  });
  if (!WRITABLE) {
    console.error('translate-mail: refusing to write the module outside CI. Pass --local to override.');
    process.exit(1);
  }
  writeFileSync(MODULE, fresh, 'utf8');
  console.log(`translate-mail: ${moduleFile(LANGUAGE)} written, ${units.length}/${units.length} strings translated.`);
}

/** The date a generated module's header carries, or `null` when there is no module yet. */
function dateOf(file: string): string | null {
  const text = read(file);
  if (text === null) return null;
  return /--locale \w+` on (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
}
