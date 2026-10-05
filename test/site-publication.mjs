import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { PUBLICATION_SETTING_KEYS, publicationSite, parsePublishedMenus, serializePublishedMenus } from '../tools/publication-site.mjs';

function fixture() {
  return { styles: [{ id: 'ss0', title: '架空スタイル', length: 'ショート', staffId: null,
    tags: ['カット'], detail: '架空の説明', image: 'assets/style1.jpg', hue: 0 }],
    settings: Object.fromEntries(PUBLICATION_SETTING_KEYS.map(key => [key, ''])) };
}

test('公開設定の許可項目をGASと揃え、別の私的な項目を追加しない', () => {
  const source = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
  const context = vm.createContext({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) } });
  vm.runInContext(source, context);
  assert.deepEqual(PUBLICATION_SETTING_KEYS.toSorted(), Array.from(vm.runInContext('PUBLIC_SETTING_KEYS', context)).toSorted());
});

test('空の文字・写真の削除・公開する値の型を保持し、許可外を持ち出さない', () => {
  const data = fixture();
  data.settings['スタッフの経験年数'] = 0;
  data.settings['準備中の帯'] = false;
  data.settings['通知先メール'] = 'private@example.test';
  data.styles[0].internal = '非公開の値';
  data.reviews = [{ body: '掲載しない口コミ' }];
  const result = publicationSite(data);
  assert.equal(result.settings['スタッフの経験年数'], 0);
  assert.equal(result.settings['準備中の帯'], false);
  assert.equal(result.settings['店の紹介文'], '');
  assert.equal(result.styles[0].staffId, null);
  assert.deepEqual(result.styles[0].tags, ['カット']);
  assert.equal(JSON.stringify(result).includes('private@example.test'), false);
  assert.equal(JSON.stringify(result).includes('非公開'), false);
  assert.equal(result.reviews, undefined);
  data.styles = [];
  assert.deepEqual(publicationSite(data).styles, []);
});

for (const [label, corrupt] of [
  ['写真一覧がない', data => { delete data.styles; }],
  ['写真一覧がnull', data => { data.styles = null; }],
  ['写真のnull', data => { data.styles[0] = null; }],
  ['写真の穴', data => { data.styles = new Array(1); }],
  ['写真IDの重複', data => { data.styles.push(structuredClone(data.styles[0])); }],
  ['空のタイトル', data => { data.styles[0].title = ' '; }],
  ['タグの不正', data => { data.styles[0].tags = [{}]; }],
  ['タグの穴', data => { data.styles[0].tags = new Array(1); }],
  ['色値の不正', data => { data.styles[0].hue = Infinity; }],
  ['設定の欠落', data => { delete data.settings['店の紹介文']; }],
  ['設定のnull', data => { data.settings = null; }],
  ['設定の配列', data => { data.settings = []; }],
  ['設定値のobject', data => { data.settings['住所'] = {}; }],
  ['設定値の不正な数', data => { data.settings['スタッフの経験年数'] = NaN; }]
]) {
  test(`${label}を公開用データへ変換しない`, () => {
    const data = fixture();
    corrupt(data);
    assert.throws(() => publicationSite(data), /公開データ/);
  });
}

for (const url of ['javascript:alert(1)', 'data:image/svg+xml,invalid', 'http://example.test/image.jpg',
  '../outside.jpg', 'assets/../../outside.jpg', 'https://user:pass@example.test/photo.jpg',
  'https://example.test/photo.jpg#fragment']) {
  test(`不正な写真URLを公開しない：${url.split(':')[0]}`, () => {
    const data = fixture();
    data.styles[0].image = url;
    assert.throws(() => publicationSite(data), /公開データ/);
    data.styles[0].image = 'assets/style1.jpg';
    data.settings['メイン写真'] = url;
    assert.throws(() => publicationSite(data), /公開データ/);
  });
}

test('安全な写真URL・空欄・外部サービスリンクをそのまま保持する', () => {
  const data = fixture();
  data.styles[0].image = 'https://example.test/photo.jpg?view=public';
  data.settings['メイン写真'] = 'assets/shop1.jpg';
  data.settings['Google口コミURL'] = 'https://example.test/reviews';
  const result = publicationSite(data);
  assert.equal(result.styles[0].image, data.styles[0].image);
  assert.equal(result.settings['メイン写真'], 'assets/shop1.jpg');
  assert.equal(result.settings['Google口コミURL'], 'https://example.test/reviews');
  data.settings['Google口コミURL'] = 'assets/style1.jpg';
  assert.throws(() => publicationSite(data), /公開データ/);
});

test('公開文章に既知形式の秘密が含まれる場合も、値をエラーへ出さず停止する', () => {
  const data = fixture();
  const sensitiveShape = ['ghp_', 'x'.repeat(30)].join('');
  data.settings['店の紹介文'] = sensitiveShape;
  assert.throws(() => publicationSite(data), error => {
    assert.match(error.message, /公開データ/);
    assert.equal(error.message.includes(sensitiveShape), false);
    return true;
  });
});

test('HTMLの閉じタグを含む店の文字もコードにせず、JSONとして往復する', () => {
  const data = fixture();
  data.styles[0].title = '</script><script>処理しない文字</script>';
  const published = { categories: [], coupons: [], site: publicationSite(data) };
  const source = serializePublishedMenus(published);
  assert.equal(source.includes('</script>'), false);
  assert.deepEqual(parsePublishedMenus(source), published);
  assert.throws(() => parsePublishedMenus('const PUBLISHED_MENUS = (() => unsafe())();'));
});
