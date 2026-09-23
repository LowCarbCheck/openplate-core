/**
 * The declarations' retention, against the real table and the real hourly
 * sweep that applies it (owner's decision, 2026-09-23).
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { legalDeclarations } from '../../src/db/schema.js';
import { createDrizzleLegalDeclarationsStore } from '../../src/legal/legal-declarations-store.js';
import { createDrizzleAiQuotaStore } from '../../src/ai/quota-store.js';
import { startAiUsageRetention } from '../../src/ai/usage-retention.js';
import type { LogFields, Logger } from '../../src/logger.js';

let database: TestDatabase;

before(async () => {
  database = await setupTestDatabase();
});

after(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

async function declare(input: { id: string; receivedAt: string }): Promise<void> {
  await createDrizzleLegalDeclarationsStore(database.db).create({
    id: input.id,
    kind: 'kuendigung',
    name: 'Anna Beispiel',
    email: 'anna@example.org',
    contractReference: null,
    terminationType: 'ordentlich',
    reason: null,
    requestedDate: null,
    timing: 'earliest',
    language: 'de',
    receivedAt: new Date(input.receivedAt),
    accountId: null,
  });
}

interface RecordedLine {
  message: string;
  fields: LogFields | undefined;
}

async function sweepAt(now: string, lines: RecordedLine[]): Promise<void> {
  const record = (message: string, fields?: LogFields): void => {
    lines.push({ message, fields });
  };
  const logger: Logger = { debug: record, info: record, warn: record, error: record };
  const sweep = startAiUsageRetention({
    quota: createDrizzleAiQuotaStore(database.db),
    legalDeclarations: createDrizzleLegalDeclarationsStore(database.db),
    logger,
    now: () => new Date(now),
    intervalMs: 60 * 60 * 1000,
  });
  try {
    await sweep.runOnce();
  } finally {
    sweep.stop();
  }
}

async function remainingIds(): Promise<string[]> {
  const rows = await database.db.select({ id: legalDeclarations.id }).from(legalDeclarations);
  return rows.map((row) => row.id).toSorted();
}

test('a row one day inside the period survives the sweep', async () => {
  await declare({ id: 'received-2026', receivedAt: '2026-09-21T10:00:00Z' });
  const lines: RecordedLine[] = [];
  // 2029-12-31 00:00 in Berlin: one day before the period ends.
  await sweepAt('2029-12-30T23:00:00Z', lines);
  assert.deepEqual(await remainingIds(), ['received-2026']);
});

test('the sweep deletes a row at the end of the third calendar year, keeps a younger one, and logs only the count', async () => {
  await declare({ id: 'received-2026', receivedAt: '2026-09-21T10:00:00Z' });
  await declare({ id: 'received-2027', receivedAt: '2027-01-15T10:00:00Z' });
  const lines: RecordedLine[] = [];
  // 2030-01-01 00:00 in Berlin.
  await sweepAt('2029-12-31T23:00:00Z', lines);
  assert.deepEqual(await remainingIds(), ['received-2027']);

  const line = lines.find((entry) => entry.message.startsWith('Deleted statutory declarations'));
  assert.equal(line?.fields?.deleted, 1);
  for (const needle of ['anna', 'Anna', 'received-2026']) {
    assert.equal(
      lines.some((entry) => JSON.stringify(entry).includes(needle)),
      false,
      `a log line carries ${needle}`,
    );
  }
});
