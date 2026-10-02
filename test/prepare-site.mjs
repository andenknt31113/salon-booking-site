import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareSite } from '../tools/prepare-site.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);

async function fixture(run) {
  const temporary = await mkdtemp(join(tmpdir(), 'zer01-site-copy-'));
  const root = join(temporary, 'source');
  const destination = join(temporary, 'public');
  await mkdir(root);
  for (const file of ['index.html', 'gallery.html', 'menu.html', 'staff.html', 'reviews.html',
    'reserve.html', 'mypage.html', 'privacy.html', '404.html', 'admin.html', 'admin-google.html',
    'design-a.html', 'favicon.svg', 'robots.txt', 'sitemap.xml', '.nojekyll']) {
    await writeFile(join(root, file), '<a href="index.html">HOME</a>');
  }
  await mkdir(join(root, 'assets', 'js'), { recursive: true });
  await writeFile(join(root, 'assets', 'js', 'example.js'), 'const sample = "表示用";');
  await writeFile(join(root, 'HANDOFF.md'), '非公開資料');
  await mkdir(join(root, 'gas'));
  await writeFile(join(root, 'gas', 'Code.gs'), '非公開コード');
  try { await run({ root, destination, temporary }); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

test('公開ページと画像等だけを同じ内容でコピーし、資料・GASを含めない', async () => {
  await fixture(async ({ root, destination }) => {
    const result = await prepareSite({ root, destination });
    assert.equal(result.files, 16);
    assert.equal(await readFile(join(destination, 'index.html'), 'utf8'), await readFile(join(root, 'index.html'), 'utf8'));
    assert.equal(await readFile(join(destination, 'assets', 'js', 'example.js'), 'utf8'), 'const sample = "表示用";');
    assert.equal((await readdir(destination)).includes('HANDOFF.md'), false);
    assert.equal((await readdir(destination)).includes('gas'), false);
    assert.equal((await readdir(destination)).includes('.nojekyll'), false);
  });
});

for (const name of ['.env', 'account.pem', 'private.md']) {
  test(`画像等へ紛れた非公開形式 ${name} はコピー前に断る`, async () => {
    await fixture(async ({ root, destination }) => {
      await writeFile(join(root, 'assets', name), '検査用');
      await assert.rejects(prepareSite({ root, destination }), /配信できないファイル形式/);
      await assert.rejects(readdir(destination), { code: 'ENOENT' });
    });
  });
}

test('公開ファイルの欠落・内部資料への導線・秘密形式をコピー前に断る', async () => {
  await fixture(async ({ root, destination }) => {
    await writeFile(join(root, 'index.html'), '<a href="HANDOFF.md">内部資料</a>');
    await assert.rejects(prepareSite({ root, destination }), /公開対象にない参照先/);
    await writeFile(join(root, 'index.html'), '<a href="index.html">HOME</a>');
    const secretExample = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    await writeFile(join(root, 'assets', 'js', 'example.js'), secretExample);
    await assert.rejects(prepareSite({ root, destination }), /秘密情報の形式/);
    await assert.rejects(readdir(destination), { code: 'ENOENT' });
  });
});

test('必須の公開ページが欠けた場合は、途中までの公開先を作らない', async () => {
  await fixture(async ({ root, destination }) => {
    await rm(join(root, 'reserve.html'));
    await assert.rejects(prepareSite({ root, destination }), { code: 'ENOENT' });
    await assert.rejects(readdir(destination), { code: 'ENOENT' });
  });
});

test('リンク経由の公開元と既存の公開先を変更せず、公開元そのものも上書きしない', async () => {
  await fixture(async ({ root, destination, temporary }) => {
    await assert.rejects(prepareSite({ root, destination: root }), /公開元/);
    await mkdir(destination);
    await writeFile(join(destination, '保持する.txt'), '変更しない');
    await assert.rejects(prepareSite({ root, destination }), /既存の内容は変更しません/);
    assert.equal(await readFile(join(destination, '保持する.txt'), 'utf8'), '変更しない');
    const empty = join(temporary, 'empty');
    await rm(join(root, 'assets', 'js', 'example.js'));
    await symlink(join(root, 'HANDOFF.md'), join(root, 'assets', 'js', 'example.js'));
    await assert.rejects(prepareSite({ root, destination: empty }), /配信できないファイル形式/);
  });
});

test('現行サイトの全ページ・全画像を変換なしで公開用に組み立てられる', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'zer01-site-current-'));
  try {
    const result = await prepareSite({ root: ROOT, destination: join(temporary, 'public') });
    assert.ok(result.files > 16);
    assert.equal(await readFile(join(temporary, 'public', 'reserve.html'), 'utf8'), await readFile(join(ROOT, 'reserve.html'), 'utf8'));
    assert.equal((await readdir(join(temporary, 'public'))).includes('test'), false);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('CLIはリンクされた実行パスでも公開ファイルを作成し、成功したふりで終了しない', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'zer01-site-cli-'));
  try {
    const alias = join(temporary, 'prepare-site.mjs');
    const destination = join(temporary, 'public');
    await symlink(join(ROOT, 'tools', 'prepare-site.mjs'), alias);
    const result = await execute(process.execPath, [alias, destination]);
    assert.match(result.stdout, /公開対象 .* ファイルをコピーしました/);
    assert.equal(await readFile(join(destination, 'reserve.html'), 'utf8'), await readFile(join(ROOT, 'reserve.html'), 'utf8'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
