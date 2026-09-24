/**
 * What the AI proxy changes in a chat body before it forwards it (M256/01).
 *
 * WHY THE PROXY TOUCHES THE BODY AT ALL. Until M256 it forwarded the body
 * unchanged, so the CALLER chose the model and the length of the answer. With
 * open sign-up any stranger holds a token, and every instance may share one
 * provider key with a small monthly limit. One caller asking for an expensive
 * model, a huge answer, five answers at once or a paid web search could drain
 * that key and stop AI for every account until the provider's reset. The
 * daily request counters cannot see any of that: they count requests, not
 * what one request costs.
 *
 * THE RULES, every one of them quiet (a body is rewritten, never refused, so
 * a client that sends an extra field is not broken by it):
 *
 *  - `model` becomes the instance's model (`AI_ADVERTISED_MODEL`) when the
 *    operator set one. Unset keeps the caller's model: a self-hosted instance
 *    may let its people pick, and that is the operator's call.
 *  - `max_tokens` and `max_completion_tokens` are capped at
 *    `AI_MAX_OUTPUT_TOKENS`. A body with neither gets `max_tokens` written in,
 *    so no answer is unbounded. A value that is not a number (`null`, a
 *    string) is replaced by the ceiling too, because `null` means "no limit".
 *  - `reasoning.max_tokens` is capped at the same ceiling. Reasoning tokens
 *    are billed as output, and this is the one field that asks for them by
 *    count. `reasoning.effort` is kept: it moves where inside the cap the
 *    answer lands, not the cap.
 *  - `n` becomes 1 when it is present: n answers cost n times one.
 *  - {@link REMOVED_CHAT_FIELDS} are deleted: a fallback model list and its
 *    route, provider routing (it can pick a dearer endpoint of the same
 *    model), paid plugins such as web search, the OpenAI-style web search
 *    options, and predicted outputs (rejected prediction tokens are billed).
 *
 * The app never sends any of the deleted fields, `n`, `reasoning` or an
 * output cap to this proxy (measured in `openplate`'s
 * `app/services/vision/openai-compatible.ts` on 2026-09-24), so nothing it
 * sends changes except the cap written in and the model it already names.
 *
 * NOTHING HERE READS A CLOCK, A DATABASE OR AN ENVIRONMENT.
 */
import { asNumber, asObject, type JsonObject, type JsonValue } from '../lib/json.js';

/**
 * The default for `AI_MAX_OUTPUT_TOKENS`.
 *
 * WHY 8192. The app sends no output cap on the managed path at all; the
 * largest value it sends anywhere is 1536, to Anthropic on a person's own key.
 * Its largest managed answer is a round of three recipes with ingredients and
 * steps, estimated at 2000 to 3000 tokens, and the instance's model may spend
 * part of the cap on reasoning it does by default. 8192 leaves room for both,
 * and at a flash model's price it bounds one request to a few cents.
 */
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 8192;

/** Fields deleted from every forwarded chat body. See the module header for each one's cost. */
export const REMOVED_CHAT_FIELDS = ['models', 'route', 'provider', 'plugins', 'web_search_options', 'prediction'];

/** The two names OpenAI-compatible APIs read an output cap from. */
const OUTPUT_CAP_FIELDS = ['max_tokens', 'max_completion_tokens'];

/** What the instance decides for every forwarded chat body. */
export interface ChatBodyPolicy {
  /** `AI_ADVERTISED_MODEL`, or `null` to keep the caller's model. */
  model: string | null;
  /** `AI_MAX_OUTPUT_TOKENS`: the most output tokens one request may ask for. */
  maxOutputTokens: number;
}

/** A JSON object this module builds and may still write to. */
interface WritableJsonObject {
  [key: string]: JsonValue | undefined;
}

/** A requested output count, or the ceiling when it is above the ceiling or not a number. */
function capTokenCount(input: { requested: JsonValue | undefined; ceiling: number }): number {
  const requested = asNumber(input.requested);
  if (requested === null || requested > input.ceiling) return input.ceiling;
  return requested;
}

/** Caps each output field the body names, or writes `max_tokens` when it names none. */
function capOutputTokens(input: { body: WritableJsonObject; ceiling: number }): void {
  const named = OUTPUT_CAP_FIELDS.filter((field) => input.body[field] !== undefined);
  if (named.length === 0) {
    input.body.max_tokens = input.ceiling;
    return;
  }
  for (const field of named) {
    input.body[field] = capTokenCount({ requested: input.body[field], ceiling: input.ceiling });
  }
}

/** Caps `reasoning.max_tokens` when the body asks for a reasoning budget by count. */
function capReasoningBudget(input: { body: WritableJsonObject; ceiling: number }): void {
  const reasoning = asObject(input.body.reasoning);
  if (reasoning === null || reasoning.max_tokens === undefined) return;
  input.body.reasoning = {
    ...reasoning,
    max_tokens: capTokenCount({ requested: reasoning.max_tokens, ceiling: input.ceiling }),
  };
}

/**
 * The body the provider receives, built from the body the caller sent.
 *
 * A NEW OBJECT: the caller's body is not changed, so the proxy's own log
 * fields (streaming or not) still read what was asked for.
 *
 * @param input.body - the parsed request body, already proved to be an object.
 * @param input.policy - the instance's model and output ceiling.
 * @returns the body to serialise and forward.
 */
export function applyChatBodyPolicy(input: { body: JsonObject; policy: ChatBodyPolicy }): JsonObject {
  const rewritten: WritableJsonObject = Object.fromEntries(
    Object.entries(input.body).filter(([field]) => !REMOVED_CHAT_FIELDS.includes(field)),
  );
  if (input.policy.model !== null) rewritten.model = input.policy.model;
  capOutputTokens({ body: rewritten, ceiling: input.policy.maxOutputTokens });
  capReasoningBudget({ body: rewritten, ceiling: input.policy.maxOutputTokens });
  if (rewritten.n !== undefined) rewritten.n = 1;
  return rewritten;
}
