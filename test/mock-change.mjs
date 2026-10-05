import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const PASSWORD = process.env.MOCK_ADMIN_PASSWORD;
if (!PASSWORD) throw new Error('MOCK_ADMIN_PASSWORD を設定してください。');

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

function day(offset) {
  const date = new Date(today + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function withMock(run) {
  const server = http.createServer(createMockHandler());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = payload => fetch(base + '/exec', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload)
  }).then(response => response.json());
  try { await run(post); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('お客様の日時変更では送信された所要時間と終了時刻を信用しない', async () => {
  await withMock(async post => {
    const phone = '09012345678';
    const originalDate = day(7);
    const nextDate = day(8);
    const booking = await post({ type: 'adminAdd', password: PASSWORD, force: true,
      date: originalDate, time: '10:00', minutes: 90, name: '予約変更の試験客', tel: phone });
    const blocker = await post({ type: 'adminAdd', password: PASSWORD, force: true,
      date: nextDate, time: '15:00', minutes: 60, name: '次の枠の試験客' });
    assert.equal(booking.ok, true);
    assert.equal(blocker.ok, true);

    const request = { type: 'change', code: booking.code, tel: phone,
      date: nextDate, time: '14:00', minutes: 30, endTime: '14:30' };
    const blocked = await post(request);
    assert.equal(blocked.ok, false, '短い所要時間を偽っても次の予約と重なれば断る');
    assert.match(blocked.error, /他のお客様/);
    assert.equal((await post({ type: 'lookup', code: booking.code, tel: phone })).reservation.date,
      originalDate, '断られた予約は移動しない');

    assert.equal((await post({ type: 'cancel', password: PASSWORD, code: blocker.code })).ok, true);
    assert.equal((await post(request)).ok, true, '枠が空いた後は変更できる');
    const moved = (await post({ type: 'lookup', code: booking.code, tel: phone })).reservation;
    assert.equal(moved.date, nextDate);
    assert.equal(moved.totalMinutes, 90, '台帳の施術時間を保つ');
    assert.equal(moved.endTime, '15:30', '終了時刻は台帳の所要時間から計算する');

    const withoutClientDuration = await post({ type: 'change', code: booking.code, tel: phone,
      date: nextDate, time: '13:00' });
    assert.equal(withoutClientDuration.ok, true, '端末から所要時間を受け取る必要はない');
    assert.equal((await post({ type: 'lookup', code: booking.code, tel: phone })).reservation.endTime,
      '14:30');
  });
});

test('模擬受け口も変更先の営業時間・休業・受付範囲を確認する', async () => {
  await withMock(async post => {
    const phone = '09012345679';
    const originalDate = day(7);
    const booking = await post({ type: 'adminAdd', password: PASSWORD, force: true,
      date: originalDate, time: '10:00', minutes: 90, name: '変更条件の試験客', tel: phone });
    assert.equal(booking.ok, true);
    const change = (date, time) => post({ type: 'change', code: booking.code, tel: phone,
      date, time, minutes: 15, endTime: '00:00' });

    assert.match((await change(day(-1), '13:00')).error, /過ぎた日付/);
    assert.match((await change(day(61), '13:00')).error, /60日先/);
    assert.match((await change(day(8), '21:00')).error, /営業時間外/,
      '最終受付内でも既存の90分が閉店時刻を越えれば断る');
    assert.match((await change(day(8), '21:30')).error, /営業時間外/,
      '最終受付より後は断る');

    const snapshot = await post({ type: 'adminData', password: PASSWORD });
    const closedDate = day(9);
    const closed = await post({ type: 'adminSave', password: PASSWORD, target: 'closed',
      stamp: snapshot.stamps.closed,
      rows: [...snapshot.closedDates, { '休業日': closedDate, '開始': '14:00', '終了': '14:30', 'メモ': '' }] });
    assert.equal(closed.ok, true);
    assert.match((await change(closedDate, '13:00')).error, /受付を止めて/,
      '端末が15分と送っても台帳の90分で休業時間との重なりを確認する');

    const weekdayDate = day(10);
    const weekday = ['日', '月', '火', '水', '木', '金', '土'][new Date(weekdayDate + 'T12:00:00Z').getUTCDay()];
    const settings = await post({ type: 'adminData', password: PASSWORD });
    assert.equal((await post({ type: 'adminSave', password: PASSWORD, target: 'settings',
      stamp: settings.stamps.settings, rows: { ...settings.settings, '定休曜日': weekday } })).ok, true);
    assert.match((await change(weekdayDate, '13:00')).error, /定休日/);
    assert.equal((await post({ type: 'lookup', code: booking.code, tel: phone })).reservation.date,
      originalDate, '断られた変更で予約は移動しない');
  });
});

test('模擬受け口も同じ日時の再送では変更を重ねず、本人確認と期限を守る', async () => {
  await withMock(async post => {
    const phone = '09012345676';
    const booking = await post({ type: 'adminAdd', password: PASSWORD, force: true,
      date: day(7), time: '10:00', minutes: 60, name: '日時変更再送の試験客', tel: phone });
    assert.equal(booking.ok, true);
    const request = { type: 'change', code: booking.code, tel: phone, date: day(8), time: '14:00' };
    assert.equal((await post(request)).ok, true, '最初の変更は通る');
    const repeated = await post(request);
    assert.equal(repeated.ok, true, '結果を見失った同じ要求は成立済みと返す');
    assert.equal(repeated.unchanged, true, '再送だと分かる');
    assert.equal((await post({ ...request, tel: '09099999999' })).ok, false,
      '電話番号が違えば同じ日時でも状態を知らせない');
    assert.equal((await post({ type: 'lookup', code: booking.code, tel: phone })).reservation.time,
      '14:00', '再送後も日時を維持する');
    assert.equal((await post({ type: 'cancel', password: PASSWORD, code: booking.code })).ok, true);
    assert.equal((await post(request)).ok, false, '取消済みは同じ日時でも成功にしない');
  });
});

test('模擬受け口は古い日時変更の遅延再送を断り、旧画面も受け付ける', async () => {
  await withMock(async post => {
    const tel = '09012345677';
    const originalDate = day(7);
    const firstDate = day(8);
    const latestDate = day(9);
    const booking = await post({ type: 'adminAdd', password: PASSWORD, force: true,
      date: originalDate, time: '10:00', minutes: 60, name: '遅延再送の試験客', tel });
    assert.equal(booking.ok, true);
    const first = { type: 'change', code: booking.code, tel,
      fromDate: originalDate, fromTime: '10:00', date: firstDate, time: '14:00' };
    const second = { ...first, fromDate: firstDate, fromTime: '14:00', date: latestDate, time: '15:00' };
    assert.equal((await post(first)).ok, true);
    assert.equal((await post(first)).unchanged, true, '同じ要求の再送は成立済みと返す');
    assert.equal((await post(second)).ok, true);
    const late = await post(first);
    assert.equal(late.ok, false);
    assert.equal(late.stale, true, '古い画面と区別できる');
    assert.equal((await post({ type: 'lookup', code: booking.code, tel })).reservation.date,
      latestDate, '最新の日時を維持する');
    assert.equal((await post({ ...second, fromTime: '', date: day(10) })).ok, false,
      '変更前の日時を片方だけ送った要求は断る');
    assert.equal((await post({ type: 'change', code: booking.code, tel,
      date: day(10), time: '16:00' })).ok, true, '旧画面の要求は従来どおり受け付ける');
  });
});

test('模擬受け口も新規予約の終了時刻と受付範囲を検証する', async () => {
  await withMock(async post => {
    const reservation = { type: 'reserve', code: 'LM-MOCK1', date: day(7), time: '14:00',
      endTime: '14:15', totalMinutes: 90, totalPrice: 4000,
      menus: [{ name: 'メンズカット' }], customer: { name: '新規予約の試験客', tel: '09012345670' } };
    assert.equal((await post(reservation)).ok, true);
    const saved = (await post({ type: 'lookup', code: reservation.code, tel: reservation.customer.tel })).reservation;
    assert.equal(saved.endTime, '15:30', '送信された短い終了時刻ではなく90分で保存する');

    const overlap = await post({ ...reservation, code: 'LM-MOCK2', time: '15:00',
      endTime: '16:00', totalMinutes: 60, customer: { name: '次のお客様', tel: '09012345671' } });
    assert.equal(overlap.ok, false, '1件目の本当の終了時刻まで席を塞ぐ');
    assert.equal((await post({ ...reservation, code: 'LM-MOCK3', totalMinutes: -60 })).ok, false,
      '不正な所要時間は既定の30分に置き換えず断る');
    assert.equal((await post({ ...reservation, code: 'LM-MOCK4', date: day(61) })).ok, false,
      '60日より先の新規予約を断る');
    assert.equal((await post({ ...reservation, code: 'LM-MOCK5', date: '2026-02-31' })).ok, false,
      '存在しない日付の新規予約を断る');
  });
});

test('模擬受け口は小数の所要時間で予約日時を書き換えない', async () => {
  await withMock(async post => {
    const date = day(7);
    const tel = '09012345675';
    const invalid = await post({ type: 'reserve', code: 'LM-FRAC1', date, time: '14:00',
      totalMinutes: 60.5, totalPrice: 4000, menus: [{ name: 'カット' }],
      customer: { name: '小数時間の試験客', tel } });
    assert.equal(invalid.ok, false, '小数の所要時間で新規予約を作らない');
    assert.equal((await post({ type: 'lookup', code: 'LM-FRAC1', tel })).ok, false);

    assert.equal((await post({ type: 'seed', code: 'LM-FRAC2', date, time: '10:00',
      endTime: '11:00', totalMinutes: 60.5, name: '古い台帳の試験客', tel })).ok, true);
    const changed = await post({ type: 'change', code: 'LM-FRAC2', tel,
      date: day(8), time: '14:00' });
    assert.equal(changed.ok, false, '古い台帳の小数時間を日時変更で引き継がない');
    const saved = (await post({ type: 'lookup', code: 'LM-FRAC2', tel })).reservation;
    assert.equal(saved.date, date);
    assert.equal(saved.time, '10:00');
    assert.equal(saved.endTime, '11:00');
  });
});
