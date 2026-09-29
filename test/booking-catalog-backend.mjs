import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
function environment({ fail = false } = {}) {
  let held = false;
  const reads = [];
  const context = vm.createContext({ Date, console: { error() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => text }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({}) },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; }
    }) }
  });
  vm.runInContext(source, context);
  for (const [name, result] of [
    ['readMenuSheet_', [{ name: 'カット', items: [{ name: 'カット', price: 6900, minutes: 60 }] }]],
    ['readCouponSheet_', []], ['readStyleSheet_', [{ name: '写真' }]], ['readReviewSheet_', [{ body: '投稿' }]],
    ['readClosedSheet_', ['2099-01-01']],
    ['readSettings_', { '営業開始': '10:00', '準備中の帯': '出さない', '通知先メール': 'private@example.invalid' }]
  ]) {
    context[name] = () => {
      assert.equal(held, true, '保存中の一覧を途中で読まない');
      reads.push(name);
      if (fail && name === 'readSettings_') throw new Error('設定を確認できません');
      return result;
    };
  }
  return { reads, held: () => held,
    send: payload => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(payload) } })) };
}

test('予約用メニューは必要な4シートだけ読み、公開許可のない設定を返さない', () => {
  const app = environment();
  const data = app.send({ type: 'menu', booking: true });
  assert.equal(data.ok, true);
  assert.deepEqual(app.reads, ['readMenuSheet_', 'readCouponSheet_', 'readClosedSheet_', 'readSettings_']);
  assert.equal(data.styles, undefined);
  assert.equal(data.reviews, undefined);
  assert.equal(data.settings['通知先メール'], undefined);
  assert.equal(data.settings['営業開始'], '10:00');
  assert.deepEqual(data.closedDates, ['2099-01-01']);
  assert.equal(data.categories[0].items[0].minutes, 60);
  assert.equal(data.timing, undefined);
  assert.equal(app.held(), false);
});

test('従来のメニュー取得の応答と、明示しない場合の挙動を維持する', () => {
  for (const booking of [undefined, false, 'true']) {
    const app = environment();
    const data = app.send({ type: 'menu', booking });
    assert.equal(data.ok, true);
    assert.equal(app.reads.length, 6);
    assert.equal(data.styles[0].name, '写真');
    assert.equal(data.reviews[0].body, '投稿');
    assert.equal(data.timing, undefined);
  }
});

test('計測はメニューの明示要求だけに時間の数値を返し、認証情報を含めない', () => {
  const app = environment();
  const data = app.send({ type: 'menu', booking: true, measure: true });
  assert.equal(data.ok, true);
  assert.deepEqual(Object.keys(data.timing).sort(), ['catalogMs', 'lockMs', 'totalMs']);
  for (const value of Object.values(data.timing)) assert.ok(Number.isFinite(value) && value >= 0);
  assert.ok(data.timing.totalMs >= data.timing.lockMs + data.timing.catalogMs);
  assert.equal(environment().send({ type: 'menu', measure: 'true' }).timing, undefined);
});

test('軽量な取得でも設定の失敗を成功にせず、台帳ロックを解放する', () => {
  const app = environment({ fail: true });
  const data = app.send({ type: 'menu', booking: true, measure: true });
  assert.equal(data.ok, false);
  assert.match(data.error, /設定を確認できません/);
  assert.equal(app.held(), false);
});
