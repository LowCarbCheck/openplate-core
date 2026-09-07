/**
 * The module surface of this package, for readers and tests.
 *
 * `src/main.ts` — not this file — is the SERVICE entry point (the thing
 * `pnpm start` and the Docker image run). This barrel exists so the pieces
 * can be imported individually: the composition root without the process
 * lifecycle, the handler cores without Express, the wire contract without
 * either.
 *
 * What used to live here — the client crypto, envelope and merge modules —
 * moved into the openplate app (`app/lib/sync/engine/`) in M128 spec 01. They
 * were never the server's business: it stores opaque bytes and cannot decrypt
 * them by construction, so shipping the crypto alongside it only blurred
 * where the trust boundary actually sits.
 */

// The wire contract (normative document: PROTOCOL.md).
export * from './protocol.js';
export type * from './contract-types.js';

// HTTP composition.
export { createApp } from './server/create-app.js';
export type { CreateAppOptions, AdminSurfaceOptions, FeedbackSurfaceOptions } from './server/create-app.js';
export { registerSyncRoutes } from './server/register-routes.js';
export { registerAuthRoutes, AUTH_API_PREFIX } from './accounts/register-auth-routes.js';
export { createAdminRoutes, ADMIN_API_PREFIX } from './server/admin-routes.js';
export { createAdminFeedbackRoutes, ADMIN_FEEDBACK_PATH } from './server/admin-feedback-routes.js';
export { registerFeedbackRoute, FEEDBACK_API_PREFIX } from './feedback/register-feedback-route.js';
export { createAdminAuthMiddleware } from './server/admin-auth.js';
export { createBearerAuthMiddleware, createEntitledUserResolver, getRequestSession } from './server/bearer-auth.js';

// Account system.
export * from './accounts/auth-handlers.js';
export type * from './accounts/account-store.js';

// Persistence.
export { createDatabase, runMigrations, waitForDatabase } from './db/client.js';
export type { Database, DatabaseHandle } from './db/client.js';
export { createDrizzleAccountStore } from './db/account-store.js';
export { createDrizzleStorageAdapter } from './db/storage-adapter.js';
export { createDrizzleAdminStore } from './db/admin-store.js';
export { createDrizzleInviteStore } from './db/invite-store.js';
export { createDrizzleFeedbackStore } from './feedback/feedback-store.js';
export type { FeedbackStore, SubmitFeedbackInput, SubmitFeedbackResult } from './feedback/feedback-store.js';
export { createDrizzleFeedbackImageStore } from './feedback/feedback-image-store.js';
export type { FeedbackImage, FeedbackImageStore } from './feedback/feedback-image-store.js';
export { createDrizzleFeedbackAdminStore } from './feedback/feedback-admin-store.js';
export type {
  FeedbackAdminStore,
  FeedbackReportDetail,
  FeedbackReportSummary,
} from './feedback/feedback-admin-store.js';
// THE RETENTION WINDOW, AND THE THING /health ADVERTISES. It is the number a
// person is shown before they hand over a photograph, and the number the sweep
// deletes on. The client lives in another repository and reads it off the
// handshake, so `feedbackRetentionAdvertisement` is the one place the promise
// is minted. See `feedback/feedback-retention.ts`.
export {
  FEEDBACK_RETENTION_DAYS,
  FEEDBACK_RETENTION_MS,
  feedbackRetentionAdvertisement,
  feedbackRetentionCutoff,
  purgeExpiredFeedback,
  startFeedbackRetention,
} from './feedback/feedback-retention.js';
export type { FeedbackRetentionSweep } from './feedback/feedback-retention.js';
export type * from './admin/admin-store.js';
export { activityWindow, clampActivityWindowDays, zeroFillActivityDays } from './admin/account-activity.js';
export type { ActivityDay, ActivityWindow } from './admin/account-activity.js';
// THE OTHER RETENTION WINDOW, and the one that is not advertised because
// nothing outside the operator's console reads it. It is the number the sweep
// prunes `ai_usage_days` at AND the longest activity strip an operator can ask
// for, which is why both live on one binding. See `ai/usage-retention.ts`.
export {
  AI_USAGE_RETENTION_DAYS,
  AI_USAGE_RETENTION_INTERVAL_MS,
  aiUsageRetentionCutoffDay,
  purgeExpiredAiUsage,
  startAiUsageRetention,
} from './ai/usage-retention.js';
export type { AiUsageRetentionSweep } from './ai/usage-retention.js';
export { createDrizzleAiQuotaStore } from './ai/quota-store.js';
export type { AiQuotaStore, ReserveResult } from './ai/quota-store.js';
export { inviteStatus } from './admin/invite-store.js';
export type * from './admin/invite-store.js';
export * as schema from './db/schema.js';

// Configuration and cross-cutting utilities.
export { parseConfig } from './config.js';
export type { ServiceConfig } from './config.js';
export { createLogger, createSilentLogger } from './logger.js';
export type { Logger, LogLevel } from './logger.js';
export { deriveServerSecrets } from './lib/server-secrets.js';
export { createThrottleStore } from './lib/throttle.js';
export * from './lib/tokens.js';
export * from './lib/verifier.js';
export * from './lib/kdf-descriptor.js';
export * from './lib/escrow.js';
export { utcDayKey, utcDayKeyDaysBefore } from './lib/utc-day.js';
export { SERVICE_VERSION } from './version.js';

// The mail PORT, and the no-op behind it. Spec 02 adds the pigeon transport.
export { createNoopMailer } from './mail/mailer.js';
export type { Mailer, SendInviteInput, SendResetInput } from './mail/mailer.js';
