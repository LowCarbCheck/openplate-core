/**
 * CORS — wide open by design, and safe for exactly one reason.
 *
 * `Access-Control-Allow-Origin: *` is normally a smell. Here it is the point:
 * an openplate client is a separately deployed artifact, and any client
 * (ours, or a self-hoster's on their own domain, or a third-party
 * implementation written from PROTOCOL.md) must be able to talk to any
 * instance of this service. An origin allowlist would mean every self-hoster
 * editing server config to use their own client.
 *
 * What makes it safe is the absence of ambient credentials. This service
 * issues NO cookies and reads none; authentication is a bearer token the
 * client must attach deliberately. A hostile page can therefore issue a
 * cross-origin request and get an unauthenticated `401` — it has nothing to
 * authenticate with, because the browser has nothing to attach automatically.
 * That is precisely the CSRF property cookies lack.
 *
 * `Access-Control-Allow-Credentials` is deliberately NEVER sent. Adding it
 * would both be rejected by browsers alongside `*` and signal an intent
 * (cookie auth) this service must not develop.
 *
 * Hand-rolled rather than the `cors` package: eleven lines against a
 * dependency every self-hoster would have to trust.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
/**
 * EVERY REQUEST HEADER ANY ROUTE ON THIS SERVICE READS, and the list is a
 * contract rather than a convenience.
 *
 * A browser sends the preflight, reads this list, and REFUSES TO SEND the real
 * request when it names a header the list omits. The refusal happens in the
 * browser: no request arrives, no access log line is written, and the caller
 * sees a request that never answers. A `curl` and a Node `fetch` enforce none
 * of this, so an integration suite over real HTTP stays green while every
 * browser is blocked. `Idempotency-Key` was missing here from M222 until the
 * pulse writes were walked in a browser, and `Access-Control-Max-Age` then kept
 * the refusal cached for a day.
 *
 * ADDING A ROUTE THAT READS A REQUEST HEADER MEANS ADDING IT HERE.
 * `tests/integration/cors-preflight.test.ts` walks the source for
 * `req.header(...)` and fails when a name is missing from this line.
 */
const ALLOWED_HEADERS = 'Authorization, Content-Type, Idempotency-Key';
/**
 * EVERY RESPONSE HEADER A CROSS-ORIGIN CALLER IS ALLOWED TO READ, and this is a
 * separate list from the one above for a separate browser rule.
 *
 * A browser hands a script only the seven safelisted response headers unless
 * the response names more here. `Retry-After` is not one of the seven, so
 * `response.headers.get('Retry-After')` answered `null` in every browser while
 * answering correctly to `curl`, and the value the four rate limiters on this
 * service compute reached nobody. The client then has to guess a backoff on the
 * one answer that tells it exactly how long to wait.
 *
 * ONE NAME, NOT A WILDCARD. `*` would publish every header this service ever
 * sends to any page on the internet, and the list of those is not a decision
 * this line should make for a route added later.
 */
const EXPOSED_HEADERS = 'Retry-After';
/** How long a browser may cache the preflight. 24h — the policy is static, so re-asking is pure latency. */
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

export function createCorsMiddleware(): RequestHandler {
  return function applyCors(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    // ON EVERY ANSWER, not only on the preflight. The preflight decides what a
    // request may SEND; this one travels on the real response and decides what
    // the script may READ off it, so a 429 that arrived without it is a 429
    // whose Retry-After is already lost.
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
