/**
 * What the biller's credential may reach, declared once.
 *
 * `BILLING_TOKEN` authenticates a THIRD admin principal (`server/admin-auth.ts`),
 * and it exists because the alternative is worse. A biller that held
 * `ADMIN_TOKEN` could list every account on the instance, read an address,
 * suspend somebody, erase somebody and open a reported photograph. It needs to
 * move two numbers on one account. So the credential is scoped at the door
 * rather than trusted at the handler.
 *
 * ── DEFAULT DENY, AND THE ALLOW LIST IS THE WHOLE POLICY ────────────────────
 * {@link SERVICE_PRINCIPAL_ROUTES} names three routes. Every other path under
 * `ADMIN_API_PREFIX` answers 403 to this principal, including the four
 * operator feedback routes and including any route added after this file was
 * written. A route added tomorrow is refused because it is not named here, not
 * because somebody remembered to refuse it, which is the only ordering of that
 * decision that survives a busy week.
 *
 * ── REFUSED AT THE MOUNT, BEFORE ANY HANDLER RUNS ───────────────────────────
 * {@link enforceServicePrincipalScope} is mounted in the same `app.use` as the
 * admin auth middleware, directly behind it and ahead of both routers
 * (`server/create-app.ts`). So a refusal costs no database read and reaches no
 * handler: an out-of-scope call cannot be an oracle for whether an account
 * exists, because nothing looked.
 *
 * ── THE FIELD LIST IS PART OF THE SCOPE, NOT PART OF VALIDATION ─────────────
 * {@link SERVICE_PRINCIPAL_PATCH_FIELDS} bounds the PATCH body to the two
 * fields the biller pays for. A body naming anything else is refused whole and
 * NOTHING is written, not even the allowed keys beside it. Silently dropping
 * the extra key would let a defect in the biller, one that believes it just
 * suspended somebody, read as success forever. The refusal is in
 * `server/admin-routes.ts`, where the body is, and it reads its list from
 * here so there is one answer to "what can that credential change".
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getAdminPrincipal } from './admin-auth.js';

/** One admin route, as a verb and a path RELATIVE to `ADMIN_API_PREFIX`, the form an express router registers. */
export interface AdminRouteRef {
  /** Upper case, as `req.method` reports it. */
  method: string;
  path: string;
}

/**
 * The three routes the service principal may reach.
 *
 * The single read and the patch are the biller's two writes and its check of
 * one account. The third is reconciliation: the nightly job that names every
 * paid period this service believes in, so it can be compared against every
 * subscription the biller believes in, in both directions.
 */
export const SERVICE_PRINCIPAL_ROUTES: readonly AdminRouteRef[] = [
  { method: 'GET', path: '/accounts/expiring' },
  { method: 'GET', path: '/accounts/:id' },
  { method: 'PATCH', path: '/accounts/:id' },
];

/**
 * The only two fields a service-principal PATCH may name.
 *
 * `role`, `suspended` and `displayName` are absent deliberately: paying for a
 * plan buys an allowance, and it must not be able to buy an administrator.
 */
export const SERVICE_PRINCIPAL_PATCH_FIELDS: readonly string[] = ['allowanceExpiresAt', 'dailyAiLimit'];

/** The machine code for a route this credential may not reach. A code, not a sentence: the caller is a program. */
export const SERVICE_SCOPE_REFUSAL = 'service-scope';

/** The machine code for a body naming a field this credential may not write. */
export const SERVICE_FIELD_REFUSAL = 'service-scope-field';

/** `:id` stands for an account's serial primary key, and matches nothing else. See `parseAccountId`. */
function isAccountIdSegment(segment: string): boolean {
  const parsed = Number(segment);
  return Number.isInteger(parsed) && parsed > 0;
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Whether a request the admin middleware just authenticated is one of the
 * three.
 *
 * The comparison is per SEGMENT rather than by regular expression, because the
 * question being asked is "is this that route", and a pattern that matched a
 * path this router would send somewhere else would be answering a different
 * one. `expiring` therefore never satisfies `:id`, which is what keeps the
 * reconciliation path and the single read two entries rather than one.
 */
export function isServiceRouteAllowed(input: AdminRouteRef): boolean {
  const presented = segmentsOf(input.path);
  return SERVICE_PRINCIPAL_ROUTES.some((allowed) => {
    if (allowed.method !== input.method.toUpperCase()) return false;
    const pattern = segmentsOf(allowed.path);
    if (pattern.length !== presented.length) return false;
    return pattern.every((segment, index) => {
      const value = presented[index] ?? '';
      return segment === ':id' ? isAccountIdSegment(value) : segment === value;
    });
  });
}

/**
 * The gate. A no-op for the operator's two credentials, default deny for the
 * biller's.
 *
 * It runs on the admin mount, so `req.path` here is already relative to
 * `ADMIN_API_PREFIX` and is the same string an express router matches. A
 * request that never passed the admin middleware has no principal and is
 * waved through, because on this service there is no such request: the
 * middleware runs first in the same `app.use` and either attaches a principal
 * or answers.
 */
export const enforceServicePrincipalScope: RequestHandler = function enforceScope(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const principal = getAdminPrincipal(req);
  if (principal === null || principal.kind !== 'service') {
    next();
    return;
  }
  if (isServiceRouteAllowed({ method: req.method, path: req.path })) {
    next();
    return;
  }
  res.status(403).json({ error: SERVICE_SCOPE_REFUSAL });
};
