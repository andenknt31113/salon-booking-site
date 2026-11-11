import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { publicHtml, syncAssetVersions } from '../tools/public-content.mjs';
import { MANUAL_VERSION_PAGES, staleAssetVersions } from '../tools/sync-asset-versions.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const assets = { 'assets/js/common.js': 'const a = 1;', 'assets/css/style.css': 'body{}' };
const readAsset = async name => {
  if (!Object.hasOwn(assets, name)) throw new Error('missing ' + name);
  return assets[name];
};

test('版なし・古い版の読込URLを、ファイル内容のhashへ揃える', async () => {
  const html = '<link rel="stylesheet" href="assets/css/style.css">\n'
    + '<script src="assets/js/common.js?v=20261006-read-deadline"></script>\n'
    + "<script src='assets/js/common.js?v=old'></script>";
  const next = await syncAssetVersions(html, readAsset);
  assert.equal(next, '<link rel="stylesheet" href="assets/css/style.css?v=' + hash('body{}') + '">\n'
    + '<script src="assets/js/common.js?v=' + hash('const a = 1;') + '"></script>\n'
    + "<script src='assets/js/common.js?v=" + hash('const a = 1;') + "'></script>");
  assert.equal(await syncAssetVersions(next, readAsset), next, '同じ内容なら版を変えない');
});

test('中身を変えると読込URLも変わる', async () => {
  const html = '<script src="assets/js/common.js"></script>';
  const before = await syncAssetVersions(html, readAsset);
  const after = await syncAssetVersions(before, async () => 'const a = 2;');
  assert.notEqual(after, before);
  assert.ok(after.includes('?v=' + hash('const a = 2;')));
});

test('公開データ・外部のファイル・画像・ページへのリンクは書き換えない', async () => {
  const html = '<script src="assets/js/published-menus.js?v=keep"></script>'
    + '<script src="https://example.invalid/assets/js/common.js"></script>'
    + '<link rel="icon" href="favicon.svg"><img src="assets/shop1.jpg"><a href="reserve.html">予約</a>'
    + '<link rel="stylesheet" href="assets/css/style.css?v=x">';
  const next = await syncAssetVersions(html, readAsset);
  assert.equal(next, html.replace('style.css?v=x', 'style.css?v=' + hash('body{}')));
});

test('存在しないファイルへの参照は、版を付けずに失敗させる', async () => {
  await assert.rejects(syncAssetVersions('<script src="assets/js/none.js"></script>', readAsset), /missing/);
});

test('お客様向けの全HTMLの読込URLが、JS・CSSの現在の内容と一致している', async () => {
  const stale = await staleAssetVersions();
  assert.deepEqual(stale.map(file => file.name), [],
    'node tools/sync-asset-versions.mjs --write で揃えてください');
});

test('版を一つに揃えて読む管理画面は、内容hashへ書き換えない', async t => {
  assert.deepEqual([...MANUAL_VERSION_PAGES], ['admin.html', 'admin-google.html']);
  const directory = await mkdtemp(join(tmpdir(), 'zer01-asset-versions-admin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../assets/css', import.meta.url), join(directory, 'assets/css'), { recursive: true });
  for (const name of [...MANUAL_VERSION_PAGES, '404.html']) {
    await writeFile(join(directory, name), '<link rel="stylesheet" href="assets/css/style.css?v=release-1">');
  }
  const stale = await staleAssetVersions(pathToFileURL(directory + '/'));
  assert.deepEqual(stale.map(file => file.name), ['404.html']);
});

test('初期HTMLの生成も同じ版を付け、再生成で変えない', async () => {
  const catalog = await readFile(new URL('../assets/js/published-menus.js', import.meta.url), 'utf8');
  const common = hash(await readFile(new URL('../assets/js/common.js', import.meta.url), 'utf8'));
  for (const file of await publicHtml(catalog)) {
    assert.equal(file.next, file.previous, file.name);
    if (file.name !== 'design-a.html') assert.ok(file.next.includes('assets/js/common.js?v=' + common), file.name);
  }
});

test('ずれの検出と書換えは対象のHTMLだけに行う', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zer01-asset-versions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../assets/css', import.meta.url), join(directory, 'assets/css'), { recursive: true });
  await writeFile(join(directory, 'a.html'), '<link rel="stylesheet" href="assets/css/style.css?v=old">');
  await writeFile(join(directory, 'b.html'), '<p>読込なし</p>');
  await writeFile(join(directory, 'note.md'), 'assets/css/style.css?v=old');
  const stale = await staleAssetVersions(pathToFileURL(directory + '/'));
  assert.deepEqual(stale.map(file => file.name), ['a.html']);
  assert.match(stale[0].next, /style\.css\?v=[a-f0-9]{64}"/);
});
