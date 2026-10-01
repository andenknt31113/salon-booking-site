import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const begin = source.indexOf('let memory = null;');
const end = source.indexOf('\n/* ===', begin);
assert.ok(begin >= 0 && end > begin);
const RECORD = { code: 'LM-STORE', date: '2030-01-02', time: '10:00', endTime: '11:00',
  status: 'reserved', totalMinutes: 60, menus: [{ name: '試験カット' }], customer: { tel: '00000000000' } };

function fixture(raw, { failRead = false, failWrite = false } = {}) {
  let value = raw;
  const store = vm.runInNewContext(source.slice(begin, end) + ';Store', {
    STORE_KEY: 'test.reservations', Date, Math,
    localStorage: {
      getItem() { if (failRead) throw new Error('読込不可の試験'); return value; },
      setItem(_key, next) { if (failWrite) throw new Error('保存不可の試験'); value = next; }
    }
  });
  return { store, raw: () => value };
}

for (const raw of ['null', '{}', 'true', '23', '"予約"', '{invalid', '[null]', '[[]]', '[{}]']) {
  test(`不正な端末控え ${raw} でも予約番号発行・追加・照会で停止しない`, () => {
    const app = fixture(raw);
    assert.deepEqual(Array.from(app.store.all()), []);
    assert.equal(app.store.readProblem, true);
    assert.equal(app.store.temporary, true);
    const code = app.store.issueCode();
    assert.match(code, /^LM-[A-Z2-9]{5}$/);
    app.store.add({ ...RECORD, code });
    assert.equal(app.store.find(code).date, RECORD.date);
    assert.equal(app.store.active().length, 1);
    assert.equal(app.raw(), raw, '壊れた元の控えを自動で上書きしない');
  });
}

test('混在する控えの正常な予約を保持し、壊れた部分を保存し直さない', () => {
  const raw = JSON.stringify([RECORD, null, { code: 'LM-INCOMPLETE' }]);
  const app = fixture(raw);
  assert.equal(app.store.all().length, 1);
  assert.equal(app.store.find(RECORD.code).customer.tel, RECORD.customer.tel);
  assert.equal(app.store.readProblem, true);
  assert.equal(app.store.reschedule(RECORD.code, { time: '14:00' }), true);
  assert.equal(app.store.find(RECORD.code).time, '14:00');
  assert.equal(app.store.cancel(RECORD.code), true);
  assert.equal(app.store.active().length, 0);
  assert.equal(app.raw(), raw);
});

test('日付・時刻・メニュー・お客様情報の不正な控えを描画へ渡さない', () => {
  for (const change of [{ date: null }, { date: '2030-02-30' }, { time: 10 }, { time: '29:00' },
    { endTime: 11 }, { menus: {} }, { menus: [null] }, { menus: [23] },
    { customer: null }, { customer: [] }, { code: '' }]) {
    const app = fixture(JSON.stringify([{ ...RECORD, ...change }]));
    assert.equal(app.store.all().length, 0);
    assert.equal(app.store.readProblem, true);
  }
});

test('正常な控えは従来どおり永続化し、古い終了時刻なしの形式も保持する', () => {
  const record = { ...RECORD };
  delete record.endTime;
  const app = fixture(JSON.stringify([record]));
  assert.equal(app.store.all().length, 1);
  assert.equal(app.store.readProblem, false);
  assert.equal(app.store.temporary, false);
  app.store.add({ ...RECORD, code: 'LM-NEW' });
  assert.equal(JSON.parse(app.raw()).length, 2);
  assert.equal(app.store.find('LM-NEW').time, '10:00');
});

test('読込不可・保存不可でも控えを保持し、端末への永続保存を保証しない', () => {
  for (const options of [{ failRead: true }, { failWrite: true }]) {
    const app = fixture(JSON.stringify([]), options);
    app.store.add(RECORD);
    assert.equal(app.store.find(RECORD.code).customer.tel, RECORD.customer.tel);
    assert.equal(app.store.temporary, true);
    assert.equal(JSON.parse(app.raw()).length, 0);
  }
});

test('確実に拒否された申込の仮控えだけを除き、別の予約を消さない', () => {
  const pending = { ...RECORD, code: 'LM-PENDING', delivered: false, deliveryState: 'unknown' };
  const app = fixture(JSON.stringify([RECORD, pending]));
  assert.equal(app.store.remove(pending.code), true);
  assert.equal(app.store.all().length, 1);
  assert.equal(app.store.find(RECORD.code).date, RECORD.date);
  assert.equal(app.store.remove('LM-NOTFOUND'), false);
  assert.equal(JSON.parse(app.raw()).length, 1);
});

test('仮控えの確定は日時変更の履歴を作らず、サーバーの番号を引き継ぐ', () => {
  const pending = { ...RECORD, delivered: false, deliveryState: 'unknown' };
  const app = fixture(JSON.stringify([pending]));
  assert.equal(app.store.replace(RECORD.code, { code: 'LM-FINAL', delivered: true, deliveryState: 'confirmed' }), true);
  assert.equal(app.store.all().length, 1);
  assert.equal(app.store.find(RECORD.code), null);
  assert.equal(app.store.find('LM-FINAL').changedAt, undefined);
  assert.equal(app.store.find('LM-FINAL').customer.tel, RECORD.customer.tel);
  assert.equal(app.store.reschedule('LM-FINAL', { time: '14:00' }), true);
  assert.ok(app.store.find('LM-FINAL').changedAt, '本当の日時変更には記録を残す');
});
