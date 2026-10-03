import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://script.google.com/macros/s/FIXTURE_READ_PROBE/exec';
const PRIVATE_TEXT = '試験用の応答本文は出力しない';
const CLI_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 1000;
const DEADLINE_MS = 3000;
const INTERVAL_MS = 1;
const script = fileURLToPath(new URL('../tools/measure-booking-backend.mjs', import.meta.url));
const expectedRequests = [
  { type: 'menu', booking: true, measure: true },
  { type: 'menu', booking: true, measure: true, initialAvailability: true },
  { type: 'availability' }
];

function runFixture(testContext, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'zer01-read-probe-cli-'));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, 'preload.mjs');
  const requestsPath = join(directory, 'requests.json');
  writeFileSync(preload, `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    const expected = ${JSON.stringify(expectedRequests)};
    const requests = [];
    process.on('exit', () => writeFileSync(process.env.PROBE_TEST_REQUESTS_PATH, JSON.stringify(requests)));
    globalThis.fetch = async (url, options) => {
      assert.equal(url, ${JSON.stringify(ENDPOINT)});
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(options.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload, expected[requests.length]);
      requests.push(payload);
      if (process.env.PROBE_TEST_MODE === 'timeout') return new Promise(() => {});
      if (process.env.PROBE_TEST_MODE === 'http-error') {
        return new Response(${JSON.stringify(PRIVATE_TEXT)}, { status: 404 });
      }
      const data = payload.type === 'menu'
        ? { ok: true, categories: [], coupons: [], closedDates: [], settings: {},
            ...(payload.initialAvailability ? { booked: [] } : {}),
            timing: { lockMs: 0, catalogMs: 0, totalMs: 0 } }
        : { ok: true, booked: [] };
      if (process.env.PROBE_TEST_MODE === 'invalid-response') delete data.ok;
      data.privateText = ${JSON.stringify(PRIVATE_TEXT)};
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    };
  `);
  const child = spawnSync(process.execPath, ['--import', preload, script, '--run', '--endpoint', ENDPOINT,
    '--attempts', '1', '--max-attempts', '3', '--timeout-ms', String(REQUEST_TIMEOUT_MS),
    '--deadline-ms', String(DEADLINE_MS), '--interval-ms', String(INTERVAL_MS)], {
    encoding: 'utf8', timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, PROBE_TEST_MODE: mode, PROBE_TEST_REQUESTS_PATH: requestsPath }
  });
  assert.equal(child.error, undefined, 'CLI自身の期限で終了する');
  assert.equal(child.signal, null);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.includes(ENDPOINT), false);
  assert.equal(child.stdout.includes(PRIVATE_TEXT), false);
  const output = JSON.parse(child.stdout);
  const requests = JSON.parse(readFileSync(requestsPath, 'utf8'));
  return { status: child.status, output, requests };
}

test('CLIの実入口から3種類の読取だけを送り、成功時だけexit 0を返す', testContext => {
  const result = runFixture(testContext, 'success');
  assert.equal(result.status, 0);
  assert.deepEqual(result.requests, expectedRequests);
  assert.equal(result.output.mode, 'run');
  assert.equal(result.output.stopReason, 'completed');
  assert.equal(result.output.attempts, 3);
  assert.equal(result.output.successes, 3);
  assert.equal(result.output.coldStartEstimate, false);
  assert.equal(result.output.cases.menu.serverTimingMs.totalMs.all.count, 1);
  assert.equal(result.output.cases.availability.serverTimingMs.totalMs.all.count, 0);
});

for (const mode of ['http-error', 'invalid-response']) {
  test(`CLIの${mode}を成功扱いせず、秘密の応答本文を含まない集計とexit 1を返す`, testContext => {
    const result = runFixture(testContext, mode);
    assert.equal(result.status, 1);
    assert.deepEqual(result.requests, expectedRequests);
    assert.equal(result.output.mode, 'run');
    assert.equal(result.output.stopReason, 'completed');
    assert.equal(result.output.attempts, 3);
    assert.equal(result.output.successes, 0);
    assert.equal(result.output.cases.menu.failures[mode], 1);
    assert.equal(result.output.cases.availability.failures[mode], 1);
  });
}

test('CLIの読取が終わらなくても期限でexit 1となり、残りの要求や再送を始めない', testContext => {
  const result = runFixture(testContext, 'timeout');
  assert.equal(result.status, 1);
  assert.deepEqual(result.requests, expectedRequests.slice(0, 1));
  assert.equal(result.output.mode, 'run');
  assert.equal(result.output.stopReason, 'timeout');
  assert.equal(result.output.attempts, 1);
  assert.equal(result.output.successes, 0);
  assert.equal(result.output.cases.menu.failures.timeout, 1);
});
