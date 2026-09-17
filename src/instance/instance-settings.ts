/**
 * The instance's runtime-mutable settings: one stored row, held in memory, and
 * the rules that keep `/health` out of the database.
 *
 * ── WHY THERE IS A CACHE AT ALL ─────────────────────────────────────────────
 * `GET /health` publishes `instance.nutrientReferenceBasis`, and `/health` is
 * the CONTAINER'S OWN HEALTHCHECK. It is polled every few seconds forever, by
 * a process whose only reaction to a non-200 is to kill this one. A handler
 * that read a row there would turn a slow query, a failed-over primary or a
 * saturated pool into a restart loop, and Bay has taken this service down that
 * way before. So the value is loaded once, kept in a variable, and served from
 * there. The database is on the WRITE path and on a timer, never on the read.
 *
 * ── AN UNREADABLE ROW IS NOT A REFUSAL TO START ─────────────────────────────
 * `config.ts` fails fast on every knob it owns, and it is right to: a weak
 * `SERVER_SECRET` cannot be run with. This one can. The environment already
 * carries a valid default (`NUTRIENT_REFERENCE_BASIS`), so a row this process
 * could not read costs the operator a log line and the instance shows the
 * default until the next refresh succeeds. Refusing to boot would trade a
 * wrong-but-plausible number for no service at all.
 *
 * ── THE REFRESH IS INSURANCE, NOT THE MECHANISM ─────────────────────────────
 * A write goes through `set`, which persists and then updates this process's
 * own copy, so the replica that served the PATCH is correct immediately. The
 * 60 second poll exists for the OTHER replicas, which never saw the request.
 * It is deliberately dumb: one indexed read of one row, errors logged and
 * swallowed, the last good value kept.
 */
import type { NutrientReferenceBasis } from '../protocol.js';
import type { Logger } from '../logger.js';

/** The stored row, as everything above the database sees it. */
export interface InstanceSettingsRecord {
  nutrientReferenceBasis: NutrientReferenceBasis;
  updatedAt: Date;
}

/**
 * The persistence contract. One row, so there is no id to pass and no list to
 * page: `read` answers the row or `null` for an instance nobody has changed
 * anything on, and `write` upserts it.
 */
export interface InstanceSettingsStore {
  read(): Promise<InstanceSettingsRecord | null>;
  write(input: { nutrientReferenceBasis: NutrientReferenceBasis; now: Date }): Promise<InstanceSettingsRecord>;
}

/**
 * What the HTTP layer is given: a synchronous read and an asynchronous write.
 *
 * `current()` RETURNS A VALUE RATHER THAN A PROMISE, and that is the whole
 * contract rather than an ergonomic detail. A caller cannot accidentally put a
 * query on `/health` because there is no query to put there.
 */
export interface InstanceSettingsSurface {
  /** The process-local value. Never a query, see the module header. */
  current(): NutrientReferenceBasis;
  /**
   * Persists the choice, then adopts it here. It THROWS when the write fails,
   * so the route answers 500 rather than reporting a change it did not make.
   */
  set(input: { nutrientReferenceBasis: NutrientReferenceBasis }): Promise<void>;
}

export interface InstanceSettings extends InstanceSettingsSurface {
  /** Stops the refresh timer. Called on shutdown, and by a test that owns the clock. */
  stop(): void;
}

/** How often a replica that served no write re-reads the row. */
export const SETTINGS_REFRESH_INTERVAL_MS = 60_000;

export interface StartInstanceSettingsOptions {
  store: InstanceSettingsStore;
  /**
   * `NUTRIENT_REFERENCE_BASIS`. Used until the row is read, and kept when it
   * cannot be read at all.
   */
  fallback: NutrientReferenceBasis;
  logger: Logger;
  /** Injected, like every clock in this repo. */
  now?: () => Date;
  /** Injected so a test does not wait a minute. */
  refreshIntervalMs?: number;
}

/**
 * Reads the row once, then serves it from memory.
 *
 * IT NEVER REJECTS. A boot that cannot reach the database still returns a
 * usable surface on the environment default, because the alternative is a
 * service that will not start over a value it already has a correct answer for.
 */
export async function startInstanceSettings(options: StartInstanceSettingsOptions): Promise<InstanceSettings> {
  const { store, logger } = options;
  const now = options.now ?? ((): Date => new Date());
  let basis = options.fallback;

  async function refresh(): Promise<void> {
    const row = await store.read();
    // A missing row is the ordinary state of an instance nobody has changed
    // anything on, never an error: the environment default stands until
    // somebody writes one.
    if (row !== null) basis = row.nutrientReferenceBasis;
  }

  try {
    await refresh();
  } catch (cause) {
    // AN ERROR, NOT A THROW. The operator needs to know the service is showing
    // the environment default rather than what they set, and the service needs
    // to keep serving while they find out.
    logger.error('Could not read instance settings at boot, using the environment default', {
      nutrientReferenceBasis: basis,
      error: cause instanceof Error ? cause.message : 'unknown error',
    });
  }

  const timer = setInterval(() => {
    void refresh().catch((cause: unknown) => {
      logger.warn('Instance settings refresh failed, keeping the last known value', {
        nutrientReferenceBasis: basis,
        error: cause instanceof Error ? cause.message : 'unknown error',
      });
    });
  }, options.refreshIntervalMs ?? SETTINGS_REFRESH_INTERVAL_MS);
  // Never the reason the process stays alive, exactly like the token sweeper.
  timer.unref();

  return {
    current(): NutrientReferenceBasis {
      return basis;
    },
    async set(input: { nutrientReferenceBasis: NutrientReferenceBasis }): Promise<void> {
      // PERSIST FIRST, ADOPT SECOND. A failed write must leave this process
      // reporting what is actually stored, not what somebody asked for.
      const written = await store.write({ nutrientReferenceBasis: input.nutrientReferenceBasis, now: now() });
      basis = written.nutrientReferenceBasis;
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
