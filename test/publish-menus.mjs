import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'salon-publication-'));
const output = join(root, 'assets/js/published-menus.js');
let response = {
  ok: true,
  categories: [{ id: 'cat0', name: 'カット', items: [{ id: 'sm0', name: '試験カット', price: 4000, minutes: 60, internal: '非公開値' }] }],
  coupons: [], settings: { '通知先メール': 'private@example.test' }, reviews: [{ body: '持ち出さない' }]
};
const requests = [];
const server = createServer((request, reply) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    requests.push(JSON.parse(body));
    reply.setHeader('Content-Type', 'application/json');
    reply.end(JSON.stringify(response));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const run = mode => execute(process.execPath, [join(root, 'tools/publish-menus.mjs'), mode], {
  env: { ...process.env, RESERVATION_ENDPOINT: `http://127.0.0.1:${server.address().port}/exec` }
});
try {
  await mkdir(join(root, 'tools'), { recursive: true });
  await mkdir(join(root, 'assets/js'), { recursive: true });
  await copyFile(new URL('../tools/publish-menus.mjs', import.meta.url), join(root, 'tools/publish-menus.mjs'));
  await copyFile(new URL('../tools/public-content.mjs', import.meta.url), join(root, 'tools/public-content.mjs'));
  await copyFile(new URL('../tools/publication-site.mjs', import.meta.url), join(root, 'tools/publication-site.mjs'));
  for (const name of ['index.html', 'menu.html', 'staff.html', 'reviews.html', 'gallery.html', 'assets/js/data.js', 'assets/js/common.js', 'assets/js/pages.js']) {
    await copyFile(new URL('../' + name, import.meta.url), join(root, name));
  }
  await writeFile(output, 'const PUBLISHED_MENUS = null;\n');
  await assert.rejects(run('--check'), '未同期の公開データを検出する');
  await run('--write');
  const published = await readFile(output, 'utf8');
  assert.ok(!/非公開値|private@example|持ち出さない/.test(published), '許可したメニュー項目以外は書き出さない');
  const data = vm.runInNewContext(published + ';PUBLISHED_MENUS');
  assert.equal(data.categories[0].items[0].price, 4000);
  const menuHtml = await readFile(join(root, 'menu.html'), 'utf8');
  assert.ok(menuHtml.includes('試験カット') && menuHtml.includes('¥4,000'), '初期HTMLも同じ公開データへ更新する');
  assert.ok(!/非公開値|private@example|持ち出さない/.test(menuHtml), 'HTMLにも内部情報を出さない');
  await run('--check');
  response.categories[0].items[0].price = 4500;
  await assert.rejects(run('--check'), '予約側の価格変更を検出する');
  assert.equal(await readFile(output, 'utf8'), published, '確認コマンドはファイルを書き換えない');
  assert.equal(await readFile(join(root, 'menu.html'), 'utf8'), menuHtml, '確認コマンドはHTMLも書き換えない');
  response = { ok: false };
  await assert.rejects(run('--write'), '不正な応答を書き出さない');
  assert.equal(await readFile(output, 'utf8'), published, '失敗しても以前の公開データが残る');
  assert.equal(await readFile(join(root, 'menu.html'), 'utf8'), menuHtml, '不正応答でHTMLも変更しない');
  response = {
    ok: true, categories: [],
    coupons: [{ id: 'cp-test', title: '試験 <script>実行しない</script>', price: 6000, priceFrom: true, minutes: 60, badge: '全員' }]
  };
  await run('--write');
  for (const name of ['index.html', 'menu.html']) {
    const html = await readFile(join(root, name), 'utf8');
    assert.ok(html.includes('¥6,000〜'), '下限料金を初期HTMLでも維持する');
    assert.ok(html.includes('&lt;script&gt;実行しない&lt;/script&gt;'), '名称にあるHTMLを文字として表示する');
    assert.ok(!html.includes('<script>実行しない</script>'), '名称をスクリプトにしない');
    assert.ok(!html.includes('試験カット'), '削除したメニューは初期HTMLにも残さない');
  }
  const current = await readFile(output, 'utf8');
  const validTemplate = await readFile(join(root, 'menu.html'), 'utf8');
  await writeFile(join(root, 'menu.html'), validTemplate.replace('id="menu-list"', 'id="missing-list"'));
  response.coupons[0].price = 6500;
  await assert.rejects(run('--write'), 'HTMLの更新位置が失われたらデータを先に書き換えない');
  assert.equal(await readFile(output, 'utf8'), current);
  await writeFile(join(root, 'menu.html'), validTemplate);
  const beforeLocal = requests.length;
  await run('--check-local');
  await writeFile(join(root, 'menu.html'), validTemplate.replace('¥6,000〜', '¥1〜'));
  await assert.rejects(run('--check-local'), '初期HTMLだけが古い場合も検知する');
  await run('--write-local');
  assert.equal(await readFile(join(root, 'menu.html'), 'utf8'), validTemplate, 'ローカルの公開データからHTMLを修復する');
  assert.equal(requests.length, beforeLocal, 'ローカル確認と修復は外部へ接続しない');
  response = { ok: true, categories: [], coupons: [] };
  await run('--write');
  const empty = vm.runInNewContext(await readFile(output, 'utf8') + ';PUBLISHED_MENUS');
  assert.equal(empty.categories.length, 0, '全件非表示を公開データにも反映する');
  for (const name of ['index.html', 'menu.html']) assert.ok(!(await readFile(join(root, name), 'utf8')).includes('試験 &lt;script&gt;'), '全件非表示をHTMLにも反映する');
  assert.ok(requests.every(request => request.type === 'menu'), '予約台帳・設定の保存操作を行わない');
  assert.ok(requests.every(request => request.booking === true && !request.initialAvailability),
    '公開料金の更新にスタイル・口コミ・空席の取得を含めない');
  console.log('公開メニュー更新：初期HTML同期・差分検知・許可リスト・不正応答時の保全・全件非表示・文字のエスケープ・外部接続なしの修復を確認');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
