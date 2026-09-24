import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const source = read('assets/js/common.js');
const catalogSource = source.match(/const STATIC_CATALOG_PAGES = [^]*?\n};/)[0];
const create = page => {
  const calls = [];
  const salon = { reservationEndpoint: 'https://example.test/api', name: '公開済みの店名', business: {} };
  const context = vm.createContext({
    document: { body: { dataset: { page } }, dispatchEvent() {} },
    SALON: salon,
    fetch: async (_, options) => {
      calls.push(JSON.parse(options.body).type);
      return { json: async () => ({ settings: { 店名: '管理画面の店名' }, closedDates: ['2026-09-08'] }) };
    },
    applySettings: settings => { salon.name = settings.店名; },
    Availability: { _blocks: new Map() },
    CustomEvent: class {},
    renderHeader() {}, renderFooter() {}, wireImageFallbacks() {},
    console
  });
  vm.runInContext(catalogSource + '\nthis.catalog = Catalog;', context);
  return { catalog: context.catalog, salon, calls };
};

for (const page of ['home', 'menu', 'staff', 'gallery', 'reviews', 'privacy']) {
  const { catalog, salon, calls } = create(page);
  const results = await Promise.all([catalog.load(), catalog.load()]);
  assert.deepEqual(results, ['local', 'local'], `${page} は公開済みデータを使う`);
  assert.deepEqual(calls, [], `${page} は設定取得の通信をしない`);
  assert.equal(salon.name, '公開済みの店名', `${page} の内容を後から書き換えない`);
  assert.equal(catalog.loaded, true, `${page} の初期化が完了する`);
}
for (const page of ['reserve', 'mypage']) {
  const { catalog, salon, calls } = create(page);
  await Promise.all([catalog.load(), catalog.load()]);
  assert.deepEqual(calls, ['menu'], `${page} は同時取得を一本にまとめる`);
  assert.equal(salon.name, '管理画面の店名', `${page} は最新の設定を維持する`);
  assert.equal(salon.business.closedDates[0], '2026-09-08', `${page} は最新の休業日を維持する`);
  await catalog.load();
  assert.equal(calls.length, 1, `${page} は完了後に重複取得しない`);
}
for (const script of ['assets/js/pages.js', 'assets/js/privacy.js']) {
  assert.ok(!read(script).includes('Catalog.load('), `${script} は公開後に設定を差し替えない`);
}
console.log('公開データと予約設定の分離：全項目成功');
