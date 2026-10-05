import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { test } from 'node:test';
import { PUBLICATION_SETTING_KEYS, parsePublishedMenus } from '../tools/publication-site.mjs';

const execute = promisify(execFile);
const FILES = ['index.html', 'menu.html', 'staff.html', 'gallery.html', 'reviews.html',
  'privacy.html', 'reserve.html', 'mypage.html', 'design-a.html',
  'assets/js/data.js', 'assets/js/published-menus.js', 'assets/js/common.js', 'assets/js/pages.js',
  'tools/public-content.mjs', 'tools/publish-menus.mjs', 'tools/publication-site.mjs'];
const GENERATED = ['assets/js/published-menus.js', 'index.html', 'menu.html', 'staff.html', 'gallery.html', 'reviews.html',
  'privacy.html', 'reserve.html', 'mypage.html', 'design-a.html'];

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'zer01-site-publication-'));
  const requests = [];
  const published = parsePublishedMenus(await readFile(new URL('../assets/js/published-menus.js', import.meta.url), 'utf8'));
  const settings = Object.fromEntries(PUBLICATION_SETTING_KEYS.map(key => [key, '']));
  Object.assign(settings, { '準備中の帯': '出さない', 営業開始: '09:00', 営業終了: '19:00', 最終受付: '18:00',
    店の紹介文: '同期試験の紹介文', 住所: '同期試験の住所', スタッフの紹介文: '同期試験の紹介',
    メイン写真: 'assets/shop1.jpg', 問い合わせ先メール: 'public@example.test', 通知先メール: 'private@example.test' });
  let response = { ok: true, publicationReady: true, categories: published.categories, coupons: published.coupons,
    styles: [{ id: 'ss0', title: '同期試験の写真', length: 'ショート', staffId: null, tags: ['同期試験'],
      detail: '同期試験の説明', image: 'assets/style1.jpg', hue: 0, internal: '持ち出さない内部値' }], settings,
    reservations: [{ name: '持ち出さない顧客' }], reviews: [{ body: '持ち出さない口コミ' }] };
  const server = createServer((request, reply) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      reply.setHeader('Content-Type', 'application/json');
      reply.end(JSON.stringify(response));
    });
  });
  try {
    for (const file of FILES) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await copyFile(new URL('../' + file, import.meta.url), join(root, file));
    }
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const command = mode => execute(process.execPath, [join(root, 'tools/publish-menus.mjs'), mode], {
      env: { RESERVATION_ENDPOINT: `http://127.0.0.1:${server.address().port}/exec`, TZ: 'UTC' }
    });
    const snapshot = () => Promise.all(GENERATED.map(file => readFile(join(root, file), 'utf8')));
    const hydrate = async page => {
      const calls = [];
      const context = vm.createContext({ URL, document: { body: { dataset: { page } }, addEventListener() {} },
        fetch: (...arguments_) => { calls.push(arguments_); throw new Error('公開画面は外部通信しない'); } });
      for (const file of ['assets/js/data.js', 'assets/js/published-menus.js', 'assets/js/common.js']) {
        vm.runInContext(await readFile(join(root, file), 'utf8'), context);
      }
      assert.equal(await vm.runInContext('Catalog.load()', context), 'local');
      assert.deepEqual(calls, []);
      return JSON.parse(vm.runInContext('JSON.stringify(SALON)', context));
    };
    await run({ root, command, snapshot, requests, hydrate, response: () => response,
      change: next => { response = next; } });
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test('メニュー・店の情報・写真をまとめて生成し、初期HTMLと六つの公開画面の値を一致させる', async () => {
  await fixture(async ({ root, command, snapshot, requests, hydrate }) => {
    const before = await snapshot();
    await assert.rejects(command('--check-site'));
    assert.deepEqual(await snapshot(), before);
    await command('--write-site');
    await command('--check-site');
    await command('--check-local');
    assert.deepEqual(requests, Array.from({ length: 3 }, () => ({ type: 'menu', publication: true })));
    const source = await readFile(join(root, 'assets/js/published-menus.js'), 'utf8');
    assert.equal(/持ち出さない|private@example/.test(source), false);
    const home = await readFile(join(root, 'index.html'), 'utf8');
    assert.ok(home.includes('同期試験の紹介文'));
    assert.ok(home.includes('同期試験の住所'));
    assert.ok(home.includes('同期試験の写真'));
    assert.ok(home.includes('assets/shop1.jpg'));
    assert.ok((await readFile(join(root, 'gallery.html'), 'utf8')).includes('同期試験の写真'));
    assert.ok((await readFile(join(root, 'staff.html'), 'utf8')).includes('同期試験の紹介'));
    for (const page of ['home', 'menu', 'staff', 'gallery', 'reviews', 'privacy']) {
      const salon = await hydrate(page);
      assert.equal(salon.description, '同期試験の紹介文');
      assert.equal(salon.styles[0].title, '同期試験の写真');
      assert.equal(salon.heroImage, 'assets/shop1.jpg');
      assert.equal(salon.contactEmail, 'public@example.test');
      assert.equal(salon.business.openTime, '09:00');
    }
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.publication-')), []);
  });
});

test('従来のメニューだけの更新でも、既に公開した店の情報・写真を消さない', async () => {
  await fixture(async ({ root, command, response, change, hydrate, requests }) => {
    await command('--write-site');
    const before = parsePublishedMenus(await readFile(join(root, 'assets/js/published-menus.js'), 'utf8')).site;
    const updated = structuredClone(response());
    updated.coupons[0].price += 100;
    delete updated.publicationReady;
    delete updated.styles;
    updated.settings = { 店の紹介文: 'メニューだけの更新で置換しない紹介' };
    change(updated);
    await command('--write');
    await command('--check');
    await command('--check-local');
    const result = parsePublishedMenus(await readFile(join(root, 'assets/js/published-menus.js'), 'utf8'));
    assert.deepEqual(result.site, before);
    assert.equal(result.coupons[0].price, updated.coupons[0].price);
    assert.equal((await hydrate('home')).description, '同期試験の紹介文');
    assert.deepEqual(requests.slice(1), [{ type: 'menu', booking: true }, { type: 'menu', booking: true }]);
  });
});

test('写真の全非掲載と空の紹介文を同期し、元のHPBの写真や文章へ戻さない', async () => {
  await fixture(async ({ root, command, response, change, hydrate }) => {
    await command('--write-site');
    const updated = structuredClone(response());
    updated.styles = [];
    updated.settings['店の紹介文'] = '';
    change(updated);
    await command('--write-site');
    await command('--check-site');
    await command('--check-local');
    const salon = await hydrate('home');
    assert.deepEqual(salon.styles, []);
    assert.equal(salon.description, '');
    assert.equal((await readFile(join(root, 'gallery.html'), 'utf8')).includes('同期試験の写真'), false);
    assert.equal((await readFile(join(root, 'index.html'), 'utf8')).includes('同期試験の紹介文'), false);
  });
});

for (const [label, corrupt] of [
  ['公開用の印がない旧応答', data => { delete data.publicationReady; }],
  ['公開用の印が文字列', data => { data.publicationReady = 'true'; }],
  ['メニュー一覧が不明', data => { data.categories = null; }],
  ['おすすめ一覧が不明', data => { data.coupons = null; }],
  ['成功とエラーの混在', data => { data.error = '確認できません'; }],
  ['成功と結果不明の混在', data => { data.unknown = true; }],
  ['成功と拒否の混在', data => { data.rejected = true; }],
  ['写真一覧が不明', data => { data.styles = null; }],
  ['公開設定が欠ける', data => { delete data.settings['住所']; }],
  ['不正な写真リンク', data => { data.styles[0].image = 'javascript:invalid'; }]
]) {
  test(`${label}では一部だけの更新や前の値による補完をせず、公開元を全て保持する`, async () => {
    await fixture(async ({ command, snapshot, response, change }) => {
      await command('--write-site');
      const before = await snapshot();
      const data = structuredClone(response());
      data.coupons[0].price += 100;
      corrupt(data);
      change(data);
      await assert.rejects(command('--write-site'));
      assert.deepEqual(await snapshot(), before);
      await command('--check-local');
    });
  });
}
