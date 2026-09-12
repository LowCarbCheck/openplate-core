/**
 * No pulse route writes an account id to a log line.
 *
 * THE RULE IS ADR-0007's AND IT IS STRICTER THAN THE REST OF THIS SERVICE.
 * `admin-log-leak.test.ts` asserts that an admin action logs the account id and
 * NOT the address, because there the id is the correlation key an operator
 * needs. Here neither is allowed: an AI proxy line records somebody spending
 * the operator's money, and a pulse line would record that somebody ate lunch
 * at 13:40, which is the diary content this service exists not to hold.
 *
 * WHY THIS FILE DOES NOT SIMPLY GREP THE SERIALIZED LINE FOR THE ID. The fake
 * account store hands out ids 1 and 2, and every line here carries a status
 * code and a byte count, so `serialized.includes('1')` matches `{"status":201}`
 * and can never fail. That is exactly the unfalsifiable assertion this
 * repository has been bitten by before. So the check is over FIELD VALUES, one
 * by one, plus a serialized sweep for the two strings that ARE distinctive: the
 * account's address and its bearer token.
 *
 * THE POSITIVE HALF IS FIRST. Without it, a route that logged nothing at all
 * would satisfy every absence check below.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pulseKey, startPulseHarness, type PulseHarness, type RecordedLine } from './pulse-harness.js';

let harness: PulseHarness;
after(async () => {
  await harness.close();
});

/** Every value any captured line put in its fields, as strings. */
function fieldValues(lines: RecordedLine[]): string[] {
  return lines.flatMap((line) => Object.values(line.fields ?? {}).map((value) => String(value)));
}

/** Every field NAME any captured line used. */
function fieldNames(lines: RecordedLine[]): string[] {
  return lines.flatMap((line) => Object.keys(line.fields ?? {}));
}

test('the pulse routes log a path, a status and a byte count, and never the account', async () => {
  harness = await startPulseHarness();

  // Every route, including the refusals, because a 400 and a 429 are written by
  // different code from a 202 and could each carry their own line.
  await harness.post({
    person: harness.anna,
    path: '/v1/pulse/meal',
    key: pulseKey(80),
    body: { kcal: 1234, protein: 33 },
  });
  await harness.post({
    person: harness.anna,
    path: '/v1/pulse/meal',
    key: pulseKey(81),
    body: { kcal: 1, protein: 1 },
  });
  await harness.post({ person: harness.anna, path: '/v1/pulse/photo', key: null });
  await harness.post({ person: harness.anna, path: '/v1/pulse/fasting', key: pulseKey(82) });
  await harness.get({ person: harness.anna, path: '/v1/pulse/today' });

  // THE POSITIVE HALF: the requests ARE logged, and with the three things the
  // ADR says a line may carry.
  const requestLines = harness.logLines.filter((line) => line.message === 'Pulse request');
  assert.ok(requestLines.length >= 5, `every pulse request must be logged, saw ${requestLines.length}`);
  const first = requestLines[0];
  assert.ok(first !== undefined);
  assert.equal(first.fields?.status, 202);
  assert.equal(first.fields?.method, 'POST');
  // The byte count is real: `{"accepted":true}` is 17 bytes on the wire.
  assert.equal(first.fields?.bytes, 17);

  // THE ABSENCE HALF, over field names first: nothing may even be CALLED an
  // account id, which catches the obvious way this regresses.
  assert.ok(!fieldNames(harness.logLines).includes('accountId'), 'no pulse line may carry an accountId field');

  // Then over every value, compared as a whole rather than as a substring, so
  // a status code that happens to contain the id's digits cannot mask a leak
  // and cannot fake one.
  const id = String(harness.anna.accountId);
  const leaked = fieldValues(harness.logLines).filter((value) => value === id);
  assert.deepEqual(leaked, [], `no field value may be the account id (${id})`);

  // And the two strings that are distinctive enough for a substring sweep to
  // mean something. This is the half that would fail if somebody logged the
  // authorization header or the account's address.
  const serialized = harness.logLines.map((line) => JSON.stringify(line)).join('\n');
  assert.ok(!serialized.includes(harness.anna.email), 'no log line may contain the account address');
  assert.ok(!serialized.includes(harness.anna.accessToken), 'and certainly not the bearer token');
  // Nor a value from the body: 1234 was sent and 1250 was stored, and neither
  // belongs in a line that has promised to carry a byte count.
  assert.ok(!serialized.includes('1234'), 'no log line may contain a figure from the body');
});
