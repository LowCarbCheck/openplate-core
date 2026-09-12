/**
 * No push route writes an account id or an endpoint to a log line.
 *
 * THE RULE IS THE PULSE'S, AND THE REASON IS ONE MORE. `admin-log-leak.test.ts`
 * asserts that an admin action logs the account id and NOT the address, because
 * there the id is the correlation key an operator needs. Here neither is
 * allowed, for ADR-0007's reason, and an endpoint is not allowed either: a push
 * endpoint is a CAPABILITY. Anybody holding one and this instance's VAPID
 * private key can wake that phone, and a log line outlives the row it
 * describes.
 *
 * WHY THIS FILE DOES NOT SIMPLY GREP THE SERIALIZED LINE FOR THE ID. The fake
 * account store hands out ids 1 and 2, and every line here carries a status
 * code and a byte count, so `serialized.includes('1')` matches `{"status":201}`
 * and can never fail. That is exactly the unfalsifiable assertion this
 * repository has been bitten by before. So the check is over FIELD VALUES, one
 * by one, plus a serialized sweep for the strings that ARE distinctive: the
 * account's address, its bearer token and the endpoint.
 *
 * THE POSITIVE HALF IS FIRST. Without it, a route that logged nothing at all
 * would satisfy every absence check below.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registrationBody, startPushHarness, type PushHarness, type RecordedLine } from './push-harness.js';

/** An endpoint distinctive enough that a substring sweep for it means something. */
const ENDPOINT = 'https://push.example.org/never-in-a-log-line-9f2c';

let harness: PushHarness;
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

test('the push routes log a path, a status and a byte count, and never the account or the endpoint', async () => {
  harness = await startPushHarness();

  // Every route, including the refusals, because a 400 and a 404 are written by
  // different code from a 201 and could each carry their own line.
  await harness.request({ person: harness.anna, method: 'GET', path: '/v1/push/config' });
  await harness.request({
    person: harness.anna,
    method: 'PUT',
    path: '/v1/push/subscriptions',
    body: registrationBody({ endpoint: ENDPOINT }),
  });
  await harness.request({
    person: harness.anna,
    method: 'PATCH',
    path: '/v1/push/subscriptions',
    body: { endpoint: ENDPOINT, catchUpMinute: 420 },
  });
  await harness.request({
    person: harness.anna,
    method: 'PATCH',
    path: '/v1/push/subscriptions',
    body: { endpoint: 'https://push.example.org/not-here' },
  });
  await harness.request({ person: harness.anna, method: 'PUT', path: '/v1/push/subscriptions', body: {} });
  await harness.request({
    person: harness.anna,
    method: 'DELETE',
    path: '/v1/push/subscriptions',
    body: { endpoint: ENDPOINT },
  });

  // THE POSITIVE HALF: the requests ARE logged, and with the four things the
  // module header says a line may carry.
  const requestLines = harness.logLines.filter((line) => line.message === 'Push request');
  assert.ok(requestLines.length >= 6, `every push request must be logged, saw ${requestLines.length}`);
  const registration = requestLines[1];
  assert.ok(registration !== undefined);
  assert.equal(registration.fields?.status, 201);
  assert.equal(registration.fields?.method, 'PUT');
  assert.equal(registration.fields?.path, '/v1/push/subscriptions');
  // The byte count is real: `{"subscribed":true}` is 19 bytes on the wire.
  assert.equal(registration.fields?.bytes, 19);

  // THE ABSENCE HALF, over field names first: nothing may even be CALLED an
  // account id or an endpoint, which catches the obvious way this regresses.
  const names = fieldNames(harness.logLines);
  assert.ok(!names.includes('accountId'), 'no push line may carry an accountId field');
  assert.ok(!names.includes('endpoint'), 'nor an endpoint field');

  // Then over every value, compared as a whole rather than as a substring, so a
  // status code that happens to contain the id's digits cannot mask a leak and
  // cannot fake one.
  const id = String(harness.anna.accountId);
  assert.deepEqual(
    fieldValues(harness.logLines).filter((value) => value === id),
    [],
    `no field value may be the account id (${id})`,
  );

  // And the strings distinctive enough for a substring sweep to mean something.
  const serialized = harness.logLines.map((line) => JSON.stringify(line)).join('\n');
  assert.ok(!serialized.includes(harness.anna.email), 'no log line may contain the account address');
  assert.ok(!serialized.includes(harness.anna.accessToken), 'and certainly not the bearer token');
  assert.ok(!serialized.includes(ENDPOINT), 'nor the push endpoint, which is a capability');
  assert.ok(!serialized.includes('anna-p256dh'), 'nor the device key');
  assert.ok(!serialized.includes('anna-auth'), 'nor its auth secret');
});
