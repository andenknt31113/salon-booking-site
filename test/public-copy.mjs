import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { publicHtml } from '../tools/public-content.mjs';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');

async function model() {
  const context = vm.createContext({ URL, document: { addEventListener() {} } });
  for (const name of ['assets/js/data.js', 'assets/js/published-menus.js', 'assets/js/common.js', 'assets/js/pages.js']) {
    vm.runInContext(await read(name), context);
  }
  return context;
}

test('トップの見出しは店名を表示し、保存済みキャッチコピーを表示しない', async () => {
  const context = await model();
  const heading = vm.runInContext('homeCatchHtml()', context);
  const salon = vm.runInContext('SALON', context);
  assert.equal(heading, `<span class="hero-name">${salon.name}</span> <span class="hero-category">${salon.nameSub}</span>`);
  assert.ok(!heading.includes(salon.catch));
  const previous = salon.catch;
  context.homeCatchHtml();
  assert.equal(salon.catch, previous, '店主の保存済み紹介内容は書き換えない');
});

test('店名はHTMLとして実行せず、業態名が空でも余計な見出しを作らない', async () => {
  const context = await model();
  vm.runInContext('SALON.name = "<試験店舗>"; SALON.nameSub = ""; SALON.catch = "表示しない宣伝文";', context);
  assert.equal(context.homeCatchHtml(), '<span class="hero-name">&lt;試験店舗&gt;</span>');
});

test('口コミ案内は操作名で見出しを付け、外部リンクと投稿手順を残す', async () => {
  const context = await model();
  const guide = context.googleReviewGuideHtml();
  assert.match(guide, /<h2>口コミを見る<\/h2>/);
  assert.match(guide, /<h2>口コミを書く<\/h2>/);
  assert.doesNotMatch(guide, /来店前に、|来店後に、|SHARE YOUR EXPERIENCE/);
  assert.match(guide, /Googleマップの店舗ページで「クチコミ」を選んでください/);
  assert.match(guide, /noopener noreferrer/);
  assert.match(guide, /口コミを収集・掲載しません/);
  assert.doesNotMatch(context.reviewEmptyHtml(), /来店前の参考に/);
});

test('初期HTMLも再生成後も同じ文言になり、宣伝文が復活しない', async () => {
  const files = await publicHtml(await read('assets/js/published-menus.js'));
  for (const name of ['index.html', 'reviews.html']) {
    const file = files.find(candidate => candidate.name === name);
    assert.equal(file.next, file.previous, `${name}の初期HTMLと描画関数は一致する`);
  }
  const home = files.find(file => file.name === 'index.html').next;
  assert.match(home, /class="hero-name">ZER01<\/span>/);
  assert.doesNotMatch(home, /なりたいイメージを探して|来店前の参考に/);
});

test('描画JSとトップCSSは内容のhashを参照し、次のメニュー公開でも古いcache版へ戻らない', async () => {
  const files = await publicHtml(await read('assets/js/published-menus.js'));
  for (const asset of ['assets/js/pages.js', 'assets/css/home.css']) {
    const version = createHash('sha256').update(await read(asset)).digest('hex');
    const consumers = files.filter(file => file.previous.includes(asset));
    assert.equal(consumers.length, asset.endsWith('pages.js') ? 5 : 1);
    for (const file of consumers) {
      assert.ok(file.previous.includes(asset + '?v=' + version), `${file.name}は実際のファイル内容に合うcache版を使う`);
      assert.ok(file.next.includes(asset + '?v=' + version), 'メニュー更新後も同じ描画版を維持する');
    }
  }
});

test('口コミの投稿方法への案内は読み込み前後で同じで、閲覧ボタンと重複しない', async () => {
  const context = await model();
  const home = await read('index.html');
  assert.match(home, /id="home-review-link" href="reviews\.html">口コミの投稿方法<\/a>/);
  assert.doesNotMatch(context.reviewEmptyHtml(), /口コミの投稿方法|ご来店の感想は/);
});
