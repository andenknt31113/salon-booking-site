import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BOOKING_CHECKS, verifyBooking } from '../tools/verify-booking.mjs';

test('予約を塞がない認証順と前日通知の復旧を一括検査の対象から外さない', () => {
  for (const path of ['test/request-lock.mjs', 'test/reminder-recovery.mjs']) {
    assert.ok(BOOKING_CHECKS.includes(path), path);
  }
});

test('メモ保存の応答照合と別画面の競合を一括検査から外さない', () => {
  for (const path of ['test/admin-note-conflict.mjs', 'test/admin-note-ack-ui.mjs']) {
    assert.ok(BOOKING_CHECKS.includes(path), path);
  }
});

test('予約確認の本人照合と狭い読込を一括検査から外さない', () => {
  for (const path of ['test/booking-lookup-reads.mjs', 'test/reservation-lookup.mjs']) {
    assert.ok(BOOKING_CHECKS.includes(path));
  }
});

const execute = promisify(execFile);
const SCRIPT = `import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
test('架空の検証', () => {
  const envFile = process.execArgv.find(value => value.startsWith('--env-file=')).slice('--env-file='.length);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  const values = readFileSync(envFile, 'utf8');
  for (const key of ['MOCK_ADMIN_PASSWORD', 'MOCK_ADMIN_TOKEN']) {
    assert.match(process.env[key], /^[a-f0-9]{64}$/);
    assert.ok(values.includes(key + '=' + process.env[key]));
    console.log(process.env[key]);
  }
  assert.equal(process.env.GAS_SOURCE, undefined);
  assert.equal(process.env.GAS_BASELINE_SOURCE, undefined);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  console.log('ENV_LOCATION ' + JSON.stringify(envFile));
});`;

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'zer01-booking-fixture-'));
  let text = '';
  const output = { write: value => { text += value; } };
  try {
    await mkdir(join(root, 'test'));
    for (const file of BOOKING_CHECKS) await writeFile(join(root, file), SCRIPT);
    await run({ root, output, log: () => text });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function assertCleanup(log) {
  const paths = [...log.matchAll(/^# ENV_LOCATION (.+)$/gm)].map(match => JSON.parse(match[1]));
  assert.ok(paths.length > 0);
  assert.equal(new Set(paths).size, 1);
  await assert.rejects(lstat(dirname(paths[0])), { code: 'ENOENT' });
}

test('架空の認証値で全対象を実行し、出力から値を除き一時.envを消す', async () => {
  await fixture(async ({ root, output, log }) => {
    const previousOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--verify-booking-invalid-parent-option';
    let result;
    try { result = await verifyBooking({ root, output }); }
    finally {
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
    }
    assert.deepEqual(result, { exitCode: 0, tests: BOOKING_CHECKS.length, pass: BOOKING_CHECKS.length, fail: 0 });
    assert.match(log(), /\[redacted\]/);
    assert.doesNotMatch(log(), /\b[a-f0-9]{64}\b/);
    await assertCleanup(log());
    await assert.rejects(lstat(join(root, '.env')), { code: 'ENOENT' });
  });
});

test('試験が失敗したら成功扱いにせず、一時認証値を残さない', async () => {
  await fixture(async ({ root, output, log }) => {
    await writeFile(join(root, BOOKING_CHECKS[0]), SCRIPT.replace("assert.equal(process.env.GAS_SOURCE, undefined);", "assert.fail('架空の保存失敗');"));
    const result = await verifyBooking({ root, output });
    assert.equal(result.exitCode, 1);
    assert.equal(result.fail, 1);
    assert.equal(result.pass, BOOKING_CHECKS.length - 1);
    assert.doesNotMatch(log(), /\b[a-f0-9]{64}\b/);
    await assertCleanup(log());
  });
});

test('親の認証値・GAS指定・既存.envを使わず、このチェックアウトを検査する', async () => {
  await fixture(async ({ root }) => {
    const existing = ['MOCK_ADMIN_PASSWORD=' + randomBytes(32).toString('hex'),
      'MOCK_ADMIN_TOKEN=' + randomBytes(32).toString('hex'),
      'GAS_SOURCE=outside-unavailable', 'GAS_BASELINE_SOURCE=outside-unavailable'].join('\n') + '\n';
    const envFile = join(root, '.env');
    await writeFile(envFile, existing, { mode: 0o600 });
    const script = SCRIPT.replace("assert.equal(process.env.GAS_SOURCE, undefined);", `
      const parent = Object.fromEntries(readFileSync('.env', 'utf8').trim().split('\\n').map(line => line.split('=')));
      assert.ok(process.env.MOCK_ADMIN_PASSWORD !== parent.MOCK_ADMIN_PASSWORD);
      assert.ok(process.env.MOCK_ADMIN_TOKEN !== parent.MOCK_ADMIN_TOKEN);
      assert.equal(process.env.GAS_SOURCE, undefined);`);
    for (const file of BOOKING_CHECKS) await writeFile(join(root, file), script);
    const source = 'const { verifyBooking } = await import(process.argv[1]);'
      + 'process.exitCode = (await verifyBooking({ root: process.argv[2] })).exitCode;';
    const result = await execute(process.execPath, [`--env-file=${envFile}`, '--input-type=module', '-e',
      source, new URL('../tools/verify-booking.mjs', import.meta.url).href, root]);
    assert.match(result.stdout, new RegExp(`# pass ${BOOKING_CHECKS.length}\\b`));
    assert.doesNotMatch(result.stdout + result.stderr, /\b[a-f0-9]{64}\b/);
    assert.equal(await readFile(envFile, 'utf8'), existing);
    await assertCleanup(result.stdout);
  });
});

test('対象の欠落・リンクを実行前に断り、元ファイルを変更しない', async () => {
  await fixture(async ({ root, output, log }) => {
    const file = join(root, BOOKING_CHECKS[0]);
    await rm(file);
    await assert.rejects(verifyBooking({ root, output }), /検証対象の通常ファイル/);
    await symlink(join(root, BOOKING_CHECKS[1]), file);
    await assert.rejects(verifyBooking({ root, output }), /検証対象の通常ファイル/);
    await rm(join(root, 'test'), { recursive: true });
    await mkdir(join(root, 'other-tests'));
    for (const name of BOOKING_CHECKS) await writeFile(join(root, 'other-tests', name.slice('test/'.length)), SCRIPT);
    await symlink(join(root, 'other-tests'), join(root, 'test'), 'dir');
    await assert.rejects(verifyBooking({ root, output }), /検証対象の通常ディレクトリ/);
    assert.equal(log(), '');
  });
});

test('不明なCLI指定で検証や本番接続を開始しない', async () => {
  const script = new URL('../tools/verify-booking.mjs', import.meta.url);
  await assert.rejects(execute(process.execPath, [fileURLToPath(script), '--unknown']), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /使い方/);
    assert.equal(error.stdout, '');
    return true;
  });
});
