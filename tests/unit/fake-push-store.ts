/**
 * The one push table, in memory.
 *
 * IT IS NOT A SECOND IMPLEMENTATION OF POSTGRES'S RULES. The one statement
 * upsert and the unique index that makes a re-registration an update belong to
 * the database, and `tests/integration/push-routes.test.ts` proves them against
 * a real one. What this holds is the arithmetic the ROUTES and the TICK depend
 * on, so a test can walk a DST changeover minute by minute without a database.
 *
 * EVERY ROW IS READABLE, so a test asserts what was written rather than only
 * what came back. That is what catches a tick that sent without recording, or a
 * `replaces` that deleted somebody else's phone.
 */
import type {
  PushSchedulePatch,
  PushStats,
  PushStore,
  PushSubscriptionRow,
  PushSubscriptionUpsert,
  PushUpsertOutcome,
} from '../../src/push/push-store.js';

export interface FakePushStore extends PushStore {
  /** Every live row, by endpoint, in insertion order. A test reads it directly. */
  rows: Map<string, PushSubscriptionRow>;
  /** Seeds a row without going through a route, for a test about the tick rather than about registration. */
  seed(row: Partial<PushSubscriptionRow> & { endpoint: string; accountId: number; timeZone: string }): void;
}

/** Everything a seeded row needs that the caller did not name. Deliberately the quiet defaults: no schedule at all. */
function withDefaults(
  row: Partial<PushSubscriptionRow> & { endpoint: string; accountId: number; timeZone: string },
  id: number,
): PushSubscriptionRow {
  return {
    id,
    accountId: row.accountId,
    endpoint: row.endpoint,
    p256dh: row.p256dh ?? 'fake-p256dh',
    auth: row.auth ?? 'fake-auth',
    userAgent: row.userAgent ?? null,
    timeZone: row.timeZone,
    locale: row.locale ?? 'en',
    catchUpMinute: row.catchUpMinute ?? null,
    fastTargetEnabled: row.fastTargetEnabled ?? false,
    lastCatchUpDay: row.lastCatchUpDay ?? null,
    lastSeenDay: row.lastSeenDay ?? '1970-01-01',
    wakeAt: row.wakeAt ?? null,
    sendsTodayDay: row.sendsTodayDay ?? null,
    sendsToday: row.sendsToday ?? 0,
    createdAt: row.createdAt ?? new Date(0),
  };
}

export function createFakePushStore(): FakePushStore {
  const rows = new Map<string, PushSubscriptionRow>();
  let nextId = 1;

  return {
    rows,

    seed(row: Partial<PushSubscriptionRow> & { endpoint: string; accountId: number; timeZone: string }): void {
      rows.set(row.endpoint, withDefaults(row, nextId));
      nextId += 1;
    },

    async upsert(input: PushSubscriptionUpsert): Promise<PushUpsertOutcome> {
      const existing = rows.get(input.endpoint);
      rows.set(input.endpoint, {
        id: existing?.id ?? nextId,
        accountId: input.accountId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent,
        timeZone: input.timeZone,
        locale: input.locale,
        catchUpMinute: input.catchUpMinute,
        fastTargetEnabled: input.fastTargetEnabled,
        // Untouched by a re-registration, exactly as the real upsert leaves
        // them: a device saying it is still here has not been sent anything.
        lastCatchUpDay: existing?.lastCatchUpDay ?? null,
        lastSeenDay: input.lastSeenDay,
        wakeAt: existing?.wakeAt ?? null,
        sendsTodayDay: existing?.sendsTodayDay ?? null,
        sendsToday: existing?.sendsToday ?? 0,
        // "Since when has this device been subscribed", so a re-registration
        // does not restart the clock. The real store compares the same column.
        createdAt: existing?.createdAt ?? input.createdAt,
      });
      if (existing !== undefined) return 'refreshed';
      nextId += 1;
      return 'created';
    },

    async deleteSupersededEndpoint(input: { accountId: number; endpoint: string }): Promise<number> {
      const row = rows.get(input.endpoint);
      // THE ACCOUNT IS IN THE PREDICATE, as it is in the real store: naming
      // somebody else's endpoint must delete nothing.
      if (row === undefined || row.accountId !== input.accountId) return 0;
      rows.delete(input.endpoint);
      return 1;
    },

    async deleteOwnEndpoint(input: { accountId: number; endpoint: string }): Promise<number> {
      const row = rows.get(input.endpoint);
      if (row === undefined || row.accountId !== input.accountId) return 0;
      rows.delete(input.endpoint);
      return 1;
    },

    async deleteGoneEndpoint(input: { endpoint: string }): Promise<number> {
      return rows.delete(input.endpoint) ? 1 : 0;
    },

    async findOwn(input: { accountId: number; endpoint: string }): Promise<PushSubscriptionRow | null> {
      const row = rows.get(input.endpoint);
      return row === undefined || row.accountId !== input.accountId ? null : row;
    },

    async patch(input: PushSchedulePatch): Promise<PushSubscriptionRow | null> {
      const row = rows.get(input.endpoint);
      if (row === undefined || row.accountId !== input.accountId) return null;
      const updated: PushSubscriptionRow = {
        ...row,
        timeZone: input.timeZone ?? row.timeZone,
        locale: input.locale ?? row.locale,
        catchUpMinute: input.catchUpMinute === undefined ? row.catchUpMinute : input.catchUpMinute,
        fastTargetEnabled: input.fastTargetEnabled ?? row.fastTargetEnabled,
        wakeAt: input.wakeAt === undefined ? row.wakeAt : input.wakeAt,
        lastSeenDay: input.lastSeenDay,
      };
      rows.set(input.endpoint, updated);
      return updated;
    },

    async listSchedulable(): Promise<PushSubscriptionRow[]> {
      return [...rows.values()].filter((row) => row.catchUpMinute !== null || row.wakeAt !== null);
    },

    async markCatchUpSent(input: {
      endpoint: string;
      localDay: string;
      sendsDay: string;
      sends: number;
    }): Promise<void> {
      const row = rows.get(input.endpoint);
      if (row === undefined) return;
      rows.set(input.endpoint, {
        ...row,
        lastCatchUpDay: input.localDay,
        sendsTodayDay: input.sendsDay,
        sendsToday: input.sends,
      });
    },

    async markFastTargetSent(input: { endpoint: string; sendsDay: string; sends: number }): Promise<void> {
      const row = rows.get(input.endpoint);
      if (row === undefined) return;
      rows.set(input.endpoint, { ...row, wakeAt: null, sendsTodayDay: input.sendsDay, sendsToday: input.sends });
    },

    async stats(input: { day: string }): Promise<PushStats> {
      let sentToday = 0;
      for (const row of rows.values()) {
        if (row.sendsTodayDay === input.day) sentToday += row.sendsToday;
      }
      return { subscriptions: rows.size, sentToday };
    },
  };
}

/** One delivery a fake sender was asked for, so a test can assert the kind, the topic and the urgency. */
export interface RecordedPush {
  endpoint: string;
  payload: string;
  topic: string;
  urgency: string;
  ttl: number;
}

/** An error that carries an HTTP status the way `web-push` does, so the prune logic meets a real predicate. */
export class FakeWebPushError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super('Received unexpected response code');
    this.statusCode = statusCode;
    this.name = 'WebPushError';
  }
}
