/**
 * The one-shot, one-way forward of a persisted declaration to the biller's
 * `POST /plans/declarations`, over the SAME internal door
 * `server/plans-proxy.ts` uses: `X-Plans-Secret` always, `X-Account-Id` and
 * `X-Account-Email` only when this declaration matched an account, and BUILT
 * from the matched account's own row, never copied from the request body —
 * the same rule `plans-proxy.ts` states for why a client's own claim about
 * either header is never consulted.
 *
 * NEVER RELAYS A RESPONSE. `server/plans-proxy.ts` exists to hand a caller's
 * browser back exactly what the biller answered; this module has no caller
 * waiting on a body, only a `forward_error` column waiting on a reason. A 2xx
 * is success, anything else is one of the four codes below, and the response
 * body is drained and discarded either way.
 *
 * AN EXPLICIT `AbortSignal.timeout`, for the reason `plans-proxy.ts` gives:
 * Node's global `fetch` otherwise waits five minutes, and the row this call is
 * about has already been persisted, so the only thing a hang costs is how long
 * a person's browser sits on a spinner before this handler gives up and
 * answers `202` anyway.
 */
import type { Logger } from '../logger.js';
import type { CreateLegalDeclarationInput } from './legal-declarations-store.js';

/** How long this service waits for the biller before giving up on the forward. Ten seconds, the same bound `plans-proxy.ts` uses and for the same reason: a person is waiting. */
export const FORWARD_DECLARATION_TIMEOUT_MS = 10_000;

/** `AbortSignal.timeout` rejects with this name; a dead host rejects with something else. */
const TIMEOUT_ERROR_NAME = 'TimeoutError';

export type ForwardDeclarationOutcome =
  | { ok: true }
  | { ok: false; code: 'plans-not-configured' | 'unreachable' | 'timeout' | 'rejected' };

export interface ForwardDeclarationUpstream {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
}

export interface ForwardDeclarationInput {
  /** `null` means no biller stands behind this instance; the caller still persisted and mailed, this is the one branch that makes no network call at all. */
  upstream: ForwardDeclarationUpstream | null;
  declaration: Pick<
    CreateLegalDeclarationInput,
    'kind' | 'name' | 'email' | 'contractReference' | 'terminationType' | 'reason' | 'requestedDate'
  >;
  /** The matched account, or `null`. Present iff `X-Account-Id` and `X-Account-Email` are both sent — the email is the ROW's, never the request body's. */
  matchedAccount: { id: number; email: string } | null;
  logger: Logger;
}

/** The body the biller's `declarations` table needs (spec 09 §4). `timing` and `language` stay behind: the biller's table has no column for either. */
function forwardBody(declaration: ForwardDeclarationInput['declaration']): string {
  return JSON.stringify({
    kind: declaration.kind,
    name: declaration.name,
    email: declaration.email,
    contractReference: declaration.contractReference,
    terminationType: declaration.terminationType,
    reason: declaration.reason,
    requestedDate: declaration.requestedDate,
  });
}

export async function forwardDeclaration(input: ForwardDeclarationInput): Promise<ForwardDeclarationOutcome> {
  if (input.upstream === null) return { ok: false, code: 'plans-not-configured' };

  const headers = new Headers();
  headers.set('X-Plans-Secret', input.upstream.secret);
  headers.set('Content-Type', 'application/json');
  if (input.matchedAccount !== null) {
    headers.set('X-Account-Id', String(input.matchedAccount.id));
    headers.set('X-Account-Email', input.matchedAccount.email);
  }

  const timeoutMs = input.upstream.timeoutMs ?? FORWARD_DECLARATION_TIMEOUT_MS;
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(`${input.upstream.baseUrl}/declarations`, {
      method: 'POST',
      headers,
      body: forwardBody(input.declaration),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : '';
    const code = name === TIMEOUT_ERROR_NAME ? 'timeout' : 'unreachable';
    input.logger.warn('Declaration forward failed', { code });
    return { ok: false, code };
  }

  // Drained rather than parsed: nothing here reads the biller's answer, see
  // the module header. Not cancelled either — `response.body?.cancel()` would
  // do the same job, but reading it to completion is what lets the connection
  // be reused for the next forward.
  await response.text().catch(() => undefined);

  if (!response.ok) {
    input.logger.warn('Declaration forward refused', { status: response.status });
    return { ok: false, code: 'rejected' };
  }
  return { ok: true };
}
