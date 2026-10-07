import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const update = await readFile(new URL('../.github/workflows/update-public-menus.yml', import.meta.url), 'utf8');
const publish = await readFile(new URL('../.github/workflows/publish-site.yml', import.meta.url), 'utf8');
const confirm = update.match(/- name: Confirm publication scope\n\s+run: \|\n([\s\S]*?)\n\s+env:/)?.[1]
  .split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
assert.ok(confirm, '実際に使用する公開確認処理が必要です');

test('書込権限を手動メニュー更新jobだけに限定し、配信jobと全体へ広げない', () => {
  assert.match(update, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(update, /^  (?:push|pull_request|pull_request_target|schedule):/m);
  const defaults = update.match(/^permissions:\n([\s\S]*?)\n\S/m)?.[1];
  assert.equal(defaults?.trim(), 'contents: read');
  const updateJob = update.match(/^  update:\n([\s\S]*?)^  publish:/m)?.[1];
  const updatePermissions = updateJob?.match(/^    permissions:\n([\s\S]*?)^    outputs:/m)?.[1];
  assert.equal(updatePermissions?.trim(), 'contents: write');
  const publishJob = update.match(/^  publish:\n([\s\S]*)/m)?.[1];
  assert.match(publishJob, /^      contents: read$/m);
  assert.doesNotMatch(publishJob, /contents: write|write-all/);
  assert.equal([...update.matchAll(/contents: write/g)].length, 1);
  assert.doesNotMatch(publish, /contents: write|write-all/);
  assert.match(update, /^        default: false$/m);
  assert.ok(update.indexOf('Confirm publication scope') < update.indexOf('uses: actions/checkout@'));
  assert.match(update, /GH_TOKEN: \$\{\{ github\.token }}/);
  assert.match(update, /^          persist-credentials: false$/m);
});

for (const [reference, answer] of [['refs/heads/main', 'false'], ['refs/heads/other', 'true'], ['', 'true']]) {
  test(`誤った公開確認は取得やcommitの前に停止する ${reference || '参照なし'} / ${answer}`, async () => {
    await assert.rejects(execute('bash', ['-e', '-c', confirm], {
      env: { ...process.env, GITHUB_REF: reference, CONFIRM_PUBLICATION: answer }
    }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /main.*公開を確認/);
      return true;
    });
  });
}

test('mainの公開を明示的に確認した場合だけ次の処理へ進む', async () => {
  await execute('bash', ['-n', '-c', confirm]);
  const result = await execute('bash', ['-e', '-c', confirm], {
    env: { ...process.env, GITHUB_REF: 'refs/heads/main', CONFIRM_PUBLICATION: 'true' }
  });
  assert.equal(result.stdout, '');
});

test('九HTMLのcache同期と元データ保持の試験を実更新より前に実行する', () => {
  const checks = update.match(/- run: node --test ([^\n]+)/)?.[1].split(/\s+/);
  assert.ok(checks);
  for (const file of ['test/commit-publication.mjs', 'test/publication-workflow.mjs',
    'test/publication-cache.mjs', 'test/site-publication.mjs', 'test/site-publication-flow.mjs',
    'test/publication-gate.mjs', 'test/publication-write-safety.mjs', 'test/publish-menu-redirect.mjs']) {
    assert.ok(checks.includes(file), '同期前の回帰検査が必要です: ' + file);
  }
  assert.ok(update.indexOf('- run: node --test ') < update.indexOf('- run: node tools/publish-menus.mjs --write'));
  assert.ok(!update.includes('--write-site'), '店舗設定・写真の切替許可は今回のメニュー更新に含めない');
  assert.match(update, /店舗情報・スタイル写真は対象外/);
});

test('元データが既に一致していても配信を省かず、前回の配信失敗から再実行できる', () => {
  const job = update.match(/\n  publish:\n([\s\S]+)$/)?.[1];
  assert.ok(job);
  assert.match(job, /needs: update/);
  assert.ok(!job.includes('if:'), '差分なしで配信をskipしない');
  assert.match(job, /uses: \.\/\.github\/workflows\/publish-site\.yml/);
  assert.match(job, /revision: \$\{\{ needs\.update\.outputs\.revision }}/);
  assert.match(job, /verify_booking: true/);
  assert.match(publish, /ref: \$\{\{ inputs\.revision \|\| github\.sha }}/);
  const check = publish.indexOf('node tools/commit-publication.mjs --check');
  const deploy = publish.indexOf('uses: actions/deploy-pages@');
  assert.ok(check > 0 && check < deploy, '配信前にmainの版を照合する');
  const verify = publish.indexOf('if: inputs.verify_booking == true');
  assert.ok(verify > 0 && verify < check, '更新用の配信は直前のメニュー照合を行い、その後mainを確認する');
});
