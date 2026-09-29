import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let handler;
const server = http.createServer((request, response) => handler(request, response));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
handler = createMockHandler({ port: server.address().port });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
const localRecord = {
  code: 'LM-CHECK', status: 'reserved', date: '2099-10-08', time: '10:00', endTime: '11:00',
  staffId: 'st01', staffName: '担当者', nominationFee: 0,
  menus: [{ id: 'm1', name: '確認用カット', price: 4000, minutes: 60 }],
  totalMinutes: 60, totalPrice: 4000, totalLabel: '¥4,000〜',
  customer: { name: '確認用', tel: '00000000000', request: '' }
};
const latest = {
  code: localRecord.code, status: '予約確定', date: '2099-10-09', time: '12:00', endTime: '13:00',
  staffName: '担当者', menuText: '確認用カット', totalMinutes: 60, totalPrice: 4000, name: '確認用'
};
async function openLookup(records = []) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
  await context.addInitScript(records => localStorage.setItem('salon.reservations.v1', JSON.stringify(records)), records);
  const page = await context.newPage();
  await page.goto(base + '/mypage.html');
  await page.locator('#lookup-code').fill(localRecord.code);
  await page.locator('#lookup-tel').fill(localRecord.customer.tel);
  return page;
}
async function interceptLookup(page, respond) {
  await page.route('**/exec', async route => {
    if (route.request().postDataJSON()?.type !== 'lookup') return route.continue();
    await respond(route);
  });
}
const answer = (route, reservation) => route.fulfill({ json: { ok: true, reservation } });

test('照会した取消結果を既存の控えに反映し、予約確定を残さない', async () => {
  const page = await openLookup([localRecord]);
  try {
    await interceptLookup(page, route => answer(route, { ...latest, status: 'キャンセル' }));
    await page.locator('#lookup-btn').click();
    await page.locator('#lookup-result .booking-card.is-cancelled').waitFor();
    assert.equal(await page.locator('#upcoming-list .booking-card').count(), 0);
    assert.equal(await page.locator('#past-list .booking-card.is-cancelled').count(), 1);
    assert.equal(await page.locator('[data-cancel], [data-lookup-cancel], [data-change]').count(), 0);
    const stored = await page.evaluate(() => Store.all());
    assert.equal(stored[0].status, 'cancelled');
    assert.equal(stored[0].date, latest.date);
    assert.equal(stored[0].totalLabel, localRecord.totalLabel);
    assert.equal(stored[0].lookupTel, undefined);
  } finally { await page.context().close(); }
});

test('日時変更を控えに反映し、別のお客様の控えや保存していない予約は増やさない', async () => {
  for (const records of [[localRecord], [{ ...localRecord, customer: { ...localRecord.customer, tel: '00000000001' } }], []]) {
    const page = await openLookup(records);
    try {
      await interceptLookup(page, route => answer(route, latest));
      await page.locator('#lookup-btn').click();
      await page.locator('#lookup-result .booking-card').waitFor();
      const stored = await page.evaluate(() => Store.all());
      assert.equal(stored.length, records.length);
      if (records.length) {
        const matches = records[0].customer.tel === localRecord.customer.tel;
        assert.equal(stored[0].date, matches ? latest.date : localRecord.date);
        assert.equal(stored[0].time, matches ? latest.time : localRecord.time);
      }
    } finally { await page.context().close(); }
  }
});

test('照会中の連打は一件だけ送り、失敗時に前の予約を復活させない', async () => {
  const page = await openLookup();
  let release;
  try {
    let requests = 0;
    const hold = new Promise(resolve => { release = resolve; });
    await interceptLookup(page, async route => {
      requests++;
      if (requests === 1) return answer(route, latest);
      await hold;
      await route.fulfill({ json: { ok: false, error: '試験用の照会失敗' } });
    });
    await page.locator('#lookup-btn').click();
    await page.locator('#lookup-result .booking-card').waitFor();
    await page.locator('#lookup-btn').click();
    await page.locator('#lookup-btn:disabled').waitFor();
    await page.locator('#lookup-code').press('Enter');
    await page.locator('#lookup-tel').press('Enter');
    await page.evaluate(() => refreshView(true));
    assert.equal(await page.locator('#lookup-result .booking-card').count(), 0);
    release();
    await page.locator('#lookup-error').waitFor({ state: 'visible' });
    assert.equal(requests, 2);
    assert.equal(await page.locator('#lookup-btn').isDisabled(), false);
    assert.equal(await page.locator('#lookup-result .booking-card').count(), 0);
  } finally { release?.(); await page.context().close(); }
});

test('予約を含まない成功応答でも画面を壊さず、再照会できる', async () => {
  const page = await openLookup([localRecord]);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await interceptLookup(page, route => route.fulfill({ json: { ok: true, message: '受信先として動作しています' } }));
    await page.locator('#lookup-btn').click();
    await page.locator('#lookup-error').waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await page.locator('#lookup-btn').isDisabled(), false);
    assert.equal(await page.locator('#lookup-result .booking-card').count(), 0);
    assert.equal(await page.locator('#upcoming-list .booking-card').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

test('端末の控えから取消した場合も、同じ予約の照会結果を取消済みに揃える', async () => {
  const page = await openLookup([localRecord]);
  try {
    await interceptLookup(page, route => answer(route, latest));
    await page.route('**/exec', async route => {
      if (route.request().postDataJSON()?.type !== 'cancel') return route.fallback();
      await route.fulfill({ json: { ok: true } });
    });
    await page.locator('#lookup-btn').click();
    await page.locator('#lookup-result .booking-card').waitFor();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-cancel]').click();
    await page.locator('#flash').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#past-list .booking-card.is-cancelled').count(), 1);
    assert.equal(await page.locator('#lookup-result .booking-card.is-cancelled').count(), 1);
    assert.equal(await page.locator('[data-cancel], [data-lookup-cancel], [data-change]').count(), 0);
  } finally { await page.context().close(); }
});

test('取消成功の後に届いた古い照会結果で、予約確定へ戻さない', async () => {
  const page = await openLookup([localRecord]);
  let release;
  try {
    const hold = new Promise(resolve => { release = resolve; });
    await interceptLookup(page, async route => { await hold; await answer(route, latest); });
    await page.route('**/exec', async route => {
      if (route.request().postDataJSON()?.type !== 'cancel') return route.fallback();
      await route.fulfill({ json: { ok: true } });
    });
    await page.locator('#lookup-btn').click();
    await page.locator('#lookup-btn:disabled').waitFor();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-cancel]').click();
    await page.locator('#flash').waitFor({ state: 'visible' });
    release();
    await page.locator('#lookup-btn:not([disabled])').waitFor();
    assert.equal(await page.locator('#past-list .booking-card.is-cancelled').count(), 1);
    assert.equal(await page.locator('#lookup-result .booking-card').count(), 0);
    assert.equal((await page.evaluate(() => Store.all()))[0].status, 'cancelled');
  } finally { release?.(); await page.context().close(); }
});

test('照会結果から取消しても電話番号の違う端末の控えは変更しない', async () => {
  const page = await openLookup([{ ...localRecord, customer: { ...localRecord.customer, tel: '00000000001' } }]);
  try {
    await interceptLookup(page, route => answer(route, latest));
    await page.route('**/exec', async route => {
      if (route.request().postDataJSON()?.type !== 'cancel') return route.fallback();
      await route.fulfill({ json: { ok: true } });
    });
    await page.locator('#lookup-btn').click();
    await page.locator('#lookup-result .booking-card').waitFor();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-lookup-cancel]').click();
    await page.locator('#flash').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#lookup-result .booking-card.is-cancelled').count(), 1);
    assert.equal((await page.evaluate(() => Store.all()))[0].status, 'reserved');
  } finally { await page.context().close(); }
});

test('取消の返事待ちに別の予約を照会しても、取り違えて取消済みにしない', async () => {
  const page = await openLookup([localRecord]);
  let release;
  try {
    const hold = new Promise(resolve => { release = resolve; });
    await interceptLookup(page, route => answer(route, { ...latest, code: route.request().postDataJSON().code }));
    await page.route('**/exec', async route => {
      if (route.request().postDataJSON()?.type !== 'cancel') return route.fallback();
      await hold;
      await route.fulfill({ json: { ok: true } });
    });
    await page.locator('#lookup-btn').click();
    await page.locator('#lookup-result .booking-card').waitFor();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-lookup-cancel]').click();
    await page.locator('[data-lookup-cancel]:disabled').waitFor();
    await page.locator('#lookup-code').fill('LM-OTHER');
    await page.locator('#lookup-btn').click();
    await page.locator('#lookup-result .booking-code').filter({ hasText: 'LMOTHER' }).waitFor();
    release();
    await page.locator('#flash').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#lookup-result .booking-card.is-cancelled').count(), 0);
    assert.match(await page.locator('#lookup-result .booking-code').innerText(), /LMOTHER/);
    assert.equal((await page.evaluate(() => Store.all()))[0].status, 'cancelled');
  } finally { release?.(); await page.context().close(); }
});
