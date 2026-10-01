import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/mypage.js', import.meta.url), 'utf8');
const begin = source.indexOf('function isUnconfirmed(');
const end = source.indexOf('\n/** 予約の終わり', begin);
assert.ok(begin >= 0 && end > begin);
const ORIGINAL = { code: 'LM-OPERATION', date: '2030-01-02', time: '10:00', endTime: '11:00',
  status: 'reserved', customer: { tel: '09011112222' }, delivered: true, deliveryState: 'confirmed', deliveryError: '' };

function fixture({ cached = true, lookup = false } = {}) {
  let record = cached ? structuredClone(ORIGINAL) : null;
  let refreshes = 0;
  const app = vm.runInNewContext(`let lastLookup = ${JSON.stringify(lookup
    ? { code: ORIGINAL.code, lookupTel: ORIGINAL.customer.tel, date: ORIGINAL.date, time: ORIGINAL.time } : null)};
    const pendingBookingActions = new Set();
    ${source.slice(begin, end)}
    ({markBookingUnconfirmed,restoreBookingDelivery,isUnconfirmed,pendingBookingActions,
      lookup:()=>lastLookup})`, {
    normalizeCode: value => String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
    normalizeTel: value => String(value || ''),
    refreshView() { refreshes++; },
    Store: {
      find(code) { return record && record.code === code ? structuredClone(record) : null; },
      replace(code, values) {
        if (!record || record.code !== code) return false;
        record = { ...record, ...values };
        return true;
      },
      reschedule() { assert.fail('通信の状態で日時変更履歴を付けない'); }
    }
  });
  return { app, record: () => record, refreshes: () => refreshes,
    update: values => { record = { ...record, ...values }; } };
}

test('取消送信の控えは元の日時と状態を残し、応答前には未確認とする', () => {
  const state = fixture();
  const previous = state.app.markBookingUnconfirmed(ORIGINAL.code);
  assert.deepEqual(previous, ORIGINAL);
  assert.equal(state.record().date, ORIGINAL.date);
  assert.equal(state.record().status, ORIGINAL.status);
  assert.equal(state.record().changedAt, undefined);
  assert.equal(state.record().cancelledAt, undefined);
  assert.equal(state.record().deliveryState, 'unknown');
  assert.equal(state.app.isUnconfirmed(state.record()), true);
  assert.equal(state.refreshes(), 1);
});

test('確実な拒否は通信の状態だけを戻し、他の画面で更新した日時やメモを巻き戻さない', () => {
  const state = fixture();
  const previous = state.app.markBookingUnconfirmed(ORIGINAL.code);
  state.update({ date: '2030-01-03', note: '別の画面で追加した内容' });
  state.app.restoreBookingDelivery(ORIGINAL.code, previous, null);
  assert.equal(state.record().date, '2030-01-03');
  assert.equal(state.record().note, '別の画面で追加した内容');
  assert.equal(state.record().deliveryState, 'confirmed');
  assert.equal(state.app.isUnconfirmed(state.record()), false);
  assert.equal(state.record().changedAt, undefined);
});

test('照会の電話番号が違うとき、同じ番号の別の控えを未確認へ変えない', () => {
  const state = fixture({ lookup: true });
  assert.equal(state.app.markBookingUnconfirmed(ORIGINAL.code, '09099998888'), null);
  assert.deepEqual(state.record(), ORIGINAL);
});

test('区切り文字の違う同じ電話番号の控えは未確認へ変える', () => {
  const state = fixture();
  const previous = state.app.markBookingUnconfirmed(ORIGINAL.code, '090-1111-2222');
  assert.deepEqual(previous, ORIGINAL);
  assert.equal(state.record().deliveryState, 'unknown');
});

test('別端末の照会から送信しても、無い端末控えや個人情報を作らない', () => {
  const state = fixture({ cached: false, lookup: true });
  const previousLookup = structuredClone(state.app.lookup());
  assert.equal(state.app.markBookingUnconfirmed(ORIGINAL.code, ORIGINAL.customer.tel), null);
  assert.equal(state.record(), null);
  assert.equal(state.app.lookup().deliveryState, 'unknown');
  state.app.restoreBookingDelivery(ORIGINAL.code, null, previousLookup);
  assert.equal(state.app.isUnconfirmed(state.app.lookup()), false);
  assert.equal(state.record(), null);
});

test('通信中に読み取った古い確定状態は次の変更や取消の根拠にしない', () => {
  const state = fixture();
  state.app.pendingBookingActions.add('LMOPERATION');
  assert.equal(state.app.isUnconfirmed(ORIGINAL), true);
  state.app.pendingBookingActions.delete('LMOPERATION');
  assert.equal(state.app.isUnconfirmed(ORIGINAL), false);
});
