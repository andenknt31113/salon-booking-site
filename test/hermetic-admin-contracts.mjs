import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHILD_TIMEOUT_MS = 30000;
const CONTRACT_TEST_COUNT = 78;
const CONTRACT_FILE = 'test/fixtures/admin-contracts.json';
const TEST_FILES = ['test/admin-calendar-loading.mjs', 'test/admin-closed-calendar-loading.mjs', 'test/admin-selected-history.mjs'];
const FILES = [...TEST_FILES, 'test/admin-contract.mjs', CONTRACT_FILE,
  'assets/js/admin.js', 'assets/js/common.js', 'gas/Code.gs'];

async function isolatedCopy(run) {
  const root = await mkdtemp(join(tmpdir(), 'zer01-hermetic-admin-'));
  try {
    for (const file of FILES) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await copyFile(join(ROOT, file), join(root, file));
    }
    const noPrograms = join(root, 'no-programs');
    await mkdir(noPrograms);
    const check = async (timezone = 'Asia/Tokyo') => {
      let result;
      try {
        result = { ...await execute(process.execPath, ['--test', '--test-reporter=tap', ...TEST_FILES], {
          cwd: root, env: { PATH: noPrograms, TZ: timezone }, timeout: CHILD_TIMEOUT_MS
        }), exitCode: 0 };
      } catch (error) {
        if (error.code !== 1) throw error;
        result = { stdout: error.stdout, stderr: error.stderr, exitCode: 1 };
      }
      const counts = Object.fromEntries(Array.from(result.stdout.matchAll(/^# (tests|pass|fail) (\d+)$/gm),
        match => [match[1], Number(match[2])]));
      return { ...result, ...counts };
    };
    await run({ root, check });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const timezone of ['Asia/Tokyo', 'UTC']) {
  test(`Gitも履歴もない独立コピーで、管理の全契約を検査する：${timezone}`, async () => {
    await isolatedCopy(async ({ check }) => {
      const result = await check(timezone);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.tests, CONTRACT_TEST_COUNT);
      assert.equal(result.pass, CONTRACT_TEST_COUNT);
      assert.equal(result.fail, 0);
    });
  });
}

test('固定契約が欠けたコピーを、旧版や現実装から補って成功扱いにしない', async () => {
  await isolatedCopy(async ({ root, check }) => {
    await rm(join(root, CONTRACT_FILE));
    const result = await check();
    assert.equal(result.exitCode, 1);
    assert.equal(result.tests, TEST_FILES.length);
    assert.equal(result.pass, 0);
    assert.equal(result.fail, TEST_FILES.length);
    assert.match(result.stdout, /ENOENT/);
  });
});

test('正しい形式でも期待値の不一致を検出し、固定契約を自動更新しない', async () => {
  await isolatedCopy(async ({ root, check }) => {
    const file = join(root, CONTRACT_FILE);
    const contracts = JSON.parse(await readFile(file, 'utf8'));
    const previous = contracts.fingerprints['calendar:week:0'];
    const changed = (previous[0] === '0' ? '1' : '0') + previous.slice(1);
    contracts.fingerprints['calendar:week:0'] = changed;
    await writeFile(file, JSON.stringify(contracts));
    const result = await check();
    assert.equal(result.exitCode, 1);
    assert.equal(result.tests, CONTRACT_TEST_COUNT);
    assert.equal(result.pass, CONTRACT_TEST_COUNT - 1);
    assert.equal(result.fail, 1);
    assert.match(result.stdout, /calendar:week:0/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).fingerprints['calendar:week:0'], changed);
  });
});

test('予定表の文字をescapeしない実装のコピーは、HTML全文の契約で拒否する', async () => {
  await isolatedCopy(async ({ root, check }) => {
    const file = join(root, 'assets/js/common.js');
    const original = await readFile(file, 'utf8');
    const changed = original.replace(/^function esc\([^]*?^}/m,
      "function esc(value) {\n  return String(value == null ? '' : value);\n}");
    assert.notEqual(changed, original);
    await writeFile(file, changed);
    const result = await check();
    assert.equal(result.exitCode, 1);
    assert.equal(result.tests, CONTRACT_TEST_COUNT);
    assert.equal(result.pass, CONTRACT_TEST_COUNT - 1);
    assert.equal(result.fail, 1);
    assert.match(result.stdout, /calendar:week:0/);
  });
});

test('取得した料金をゼロへ置換する実装のコピーは、応答全文の契約で拒否する', async () => {
  await isolatedCopy(async ({ root, check }) => {
    const file = join(root, 'gas/Code.gs');
    const original = await readFile(file, 'utf8');
    const previous = "price: Number(row[col('合計金額')]) || 0,";
    assert.equal(original.split(previous).length, 2);
    await writeFile(file, original.replace(previous, 'price: 0,'));
    const result = await check();
    assert.equal(result.exitCode, 1);
    assert.equal(result.tests, CONTRACT_TEST_COUNT);
    assert.ok(result.fail > 0);
    assert.match(result.stdout, /history:/);
  });
});
