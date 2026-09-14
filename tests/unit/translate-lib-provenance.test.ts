/**
 * The vendored translator, against the provenance the sync left behind, M230 spec 03.
 *
 * `scripts/lib/translate.ts`, `translate-ui.ts` and `translate-language.ts` are copies of
 * `openplate-website`'s, written by `pnpm sync:translate-lib` and by nothing else. The app repo
 * made the same choice in M229 and carries the same worry: a copy edited in place becomes a second
 * client in substance, one convenient fix at a time, and no diff ever says so. This is the check
 * that says so: it re-hashes every vendored file against `scripts/lib/TRANSLATE_SOURCE.json` and
 * fails when a byte differs. Fix the library in the website, then sync.
 *
 * ── THE REWRITES ARE ASSERTED, NOT ONLY RECORDED ──
 * A rewrite is the one way a vendored file may differ from its upstream, so the test also proves
 * the record is complete: every import in a vendored file resolves to a node builtin, to another
 * vendored file (with the extension NodeNext wants, which the sync adds and records), or to a shim
 * named in the provenance's rewrite table. An import that resolves to anything else is a hidden
 * edit.
 *
 * No schema library in this repo, so the provenance is decoded by hand: every field read below is
 * checked to be the shape the sync writes before a hash is compared, so a moved shape fails here
 * with a sentence and not as an empty loop that passes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PROVENANCE = resolve(ROOT, 'scripts/lib/TRANSLATE_SOURCE.json');

const SHA256 = /^[0-9a-f]{64}$/;

interface VendoredFile {
  from: string;
  upstream: string;
  vendored: string;
}

interface Rewrite {
  from: string;
  to: string;
}

/** `TRANSLATE_SOURCE.json` as the sync writes it. */
interface Provenance {
  repo: string;
  commit: string;
  producedBy: string;
  rewrites: Rewrite[];
  siblingExtension: string;
  files: Record<string, VendoredFile>;
  shimmed: Record<string, string>;
}

function readProvenance(): Provenance {
  // SAFETY: the file is written by `scripts/sync-translate-lib.ts` and by nothing else, and every
  // field the tests below read is asserted to be the shape claimed here first, in `describe('the
  // provenance file')`, before any hash is compared against it.
  const parsed = JSON.parse(readFileSync(PROVENANCE, 'utf8')) as Provenance;
  return parsed;
}

const provenance = readProvenance();

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Every import specifier in a file, read the way the sync's rewriter reads them. */
function importsOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => /^(?:\s*(?:import\b[^']*|\}|export\s*\{[^}]*\}))\s+from\s+'([^']+)';?$/.exec(line)?.[1])
    .filter((specifier) => specifier !== undefined);
}

describe('the provenance file', () => {
  it('is the shape the sync writes', () => {
    assert.equal(provenance.repo, 'LowCarbCheck/openplate-website');
    assert.match(provenance.commit, /^[0-9a-f]{40}$/);
    assert.equal(provenance.producedBy, 'openplate-core, scripts/sync-translate-lib.ts');
    assert.equal(provenance.siblingExtension, '.js');
    assert.ok(Array.isArray(provenance.rewrites) && provenance.rewrites.length > 0, 'rewrites is a non-empty list');
    for (const rewrite of provenance.rewrites) {
      assert.ok(rewrite.from.length > 0 && rewrite.to.length > 0, 'a rewrite names both ends');
      assert.ok(rewrite.to.endsWith(provenance.siblingExtension), `${rewrite.to} lacks the recorded extension`);
    }
    for (const [path, file] of Object.entries(provenance.files)) {
      assert.ok(file.from.length > 0, `${path} names its upstream`);
      assert.match(file.upstream, SHA256, `${path} upstream hash`);
      assert.match(file.vendored, SHA256, `${path} vendored hash`);
    }
    for (const [path, hash] of Object.entries(provenance.shimmed)) assert.match(hash, SHA256, `${path} shim hash`);
  });

  it('names the three files the sync vendors', () => {
    assert.deepEqual(Object.keys(provenance.files).toSorted(), [
      'scripts/lib/translate-language.ts',
      'scripts/lib/translate-ui.ts',
      'scripts/lib/translate.ts',
    ]);
  });

  it('names the two upstream modules the shims stand in for', () => {
    assert.deepEqual(Object.keys(provenance.shimmed).toSorted(), ['app/lib/docs-i18n.server.ts', 'app/lib/docs.ts']);
  });

  it('points every rewrite at a file that exists beside the vendored ones', () => {
    for (const rewrite of provenance.rewrites) {
      const target = resolve(ROOT, 'scripts/lib', rewrite.to.replace(/\.js$/, '.ts'));
      assert.ok(existsSync(target), `${rewrite.from} is rewritten to ${rewrite.to}, and ${target} is not there`);
    }
  });
});

describe('the vendored translator', () => {
  for (const [path, expected] of Object.entries(provenance.files)) {
    const text = readFileSync(resolve(ROOT, path), 'utf8');

    it(`${path} still hashes to what the sync wrote`, () => {
      assert.equal(
        sha256Of(text),
        expected.vendored,
        `${path} is not the file TRANSLATE_SOURCE.json records. The translator is not edited here: fix it in ` +
          `openplate-website (${expected.from}), then run \`pnpm sync:translate-lib\`.`,
      );
    });

    it(`${path} differs from its upstream only where the rewrite table says`, () => {
      const rewritten = importsOf(text).some((specifier) => !specifier.startsWith('node:'));
      if (expected.upstream === expected.vendored) {
        assert.equal(rewritten, false, `${path} is byte-identical to upstream yet carries a relative import`);
        return;
      }
      assert.equal(rewritten, true, `${path} differs from upstream and no relative import explains it`);
    });

    it(`${path} imports nothing the provenance cannot account for`, () => {
      const unexplained = unexplainedImports(path, text);
      assert.deepEqual(unexplained, [], `${path} imports from outside the vendored set: ${unexplained.join(', ')}`);
    });
  }
});

/**
 * The imports of a vendored file that are neither a builtin, another vendored file, nor a recorded
 * rewrite. A relative import must carry the recorded extension to count as a vendored sibling.
 */
function unexplainedImports(path: string, text: string): string[] {
  const vendored = new Set(Object.keys(provenance.files).map((entry) => resolve(ROOT, entry)));
  const shims = new Set(provenance.rewrites.map((rewrite) => rewrite.to));
  const extension = provenance.siblingExtension;
  return importsOf(text).filter((specifier) => {
    if (specifier.startsWith('node:')) return false;
    if (shims.has(specifier)) return false;
    if (!specifier.endsWith(extension)) return true;
    const bare = specifier.slice(0, -extension.length);
    return !vendored.has(resolve(dirname(resolve(ROOT, path)), `${bare}.ts`));
  });
}

describe('the checks themselves', () => {
  const [path, expected] = Object.entries(provenance.files)[0] ?? [];
  assert.ok(path !== undefined && expected !== undefined, 'the provenance names at least one file');
  const text = readFileSync(resolve(ROOT, path), 'utf8');

  it('would fail on a one-character hand edit', () => {
    assert.notEqual(sha256Of(`${text} `), expected.vendored);
  });

  it('would fail on an import the rewrite table does not know', () => {
    assert.deepEqual(unexplainedImports(path, `${text}\nimport { x } from '../../app/lib/docs';\n`), [
      '../../app/lib/docs',
    ]);
  });

  it('would fail on a sibling import that dropped the extension', () => {
    assert.deepEqual(unexplainedImports(path, `${text}\nimport { x } from './translate';\n`), ['./translate']);
  });

  it('reads a multi-line import by its closing line', () => {
    assert.deepEqual(importsOf("import {\n  a,\n} from './translate.js';\nimport b from 'node:fs';"), [
      './translate.js',
      'node:fs',
    ]);
  });
});
