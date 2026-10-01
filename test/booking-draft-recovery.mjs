import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.RESERVE_SOURCE || new URL('../assets/js/reserve.js', import.meta.url), 'utf8');
const begin = SOURCE.indexOf('const DRAFT_KEY =');
const end = SOURCE.indexOf('\n/* 下書きに残っていたID', begin);
assert.ok(begin >= 0 && end > begin);
const CUSTOMER = { name: '下書き試験', kana: 'シタガキシケン', tel: '00000000000',
  email: 'draft@example.test', visit: '初めて', request: '控えの内容', agree: true };
const DRAFT = { step: 4, couponId: 'cp01', menuIds: [], staffId: 'st01', staffChosen: true,
  date: '2030-01-05', time: '10:00', calOffset: 7, customer: CUSTOMER,
  couponName: '試験カット', menuNames: [], menuDetails: [{ name: '試験カット', price: 6900,
    minutes: 60, isCoupon: true, priceFrom: false }] };

function fixture(draftRaw, profileRaw = null, { unreadable = false } = {}) {
  const writes = [];
  const initialDraft = draftRaw;
  const context = vm.createContext({
    sessionStorage: {
      getItem() { if (unreadable) throw new Error('試験用の読込失敗'); return initialDraft; },
      setItem: (...args) => writes.push(args), removeItem: (...args) => writes.push(args)
    },
    localStorage: { getItem: () => profileRaw },
    toKey: date => date.toISOString().slice(0, 10),
    fromKey: key => new Date(key + 'T00:00:00Z')
  });
  vm.runInContext(SOURCE.slice(begin, end) + '\nconst PROFILE_FIELDS = ["name", "kana", "tel", "email"];', context);
  return { context, writes, load: () => context.loadDraft(), profile: () => context.loadProfile(),
    state: () => JSON.parse(vm.runInContext('JSON.stringify(state)', context)),
    prototypeIsDefault: () => vm.runInContext('Object.getPrototypeOf(state) === Object.prototype', context) };
}

for (const changes of [{ menuIds: null }, { menuIds: {} }, { menuIds: [null] }, { customer: null },
  { customer: [] }, { customer: { ...CUSTOMER, name: {} } }, { customer: { ...CUSTOMER, agree: 'false' } },
  { step: '4' }, { step: -1 }, { date: '2030-02-30' }, { time: '25:00' },
  { menuNames: [null] }, { couponName: {} }, { menuDetails: [null] }, { menuDetails: [{}] }]) {
  test(`壊れた下書きを描画へ渡さず、初期の入力状態を保つ：${JSON.stringify(changes)}`, () => {
    const app = fixture(JSON.stringify({ ...DRAFT, ...changes }));
    const before = app.state();
    assert.equal(app.load(), null);
    assert.deepEqual(app.state(), before);
    assert.deepEqual(app.writes, [], '読み取っただけで保存内容を消さない');
  });
}

test('正常な下書きは名前・金額・所要の照合情報と入力を保持して復元する', () => {
  const app = fixture(JSON.stringify(DRAFT));
  const loaded = JSON.parse(JSON.stringify(app.load()));
  const expected = structuredClone(DRAFT);
  delete expected.couponName;
  delete expected.menuNames;
  delete expected.menuDetails;
  expected.calOffset = 0;
  assert.deepEqual(app.state(), expected, '入力と選択だけを状態へ戻す');
  assert.deepEqual(loaded.menuDetails, DRAFT.menuDetails);
  assert.equal(loaded.couponName, DRAFT.couponName);
  assert.deepEqual(loaded.customer, CUSTOMER);
});

test('古い任意項目なしの下書きは既定値を使い、任意の状態を注入しない', () => {
  const saved = { step: 2, couponId: null, menuIds: ['m01'], customer: { name: '旧下書き' },
    unexpected: '取り込まない', __proto__: null };
  const raw = JSON.stringify(saved).replace('{', '{"__proto__":{"injected":true},');
  const app = fixture(raw);
  assert.notEqual(app.load(), null);
  assert.equal(app.prototypeIsDefault(), true);
  assert.equal(Object.hasOwn(app.state(), 'unexpected'), false);
  assert.equal(app.state().customer.name, '旧下書き');
  assert.equal(app.state().customer.agree, false);
  assert.equal(app.state().staffChosen, false);
});

test('完了済み・壊れたJSON・読込不能では入力復元をせず停止しない', () => {
  for (const raw of ['null', '[]', 'true', '{invalid', JSON.stringify({ ...DRAFT, step: 6 })]) {
    const app = fixture(raw);
    assert.equal(app.load(), null);
    assert.equal(app.state().step, 1);
  }
  assert.equal(fixture(null, null, { unreadable: true }).load(), null);
});

test('お客様の控えは文字列の連絡先だけ復元し、同意や別の状態を取り込まない', () => {
  const app = fixture(null, JSON.stringify({ ...CUSTOMER, injected: true }));
  assert.deepEqual(JSON.parse(JSON.stringify(app.profile())), {
    name: CUSTOMER.name, kana: CUSTOMER.kana, tel: CUSTOMER.tel, email: CUSTOMER.email
  });
});

test('壊れた連絡先の控えで入力欄を隠したり、object表記を表示したりしない', () => {
  for (const raw of ['null', '[]', '{invalid', JSON.stringify({ name: {}, tel: '00000000000' }),
    JSON.stringify({ name: '試験', tel: {} }), JSON.stringify({ name: '試験', tel: '00000000000', email: [] })]) {
    assert.equal(fixture(null, raw).profile(), null);
  }
});
