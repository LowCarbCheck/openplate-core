/**
 * language.ts, the site's language model. The URL is the whole of it.
 *
 * This site is prerendered to static HTML at build time, so the language cannot
 * come from a cookie, a header or a stored preference: those are read at
 * request time, and there is no request. Every page therefore exists once per
 * language, at its German path and again under `/en`, `/fr`, `/it`, `/es` and
 * `/tr`, and the prefix in the URL IS the language. A crawler, a shared link and a browser back
 * button all agree on which document they are looking at, and every copy is
 * cacheable forever.
 *
 * ── THE DEFAULT LANGUAGE AND THE SOURCE LANGUAGE ARE NOT THE SAME THING ──
 * They were the same value while both were `en`, and reading one where the
 * other was meant cost nothing. German now owns the root, so the two have come
 * apart and every reader of this module has to say which one it wants:
 *
 *   DEFAULT_LANGUAGE  German. It owns the unprefixed URLs, so `openplate.de/docs`
 *                     IS the German document, and it is the language of any path
 *                     that carries no prefix. This is a question about the URL.
 *   SOURCE_LANGUAGE   English. It is the hand-written bundle, it is the language
 *                     the upstream repositories write their documentation in,
 *                     and it is the key the translation memory is stored under.
 *                     So it stays the fallback for a missing key and the text a
 *                     translation is made from. This is a question about the
 *                     words, not about where they are served.
 *
 * The rule of thumb: ask for DEFAULT_LANGUAGE when you are routing, ask for
 * SOURCE_LANGUAGE when you are translating. A check that reads "is this the
 * default language" and means "is this page untranslated" is now backwards, and
 * it fails silently, because both branches still render.
 *
 * Client- and server-safe: plain string work, no `document`, no server imports.
 */

/** The languages the site ships copy for, in the order the switcher names them. */
export const SUPPORTED_LANGUAGES = ['de', 'en', 'fr', 'it', 'es', 'tr'] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * The language that owns the unprefixed paths, and the one answer when a path
 * names no language at all.
 */
export const DEFAULT_LANGUAGE = 'de' satisfies LanguageCode;

/**
 * The language every other language is made from, and the fallback for a key
 * that is missing everywhere else. See the module note above: this is the
 * hand-written bundle, not the language of the root URL.
 */
export const SOURCE_LANGUAGE = 'en' satisfies LanguageCode;

/** Native display names. A language is always named in its own language, never translated. */
export const LANGUAGE_LABELS = {
  de: 'Deutsch',
  en: 'English',
  fr: 'Français',
  it: 'Italiano',
  es: 'Español',
  tr: 'Türkçe',
} satisfies Record<LanguageCode, string>;

/**
 * The URL prefix each language lives under. The default language has none, so
 * `openplate.de/docs` stays the canonical German URL rather than redirecting
 * to `/de/docs`, and English answers at `/en/docs`.
 */
export const LANGUAGE_PREFIXES = {
  de: '',
  en: '/en',
  fr: '/fr',
  it: '/it',
  es: '/es',
  tr: '/tr',
} satisfies Record<LanguageCode, string>;

/**
 * A language whose words are made from another language's, i.e. every one except the source.
 *
 * The type, not the list, so that a `Record` keyed by it is a COMPILE ERROR the day a fourth
 * language is added without the file that language needs. `docs-i18n.server.ts` keys its map of
 * translation memories by this, which is what turns "a language with no memory" from a page that
 * silently renders English into a build that refuses to finish.
 */
export type TranslatedLanguage = Exclude<LanguageCode, typeof SOURCE_LANGUAGE>;

/**
 * Every language a translator has to be paid for, in the switcher's order.
 *
 * Separate from PREFIXED_LANGUAGES, and the two lists happen to differ by exactly one member each
 * way: German is not prefixed but is translated, English is prefixed but is not translated. They
 * answer different questions, so a caller that reads the wrong one gets a plausible list and the
 * wrong work. The route table wants the prefixed ones; the translator wants these.
 */
export const TRANSLATED_LANGUAGES = SUPPORTED_LANGUAGES.filter(
  (language): language is TranslatedLanguage => language !== SOURCE_LANGUAGE,
);

/** Every prefixed language, i.e. every one except the default. Drives the route table. */
export const PREFIXED_LANGUAGES = SUPPORTED_LANGUAGES.filter(
  (language) => language !== DEFAULT_LANGUAGE,
);

/**
 * The language a pathname is written in.
 *
 * Matches the prefix as a whole segment, so `/enterprise` is German and only
 * `/en` and `/en/...` are English. Anything unrecognised is the default, which
 * is also what the router does with the same path.
 */
export function languageFromPathname(pathname: string): LanguageCode {
  for (const language of PREFIXED_LANGUAGES) {
    const prefix = LANGUAGE_PREFIXES[language];
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return language;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * React Router's single-fetch suffix, which a loader's own URL carries and a reader's never does.
 *
 * A loader is called at `<path>.data`, not at `<path>`, and that turns the language root into the
 * one URL on this site whose language cannot be read off it: `/en/app.data` still starts with
 * `/en/`, but `/en.data` is neither `/en` nor a path under it, so the language of the ENGLISH FRONT
 * PAGE came back as German. The page then rendered an English frame around German paragraphs,
 * which is exactly the kind of wrong that no test sees and one screenshot does.
 */
const DATA_SUFFIX = '.data';

/**
 * The language of the URL a LOADER was handed.
 *
 * Every loader that reads the language must use this and not `languageFromPathname` on its own
 * `request.url`. It is separate rather than folded into that function because a pathname is a
 * pathname: `/en.data` is a fact about React Router's data protocol, not about what a language
 * prefix means, and the browser router asks the other question about a real path.
 */
export function languageFromRequest(url: string): LanguageCode {
  const { pathname } = new URL(url);
  return languageFromPathname(pathname.endsWith(DATA_SUFFIX) ? pathname.slice(0, -DATA_SUFFIX.length) : pathname);
}

/**
 * The same page, addressed in `language`.
 *
 * `path` is always the canonical unprefixed path (`/docs`, `/`), because that
 * is what the route table is written in. Passing an already-prefixed path
 * would double the prefix, so callers hold the canonical form and localise at
 * the point of use.
 */
export function localizePath(path: string, language: LanguageCode): string {
  const prefix = LANGUAGE_PREFIXES[language];
  if (!prefix) return path;
  return path === '/' ? prefix : `${prefix}${path}`;
}

/**
 * The canonical, unprefixed path of an already-localized pathname.
 *
 * The inverse of `localizePath`, and the piece the language switcher needs:
 * it holds an English URL and has to name the same page unprefixed before it
 * can localize it again. `/en/core` becomes `/core`, `/en` becomes `/`, and an
 * unprefixed path is already canonical.
 */
export function canonicalizePath(pathname: string): string {
  const prefix = LANGUAGE_PREFIXES[languageFromPathname(pathname)];
  if (!prefix) return pathname;

  const rest = pathname.slice(prefix.length);
  return rest === '' ? '/' : rest;
}
