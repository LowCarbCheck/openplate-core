/**
 * A mail template from the mounted content folder (M246/04), parsed and
 * rendered as PURE FUNCTIONS of their inputs.
 *
 * THE FORMAT IS NOT OURS. It is section 2, 3 and 6 of the legal file contract
 * (`legal/CONTRACT.md` in the private repo that holds the files): front matter
 * with exactly `title`, `updated` and `subject`, then a body in a small
 * markdown subset, with `{{placeholders}}` the core fills. The private repo
 * checks every file against the same rules before it ships, so a refusal here
 * means a file reached a server without passing that check.
 *
 * REFUSED, NEVER ESCAPED INTO VIEW. Anything outside the subset (raw HTML, a
 * character reference, an image, a code span or fence, a block quote, a
 * table, a `#` or `####` heading, an indented line, an unknown placeholder)
 * makes the whole file unusable, and `parseMailTemplate` throws
 * {@link MailTemplateError}. The caller then sends the neutral text instead.
 * A mail is either filled completely from a valid file or not built from the
 * file at all; there is no half-filled letter.
 *
 * VALUES ARE FILLED INTO THE PARSED TREE, NEVER INTO THE SOURCE. A person's
 * name or reason is text they typed. Substituting it into the markdown before
 * parsing would let `**` or `[x](https://...)` in a form field become markup
 * in a letter this service signs. Here a value is a leaf: literal in the text
 * part, escaped in the HTML part.
 */
import type { InstanceLanguage } from '../protocol.js';
import { escapeHtml, renderHtmlDocument } from './invite-message.js';

/** Every placeholder the contract defines. Which ones a given template may use is the caller's list. */
export type MailPlaceholder = 'date' | 'receiptId' | 'details' | 'matched';

/** The placeholders that stand inside a line. `details` is a block of its own, see {@link MailBlock}. */
export type InlinePlaceholder = Exclude<MailPlaceholder, 'details'>;

export type InlineNode =
  | { kind: 'text'; value: string }
  | { kind: 'placeholder'; name: InlinePlaceholder }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'emphasis'; children: InlineNode[] }
  | { kind: 'link'; target: string; children: InlineNode[] };

export interface ParagraphLine {
  content: InlineNode[];
  /** A backslash ended the source line: the next line starts on a new line rather than after a space. */
  isHardBreakAfter: boolean;
}

export interface DefinitionEntry {
  term: InlineNode[];
  definitions: InlineNode[][];
}

export type MailBlock =
  | { kind: 'heading'; level: 2 | 3; content: InlineNode[] }
  | { kind: 'paragraph'; lines: ParagraphLine[] }
  | { kind: 'list'; isOrdered: boolean; items: InlineNode[][] }
  | { kind: 'definitions'; entries: DefinitionEntry[] }
  /** A line that held only `{{details}}`: one paragraph per detail line, in order. */
  | { kind: 'details' };

export interface MailTemplate {
  /** Plain text and placeholders only; the contract allows no markup in front matter. */
  subject: InlineNode[];
  blocks: MailBlock[];
}

/** Why a file was not used. The message names the rule and a line number, never file content. */
export class MailTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailTemplateError';
  }
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export interface MailTemplateValues {
  /** A value for each inline placeholder this letter can fill. A placeholder with no value here refuses the render. */
  inline: ReadonlyMap<InlinePlaceholder, string>;
  /** The `Label: value` lines that replace `{{details}}`, already in the order the form asked for them. */
  details: readonly string[];
}

const FRONT_MATTER_KEYS = ['title', 'updated', 'subject'] as const;
const INLINE_PLACEHOLDERS: readonly InlinePlaceholder[] = ['date', 'receiptId', 'matched'];
const ESCAPABLE = new Set(['\\', '*', '[', ']']);
const ALLOWED_LINK_PREFIXES = ['/', 'https://', 'mailto:', 'tel:'] as const;
const LINK_AT = /^\[([^\]\\]+)\]\(([^)\s]+)\)/;
const PLACEHOLDER_AT = /^\{\{([A-Za-z]+)\}\}/;
const DETAILS_LINE = '{{details}}';

function refuse(message: string, line?: number): never {
  throw new MailTemplateError(line === undefined ? message : `line ${line}: ${message}`);
}

// ── Inline text ──────────────────────────────────────────────────────────

interface Cursor {
  text: string;
  index: number;
  line: number;
  placeholders: ReadonlySet<InlinePlaceholder>;
}

function asInlinePlaceholder(name: string): InlinePlaceholder | null {
  return INLINE_PLACEHOLDERS.find((candidate) => candidate === name) ?? null;
}

/** The checks that do not depend on position: each one names a construct the subset leaves out. */
function refuseForeignSyntax(text: string, line: number): void {
  if (/<[A-Za-z/!?]/.test(text)) refuse('raw HTML is not allowed', line);
  if (/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(text)) refuse('an HTML character reference is not allowed', line);
  if (text.includes('![')) refuse('an image is not allowed', line);
  if (text.includes('`')) refuse('a code span is not allowed', line);
}

function readPlaceholder(cursor: Cursor): InlineNode {
  const match = PLACEHOLDER_AT.exec(cursor.text.slice(cursor.index));
  if (match === null) return refuse('a malformed placeholder', cursor.line);
  const name = match[1] ?? '';
  const placeholder = asInlinePlaceholder(name);
  if (placeholder === null || !cursor.placeholders.has(placeholder)) {
    const where = name === 'details' ? ', {{details}} must stand alone on its line' : '';
    return refuse(`{{${name}}} is not a placeholder of this template${where}`, cursor.line);
  }
  cursor.index += match[0].length;
  return { kind: 'placeholder', name: placeholder };
}

function readLink(cursor: Cursor): InlineNode {
  const match = LINK_AT.exec(cursor.text.slice(cursor.index));
  if (match === null) return refuse('a [ that starts no [text](target) link', cursor.line);
  const target = match[2] ?? '';
  if (!ALLOWED_LINK_PREFIXES.some((prefix) => target.startsWith(prefix))) {
    return refuse('a link target must start with /, https://, mailto: or tel:', cursor.line);
  }
  cursor.index += match[0].length;
  const inner: Cursor = { ...cursor, text: match[1] ?? '', index: 0 };
  return { kind: 'link', target, children: readRun({ cursor: inner, closer: null, isInsideLink: true }) };
}

/**
 * Reads inline nodes until `closer` (the marker that opened this run) or the
 * end of the text. Emphasis nests by recursion: `**` opens a strong run that
 * ends at the next `**`, and a single `*` inside it opens an emphasis run.
 */
function readRun(input: { cursor: Cursor; closer: '**' | '*' | null; isInsideLink: boolean }): InlineNode[] {
  const { cursor, closer, isInsideLink } = input;
  const nodes: InlineNode[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer !== '') nodes.push({ kind: 'text', value: buffer });
    buffer = '';
  };

  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index] ?? '';
    if (char === '\\') {
      const next = cursor.text[cursor.index + 1];
      if (next === undefined || !ESCAPABLE.has(next)) refuse('a backslash may only escape \\ * [ ]', cursor.line);
      buffer += next;
      cursor.index += 2;
      continue;
    }
    if (cursor.text.startsWith('{{', cursor.index)) {
      flush();
      nodes.push(readPlaceholder(cursor));
      continue;
    }
    if (cursor.text.startsWith('}}', cursor.index)) refuse('a malformed placeholder', cursor.line);
    if (char === '[') {
      if (isInsideLink) refuse('a link inside a link is not allowed', cursor.line);
      flush();
      nodes.push(readLink(cursor));
      continue;
    }
    if (char === ']') refuse('a ] outside a link', cursor.line);
    if (char === '*') {
      let run = 1;
      while (cursor.text[cursor.index + run] === '*') run += 1;
      if (run > 2) refuse(`a run of ${run} asterisks is not allowed`, cursor.line);
      const marker = run === 2 ? '**' : '*';
      cursor.index += run;
      flush();
      if (marker === closer) return nodes;
      const children = readRun({ cursor, closer: marker, isInsideLink });
      nodes.push(marker === '**' ? { kind: 'strong', children } : { kind: 'emphasis', children });
      continue;
    }
    buffer += char;
    cursor.index += 1;
  }

  if (closer !== null) refuse(`${closer} is opened and never closed`, cursor.line);
  flush();
  return nodes;
}

function parseInline(input: {
  text: string;
  line: number;
  placeholders: ReadonlySet<InlinePlaceholder>;
}): InlineNode[] {
  refuseForeignSyntax(input.text, input.line);
  const cursor: Cursor = { text: input.text, index: 0, line: input.line, placeholders: input.placeholders };
  return readRun({ cursor, closer: null, isInsideLink: false });
}

// ── Front matter ─────────────────────────────────────────────────────────

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

interface FrontMatter {
  subject: InlineNode[];
  /** Index of the first body line. */
  bodyStart: number;
}

function readFrontMatter(input: {
  lines: readonly string[];
  placeholders: ReadonlySet<InlinePlaceholder>;
}): FrontMatter {
  const { lines, placeholders } = input;
  if (lines[0] !== '---') return refuse('the file must start with a front matter line ---', 1);
  const close = lines.indexOf('---', 1);
  if (close === -1) return refuse('the front matter is never closed with ---', 1);
  if (close !== FRONT_MATTER_KEYS.length + 1) {
    return refuse(`front matter keys must be exactly ${FRONT_MATTER_KEYS.join(', ')}, in that order`, 2);
  }

  const values: string[] = [];
  FRONT_MATTER_KEYS.forEach((key, position) => {
    const line = position + 2;
    const match = /^([a-z]+): (.+)$/.exec(lines[position + 1] ?? '');
    if (match === null || match[1] !== key) {
      refuse(`front matter keys must be exactly ${FRONT_MATTER_KEYS.join(', ')}, in that order`, line);
    }
    const value = match[2] ?? '';
    if (key !== 'updated' && /[*[\]\\]/.test(value)) refuse(`${key}: front matter is plain text, no markup`, line);
    values.push(value);
  });

  const [title = '', updated = '', subject = ''] = values;
  if (!isCalendarDate(updated)) refuse('updated is not a YYYY-MM-DD calendar date', 3);
  parseInline({ text: title, line: 2, placeholders: new Set() });
  return { subject: parseInline({ text: subject, line: 4, placeholders }), bodyStart: close + 1 };
}

// ── Blocks ───────────────────────────────────────────────────────────────

interface SourceLine {
  text: string;
  /** 1-based, in the whole file. */
  line: number;
}

/** A structural problem with how a line starts, mirroring the contract checker line for line. */
function refuseLineStart(source: SourceLine): void {
  const { text, line } = source;
  if (/^\s/.test(text)) refuse('an indented line is not allowed (no code blocks, no nested lists)', line);
  if (/^(?:```|~~~)/.test(text)) refuse('a code fence is not allowed', line);
  if (text.startsWith('>')) refuse('a block quote is not allowed', line);
  if (text.startsWith('|')) refuse('a table is not allowed', line);
  if (/^[*+] /.test(text)) refuse('a bullet is written with - ', line);
  if (text.startsWith('#') && !/^#{2,3} \S/.test(text)) refuse('only ## and ### headings are allowed', line);
  if (text.startsWith(':::')) refuse('a mail template carries no sections', line);
}

/** An odd number of trailing backslashes is a hard break; an even number is escaped backslashes. */
function splitHardBreak(text: string): { text: string; isHardBreak: boolean } {
  const trailing = /\\+$/.exec(text)?.[0].length ?? 0;
  return trailing % 2 === 1 ? { text: text.slice(0, -1), isHardBreak: true } : { text, isHardBreak: false };
}

interface BlockReader {
  placeholders: ReadonlySet<InlinePlaceholder>;
  blocks: MailBlock[];
}

function inlineOf(reader: BlockReader, source: SourceLine, text: string): InlineNode[] {
  return parseInline({ text, line: source.line, placeholders: reader.placeholders });
}

/** A group whose lines include a `: ` definition: every term is followed by one or more definitions. */
function readDefinitions(reader: BlockReader, group: readonly SourceLine[]): void {
  const entries: DefinitionEntry[] = [];
  for (const source of group) {
    const { text, isHardBreak } = splitHardBreak(source.text);
    if (isHardBreak) refuse('a hard line break is not allowed in a definition list', source.line);
    if (text.startsWith(': ')) {
      const current = entries.at(-1);
      if (current === undefined) refuse('a : definition line must follow a term line', source.line);
      current.definitions.push(inlineOf(reader, source, text.slice(2)));
      continue;
    }
    if (/^(?:#{2,3} |- |\d+\. )/.test(text)) {
      refuse('a definition list term cannot be a heading or a list item', source.line);
    }
    const previous = entries.at(-1);
    if (previous !== undefined && previous.definitions.length === 0) {
      refuse('a definition list term must be followed by a : definition line', source.line - 1);
    }
    entries.push({ term: inlineOf(reader, source, text), definitions: [] });
  }
  const last = group.at(-1);
  if (entries.at(-1)?.definitions.length === 0) {
    refuse('a definition list term must be followed by a : definition line', last?.line);
  }
  reader.blocks.push({ kind: 'definitions', entries });
}

/**
 * Headings, lists and paragraphs within one blank-line-separated group. A
 * plain line after a list item continues that item, as it would in any
 * markdown renderer; a marker line starts a list even directly under a
 * paragraph line.
 */
function readFlow(reader: BlockReader, group: readonly SourceLine[]): void {
  let open: MailBlock | null = null;
  const close = (): void => {
    if (open === null) return;
    if (open.kind === 'paragraph' && open.lines.at(-1)?.isHardBreakAfter === true) {
      refuse('a hard line break must be followed by a line of the same paragraph');
    }
    reader.blocks.push(open);
    open = null;
  };

  for (const source of group) {
    const { text, isHardBreak } = splitHardBreak(source.text);
    const heading = /^(#{2,3}) (.+)$/.exec(text);
    const bullet = /^- (.+)$/.exec(text);
    const ordered = /^\d+\. (.+)$/.exec(text);
    if ((heading !== null || bullet !== null || ordered !== null) && isHardBreak) {
      refuse('a hard line break belongs inside a paragraph', source.line);
    }

    if (heading !== null) {
      close();
      const level = heading[1] === '##' ? 2 : 3;
      reader.blocks.push({ kind: 'heading', level, content: inlineOf(reader, source, heading[2] ?? '') });
      continue;
    }
    const item = bullet ?? ordered;
    if (item !== null) {
      const isOrdered = ordered !== null;
      const content = inlineOf(reader, source, item[1] ?? '');
      if (open?.kind === 'list' && open.isOrdered === isOrdered) {
        open.items.push(content);
        continue;
      }
      close();
      open = { kind: 'list', isOrdered, items: [content] };
      continue;
    }

    const content = inlineOf(reader, source, text);
    if (open?.kind === 'list') {
      if (isHardBreak) refuse('a hard line break is not allowed in a list item', source.line);
      const lastItem = open.items.at(-1) ?? [];
      lastItem.push({ kind: 'text', value: ' ' }, ...content);
      continue;
    }
    if (open?.kind === 'paragraph') {
      open.lines.push({ content, isHardBreakAfter: isHardBreak });
      continue;
    }
    close();
    open = { kind: 'paragraph', lines: [{ content, isHardBreakAfter: isHardBreak }] };
  }
  close();
}

function readGroup(reader: BlockReader, group: readonly SourceLine[]): void {
  if (group.length === 0) return;
  if (group.some((source) => source.text.startsWith(': '))) {
    readDefinitions(reader, group);
    return;
  }
  readFlow(reader, group);
}

function readBody(input: {
  lines: readonly string[];
  start: number;
  placeholders: ReadonlySet<InlinePlaceholder>;
  allowsDetails: boolean;
}): MailBlock[] {
  const reader: BlockReader = { placeholders: input.placeholders, blocks: [] };
  let group: SourceLine[] = [];
  const flush = (): void => {
    readGroup(reader, group);
    group = [];
  };

  for (let index = input.start; index < input.lines.length; index += 1) {
    const source: SourceLine = { text: input.lines[index] ?? '', line: index + 1 };
    if (source.text === '') {
      flush();
      continue;
    }
    if (source.text === DETAILS_LINE) {
      if (!input.allowsDetails) refuse('{{details}} is not a placeholder of this template', source.line);
      flush();
      reader.blocks.push({ kind: 'details' });
      continue;
    }
    refuseLineStart(source);
    group.push(source);
  }
  flush();
  return reader.blocks;
}

/**
 * Parses one template file, or throws {@link MailTemplateError} naming the
 * first rule it breaks. `placeholders` is the set CONTRACT.md section 6 lists
 * for this template; any other `{{name}}` refuses the file.
 */
export function parseMailTemplate(input: { source: string; placeholders: readonly MailPlaceholder[] }): MailTemplate {
  if (input.source.startsWith('\uFEFF')) refuse('the file starts with a byte order mark', 1);
  if (input.source.includes('\r')) refuse('the file has CR line ends; use LF');

  const inline = new Set(input.placeholders.flatMap((name) => asInlinePlaceholder(name) ?? []));
  const lines = input.source.split('\n');
  const frontMatter = readFrontMatter({ lines, placeholders: inline });
  const blocks = readBody({
    lines,
    start: frontMatter.bodyStart,
    placeholders: inline,
    allowsDetails: input.placeholders.includes('details'),
  });
  if (blocks.length === 0) refuse('the body is empty');
  return { subject: frontMatter.subject, blocks };
}

// ── Rendering ────────────────────────────────────────────────────────────

function valueOf(values: MailTemplateValues, name: InlinePlaceholder): string {
  const value = values.inline.get(name);
  if (value === undefined) return refuse(`{{${name}}} has no value for this letter`);
  return value;
}

function inlineText(nodes: readonly InlineNode[], values: MailTemplateValues): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          return node.value;
        case 'placeholder':
          return valueOf(values, node.name);
        case 'strong':
        case 'emphasis':
          return inlineText(node.children, values);
        case 'link': {
          const label = inlineText(node.children, values);
          return label === node.target ? label : `${label} (${node.target})`;
        }
      }
    })
    .join('');
}

function inlineHtml(nodes: readonly InlineNode[], values: MailTemplateValues): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          return escapeHtml(node.value);
        case 'placeholder':
          return escapeHtml(valueOf(values, node.name));
        case 'strong':
          return `<strong>${inlineHtml(node.children, values)}</strong>`;
        case 'emphasis':
          return `<em>${inlineHtml(node.children, values)}</em>`;
        case 'link':
          return `<a href="${escapeHtml(node.target)}">${inlineHtml(node.children, values)}</a>`;
      }
    })
    .join('');
}

function paragraphText(lines: readonly ParagraphLine[], values: MailTemplateValues): string {
  return lines
    .map((line, index) => {
      const separator = index === lines.length - 1 ? '' : line.isHardBreakAfter ? '\n' : ' ';
      return inlineText(line.content, values) + separator;
    })
    .join('');
}

function paragraphHtml(lines: readonly ParagraphLine[], values: MailTemplateValues): string {
  return lines
    .map((line, index) => {
      const separator = index === lines.length - 1 ? '' : line.isHardBreakAfter ? '<br>\n' : '\n';
      return inlineHtml(line.content, values) + separator;
    })
    .join('');
}

function blockText(block: MailBlock, values: MailTemplateValues): string {
  switch (block.kind) {
    case 'heading':
      return inlineText(block.content, values);
    case 'paragraph':
      return paragraphText(block.lines, values);
    case 'list':
      return block.items
        .map((item, index) => `${block.isOrdered ? `${index + 1}.` : '-'} ${inlineText(item, values)}`)
        .join('\n');
    case 'definitions':
      return block.entries
        .map((entry) =>
          [inlineText(entry.term, values), ...entry.definitions.map((line) => inlineText(line, values))].join('\n'),
        )
        .join('\n');
    case 'details':
      return values.details.join('\n\n');
  }
}

function blockHtml(block: MailBlock, values: MailTemplateValues): string {
  switch (block.kind) {
    case 'heading':
      return `<h${block.level}>${inlineHtml(block.content, values)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${paragraphHtml(block.lines, values)}</p>`;
    case 'list': {
      const tag = block.isOrdered ? 'ol' : 'ul';
      const items = block.items.map((item) => `<li>${inlineHtml(item, values)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'definitions': {
      const entries = block.entries
        .map(
          (entry) =>
            `<dt>${inlineHtml(entry.term, values)}</dt>` +
            entry.definitions.map((line) => `<dd>${inlineHtml(line, values)}</dd>`).join(''),
        )
        .join('');
      return `<dl>${entries}</dl>`;
    }
    case 'details':
      return values.details.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n');
  }
}

/**
 * Fills a parsed template. Throws {@link MailTemplateError} when the
 * template names a placeholder `values` has no entry for, so the caller can
 * fall back rather than send a letter with a hole in it.
 */
export function renderMailTemplate(input: {
  template: MailTemplate;
  values: MailTemplateValues;
  language: InstanceLanguage;
}): RenderedMail {
  const { template, values } = input;
  return {
    subject: inlineText(template.subject, values),
    text: template.blocks.map((block) => blockText(block, values)).join('\n\n'),
    html: renderHtmlDocument({
      language: input.language,
      body: template.blocks.map((block) => blockHtml(block, values)),
    }),
  };
}
