import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const common = readFileSync(new URL('../assets/js/common.js', import.meta.url), 'utf8');
const PAGE_SIZE = 50;
const normalization = common.match(/^const KANA_HALF[^]*?^}\)\(\);/m)[0];
const functions = ['telKey', 'searchKey', 'buildCustomers', 'customerSchedule', 'guardNoteFilters',
  'closeCustomerProfile', 'renderCustomers', 'changeCustomerPage'].map(name => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match || name === 'changeCustomerPage', name);
  return match?.[0] || '';
}).join('\n');
const helpers = ['toHalfWidth', 'toKatakana', 'toKey', 'fromKey', 'formatDateJa', 'esc']
  .map(name => common.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0]).join('\n');

function reservations(count) {
  return Array.from({ length: count }, (_unused, index) => {
    const number = String(index).padStart(4, '0');
    const row = { code: `LM-PAGE-${number}`, date: '2025-01-01', time: '10:00', endTime: '11:00',
      name: `架空のお客様${number}`, tel: `0000000${number}`, email: '', menu: '架空カット',
      price: 4000, status: '予約確定', note: `保存済みメモ${number}`, request: '' };
    return [row, { ...row, code: row.code + '-NEXT', date: '2099-01-01', note: '' }];
  }).flat();
}

function fixture(count = 125) {
  const rows = { innerHTML: '', querySelector(selector) {
    assert.equal(selector, '[data-customer-history]');
    return this.innerHTML.includes('data-customer-history') ? summary : null;
  } };
  const focus = [];
  const summary = { focus(options) { focus.push(['focus', options]); },
    scrollIntoView(options) { focus.push(['scroll', options]); } };
  const nodes = { '.admin-pane[data-pane="customers"]': { hidden: false }, '#customer-rows': rows,
    '#customer-rows .customer-record[open]': null, '#customer-search': { value: '' },
    '#customer-sort': { value: 'recent' }, '#clear-customer-search': { disabled: true },
    '#customer-count': { textContent: '' }, '#customer-pages': { hidden: true },
    '#customer-page-label': { textContent: '' }, '#customer-previous': { disabled: true },
    '#customer-next': { disabled: true } };
  const alerts = [];
  const schedules = [];
  const context = vm.createContext({ customerPage: 0, CUSTOMER_PAGE_SIZE: PAGE_SIZE,
    customersNeedRender: true, renderedCustomerFilters: {}, activeChange: null, unsaved: false,
    adminData: { reservations: reservations(count) },
    $: selector => {
      assert.ok(selector in nodes, selector);
      if (selector.endsWith('.customer-record[open]')) return nodes[selector]?.open ? nodes[selector] : null;
      return nodes[selector];
    },
    isCancelled: row => row.status === 'キャンセル',
    hasUnsavedReservationNotes: () => context.unsaved,
    pad2: value => String(value).padStart(2, '0'),
    customerProfileHtml: customer => `保持する詳細:${customer.tel}:${customer.visits.length}`,
    alert: message => alerts.push(message), WEEKDAY_JA: ['日', '月', '火', '水', '木', '金', '土'] });
  vm.runInContext(normalization + '\n' + helpers + '\n' + functions, context);
  const originalSchedule = context.customerSchedule;
  context.customerSchedule = (...argumentsList) => {
    const result = originalSchedule(...argumentsList);
    schedules.push({ visits: argumentsList[0].length, full: Array.isArray(result.past), result });
    return result;
  };
  function advance(direction) {
    assert.equal(typeof context.changeCustomerPage, 'function', '名簿のページ操作がある');
    context.changeCustomerPage(direction);
  }
  function visible() {
    return Array.from(rows.innerHTML.matchAll(/data-customer-tel="([^"]+)"/g), match => match[1]);
  }
  function expand(tel) {
    const profile = { replaceChildren() { this.cleared = true; } };
    nodes['#customer-rows .customer-record[open]'] = { open: true, dataset: { customerTel: tel },
      querySelector: selector => { assert.equal(selector, '.customer-profile'); return profile; } };
    return profile;
  }
  return { context, nodes, rows, alerts, focus, schedules, advance, visible, expand };
}

test('125人を50・50・25人で漏れなく表示し、全予約と集計を残す', () => {
  const app = fixture();
  const original = structuredClone(app.context.adminData.reservations);
  app.context.renderCustomers();
  assert.equal(app.visible().length, PAGE_SIZE);
  assert.match(app.nodes['#customer-count'].textContent, /1〜50件.*検索結果 125件.*名簿 125件/);
  assert.equal(app.nodes['#customer-previous'].disabled, true);
  const seen = [...app.visible()];
  app.advance(1);
  assert.equal(app.visible().length, PAGE_SIZE);
  assert.match(app.nodes['#customer-count'].textContent, /51〜100件/);
  seen.push(...app.visible());
  app.advance(1);
  assert.equal(app.visible().length, 25);
  assert.match(app.nodes['#customer-count'].textContent, /101〜125件/);
  assert.equal(app.nodes['#customer-next'].disabled, true);
  seen.push(...app.visible());
  assert.equal(new Set(seen).size, 125);
  assert.equal(app.nodes['#customer-page-label'].textContent, '3 / 3ページ');
  app.advance(1);
  assert.equal(app.context.customerPage, 2);
  app.advance(-1);
  assert.equal(app.context.customerPage, 1);
  assert.equal(app.visible().length, PAGE_SIZE);
  assert.deepEqual(app.context.adminData.reservations, original);
  assert.equal(app.context.buildCustomers().length, 125);
  assert.ok(app.context.buildCustomers().every(customer => customer.visits.length === 2 && customer.spent === 8000));
  assert.ok(app.focus.length > 0);
});

test('5,000人でも一覧は50人だけ描画し、台帳・検索範囲を切り捨てない', () => {
  const app = fixture(5000);
  app.context.renderCustomers();
  assert.equal(app.visible().length, PAGE_SIZE);
  assert.match(app.nodes['#customer-count'].textContent, /検索結果 5000件.*名簿 5000件/);
  assert.equal(app.context.adminData.reservations.length, 10000);
  app.nodes['#customer-search'].value = '架空のお客様4999';
  app.context.renderCustomers();
  assert.deepEqual(app.visible(), ['00000004999']);
  assert.equal(app.context.buildCustomers().find(customer => customer.tel === '00000004999').visits.length, 2);
});

test('後のページにある電話番号・旧名も全件から検索し、先頭ページへ戻る', () => {
  const app = fixture();
  app.context.adminData.reservations[218].name = '過去のお名前';
  app.context.renderCustomers();
  app.advance(1);
  app.nodes['#customer-search'].value = '過去 のお名前';
  app.context.renderCustomers();
  assert.equal(app.context.customerPage, 0);
  assert.deepEqual(app.visible(), ['00000000109']);
  assert.equal(app.nodes['#customer-pages'].hidden, true);
  app.nodes['#customer-search'].value = '００００００００１２４';
  app.context.renderCustomers();
  assert.deepEqual(app.visible(), ['00000000124']);
  app.nodes['#customer-search'].value = '';
  app.context.renderCustomers();
  assert.equal(app.visible().length, PAGE_SIZE);
  assert.equal(app.nodes['#customer-pages'].hidden, false);
});

test('並び順の変更では先頭へ戻り、同じ条件の再描画ではページを保持する', () => {
  const app = fixture();
  app.context.renderCustomers();
  app.advance(1);
  const page = app.visible();
  app.context.renderCustomers();
  assert.equal(app.context.customerPage, 1);
  assert.deepEqual(app.visible(), page);
  app.nodes['#customer-sort'].value = 'name';
  app.context.renderCustomers();
  assert.equal(app.context.customerPage, 0);
  assert.equal(app.visible().length, PAGE_SIZE);
});

for (const state of ['unsaved', 'change']) {
  test(`${state}の入力中はページ・検索・表示・開いた詳細を変更しない`, () => {
    const app = fixture();
    app.context.renderCustomers();
    app.advance(1);
    const selected = app.visible()[0];
    const profile = app.expand(selected);
    const before = app.rows.innerHTML;
    if (state === 'unsaved') app.context.unsaved = true;
    else app.context.activeChange = { code: 'LM-EDIT' };
    app.advance(1);
    assert.equal(app.context.customerPage, 1);
    assert.equal(app.rows.innerHTML, before);
    assert.equal(profile.cleared, undefined);
    assert.equal(app.focus.length, 2);
    app.nodes['#customer-search'].value = '別の検索';
    app.nodes['#customer-sort'].value = 'name';
    app.context.renderCustomers();
    assert.equal(app.nodes['#customer-search'].value, '');
    assert.equal(app.nodes['#customer-sort'].value, 'recent');
    assert.equal(app.context.customerPage, 1);
    assert.equal(app.rows.innerHTML, before);
    assert.equal(app.alerts.length, 2);
    app.context.unsaved = false;
    app.context.activeChange = null;
    app.advance(1);
    assert.equal(app.context.customerPage, 2);
    assert.equal(profile.cleared, true);
  });
}

test('予定の更新で並びが変わっても、開いた人の詳細とページを維持する', () => {
  const app = fixture(100);
  app.context.renderCustomers();
  const selected = app.visible().at(-1);
  app.expand(selected);
  const added = { ...app.context.adminData.reservations[0], code: 'LM-NEW', tel: '00000009999',
    date: '2026-01-01' };
  app.context.adminData.reservations.push(added);
  app.context.renderCustomers();
  assert.equal(app.context.customerPage, 1);
  assert.ok(app.visible().includes(selected));
  assert.ok(app.rows.innerHTML.includes(`保持する詳細:${selected}:2`));
});

for (const count of [0, 1, 50, 51, 100]) {
  test(`${count}人の境界でページ数と移動可否を正しく表示する`, () => {
    const app = fixture(count);
    app.context.renderCustomers();
    assert.equal(app.visible().length, Math.min(count, PAGE_SIZE));
    assert.equal(app.nodes['#customer-pages'].hidden, count <= PAGE_SIZE);
    assert.equal(app.nodes['#customer-previous'].disabled, true);
    assert.equal(app.nodes['#customer-next'].disabled, count <= PAGE_SIZE);
    const original = app.rows.innerHTML;
    app.advance(-1);
    app.advance(0);
    app.advance('1');
    assert.equal(app.rows.innerHTML, original);
    if (count <= PAGE_SIZE) assert.match(app.nodes['#customer-count'].textContent, new RegExp(`${count}件を表示 / 名簿 ${count}件`));
  });
}

test('取得結果が減って最終ページがなくなっても、残った名簿を正しく表示する', () => {
  const app = fixture();
  app.context.renderCustomers();
  app.advance(1);
  app.advance(1);
  app.context.adminData.reservations = app.context.adminData.reservations.slice(0, 120);
  app.context.renderCustomers();
  assert.equal(app.context.customerPage, 1);
  assert.equal(app.visible().length, 10);
  assert.match(app.nodes['#customer-count'].textContent, /51〜60件.*検索結果 60件.*名簿 60件/);
});

for (const sort of ['recent', 'visits', 'name']) {
  test(`5000人の${sort}順でも詳細履歴の作成は表示する50人だけに限定する`, () => {
    const app = fixture(5000);
    const original = structuredClone(app.context.adminData.reservations);
    app.nodes['#customer-sort'].value = sort;
    app.context.renderCustomers();
    assert.equal(app.visible().length, PAGE_SIZE);
    assert.equal(app.schedules.filter(call => call.full).length, PAGE_SIZE);
    assert.equal(app.schedules.filter(call => !call.full).length, sort === 'name' ? 0 : 5000);
    assert.ok(app.schedules.filter(call => !call.full).every(call =>
      Object.keys(call.result).sort().join(',') === 'pastCount,previousDate'));
    app.schedules.length = 0;
    app.advance(1);
    assert.equal(app.schedules.filter(call => call.full).length, PAGE_SIZE);
    assert.deepEqual(app.context.adminData.reservations, original);
  });
}

test('全名簿から1人を検索したら、その人だけ集計し、該当なしでは履歴を作らない', () => {
  const app = fixture(5000);
  const original = structuredClone(app.context.adminData.reservations);
  app.nodes['#customer-search'].value = '架空のお客様4999';
  app.context.renderCustomers();
  assert.deepEqual(app.visible(), ['00000004999']);
  assert.equal(app.schedules.filter(call => call.full).length, 1);
  assert.equal(app.schedules.filter(call => !call.full).length, 1);
  assert.match(app.rows.innerHTML, /過去の予約 1件.*今後・施術中 1件/);
  app.schedules.length = 0;
  app.nodes['#customer-search'].value = '名簿にないお名前';
  app.context.renderCustomers();
  assert.equal(app.visible().length, 0);
  assert.equal(app.schedules.length, 0);
  assert.deepEqual(app.context.adminData.reservations, original);
});

test('軽量な並び順の集計は終了時刻・取消・同時刻・不明な日時を含む従来の詳細と一致する', () => {
  const app = fixture(0);
  const now = new Date(2030, 0, 5, 12, 0);
  const visits = [
    { code: 'past-old', date: '2029-01-01', time: '10:00', endTime: '11:00', status: '' },
    { code: 'in-progress', date: '2030-01-05', time: '11:00', endTime: '13:00', status: '' },
    { code: 'past-now', date: '2030-01-05', time: '10:00', endTime: '12:00', status: '' },
    { code: 'same-time', date: '2030-01-05', time: '10:00', endTime: '11:00', status: '' },
    { code: 'cancelled-latest', date: '2030-01-05', time: '11:00', endTime: '12:00', status: 'キャンセル' },
    { code: 'missing-end', date: '2030-01-05', time: '09:00', status: '' },
    { code: 'unknown-date', date: '日付不明', time: '', endTime: '', status: '' }
  ];
  for (const records of [[], visits, visits.slice().reverse(), visits.filter(row => row.status === 'キャンセル')]) {
    const original = structuredClone(records);
    const full = app.context.customerSchedule(records, now);
    const summary = app.context.customerSchedule(records, now, true);
    assert.equal(summary.pastCount, full.past.length);
    assert.equal(summary.previousDate, full.previous?.date || '');
    assert.deepEqual(records, original);
    assert.deepEqual(Object.keys(summary).sort(), ['pastCount', 'previousDate']);
  }
});

test('名簿の並びと表示は同じ時刻で集計し、分の境界で過去予約の判定を混在させない', () => {
  const app = fixture(0);
  const now = new Date(2030, 0, 5, 11, 59);
  const nextMinute = new Date(2030, 0, 5, 12, 0);
  let dateReads = 0;
  app.context.Date = class extends Date {
    constructor(...values) {
      super(...(values.length ? values : [dateReads++ ? nextMinute.getTime() : now.getTime()]));
    }
  };
  app.context.adminData.reservations = Array.from({ length: 2 }, (_unused, index) => ({
    code: `LM-TIME-${index}`, date: '2030-01-05', time: '11:00', endTime: '12:00',
    name: `架空のお客様${index}`, tel: `0000000000${index}`, email: '', menu: '架空カット',
    price: 4000, status: '', note: '', request: ''
  }));
  app.context.renderCustomers();
  assert.equal(dateReads, 1);
  assert.equal((app.rows.innerHTML.match(/過去の予約 0件 ／ 今後・施術中 1件/g) || []).length, 2);
  assert.equal((app.rows.innerHTML.match(/過去予約なし/g) || []).length, 2);
});

test('取消と今後の予約を過去件数に混ぜず、家族の旧名検索と全3種類の並びを保持する', () => {
  const app = fixture(0);
  const now = new Date(2030, 0, 5, 12, 0);
  app.context.Date = class extends Date {
    constructor(...values) { super(...(values.length ? values : [now.getTime()])); }
  };
  const booking = (code, tel, name, date, status = '') => ({ code, tel, name, date, status,
    time: '10:00', endTime: '11:00', email: '', menu: '架空カット', price: 4000, note: '', request: '' });
  const records = [
    booking('gamma-past', '00000000003', 'Gamma', '2030-01-04'),
    booking('alpha-past', '00000000001', 'Alpha', '2030-01-03'),
    booking('beta-cancel', '00000000002', 'Beta', '2030-01-04', 'キャンセル'),
    booking('gamma-old', '00000000003', 'Gamma', '2030-01-01'),
    booking('gamma-next', '00000000003', 'Gamma', '2030-01-06'),
    booking('gamma-cancel', '00000000003', 'Gamma', '2030-01-05', 'キャンセル'),
    booking('alpha-child', '00000000001', '家族の古いお名前', '2030-01-01'),
    booking('alpha-old', '00000000001', 'Alpha', '2029-01-01'),
    booking('alpha-next', '00000000001', 'Alpha', '2030-01-06')
  ];
  app.context.adminData.reservations = records;
  for (const [sort, expected] of [['recent', ['00000000003', '00000000001', '00000000002']],
    ['visits', ['00000000001', '00000000003', '00000000002']],
    ['name', ['00000000001', '00000000002', '00000000003']]]) {
    app.nodes['#customer-sort'].value = sort;
    app.context.renderCustomers();
    assert.deepEqual(app.visible(), expected);
    assert.match(app.rows.innerHTML, /過去の予約 3件 ／ 今後・施術中 1件/);
    assert.match(app.rows.innerHTML, /過去の予約 2件 ／ 今後・施術中 1件/);
    assert.match(app.rows.innerHTML, /過去の予約 0件 ／ 今後・施術中 0件/);
  }
  app.nodes['#customer-search'].value = '家族 の 古い お名前';
  app.context.renderCustomers();
  assert.deepEqual(app.visible(), ['00000000001']);
  assert.match(app.rows.innerHTML, /同じ番号：Alpha・家族の古いお名前/);
  const customer = app.context.buildCustomers().find(person => person.tel === '00000000003');
  assert.equal(customer.visits.length, 4);
  assert.equal(customer.spent, 12000);
  assert.equal(app.context.adminData.reservations, records);
});
