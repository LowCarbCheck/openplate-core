/**
 * Service entry point, the only module in `src/` that reads `process.env`,
 * opens sockets, or decides when the process should die.
 *
 * Boot order is deliberate and strict:
 *   1. Parse config. A misconfiguration must kill the process here, before
 *      anything downstream has a chance to half-work.
 *   2. Wait for Postgres (bounded retry, a `docker compose up` starts both
 *      at once and the database is not ready for a second or two).
 *   3. Run migrations. A self-hoster pulling a newer image must never have to
 *      run a second command, and a half-migrated schema must never serve a
 *      request.
 *   4. Only then open the listener.
 *
 * Anything that fails in 1-3 exits non-zero with a scrubbed message, so a
 * container orchestrator restarts (or, for a genuinely bad config, backs off
 * and reports) rather than a broken instance quietly accepting signups.
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { parseConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDatabase, runMigrations, waitForDatabase } from './db/client.js';
import { createDrizzleAccountStore } from './db/account-store.js';
import { createDrizzleStorageAdapter } from './db/storage-adapter.js';
import { createDrizzleBlobRollbackStore } from './db/blob-rollback-store.js';
import { createDrizzleAdminStore } from './db/admin-store.js';
import { createDrizzleInviteStore } from './db/invite-store.js';
import { createDrizzleShareStore } from './db/share-store.js';
import { createDrizzleRotationStore } from './db/rotation-store.js';
import { createDrizzleResearchStore } from './db/research-store.js';
import { deriveServerSecrets } from './lib/server-secrets.js';
import { createThrottleStore } from './lib/throttle.js';
import { generateFamilyId, generatePasswordResetToken, generateToken } from './lib/tokens.js';
import { createMailer } from './mail/mailer.js';
import { createDrizzleAiQuotaStore } from './ai/quota-store.js';
import { AI_USAGE_RETENTION_DAYS, startAiUsageRetention } from './ai/usage-retention.js';
import { createDrizzleFeedbackStore } from './feedback/feedback-store.js';
import { createDrizzleFeedbackAdminStore } from './feedback/feedback-admin-store.js';
import { createDrizzleFeedbackImageStore } from './feedback/feedback-image-store.js';
import {
  FEEDBACK_RETENTION_DAYS,
  feedbackRetentionAdvertisement,
  startFeedbackRetention,
} from './feedback/feedback-retention.js';
import { createDrizzlePulseStore } from './pulse/pulse-store.js';
import { PULSE_RETENTION_DAYS, startPulseRetention } from './pulse/pulse-retention.js';
import { createDrizzlePushStore } from './push/push-store.js';
import { createWebPushSender } from './push/web-push-sender.js';
import { PUSH_DAILY_SEND_CAP, startPushScheduler } from './push/push-scheduler.js';
import { createApp } from './server/create-app.js';
import type { AuthContext } from './accounts/auth-handlers.js';
import type { InstanceInfo } from './protocol.js';
import { SERVICE_VERSION } from './version.js';

/** How long a fully-expired token row is kept before the sweeper drops it. */
const TOKEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How often the sweeper runs. Hourly is far more often than necessary and costs one indexed DELETE. */
const TOKEN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const logger = createLogger({ component: 'openplate-core', level: config.logLevel });

  const secrets = deriveServerSecrets(config.serverSecret);
  const database = createDatabase({ connectionString: config.databaseUrl, ssl: config.databaseSsl });

  await waitForDatabase({ pool: database.pool, logger });
  await runMigrations({
    db: database.db,
    migrationsFolder: resolve(process.env.MIGRATIONS_DIR ?? 'drizzle/migrations'),
  });
  logger.info('Migrations applied');

  // Both or neither, by construction: `parseConfig` refuses to boot with mail
  // configured and no link bases, so this is a narrowing rather than a policy.
  // With no mail an instance gets the no-op mailer, and every invitation comes
  // back as a link for the operator to paste.
  const links =
    config.clientBaseUrl !== null && config.serverPublicUrl !== null
      ? { clientBaseUrl: config.clientBaseUrl, serverPublicUrl: config.serverPublicUrl }
      : null;
  const mailer = createMailer({
    mail: config.mail,
    links,
    language: config.instanceLanguage,
    logger,
  });

  // BUILT BEFORE THE AUTH CONTEXT, because the member mint is on the auth
  // router and needs the same store the admin tree mints through, see
  // `AuthContext.memberInvites`.
  const invites = createDrizzleInviteStore(database.db);

  const authContext: AuthContext = {
    store: createDrizzleAccountStore(database.db),
    pepper: secrets.verifierPepper,
    enumerationSecret: secrets.enumerationSecret,
    escrowKey: secrets.escrowKey,
    mailer,
    now: () => new Date(),
    mintToken: generateToken,
    mintResetToken: generatePasswordResetToken,
    mintFamilyId: generateFamilyId,
    logger,
    // `null` unless BOTH member-invite settings are configured, which leaves
    // `POST /v1/auth/invites` answering the ordinary unknown-path 404, see
    // `accounts/register-auth-routes.ts`.
    memberInvites: config.memberInvites === null ? null : { invites, policy: config.memberInvites },
  };

  // ALWAYS PRESENT, because signup is invite-only and the invite store is the
  // only door onto this service. `token: null` means no static break-glass
  // credential, which leaves the tree answering the ordinary unknown-path 404
  // until an admin account signs in, see `server/admin-auth.ts`.
  const admin = {
    token: config.adminToken,
    // The biller's scoped credential (M213). `null` on every instance that has
    // not set `BILLING_TOKEN`, which means the third principal does not exist
    // there and its three routes are the operator's alone.
    billingToken: config.billingToken,
    metadata: createDrizzleAdminStore(database.db),
    invites,
    // The restore path of ADR-0009. Its own store, so nothing on the sync
    // routes can reach a delete of an accepted write.
    blobs: createDrizzleBlobRollbackStore(database.db),
    // The same pair the mailer builds its links from, so an admin response and
    // a letter can never disagree about where a link points.
    links,
  };

  // An instance with no static token and no admin account can never mint an
  // invite, so nobody can ever register on it. That is a misconfiguration worth
  // shouting about, and deliberately NOT fatal: an admin account created
  // before the token was removed still works, and refusing to boot would lock
  // out the very person who could fix it.
  if (config.adminToken === null) {
    logger.warn(
      'No ADMIN_TOKEN: only an account with role "admin" can reach /v1/admin. ' +
        'Set ADMIN_TOKEN if you need a break-glass credential that does not depend on an account.',
    );
  }

  // `null` unless UPSTREAM_API_KEY is set, which leaves
  // `POST /v1/chat/completions` answering the ordinary unknown-path 404, see
  // `server/create-app.ts`.
  // BUILT UNCONDITIONALLY, unlike the `ai` surface below. This store owns
  // `ai_usage_days` at both ends, and the retention sweep at the bottom of this
  // file has to run on every instance: one that had an upstream key last year
  // and none today still holds the counters from when it did, and a sweep wired
  // behind the flag would leave exactly those rows in place forever.
  const aiQuota = createDrizzleAiQuotaStore(database.db);

  const ai =
    config.ai === null
      ? null
      : {
          upstream: config.ai,
          quota: aiQuota,
          perMinute: config.aiRateLimitPerMinute,
          maxRequestBytes: config.aiMaxRequestBytes,
          instanceDailyLimit: config.aiInstanceDailyLimit,
        };

  const instance: InstanceInfo = {
    name: config.instanceName,
    language: config.instanceLanguage,
    // Both reported honestly rather than omitted: a client that sees
    // `mail: false` knows to show the operator a link instead of promising a
    // letter, and one that sees `ai: null` knows not to offer a scan.
    mail: config.mail !== null,
    // DESCRIPTIVE, NEVER A GRANT, like every other field here: it says whether
    // a client should draw an invite card, and the cap, the re-invite rule and
    // the throttle stay on the server whatever it says. Built from the SAME
    // config binding that decides whether the route exists at all.
    memberInvites: config.memberInvites !== null,
    // DESCRIPTIVE, NEVER A GRANT. It says an upstream is configured, not that
    // the caller may use it: an account with `dailyAiLimit: 0` gets a 403
    // whatever this says. The model name is advertising copy the operator
    // chose, and `null` when they chose none.
    //
    // THE INSTANCE CEILING IS DELIBERATELY NOT HERE, and this is where a reader
    // looking for it will look. `AI_INSTANCE_DAILY_LIMIT` is the operator's
    // BUDGET, and `/health` is unauthenticated: publishing it would tell any
    // stranger how much the operator is willing to spend per day and how much
    // of it is left. A client also could not act on it, because it never learns
    // how much of the ceiling is spent, so it can neither warn nor plan. The
    // one thing it does need, "the instance is out of capacity right now", it
    // learns from the 503 the proxy answers. `GET /v1/admin/stats` reports it
    // to the operator instead, behind the admin credential.
    ai: ai === null ? null : { model: config.aiAdvertisedModel },
    // DESCRIPTIVE, NEVER A GRANT, and built from the SAME config binding that
    // decides whether the subtree is mounted at all, so an instance cannot
    // advertise a door it does not have. `false` means `/v1/plans/*` answers
    // the ordinary unknown-path 404 here, and a client draws no plan door.
    plans: config.plans !== null,
    // DESCRIPTIVE, NEVER A GRANT, and built from the SAME config binding that
    // decides whether the subtree is mounted at all, so an instance cannot
    // advertise a door it does not have. `false` means `/v1/push/*` answers the
    // ordinary unknown-path 404 here, and a client draws no notification
    // settings. It says nothing about what a push contains, because a push
    // contains a kind. See ADR-0008.
    push: config.push !== null,
  };

  // `null` unless SYNC_SHARING is on, which leaves both share subtrees
  // answering the ordinary unknown-path 404, see `server/create-app.ts`.
  const shares = config.sharingEnabled ? createDrizzleShareStore(database.db) : null;

  // `null` unless SYNC_RESEARCH is on, which leaves both contribution
  // subtrees answering the ordinary unknown-path 404, see
  // `server/create-app.ts`. Decided independently of `shares`: neither flag
  // implies the other.
  const research = config.researchEnabled ? createDrizzleResearchStore(database.db) : null;

  // `null` unless SYNC_FEEDBACK is on, which leaves the whole `/v1/feedback`
  // subtree answering the ordinary unknown-path 404, see
  // `server/create-app.ts`. Decided independently of every other flag, and it
  // is the one whose cost is different in kind: an instance with this on holds
  // photographs of its users' food that the operator can look at.
  const feedback = config.feedbackEnabled
    ? {
        reports: createDrizzleFeedbackStore(database.db),
        review: createDrizzleFeedbackAdminStore(database.db),
        images: createDrizzleFeedbackImageStore(database.db),
        dailyLimit: config.feedbackDailyLimit,
        maxRequestBytes: config.feedbackMaxRequestBytes,
      }
    : null;

  // THE RETENTION WINDOW, ADVERTISED, AND ONLY WHEN THERE IS ONE TO KEEP.
  //
  // The app has to tell a person how long a photograph of their food is kept
  // BEFORE they hand it over, and it is a separate deployable that cannot
  // import this constant. So the promise is published here, from the same
  // binding the sweep above deletes on: change the number and both move.
  //
  // ABSENT, NOT NULL, when the feature is off. An instance with SYNC_FEEDBACK
  // unset has no promise to make and adds no key to the handshake, so it stays
  // indistinguishable from one built before this field existed, exactly as its
  // 404 keeps its `/v1/feedback` tree indistinguishable from one where the
  // feature was never written. A client that finds no window offers no report.
  if (feedback !== null) instance.feedback = feedbackRetentionAdvertisement();

  // THE COMMUNITY PULSE, on every instance and with no flag to read: the opt in
  // is on the device, and the sweep at the bottom of this file has to run
  // whatever anybody's device is doing today. See ADR-0007.
  const pulse = createDrizzlePulseStore(database.db);

  // WEB PUSH (M223). `null` unless all three `VAPID_*` variables are set, which
  // leaves the whole `/v1/push` subtree answering the ordinary unknown-path
  // 404, see `server/create-app.ts`. The store is built only when there is a
  // key to sign with: unlike the AI quota store above there is no counter here
  // that outlives the feature being on, so an instance with no keys has nothing
  // to read and nothing to sweep.
  const push =
    config.push === null ? null : { store: createDrizzlePushStore(database.db), publicKey: config.push.publicKey };

  const app = createApp({
    authContext,
    storage: createDrizzleStorageAdapter(database.db),
    rotation: createDrizzleRotationStore(database.db),
    throttle: createThrottleStore(),
    logger,
    trustProxy: config.trustProxy,
    notice: config.notice,
    instance,
    mailer,
    mailConfigured: config.mail !== null,
    admin,
    ai,
    // `null` unless PLANS_UPSTREAM_URL and PLANS_UPSTREAM_SECRET are both set,
    // which leaves the whole `/v1/plans` subtree answering the ordinary
    // unknown-path 404, see `server/create-app.ts`.
    plans: config.plans,
    shares,
    research,
    feedback,
    pulse,
    push,
  });

  // NO HOST MEANS EVERY INTERFACE, and that is the production default on
  // purpose: this process runs in a container behind Traefik, whose only route
  // in is the container network address. A loopback bind here would leave the
  // proxy unable to reach the service, so nobody should "harden" this. `HOST`
  // is the opt-in, and it is the development machine that wants it: a dev
  // instance with a seeded database and an admin token, bound to everything, is
  // reachable from every machine on the operator's LAN.
  //
  // NOT DEFAULTED TO `0.0.0.0`. That string is IPv4 only, while the no-host
  // form of `listen` takes IPv6 as well, so writing it out would quietly narrow
  // what production binds today.
  const server = app.listen({ port: config.port, host: config.host ?? undefined }, () => {
    logger.info('openplate-core listening', {
      port: config.port,
      // The bound address, honestly: `null` is not "no host", it is every one.
      host: config.host ?? 'all interfaces',
      serviceVersion: SERVICE_VERSION,
      instanceName: config.instanceName,
      instanceLanguage: config.instanceLanguage,
      // Whether a break-glass credential exists on this instance, never its value.
      adminToken: config.adminToken !== null,
      // Whether a biller reaches this instance, never its credential.
      billingToken: config.billingToken !== null,
      mail: config.mail !== null,
      ai: ai !== null,
      sharing: shares !== null,
      research: research !== null,
      feedback: feedback !== null,
      memberInvites: config.memberInvites !== null,
      // Whether a biller stands behind this instance, never its URL and never
      // its shared secret.
      plans: config.plans !== null,
      // Whether this instance can send a notification, never a key and never the subject.
      push: config.push !== null,
    });
  });

  // RETENTION, RUNNING ON ITS OWN, on every instance that holds photographs.
  // The consent wording a person read names a number of days and this is what
  // makes that sentence true without an operator remembering anything. `null`
  // when the feature is off, because there is nothing to sweep and an interval
  // that always finds nothing is still a timer somebody has to explain.
  const feedbackRetention =
    feedback === null
      ? null
      : startFeedbackRetention({
          reports: feedback.review,
          images: feedback.images,
          logger,
          now: () => new Date(),
        });
  if (feedbackRetention !== null) {
    logger.info('Feedback retention sweep started', { retentionDays: FEEDBACK_RETENTION_DAYS });
  }

  // THE COUNTERS EXPIRE, on every instance, whatever the AI surface is doing.
  // `ai_usage_days` grew without bound from the day it was added, and one row
  // per account per active day is a trace of when a person opened a health app.
  // Ninety days is the operator's decision and the same window
  // `GET /v1/admin/accounts/:id/activity` can show, so an operator never reads
  // a pruned row as an absence of activity.
  const aiUsageRetention = startAiUsageRetention({
    quota: aiQuota,
    logger,
    now: () => new Date(),
  });
  logger.info('AI usage retention sweep started', { retentionDays: AI_USAGE_RETENTION_DAYS });

  // THE PULSE ROWS EXPIRE, on every instance, for the reason the AI counters do
  // and one more: a contributor row says an account was here on a day, and a
  // presence row says somebody is fasting right now. Thirty days for the sums,
  // thirty minutes for presence, twenty-four hours for an idempotency key.
  const pulseRetention = startPulseRetention({ pulse, logger, now: () => new Date() });
  logger.info('Community pulse retention sweep started', { retentionDays: PULSE_RETENTION_DAYS });

  // THE MINUTE TICK, and only on an instance that can send. Unlike every sweep
  // above it is not a retention job: it has nothing to expire, and a tick on an
  // instance with no keys would be a timer that finds work it cannot do. A
  // catch-up due at 08:00 is why the period is a minute rather than the hour
  // the sweeps use. See `push/push-scheduler.ts` and ADR-0008.
  const pushScheduler =
    push === null || config.push === null
      ? null
      : startPushScheduler({
          store: push.store,
          sender: createWebPushSender(config.push),
          logger,
          now: () => new Date(),
        });
  if (pushScheduler !== null) {
    logger.info('Push scheduler started', { dailySendCap: PUSH_DAILY_SEND_CAP });
  }

  const accountStore = authContext.store;
  const sweeper = setInterval(() => {
    void (async () => {
      try {
        const deleted = await accountStore.purgeExpiredTokens({
          before: new Date(Date.now() - TOKEN_RETENTION_MS),
        });
        if (deleted > 0) logger.info('Purged expired token rows', { deleted });
      } catch (cause) {
        logger.error('Token sweep failed', { error: cause instanceof Error ? cause.message : 'unknown error' });
      }
    })();
  }, TOKEN_SWEEP_INTERVAL_MS);
  // Never the reason the process stays alive.
  sweeper.unref();

  async function shutdown(signal: string): Promise<void> {
    logger.info('Shutting down', { signal });
    clearInterval(sweeper);
    feedbackRetention?.stop();
    aiUsageRetention.stop();
    pulseRetention.stop();
    pushScheduler?.stop();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await database.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((cause: unknown) => {
  // Scrubbed: a config or connection error can carry a connection string.
  process.stderr.write(`${cause instanceof Error ? cause.message : 'unknown startup error'}\n`);
  process.exit(1);
});
