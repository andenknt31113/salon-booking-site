import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.RESERVE_SOURCE || new URL('../assets/js/reserve.js', import.meta.url), 'utf8');
const helperStart = SOURCE.indexOf('const soloStylist =');
const helperEnd = SOURCE.indexOf('\nfunction renderStaffLead()', helperStart);
const navigationStart = SOURCE.indexOf('function goTo(step)');
const navigationEnd = SOURCE.indexOf('\n/* ---------- 日時の変更', navigationStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart && navigationEnd > navigationStart);
const SOLO = { id: 'st01', name: '試験担当', nominationFee: 0 };

function fixture({ staff = [SOLO], step = 1, verified = true, paused = false, changing = null,
  hasMenu = true, chosen = true, date = null, time = null, valid = true } = {}) {
  const calls = [];
  const context = vm.createContext({
    SALON: { staff: structuredClone(staff), draft: paused }, changing,
    state: { step, staffChosen: chosen, staffId: chosen ? SOLO.id : null, date, time },
    catalogVerified: () => verified, hasMenu: () => hasMenu, validateForm: () => valid,
    alert: () => calls.push('alert'),
    renderCalendar: () => calls.push('calendar'), renderConfirm: () => calls.push('confirm'),
    saveDraft: () => calls.push('save'), renderStep: () => calls.push('render'),
    $: selector => ({ focus: () => calls.push(selector), setAttribute() {},
      scrollIntoView: () => calls.push('scroll') })
  });
  vm.runInContext(SOURCE.slice(helperStart, helperEnd) + '\n' + SOURCE.slice(navigationStart, navigationEnd), context);
  return { context, calls, go: target => context.goTo(target),
    skip: () => vm.runInContext('skipStaffStep()', context) };
}

test('担当が一人・追加料金なしの場合だけ担当の確認画面を省く', () => {
  assert.equal(fixture().skip(), true);
  for (const staff of [[], [SOLO, { ...SOLO, id: 'st02' }], [{ ...SOLO, nominationFee: 500 }],
    [{ ...SOLO, nominationFee: -1 }], [{ ...SOLO, nominationFee: '不明' }],
    [{ ...SOLO, id: '' }], [{ ...SOLO, name: '' }]]) {
    assert.equal(fixture({ staff }).skip(), false);
  }
  assert.equal(fixture({ changing: { code: 'LM-TEST' } }).skip(), false);
});

test('一人営業はメニューから日時へ進み、戻るとメニューと同じ担当を保つ', () => {
  const app = fixture();
  app.go(2);
  assert.equal(app.context.state.step, 3);
  assert.equal(app.context.state.staffId, SOLO.id);
  assert.equal(app.calls.filter(call => call === 'calendar').length, 1);
  app.go(2);
  assert.equal(app.context.state.step, 1);
  assert.equal(app.context.state.staffId, SOLO.id);
});

test('担当画面を省いても最新の料金未確認・受付停止・メニュー未選択は日時へ進ませない', () => {
  for (const options of [{ verified: false }, { paused: true }, { hasMenu: false }]) {
    const app = fixture(options);
    app.go(2);
    assert.equal(app.context.state.step, 1);
    assert.equal(app.calls.includes('calendar'), false);
    assert.equal(app.calls.includes('save'), false);
  }
});

test('複数担当・追加料金ありでは従来の担当選択を保ち、未選択で日時へ進めない', () => {
  for (const staff of [[SOLO, { ...SOLO, id: 'st02' }], [{ ...SOLO, nominationFee: 500 }]]) {
    const app = fixture({ staff, chosen: false });
    app.go(2);
    assert.equal(app.context.state.step, 2);
    app.go(3);
    assert.equal(app.context.state.step, 2);
    assert.equal(app.calls.includes('calendar'), false);
  }
});

test('担当の省略で日時・お客様情報・同意の検証を飛ばさない', () => {
  const noTime = fixture({ step: 3 });
  noTime.go(4);
  assert.equal(noTime.context.state.step, 3);
  const invalid = fixture({ step: 4, valid: false });
  invalid.go(5);
  assert.equal(invalid.context.state.step, 4);
  assert.equal(invalid.calls.includes('confirm'), false);
  const ready = fixture({ step: 4 });
  ready.go(5);
  assert.equal(ready.context.state.step, 5);
  assert.equal(ready.calls.includes('confirm'), true);
});

test('日時変更では担当やメニューに戻さず、日時から変更確認へ進む', () => {
  const app = fixture({ step: 3, changing: { code: 'LM-TEST' }, date: '2030-01-05', time: '10:00' });
  app.go(2);
  assert.equal(app.context.state.step, 3);
  app.go(4);
  assert.equal(app.context.state.step, 5);
  assert.equal(app.context.state.staffId, SOLO.id);
});
