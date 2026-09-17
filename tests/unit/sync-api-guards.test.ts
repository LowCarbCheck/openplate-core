/**
 * The two things `sync-api` must refuse to do, proven by a real process
 * against a real listener.
 *
 * ── A MISSING `ADMIN_TOKEN` STOPS THE COMMAND BEFORE THE SOCKET ─────────────
 * Not "sends an unauthenticated request and reports the 401". The difference
 * matters twice: an operator gets a message naming the variable they can fix
 * rather than a status code to decode, and a mistyped host never receives a
 * request from us at all. The message names the variable because that is the
 * one thing the operator can change.
 *
 * ── DELETION REQUIRES `--yes` ───────────────────────────────────────────────
 * The erasure is immediate, total and irreversible — no soft delete, no grace
 * period, the ciphertext gone by cascade in the same statement. `--yes` is the
 * cheapest possible guard against a wrong id in a shell history, and its whole
 * value is that the request is not sent: a confirmation that fires after the
 * DELETE would be a receipt, not a guard.
 *
 * Both assertions check the REQUEST COUNT on a listener that would have
 * answered. An absence assertion against a server that could not have been
 * reached would prove nothing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, startCountingServer, type CountingServer } from './sync-api-cli-harness.js';

const ADMIN_TOKEN = 'sync-api-test-admin-token-0123456789';

let server: CountingServer;

before(async () => {
  server = await startCountingServer();
});

after(async () => {
  await server.close();
});

test('with no ADMIN_TOKEN it exits non-zero, names the variable, and sends nothing', async () => {
  const requestsBefore = server.requests.length;

  const run = await runCli({ args: ['stats', '--url', server.baseUrl], adminToken: null });

  assert.notEqual(run.exitCode, 0, 'a missing credential must be a failure exit');
  assert.ok(run.stderr.includes('ADMIN_TOKEN'), `stderr must name the variable, saw: ${run.stderr}`);
  assert.equal(server.requests.length, requestsBefore, 'no request may be sent without a token');
});

test('the same refusal applies to every command, including a delete', async () => {
  const requestsBefore = server.requests.length;

  const run = await runCli({ args: ['accounts', 'delete', '5', '--yes', '--url', server.baseUrl], adminToken: null });

  assert.notEqual(run.exitCode, 0);
  assert.ok(run.stderr.includes('ADMIN_TOKEN'));
  assert.equal(server.requests.length, requestsBefore);
});

test('accounts delete without --yes exits non-zero and sends nothing', async () => {
  const requestsBefore = server.requests.length;

  const run = await runCli({ args: ['accounts', 'delete', '5', '--url', server.baseUrl], adminToken: ADMIN_TOKEN });

  assert.notEqual(run.exitCode, 0, 'an unconfirmed delete must be a failure exit');
  assert.ok(run.stderr.includes('--yes'), `stderr must say what is missing, saw: ${run.stderr}`);
  assert.equal(server.requests.length, requestsBefore, 'an unconfirmed delete must not reach the network');
});

test('with the token AND --yes the delete is actually sent, so the guards above are not vacuous', async () => {
  const requestsBefore = server.requests.length;

  const run = await runCli({
    args: ['accounts', 'delete', '5', '--yes', '--url', server.baseUrl],
    adminToken: ADMIN_TOKEN,
  });

  assert.equal(run.exitCode, 0, `expected success, stderr: ${run.stderr}`);
  assert.deepEqual(server.requests.slice(requestsBefore), ['DELETE /v1/admin/accounts/5']);
});

test('settings set refuses an unknown key and an unknown value, and sends nothing', async () => {
  const requestsBefore = server.requests.length;

  const badKey = await runCli({
    args: ['settings', 'set', 'nutrient-basis', 'efsa', '--url', server.baseUrl],
    adminToken: ADMIN_TOKEN,
  });
  assert.notEqual(badKey.exitCode, 0);
  assert.ok(badKey.stderr.includes('nutrient-reference-basis'), `stderr must name the key, saw: ${badKey.stderr}`);

  // `dach` is the plausible wrong value, and the one the service refuses too.
  const badValue = await runCli({
    args: ['settings', 'set', 'nutrient-reference-basis', 'dach', '--url', server.baseUrl],
    adminToken: ADMIN_TOKEN,
  });
  assert.notEqual(badValue.exitCode, 0);
  assert.ok(badValue.stderr.includes('dge'), `stderr must list the alternatives, saw: ${badValue.stderr}`);

  assert.equal(server.requests.length, requestsBefore, 'neither typo may reach the network');
});

test('a valid settings set IS sent, so the refusals above are not vacuous', async () => {
  const requestsBefore = server.requests.length;

  // The counting server answers `{}`, which this CLI refuses to decode, so the
  // exit status is not the assertion here. The REQUEST is: it proves the two
  // refusals above stopped something that would otherwise have gone out.
  await runCli({
    args: ['settings', 'set', 'nutrient-reference-basis', 'efsa', '--url', server.baseUrl],
    adminToken: ADMIN_TOKEN,
  });

  assert.deepEqual(server.requests.slice(requestsBefore), ['PATCH /v1/admin/settings']);
});

test('the admin token never appears in the CLI output', async () => {
  const run = await runCli({ args: ['stats', '--url', server.baseUrl], adminToken: ADMIN_TOKEN });

  assert.ok(!run.stdout.includes(ADMIN_TOKEN), 'stdout must not echo the credential');
  assert.ok(!run.stderr.includes(ADMIN_TOKEN), 'stderr must not echo the credential');
});
