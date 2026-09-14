/**
 * A stand-in for `openplate-website/app/lib/docs.ts`, the documentation tree the vendored
 * translator was written beside.
 *
 * ── WHY A STAND-IN AND NOT A COPY ──
 * `scripts/lib/translate.ts` is a byte copy of the website's translator (`scripts/lib/
 * TRANSLATE_SOURCE.json` says from which commit). The website's file serves two corpora: the
 * site's own UI catalogs, and the documentation it quotes from three repositories. The
 * documentation half imports this block tree, and copying it to satisfy an import would be
 * vendoring a docs site into a mail dictionary. So `scripts/sync-translate-lib.ts` rewrites that
 * import to this file, which declares the NAMES the copy refers to and nothing behind them.
 * No value of these types is ever made in this service; the functions that would walk one, in
 * `docs-i18n.server.ts` beside this, throw.
 *
 * The shapes are the subset the copy touches: `index[component].lead`, `.entries`,
 * `entry.slug`, `docs[component][slug]`. The upstream file's hash is recorded under `shimmed`
 * in the provenance, so a change to the real thing is a changed line at the next sync, and the
 * person syncing re-reads this against it.
 */

/** The three programs openplate is built from, as the website names them. */
export const DOC_COMPONENTS = ['app', 'core', 'inference'] as const;

export type DocComponent = (typeof DOC_COMPONENTS)[number];

/** One run of inline text. Opaque here: the service never parses a document. */
export interface Inline {
  readonly kind: 'text' | 'code' | 'strong' | 'em' | 'link';
}

/** One block of a document. Opaque here, for the same reason. */
export interface Block {
  readonly kind: string;
}

export interface DocEntry {
  readonly slug: string;
  readonly title: string;
  readonly blurb: readonly Inline[];
}

export interface DocFile {
  readonly component: DocComponent;
  readonly slug: string;
  readonly title: string;
  readonly blocks: readonly Block[];
}

export interface ComponentDocs {
  readonly component: DocComponent;
  readonly lead: readonly Block[];
  readonly entries: readonly DocEntry[];
}

export type DocsIndex = Record<DocComponent, ComponentDocs>;

export type DocsRegistry = Record<DocComponent, Record<string, DocFile>>;
