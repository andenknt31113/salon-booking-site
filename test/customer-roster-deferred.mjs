import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const render = source.match(/function renderCustomers\(\) {[\s\S]*?\n}\n/)[0];

function fixture({ hidden = false, blocked = false } = {}) {
  const pane = { hidden };
  const rows = { innerHTML: '保持する履歴とメモ' };
  const nodes = { '.admin-pane[data-pane="customers"]': pane, '#customer-rows': rows,
    '#customer-rows .customer-record[open]': null, '#customer-search': { value: '' },
    '#customer-sort': { value: 'recent' }, '#clear-customer-search': { disabled: false },
    '#customer-count': { textContent: '' } };
  const calls = [];
  const context = vm.createContext({ customersNeedRender: false, renderedCustomerFilters: {},
    adminData: { reservations: [] },
    $: selector => { assert.ok(selector in nodes, selector); return nodes[selector]; },
    guardNoteFilters: () => { calls.push('guard'); return !blocked; },
    buildCustomers: () => { calls.push('build'); return []; },
    searchKey: value => value, telKey: value => value });
  vm.runInContext(render, context);
  return { context, rows, pane, calls };
}

test('非表示の名簿は集計もフィルター操作もせず、次に開く際の更新だけを記録する', () => {
  const app = fixture({ hidden: true });
  app.context.renderCustomers();
  assert.deepEqual(app.calls, []);
  assert.equal(app.rows.innerHTML, '保持する履歴とメモ');
  assert.equal(app.context.customersNeedRender, true);
});

test('名簿を開いても未保存のメモがあれば再描画を拒否し、更新が必要な状態を保持する', () => {
  const app = fixture({ blocked: true });
  app.context.renderCustomers();
  assert.deepEqual(app.calls, ['guard']);
  assert.equal(app.rows.innerHTML, '保持する履歴とメモ');
  assert.equal(app.context.customersNeedRender, true);
});

test('空の名簿も開いた時に一回集計し、正常表示の後だけ更新待ちを解除する', () => {
  const app = fixture({ hidden: true });
  app.context.renderCustomers();
  app.pane.hidden = false;
  app.context.renderCustomers();
  assert.deepEqual(app.calls, ['guard', 'build']);
  assert.match(app.rows.innerHTML, /ご予約が入ると/);
  assert.equal(app.context.customersNeedRender, false);
});
