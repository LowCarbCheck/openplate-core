/**
 * The operator's view of a reported estimate: list it, open it, look at the
 * photograph, delete it.
 *
 * IT IS A SECOND ROUTER ON THE SAME TREE, NOT A SECOND DOOR. These paths live
 * under `ADMIN_API_PREFIX` and `create-app.ts` mounts them behind the SAME
 * `createAdminAuthMiddleware` instance the account and invite routes are
 * behind, so there is one admin credential on this service and one place that
 * decides what it is (`server/admin-auth.ts`). A separate router rather than
 * more handlers in `admin-routes.ts` because this family is gated by a SECOND
 * condition that the account family is not: `SYNC_FEEDBACK`. Mixing the two
 * gates into one file would mean every future reader of the account routes has
 * to work out which of the two applies to the handler they are looking at.
 *
 * TWO GATES, BOTH LOAD-BEARING, and neither is a substitute for the other.
 *
 *  1. `SYNC_FEEDBACK` off means `/v1/admin/feedback*` answers the ordinary
 *     unknown-path 404, to an authenticated administrator as much as to
 *     anybody: on an instance that stores no reports there is nothing here, and
 *     a mounted-but-empty list would tell an operator the feature exists and is
 *     merely switched off. The terminator is mounted on the PREFIX rather than
 *     on the three paths, so a verb added later is dark by default rather than
 *     by somebody remembering this file.
 *  2. Administrator authentication, which is not this module's to make: the
 *     middleware above it answers 404 on an instance with no admin credential
 *     and 401 on one that has, before anything below runs. A member's perfectly
 *     valid session is refused there, in one place, for the whole tree.
 *
 * THE IMAGE ROUTE IS THE ONLY PATH ON THIS SERVICE THAT SERVES A PERSON'S
 * PHOTOGRAPH TO SOMEBODY WHO IS NOT THEM. It is reachable by report id only,
 * behind the admin credential, and it is never a URL anybody can guess into:
 * there is no signed link, no token in a query string and no listing of images.
 * Every hit is logged. See the audit comment on the handler.
 *
 * See `docs/adr/0006-a-reported-photograph-is-the-second-hole-in-the-claim.md`
 * and `docs/adr/0001-an-admin-api-for-a-zero-knowledge-service.md`, whose every
 * prohibition this family inherits.
 */
import express from 'express';
import type { Request, Response, Router } from 'express';
import { asyncHandler } from './async-handler.js';
import { getAdminPrincipal } from './admin-auth.js';
import { handleNotFound } from './error-middleware.js';
import {
  DEFAULT_ADMIN_PAGE_LIMIT,
  MAX_ADMIN_PAGE_LIMIT,
  PAGING_REFUSAL,
  parseBoundedInteger,
  queryValue,
} from './admin-routes.js';
import type {
  FeedbackAdminStore,
  FeedbackReportDetail,
  FeedbackReportSummary,
} from '../feedback/feedback-admin-store.js';
import type { FeedbackImageStore } from '../feedback/feedback-image-store.js';
import type { JsonObject } from '../lib/json.js';
import type { Logger } from '../logger.js';

/** The subtree this family owns, relative to `ADMIN_API_PREFIX`. One name, so the terminator cannot miss a path. */
export const ADMIN_FEEDBACK_PATH = '/feedback';

/** The wire shape of one row in the operator's queue. No figures, no image, nothing from anybody's diary. */
interface AdminFeedbackSummaryView {
  id: number;
  accountId: number;
  hasImage: boolean;
  consentWordingVersion: string;
  createdAt: string;
}

/** The wire shape of one opened report: the figures beside the consent record that let them be kept. */
interface AdminFeedbackDetailView extends AdminFeedbackSummaryView {
  measurements: JsonObject;
  consent: { agreedAt: string; wordingVersion: string };
}

/** The ONLY function that turns a report into a list body. Every field is named; nothing is spread in from a row. */
function toSummaryView(report: FeedbackReportSummary): AdminFeedbackSummaryView {
  return {
    id: report.id,
    accountId: report.accountId,
    hasImage: report.hasImage,
    consentWordingVersion: report.consentWordingVersion,
    createdAt: report.createdAt.toISOString(),
  };
}

/**
 * The ONLY function that turns a report into a detail body.
 *
 * `measurements` GOES BACK VERBATIM, which is the point of the screen: a
 * reviewer looks at the figures the model produced beside the photograph they
 * were produced from. The service has no opinion about their shape (the write
 * path bounds their size and nothing else), so it has none here either.
 */
function toDetailView(report: FeedbackReportDetail): AdminFeedbackDetailView {
  return {
    ...toSummaryView(report),
    measurements: report.measurements,
    consent: {
      agreedAt: report.consentAgreedAt.toISOString(),
      wordingVersion: report.consentWordingVersion,
    },
  };
}

/** A path `:id` is a report's serial primary key: a positive integer and nothing else. */
function parseReportId(raw: string): number | null {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The same sentence for "no such report" everywhere, and never the id that was asked about. */
function sendNotFound(res: Response): void {
  res.status(404).json({ error: 'no such report' });
}

/**
 * Which admin credential was presented. `unknown` is unreachable
 * through a mounted route (the middleware attaches a principal before any
 * handler runs) and exists so an audit line can never be silently absent: a
 * handler reached some other way logs "somebody" rather than nothing.
 */
type AdminCredentialKind = 'static-token' | 'account' | 'service' | 'unknown';

/** The two fields every audit line below carries. Named, so both call sites emit the same shape. */
interface AdminAuditFields {
  credential: AdminCredentialKind;
  /** `null` for the static break-glass token, which belongs to whoever runs the container and is not an account. */
  adminAccountId: number | null;
}

/** Who is holding the credential on this request, in the two fields a log line may carry. */
function describeAdmin(req: Request): AdminAuditFields {
  const principal = getAdminPrincipal(req);
  if (principal === null) return { credential: 'unknown', adminAccountId: null };
  if (principal.kind === 'static') return { credential: 'static-token', adminAccountId: null };
  // UNREACHABLE THROUGH A MOUNTED ROUTE, and named anyway for the reason
  // `unknown` is: the biller's credential is refused on this whole family by
  // `enforceServicePrincipalScope`, which runs before this router, so a line
  // saying `service` here would be evidence that the scope stopped working.
  if (principal.kind === 'service') return { credential: 'service', adminAccountId: null };
  return { credential: 'account', adminAccountId: principal.accountId };
}

export interface AdminFeedbackSurface {
  /** List, read and delete. Deliberately not the submit store, see `feedback/feedback-admin-store.ts`. */
  reports: FeedbackAdminStore;
  /** The photograph, behind the interface, so a later object store is one adapter and no change here. */
  images: FeedbackImageStore;
}

export interface AdminFeedbackRoutesOptions {
  /** `null` is `SYNC_FEEDBACK` off, and it means the whole subtree answers the ordinary unknown-path 404. */
  surface: AdminFeedbackSurface | null;
  logger: Logger;
}

/**
 * Builds the router. It does NOT include authentication: `create-app.ts` mounts
 * it behind the same admin middleware every other operator route is behind.
 */
export function createAdminFeedbackRoutes(options: AdminFeedbackRoutesOptions): Router {
  const router = express.Router();
  const { surface, logger } = options;

  if (surface === null) {
    // No `SYNC_FEEDBACK` on this instance: an explicit 404 on the whole
    // subtree, never a bare absence and never an empty list.
    router.use(ADMIN_FEEDBACK_PATH, handleNotFound);
    return router;
  }

  const { reports, images } = surface;

  router.get(
    ADMIN_FEEDBACK_PATH,
    asyncHandler(async (req, res) => {
      const limit = parseBoundedInteger(queryValue(req, 'limit'), DEFAULT_ADMIN_PAGE_LIMIT, MAX_ADMIN_PAGE_LIMIT);
      const offset = parseBoundedInteger(queryValue(req, 'offset'), 0, Number.MAX_SAFE_INTEGER);
      if (!limit.ok || !offset.ok) {
        res.status(400).json({ error: PAGING_REFUSAL });
        return;
      }

      const page = await reports.list({ limit: limit.value, offset: offset.value });
      res.status(200).json({
        reports: page.reports.map(toSummaryView),
        total: page.total,
        limit: limit.value,
        offset: offset.value,
      });
    }),
  );

  router.get(
    `${ADMIN_FEEDBACK_PATH}/:id`,
    asyncHandler(async (req, res) => {
      const reportId = parseReportId(req.params.id ?? '');
      if (reportId === null) {
        sendNotFound(res);
        return;
      }

      const report = await reports.get(reportId);
      if (report === null) {
        sendNotFound(res);
        return;
      }
      // NOT LOGGED, and the asymmetry with the image route below is deliberate.
      // The figures are what the operator turned the feature on to read, and a
      // line per row scanned would bury the one line that matters.
      res.status(200).json({ report: toDetailView(report) });
    }),
  );

  router.get(
    `${ADMIN_FEEDBACK_PATH}/:id/image`,
    asyncHandler(async (req, res) => {
      const reportId = parseReportId(req.params.id ?? '');
      if (reportId === null) {
        sendNotFound(res);
        return;
      }

      const image = await images.get(reportId);
      if (image === null) {
        // A report that never had an image and one whose image retention
        // already took get the same answer. Telling them apart here would be a
        // second read of the row for nothing: `hasImage` on the detail is where
        // that distinction is answered honestly.
        sendNotFound(res);
        return;
      }

      // ── THE AUDIT LINE ────────────────────────────────────────────────────
      //
      // WHO, WHICH REPORT, WHEN. `ts` on the line is the when. An operator
      // holding an admin token can look at a person's meal, and the difference
      // between a controlled capability and an unaudited one is that somebody
      // can later say which photographs were opened and by whom.
      //
      // IN THE STRUCTURED LOG AND NOT IN A TABLE, deliberately, and this is the
      // part to argue with rather than to change quietly. A table was the first
      // design and it is worse here for three reasons. First, it is MORE
      // personal data held for LONGER: "admin 4 opened account 12's meal
      // photograph" is a record about two people, and it would outlive both the
      // photograph (thirty days) and, unless somebody remembers a second
      // cascade, the accounts themselves, so the erasure this spec exists to
      // guarantee would leave a trail behind. Second, an audit table an
      // administrator can reach is an audit table an administrator can delete;
      // the log is already shipped off the box by whatever collects the
      // service's stdout, which is the only property that makes an audit record
      // worth anything against the one person it is auditing. Third, this
      // service already logs every other operator action this way (`Account
      // changed by admin`, `Account deleted by admin`), so a table here would
      // put half the operator's actions in one place and half in another.
      //
      // If an instance ever needs a tamper-evident audit an operator cannot
      // reach, that is an append-only store somewhere else, and it belongs in
      // an ADR before it belongs in this file.
      const admin = describeAdmin(req);
      logger.info('Feedback image read by admin', {
        reportId,
        credential: admin.credential,
        adminAccountId: admin.adminAccountId,
      });

      // `no-store` so the photograph is not left in the reviewer's browser
      // cache or in any proxy between them and the service, and `nosniff` so a
      // stored type this route trusts cannot be re-read as something
      // executable. The write path's allowlist is the first half of that
      // bargain (`feedback/register-feedback-route.ts`).
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', image.contentType);
      res.status(200).send(image.bytes);
    }),
  );

  router.delete(
    `${ADMIN_FEEDBACK_PATH}/:id`,
    asyncHandler(async (req, res) => {
      const reportId = parseReportId(req.params.id ?? '');
      if (reportId === null) {
        sendNotFound(res);
        return;
      }

      // THE IMAGE THROUGH THE STORE FIRST, THEN THE ROW, and not the other way
      // round. `feedback_images` cascades from `feedback_reports` today, so
      // dropping the row alone would delete the bytes as well and this line
      // would look redundant. It is not: the cascade only exists while the
      // bytes happen to live in Postgres, and `FeedbackImageStore` exists so
      // they can stop. Ordered this way, the worst failure leaves a row whose
      // image is gone; ordered the other way, the worst failure leaves BYTES
      // NOBODY CAN REACH, because nothing enumerates an image store by design.
      // Same reasoning, and the same order, as the retention sweep.
      await images.delete(reportId);
      const deleted = await reports.delete(reportId);
      if (!deleted) {
        sendNotFound(res);
        return;
      }

      // The report id and who did it. Never the account the report belonged to:
      // the row is gone, and naming its owner here would keep a person in a log
      // after the thing about them was deleted.
      const admin = describeAdmin(req);
      logger.info('Feedback report deleted by admin', {
        reportId,
        credential: admin.credential,
        adminAccountId: admin.adminAccountId,
      });
      res.status(204).end();
    }),
  );

  return router;
}
