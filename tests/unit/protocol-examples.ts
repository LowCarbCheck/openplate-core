/**
 * The JSON examples PROTOCOL.md shows, read out of the document itself
 * (M253), so a test can hold them against what the service answers.
 *
 * WHY FROM THE DOCUMENT. An alternative client is written from those
 * examples. An example that names a field the service does not send, or omits
 * one it does, is a wrong specification that no type check can see.
 */
import { readFileSync } from 'node:fs';
import { asObject, type JsonValue } from '../../src/lib/json.js';

const PROTOCOL_PATH = new URL('../../PROTOCOL.md', import.meta.url);

/**
 * The first fenced `json` block after the heading that starts with `heading`,
 * parsed. Throws when the heading or the block is missing, so a renamed
 * section fails loudly rather than comparing nothing.
 */
export function protocolExample(heading: string): JsonValue {
  const text = readFileSync(PROTOCOL_PATH, 'utf8');
  const start = text.indexOf(`\n${heading}`);
  if (start === -1) throw new Error(`PROTOCOL.md has no heading starting "${heading}"`);
  const open = text.indexOf('```json\n', start);
  const close = text.indexOf('\n```', open + 1);
  if (open === -1 || close === -1) throw new Error(`no json example under "${heading}"`);
  // SAFETY: `JSON.parse` returns a JSON value by definition; the annotation
  // names that, and every caller decodes it further before relying on a key.
  const parsed: JsonValue = JSON.parse(text.slice(open + '```json\n'.length, close));
  return parsed;
}

/**
 * The key paths of a JSON value, sorted: `instance.trial.scans` and so on.
 * Arrays and scalars are leaves. Two documents with the same key paths name
 * the same fields at the same depth, whatever their values.
 */
export function keyPaths(value: JsonValue | undefined, prefix = ''): string[] {
  const object = asObject(value);
  if (object === null) return [prefix];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(object)) {
    paths.push(...keyPaths(child, prefix === '' ? key : `${prefix}.${key}`));
  }
  return paths.toSorted();
}
