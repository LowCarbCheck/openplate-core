/**
 * sync-translate-lib, copy the translator out of `openplate-website` into `scripts/lib/`.
 *
 * A DEVELOPER TOOL, run by hand, whose output is COMMITTED.
 *
 *   pnpm sync:translate-lib                                        # the sibling checkout, ../openplate-website
 *   OPENPLATE_WEBSITE_REPO=/some/checkout pnpm sync:translate-lib  # any checkout
 *
 * ── ONE TRANSLATOR, THREE REPOSITORIES ──
 * The website's `scripts/lib/translate.ts` is the client that buys this workspace's translations:
 * the model, the style contract, the glossary, the dash gate, the budget and the memory format all
 * live there. The app vendored it in M229 (`openplate/scripts/sync-translate-lib.ts`), and this
 * service's two letters want the same treatment for the four languages nobody hand-wrote (M230
 * spec 03). The choice is the app's, taken as it stands: a VENDORED COPY WITH PROVENANCE. The
 * files here are byte copies, this script is the only thing that writes them, and
 * `tests/unit/translate-lib-provenance.test.ts` re-hashes them against
 * `scripts/lib/TRANSLATE_SOURCE.json` on every push. A hand edit to a vendored file is a red
 * test, which is what keeps "a copy" from turning into "a fork" one convenient fix at a time. Fix
 * it in the website, then sync.
 *
 * ── THE REWRITES ARE PART OF THE RECORD ──
 * The copy is not quite byte-identical, because the website's files import from the website's
 * tree. Every import specifier that has to change is listed in `REWRITES` below, applied
 * mechanically, and written into the provenance next to the hash of the file BEFORE the rewrite
 * and the hash AFTER it. An import this table does not know is a hard failure, not a guess: a new
 * upstream dependency is a decision for a person, because the answer may be "shim it" or may be
 * "that module is not portable, cut the library upstream first".
 *
 * ── WHAT IS SHIMMED, AND WHY THE SHIMS' UPSTREAM IS HASHED TOO ──
 * The translator imports the website's documentation tree (`app/lib/docs.ts`) and the module that
 * hashes and rebuilds it (`app/lib/docs-i18n.server.ts`). Those two are the documentation corpus,
 * which this service does not have, and the second one imports committed translation memories the
 * size of the corpus. They are not copied. `scripts/lib/translate-shims/` declares the names the
 * copy refers to, with real code where the mail path needs it (`hash`, `fits`, the memory types)
 * and a throw where only the docs path would ever arrive. The upstream hash of each shimmed module
 * is recorded under `shimmed`, so a change to the real file is a changed line in the provenance at
 * the next sync, and the person syncing re-reads the shim against it rather than trusting it blind.
 *
 * ── WHAT THE APP COPIES AND THIS DOES NOT ──
 * The app also vendors `scripts/merge-memory.ts`, the memory union its translation bot needs when
 * its commit races a moved `main`. There is no bot here: forty strings that change once a year are
 * bought by a person at a keyboard (`pnpm translate:mail`), and this repo's pre-push hook is the
 * gate. Nothing merges, so nothing is copied for it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const ENV_REPO = 'OPENPLATE_WEBSITE_REPO';
const ROOT = resolve(import.meta.dirname, '..');
const WEBSITE = resolve(process.env[ENV_REPO] ?? resolve(ROOT, '../openplate-website'));
const PROVENANCE = 'scripts/lib/TRANSLATE_SOURCE.json';
const REPO = 'LowCarbCheck/openplate-website';

/** One vendored file: where it is in the website, and where the copy lands here. Both repo-relative. */
interface Copy {
  from: string;
  to: string;
}

const COPIES: Copy[] = [
  { from: 'scripts/lib/translate.ts', to: 'scripts/lib/translate.ts' },
  { from: 'scripts/lib/translate-ui.ts', to: 'scripts/lib/translate-ui.ts' },
  // The website's language model, because the glossary's `say` column is keyed by ITS translated
  // languages and the copy would not compile against this service's list. The service's own
  // languages are gated in `scripts/translate-mail.ts` before the library sees a locale.
  { from: 'app/i18n/language.ts', to: 'scripts/lib/translate-language.ts' },
];

/**
 * One import specifier the copy may not keep, and what it becomes. `from` is the specifier exactly
 * as the upstream file spells it; `to` is relative to `scripts/lib/`, where every copy lands.
 */
interface Rewrite {
  from: string;
  to: string;
}

const REWRITES: Rewrite[] = [
  { from: '../../app/i18n/language', to: './translate-language.js' },
  { from: '../../app/lib/docs-i18n.server', to: './translate-shims/docs-i18n.server.js' },
  { from: '../../app/lib/docs', to: './translate-shims/docs.js' },
];

/**
 * The extension every relative import gets on the way in.
 *
 * The website resolves modules the bundler way and writes `'./translate'`; this repo is
 * `moduleResolution: NodeNext`, which refuses a relative specifier with no extension, and `tsx`
 * maps `./translate.js` back to the `.ts` beside it. So a sibling import is re-pointed AND given
 * this suffix, every `REWRITES` target above carries it already, and the provenance records it
 * so the test can assert the rule rather than guess at it. The app repo does not need this:
 * its tsconfig resolves the bundler way too.
 */
const SIBLING_EXTENSION = '.js';

/** The upstream modules the shims stand in for. Hashed, never copied. */
const SHIMMED = ['app/lib/docs-i18n.server.ts', 'app/lib/docs.ts'];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', WEBSITE, ...args], { encoding: 'utf8' }).trim();
}

/**
 * The sha recorded is only a fact if the files copied are the files at that sha. A checkout with
 * one of them modified would write a commit id that does not describe the bytes, which is the one
 * thing a provenance file must never do. Refused, not warned about.
 */
function refuseDirty(): void {
  const watched = [...COPIES.map((copy) => copy.from), ...SHIMMED];
  const dirty = git(['status', '--porcelain', '--', ...watched]);
  if (dirty === '') return;
  throw new Error(`sync-translate-lib: ${WEBSITE} has uncommitted changes in a file this sync copies:\n${dirty}`);
}

/** A line that imports something: `import x from '...'`, `} from '...'`, `export { x } from '...'`. */
const IMPORT_LINE = /^(\s*(?:import\b[^']*|\}|export\s*\{[^}]*\})\s+from\s+')([^']+)(';?)$/;

/**
 * The file with every import pointed at where the thing now is.
 *
 * Three kinds of specifier, and a fourth that stops the run: a `node:` builtin stays; a specifier
 * in `REWRITES` becomes its replacement; a relative import of ANOTHER COPIED FILE is re-pointed at
 * that file's new home with `SIBLING_EXTENSION` on it; anything else is an import this table has
 * never seen, and the copy would not compile, so the sync says which line and exits rather than
 * write it.
 */
function rewriteImports(copy: Copy, text: string): string {
  const fromDir = dirname(resolve(WEBSITE, copy.from));
  const toDir = dirname(resolve(ROOT, copy.to));
  return text
    .split('\n')
    .map((line, index) => {
      const match = IMPORT_LINE.exec(line);
      if (match === null) return line;
      const [, head, specifier, tail] = match;
      if (specifier === undefined || head === undefined || tail === undefined) return line;
      if (specifier.startsWith('node:')) return line;
      const rewrite = REWRITES.find((entry) => entry.from === specifier);
      if (rewrite !== undefined) return `${head}${rewrite.to}${tail}`;
      const sibling = COPIES.find((entry) => resolve(WEBSITE, entry.from) === `${resolve(fromDir, specifier)}.ts`);
      if (sibling !== undefined) return `${head}${dotted(relative(toDir, resolve(ROOT, sibling.to)))}${tail}`;
      throw new Error(
        `sync-translate-lib: ${copy.from}:${index + 1} imports '${specifier}', which REWRITES does not know. ` +
          'Decide whether it is shimmed, copied or cut upstream, then add it to the table.',
      );
    })
    .join('\n');
}

/** `translate.ts` as `./translate.js`: a relative specifier with a leading dot on and the extension NodeNext wants. */
function dotted(path: string): string {
  const bare = path.replace(/\.ts$/, '');
  return `${bare.startsWith('.') ? bare : `./${bare}`}${SIBLING_EXTENSION}`;
}

interface VendoredFile {
  from: string;
  upstream: string;
  vendored: string;
}

refuseDirty();
const commit = git(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`sync-translate-lib: ${WEBSITE} is not a git checkout`);

function vendor(copy: Copy): VendoredFile {
  const source = readFileSync(resolve(WEBSITE, copy.from), 'utf8');
  const rewritten = rewriteImports(copy, source);
  mkdirSync(dirname(resolve(ROOT, copy.to)), { recursive: true });
  writeFileSync(resolve(ROOT, copy.to), rewritten, 'utf8');
  console.log(`sync-translate-lib: ${copy.from} -> ${copy.to}${rewritten === source ? '' : ' (imports rewritten)'}`);
  return { from: copy.from, upstream: sha256(source), vendored: sha256(rewritten) };
}

const provenance = {
  repo: REPO,
  commit,
  producedBy: 'openplate-core, scripts/sync-translate-lib.ts',
  rewrites: REWRITES,
  siblingExtension: SIBLING_EXTENSION,
  files: Object.fromEntries(COPIES.map((copy) => [copy.to, vendor(copy)])),
  shimmed: Object.fromEntries(SHIMMED.map((path) => [path, sha256(readFileSync(resolve(WEBSITE, path), 'utf8'))])),
};
writeFileSync(resolve(ROOT, PROVENANCE), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
console.log(`sync-translate-lib: ${PROVENANCE} records ${REPO}@${commit.slice(0, 12)}.`);
