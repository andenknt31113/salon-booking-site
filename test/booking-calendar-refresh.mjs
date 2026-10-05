import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/reserve.js', import.meta.url), 'utf8');
const start = source.indexOf('const refreshCalendar = async () => {');
const end = source.indexOf("document.addEventListener('visibilitychange'", start);
assert.ok(start >= 0 && end > start);
const script = new vm.Script(source.slice(start, end) + '\nrefreshCalendar;');
const SELECTED = { step: 3, date: '2030-01-06', time: '10:00', staffId: 'st01' };

function fixture() {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const alerts = [];
  const blocked = new Set();
  const context = vm.createContext({
    state: { ...SELECTED, customer: { name: '架空のお客様', request: '書きかけの要望' } },
    document: { hidden: false }, SALON: { reservationEndpoint: 'https://booking.example.test/exec' },
    Catalog: { loaded: true, source: 'sheet' },
    Remote: { load(force) { assert.equal(force, true); calls.push('load'); return pending; } },
    Availability: { slotInfo(date, time, staffId, minutes) {
      calls.push(['slotInfo', date, time, staffId, minutes]);
      return { available: !blocked.has(`${date} ${time}`), reason: 'taken' };
    } },
    totalMinutes: () => 60,
    showCalendarLoading: value => calls.push(['loading', value]),
    renderCalendar: () => calls.push('calendar'),
    updateSummary: () => calls.push('summary'),
    renderStepCta: () => calls.push('cta'),
    formatDateJa: value => value,
    slotStopMessage: value => value,
    alert: value => alerts.push(value)
  });
  return { context, calls, alerts, blocked, release, refresh: script.runInContext(context) };
}

for (const step of [1, 4, 5, 6]) {
  test(`空席確認中にSTEP${step}へ移ったら、遅い応答で日時・入力・表示を変えない`, async () => {
    const app = fixture();
    app.blocked.add(`${SELECTED.date} ${SELECTED.time}`);
    const pending = app.refresh();
    app.context.state.step = step;
    const current = structuredClone(app.context.state);
    app.release(true);
    await pending;
    assert.deepEqual(app.context.state, current);
    assert.deepEqual(app.alerts, []);
    assert.deepEqual(app.calls, [['loading', true], 'load', ['loading', false]]);
  });
}

test('空席確認中に画面を隠したら、戻る前に日時を消したり警告を開いたりしない', async () => {
  const app = fixture();
  app.blocked.add(`${SELECTED.date} ${SELECTED.time}`);
  const pending = app.refresh();
  app.context.document.hidden = true;
  const current = structuredClone(app.context.state);
  app.release(true);
  await pending;
  assert.deepEqual(app.context.state, current);
  assert.deepEqual(app.alerts, []);
  assert.deepEqual(app.calls, [['loading', true], 'load', ['loading', false]]);
});

test('待機中に別の空き日時と担当を選んだら、以前の枠の満席を理由に新しい選択を消さない', async () => {
  const app = fixture();
  app.blocked.add(`${SELECTED.date} ${SELECTED.time}`);
  const pending = app.refresh();
  Object.assign(app.context.state, { date: '2030-01-07', time: '14:00', staffId: 'st02' });
  const current = structuredClone(app.context.state);
  app.release(true);
  await pending;
  assert.deepEqual(app.context.state, current);
  assert.deepEqual(app.alerts, []);
  assert.ok(app.calls.some(call => Array.isArray(call) && call[0] === 'slotInfo'
    && call.slice(1).join() === ['2030-01-07', '14:00', 'st02', 60].join()));
});

test('待機中に選び直した枠が埋まったなら、古い枠ではなく現在の選択だけを警告する', async () => {
  const app = fixture();
  const pending = app.refresh();
  Object.assign(app.context.state, { date: '2030-01-07', time: '14:00' });
  app.blocked.add('2030-01-07 14:00');
  app.release(true);
  await pending;
  assert.equal(app.context.state.time, null);
  assert.equal(app.context.state.date, '2030-01-07');
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /2030-01-07 14:00/);
  assert.deepEqual(app.context.state.customer, { name: '架空のお客様', request: '書きかけの要望' });
});

test('二つの画面復帰が同じ通信を待っても、満席の警告を二重に開かない', async () => {
  const app = fixture();
  app.blocked.add(`${SELECTED.date} ${SELECTED.time}`);
  const first = app.refresh();
  const second = app.refresh();
  app.release(true);
  await Promise.all([first, second]);
  assert.equal(app.context.state.time, null);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /2030-01-06 10:00/);
  assert.equal(app.calls.filter(call => call === 'summary').length, 1);
});

test('選択を解除した後は遅い満席結果で過去の日時を警告しない', async () => {
  const app = fixture();
  app.blocked.add(`${SELECTED.date} ${SELECTED.time}`);
  const pending = app.refresh();
  app.context.state.time = null;
  app.release(true);
  await pending;
  assert.equal(app.context.state.time, null);
  assert.deepEqual(app.alerts, []);
  assert.equal(app.calls.filter(call => call === 'calendar').length, 1);
});

for (const busy of [false, true]) {
  test(`現在の枠を${busy ? '満席' : '空席'}と確認した結果は従来の選択・警告を保持する`, async () => {
    const app = fixture();
    if (busy) app.blocked.add(`${SELECTED.date} ${SELECTED.time}`);
    const pending = app.refresh();
    app.release(true);
    await pending;
    assert.equal(app.context.state.time, busy ? null : SELECTED.time);
    assert.equal(app.alerts.length, busy ? 1 : 0);
    assert.equal(app.calls.filter(call => call === 'calendar').length, 1);
  });
}

for (const change of [app => { app.context.state.step = 4; },
  app => { app.context.document.hidden = true; },
  app => { app.context.Catalog.loaded = false; },
  app => { app.context.Catalog.source = 'local'; }]) {
  test('日時選択中・表示中・料金確認済みの場合以外は追加通信を始めない', async () => {
    const app = fixture();
    change(app);
    await app.refresh();
    assert.deepEqual(app.calls, []);
    assert.deepEqual(app.alerts, []);
  });
}
