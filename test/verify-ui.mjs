import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { UI_CHECKS, verifyUI } from '../tools/verify-ui.mjs';
import { verifyLocalChecks } from '../tools/verify-local.mjs';

const execute = promisify(execFile);
const EXCLUDED_ENV = ['GAS_SOURCE', 'GAS_BASELINE_SOURCE', 'ADMIN_SOURCE', 'ADMIN_BASELINE_SOURCE',
  'BASE', 'ADMIN_PW', 'TEST_BROWSER', 'TEST_SCREENSHOT_DIR', 'SCREENSHOT_DIR', 'TEST_ARTIFACT_DIR', 'NODE_OPTIONS'];
const SCRIPT = `import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
test('架空の画面検証', () => {
  const envFile = process.execArgv.find(value => value.startsWith('--env-file=')).slice('--env-file='.length);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  const values = readFileSync(envFile, 'utf8');
  for (const key of ['MOCK_ADMIN_PASSWORD', 'MOCK_ADMIN_TOKEN']) {
    assert.match(process.env[key], /^[a-f0-9]{64}$/);
    assert.ok(values.includes(key + '=' + process.env[key]));
    console.log(process.env[key]);
    console.error(process.env[key]);
  }
  for (const key of ${JSON.stringify(EXCLUDED_ENV)}) assert.equal(process.env[key], undefined);
  console.log('ENV_LOCATION ' + JSON.stringify(envFile));
});`;

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'zer01-ui-fixture-'));
  let text = '';
  const output = { write: value => { text += value; } };
  try {
    await mkdir(join(root, 'test'));
    for (const file of UI_CHECKS) await writeFile(join(root, file), SCRIPT);
    await run({ root, output, log: () => text });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function assertCleanup(log) {
  const paths = [...log.matchAll(/^# ENV_LOCATION (.+)$/gm)].map(match => JSON.parse(match[1]));
  assert.ok(paths.length > 0);
  assert.equal(new Set(paths).size, 1);
  await assert.rejects(lstat(dirname(paths[0])), { code: 'ENOENT' });
}

test('日付移動・名簿検索・未保存入力の保護を画面検査から外さない', () => {
  assert.ok(UI_CHECKS.includes('test/admin-daily-usability.mjs'));
});

test('全対象を架空の認証値で実行し、標準出力・エラーから値を除き一時.envを消す', async () => {
  await fixture(async ({ root, output, log }) => {
    assert.equal(UI_CHECKS.length, 20);
    const result = await verifyUI({ root, output });
    assert.deepEqual(result, { exitCode: 0, tests: UI_CHECKS.length, pass: UI_CHECKS.length, fail: 0 });
    assert.match(log(), /\[redacted\]/);
    assert.doesNotMatch(log(), /\b[a-f0-9]{64}\b/);
    await assertCleanup(log());
    await assert.rejects(lstat(join(root, '.env')), { code: 'ENOENT' });
  });
});

test('複数ファイルを同時起動せず、前のファイルの終了を待つ', async () => {
  await fixture(async ({ root, output, log }) => {
    const serialScript = `import { closeSync, openSync, unlinkSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { after, test } from 'node:test';
const lock = 'fixture-running.lock';
const handle = openSync(lock, 'wx');
after(() => { closeSync(handle); unlinkSync(lock); });
test('架空の画面を一つずつ起動', async () => { await setTimeout(25); });`;
    for (const file of UI_CHECKS) await writeFile(join(root, file), serialScript);
    assert.deepEqual(await verifyUI({ root, output }), { exitCode: 0, tests: UI_CHECKS.length, pass: UI_CHECKS.length, fail: 0 });
    assert.match(log(), /# fail 0/);
    await assert.rejects(lstat(join(root, 'fixture-running.lock')), { code: 'ENOENT' });
  });
});

test('実際の模擬受け口も一時.envの認証値を使い、別の値と無認証を拒否する', async () => {
  await fixture(async ({ root, output, log }) => {
    const mock = new URL('./mock-gas.mjs', import.meta.url).href;
    const script = `import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createMockHandler } from ${JSON.stringify(mock)};
test('架空の管理権限', async () => {
  assert.ok(process.env.MOCK_ADMIN_PASSWORD);
  const server = http.createServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    server.on('request', createMockHandler({ port, apiOnly: true }));
    const post = async payload => (await fetch('http://127.0.0.1:' + port + '/exec', {
      method: 'POST', body: JSON.stringify(payload)
    })).json();
    assert.equal((await post({ type: 'adminLogin', password: process.env.MOCK_ADMIN_PASSWORD })).ok, true);
    assert.equal((await post({ type: 'adminData', password: process.env.MOCK_ADMIN_PASSWORD })).ok, true);
    assert.equal((await post({ type: 'adminLogin', password: randomBytes(32).toString('hex') })).ok, false);
    assert.equal((await post({ type: 'adminData' })).ok, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});`;
    await writeFile(join(root, UI_CHECKS[0]), script);
    assert.deepEqual(await verifyLocalChecks({ root, checks: [UI_CHECKS[0]], output }),
      { exitCode: 0, tests: 1, pass: 1, fail: 0 });
    assert.doesNotMatch(log(), /\b[a-f0-9]{64}\b/);
  });
});

test('試験失敗を成功扱いせず、エラーに含まれる模擬認証値を伏せる', async () => {
  await fixture(async ({ root, output, log }) => {
    await writeFile(join(root, UI_CHECKS[0]), SCRIPT.replace("console.log('ENV_LOCATION ' + JSON.stringify(envFile));",
      "console.log('ENV_LOCATION ' + JSON.stringify(envFile)); assert.fail(process.env.MOCK_ADMIN_TOKEN);"));
    const result = await verifyUI({ root, output });
    assert.equal(result.exitCode, 1);
    assert.equal(result.fail, 1);
    assert.equal(result.pass, UI_CHECKS.length - 1);
    assert.doesNotMatch(log(), /\b[a-f0-9]{64}\b/);
    await assertCleanup(log());
  });
});

test('skipだけの結果を全件成功と扱わず、正常に一時領域を消す', async () => {
  await fixture(async ({ root, output, log }) => {
    for (const file of UI_CHECKS) await writeFile(join(root, file), SCRIPT.replace("test('架空の画面検証'",
      "console.log('ENV_LOCATION ' + JSON.stringify(process.execArgv.find(value => value.startsWith('--env-file=')).slice('--env-file='.length))); test.skip('架空の画面検証'"));
    const result = await verifyUI({ root, output });
    assert.equal(result.exitCode, 1);
    assert.equal(result.tests, UI_CHECKS.length);
    assert.equal(result.pass, 0);
    assert.equal(result.fail, 0);
    assert.match(log(), new RegExp(`# skipped ${UI_CHECKS.length}\\b`));
    await assertCleanup(log());
  });
});

test('親の認証・別ソース・保存先を使わず、runtime指定と既存.envだけは保持する', async () => {
  await fixture(async ({ root }) => {
    const existing = ['MOCK_ADMIN_PASSWORD=' + randomBytes(32).toString('hex'),
      'MOCK_ADMIN_TOKEN=' + randomBytes(32).toString('hex'),
      ...EXCLUDED_ENV.filter(key => key !== 'NODE_OPTIONS').map(key => `${key}=outside-unavailable`),
      'PLAYWRIGHT=fixture-runtime-module', 'CHROMIUM=fixture-existing-browser'].join('\n') + '\n';
    const envFile = join(root, '.env');
    await writeFile(envFile, existing, { mode: 0o600 });
    const script = SCRIPT.replace("const values = readFileSync(envFile, 'utf8');", `
      const values = readFileSync(envFile, 'utf8');
      const parent = Object.fromEntries(readFileSync('.env', 'utf8').trim().split('\\n').map(line => line.split('=')));
      assert.ok(process.env.MOCK_ADMIN_PASSWORD !== parent.MOCK_ADMIN_PASSWORD);
      assert.ok(process.env.MOCK_ADMIN_TOKEN !== parent.MOCK_ADMIN_TOKEN);
      assert.equal(process.env.PLAYWRIGHT, parent.PLAYWRIGHT);
      assert.equal(process.env.CHROMIUM, parent.CHROMIUM);`);
    for (const file of UI_CHECKS) await writeFile(join(root, file), script);
    const source = 'const { verifyUI } = await import(process.argv[1]);'
      + 'process.env.NODE_OPTIONS = "--verify-ui-invalid-parent-option";'
      + 'process.exitCode = (await verifyUI({ root: process.argv[2] })).exitCode;';
    const result = await execute(process.execPath, [`--env-file=${envFile}`, '--input-type=module', '-e',
      source, new URL('../tools/verify-ui.mjs', import.meta.url).href, root]);
    assert.match(result.stdout, new RegExp(`# pass ${UI_CHECKS.length}\\b`));
    assert.doesNotMatch(result.stdout + result.stderr, /\b[a-f0-9]{64}\b/);
    assert.equal(await readFile(envFile, 'utf8'), existing);
    await assertCleanup(result.stdout);
  });
});

test('欠落した試験やファイル・ディレクトリのリンクを実行前に拒否する', async () => {
  await fixture(async ({ root, output, log }) => {
    const file = join(root, UI_CHECKS[0]);
    await rm(file);
    await assert.rejects(verifyUI({ root, output }), /検証対象の通常ファイル/);
    await symlink(join(root, UI_CHECKS[1]), file);
    await assert.rejects(verifyUI({ root, output }), /検証対象の通常ファイル/);
    await rm(join(root, 'test'), { recursive: true });
    await mkdir(join(root, 'other-tests'));
    await symlink(join(root, 'other-tests'), join(root, 'test'), 'dir');
    await assert.rejects(verifyUI({ root, output }), /検証対象の通常ディレクトリ/);
    assert.equal(log(), '');
  });
});

test('空・重複・ディレクトリ外・実行引数となる検証対象を拒否する', async () => {
  await fixture(async ({ root, output, log }) => {
    for (const checks of [[], undefined, [UI_CHECKS[0], UI_CHECKS[0]], ['../test/outside.mjs'],
      ['/test/outside.mjs'], ['test/../outside.mjs'], ['--import=outside.mjs'], ['test/nested/outside.mjs'], [null]]) {
      await assert.rejects(verifyLocalChecks({ root, checks, output }), /検証対象には重複のない/);
    }
    assert.equal(log(), '');
  });
});

test('exit 0でも標準出力の集計がない結果や不一致の集計を成功としない', async () => {
  await fixture(async ({ root, output, log }) => {
    const original = process.execPath;
    const launcher = join(root, 'fixture-launcher');
    try {
      process.execPath = launcher;
      await writeFile(launcher, `#!/bin/sh
printf '# ENV_LOCATION "%s"\n' "\${1#--env-file=}"
printf '# tests 1\n# pass 1\n# fail 0\n' >&2
exit 0
`, { mode: 0o700 });
      assert.deepEqual(await verifyUI({ root, output }), { exitCode: 1 });
      await assertCleanup(log());
      await writeFile(launcher, `#!/bin/sh
printf '# tests 2\n# pass 1\n# fail 0\n'
exit 0
`, { mode: 0o700 });
      assert.deepEqual(await verifyUI({ root, output }), { exitCode: 1, tests: 2, pass: 1, fail: 0 });
    } finally { process.execPath = original; }
  });
});

test('検証プロセスの起動失敗でも一時.envを消して例外を返す', async () => {
  await fixture(async ({ root, output }) => {
    const original = process.execPath;
    let envFile;
    try {
      process.execPath = join(root, 'unavailable-node');
      await assert.rejects(verifyUI({ root, output }), error => {
        assert.equal(error.code, 'ENOENT');
        envFile = error.spawnargs.find(value => value.startsWith('--env-file=')).slice('--env-file='.length);
        return true;
      });
      await assert.rejects(lstat(dirname(envFile)), { code: 'ENOENT' });
    } finally { process.execPath = original; }
  });
});

test('CLIを別の作業ディレクトリから実行しても自分のチェックアウトを検査する', async () => {
  await fixture(async ({ root }) => {
    await mkdir(join(root, 'tools'));
    for (const file of ['verify-local.mjs', 'verify-ui.mjs']) {
      await writeFile(join(root, 'tools', file), await readFile(new URL('../tools/' + file, import.meta.url)));
    }
    const result = await execute(process.execPath, [join(root, 'tools/verify-ui.mjs')], { cwd: tmpdir() });
    assert.match(result.stdout, new RegExp(`# pass ${UI_CHECKS.length}\\b`));
    assert.doesNotMatch(result.stdout + result.stderr, /\b[a-f0-9]{64}\b/);
    await assertCleanup(result.stdout);
  });
});

test('不明なCLI指定では画面試験・通信を開始しない', async () => {
  await assert.rejects(execute(process.execPath, [fileURLToPath(new URL('../tools/verify-ui.mjs', import.meta.url)), '--unknown']), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /使い方/);
    assert.equal(error.stdout, '');
    return true;
  });
});
