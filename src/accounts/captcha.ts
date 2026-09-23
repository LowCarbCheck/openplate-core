/**
 * The sign-up captcha: one question, "did a person solve the widget", asked
 * of Cloudflare Turnstile before the open sign-up door mints anything (M253).
 *
 * WHY IT IS HERE. `POST /v1/auth/signup-request` is the one unauthenticated
 * route on this service whose success costs the operator something: a letter
 * goes out, and a redeemed letter is a trial on the operator's provider key.
 * The per-IP throttle bounds one source; a captcha bounds a script with many
 * sources. The owner chose Turnstile on 2026-09-23.
 *
 * A PORT AND ONE ADAPTER, and the port is what the handler sees. The handler
 * is tested against a stub that answers whatever the test names, and the
 * adapter is tested against a local HTTP server standing in for
 * `siteverify`. Nothing in the test tiers ever reaches Cloudflare.
 *
 * THREE ANSWERS, NOT TWO, and the third is the one a boolean would lose.
 * `failed` is the person's to fix (solve the widget again), so the route
 * answers `400`. `unavailable` is Cloudflare's or the network's, so the route
 * answers `503` and the person retries later. Folding `unavailable` into
 * `failed` would tell somebody who solved the widget that they did not, and
 * folding it into `passed` would open the door whenever Cloudflare is slow.
 *
 * NOTHING HERE IS LOGGED BY THIS MODULE, and the token never is anywhere. A
 * Turnstile token is single use and short lived, but it is still a credential
 * a person handed us.
 */

/** What an operator configures: `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY`, both or neither. */
export interface TurnstileConfig {
  /** The server-side secret `siteverify` checks a token with. Never published, never logged. */
  secretKey: string;
  /** The public key a client renders the widget with. Published on `/health` while open sign-up is on. */
  siteKey: string;
}

/** The three outcomes of one verification. See the module header for why there are three. */
export type CaptchaVerdict = 'passed' | 'failed' | 'unavailable';

/** The port the open sign-up handler asks. */
export interface CaptchaVerifier {
  /**
   * Checks one token. `token` is `null` when the request carried none, which
   * is answered `failed` without a network call: there is nothing to ask
   * about.
   */
  verify(input: { token: string | null }): Promise<CaptchaVerdict>;
}

/** Cloudflare's verification endpoint. Injectable in the factory so a test can point it at a local server. */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * How long one verification may take. Five seconds: Turnstile answers in tens
 * of milliseconds, and a person waiting on a sign-up form has already waited
 * for the widget itself.
 */
const SITEVERIFY_TIMEOUT_MS = 5_000;

/**
 * The longest token this adapter forwards. Turnstile documents 2048
 * characters; anything longer is not a token and is refused without a call.
 */
const MAX_TOKEN_LENGTH = 2048;

/** The one field this adapter reads off Cloudflare's answer. */
interface SiteverifyAnswer {
  readonly success?: unknown;
}

export interface TurnstileVerifierOptions {
  config: TurnstileConfig;
  /** Defaults to {@link TURNSTILE_SITEVERIFY_URL}. A test passes a local server. */
  siteverifyUrl?: string;
  /** Defaults to {@link SITEVERIFY_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * The Turnstile adapter.
 *
 * THE CLIENT ADDRESS IS NOT SENT. `siteverify` accepts a `remoteip` field as
 * an extra signal, and leaving it out is a choice: the browser already talked
 * to Cloudflare when it rendered the widget, and this service has no reason
 * to hand a third party the address a second time.
 */
export function createTurnstileVerifier(options: TurnstileVerifierOptions): CaptchaVerifier {
  const url = options.siteverifyUrl ?? TURNSTILE_SITEVERIFY_URL;
  const timeoutMs = options.timeoutMs ?? SITEVERIFY_TIMEOUT_MS;

  return {
    async verify(input: { token: string | null }): Promise<CaptchaVerdict> {
      if (input.token === null || input.token === '' || input.token.length > MAX_TOKEN_LENGTH) return 'failed';

      const form = new URLSearchParams({ secret: options.config.secretKey, response: input.token });
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Unreachable, refused or too slow: not the person's fault.
        return 'unavailable';
      }
      if (!response.ok) return 'unavailable';

      let answer: SiteverifyAnswer;
      try {
        // `Object()` boxes rather than narrows, so a body that is not an object
        // simply has no `success` and reads as a failed check below.
        answer = Object(await response.json());
      } catch {
        return 'unavailable';
      }
      return answer.success === true ? 'passed' : 'failed';
    },
  };
}
