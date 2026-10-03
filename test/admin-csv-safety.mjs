import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(process.env.ADMIN_SOURCE || new URL('../assets/js/admin.js', import.meta.url), 'utf8');
const definition = source.match(/async function exportCsv\([^]*?\n}/)?.[0];
assert.ok(definition, '実際のCSV出力関数が必要です');
const HEADERS = ['予約番号', '来店日', '開始', '終了', 'メニュー', '担当', '金額',
  'お名前', '電話番号', 'メール', '来店回数', 'ご要望', '状態', '施術メモ'];
const FIELDS = ['code', 'date', 'time', 'endTime', 'menu', 'staffName', 'price',
  'name', 'tel', 'email', 'visit', 'request', 'status', 'note'];
const RECORD = { code: 'LM-CSV', date: '2026-10-04', time: '10:00', endTime: '11:00',
  menu: '架空カット', staffName: '架空担当', price: 6900, name: '架空のお客様', tel: '00000000000',
  email: 'fixture@example.test', visit: '2回目以降', request: '', status: '予約確定', note: '' };

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const text = csv.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(cell); cell = '';
    } else if (!quoted && character === '\r' && text[index + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; index++;
    } else cell += character;
  }
  assert.equal(quoted, false, '引用符を閉じたCSVにする');
  row.push(cell); rows.push(row);
  return rows;
}

function fixture(records = [RECORD]) {
  const snapshots = structuredClone(records);
  const downloads = [];
  const revoked = [];
  const alerts = [];
  const context = vm.createContext({ Blob, Date, dashboardGeneration: 1, reservationDetailsError: '',
    filteredReservations: () => snapshots,
    hasPendingReservationDetails: () => false,
    loadReservationDetails: async () => { throw new Error('詳細取得は不要です'); },
    toKey: () => '2026-10-04', alert: message => alerts.push(message),
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:fixture'; },
      revokeObjectURL: url => revoked.push(url) },
    document: { body: { appendChild() {} }, createElement: tag => {
      assert.equal(tag, 'a');
      return { click() {}, remove() {} };
    } }
  });
  vm.runInContext(definition, context);
  return { context, snapshots, downloads, revoked, alerts, async run() {
    await context.exportCsv();
    return downloads.length ? parseCsv(await downloads[0].text()) : null;
  } };
}

for (const value of ['=1+2', '+1+2', '-1+2', '@SUM(1,2)', '\t=1+2', '\r=1+2', '\n=1+2',
  ' =1+2', '  +1+2', '\u3000-1+2', '\uFEFF@SUM(1,2)', '\u0000=1+2', '\u001f+1+2', '\u007f-1+2',
  '＝1+2', '＋1+2', '－1+2', '＠SUM(1,2)', ' \t＝1+2', '\tお客様', '\rメモ', '\nメモ']) {
  test(`危険な先頭文字を元の文字を消さず保護する ${JSON.stringify(value)}`, async () => {
    const app = fixture([{ ...RECORD, request: value }]);
    const rows = await app.run();
    assert.equal(rows[1][FIELDS.indexOf('request')], "'" + value);
    assert.equal(app.snapshots[0].request, value, '元の予約データへ引用記号を書き戻さない');
    assert.deepEqual(app.alerts, []);
  });
}

for (const value of ['日本語のメモ', ' leading spaces', '途中に=1+2', "'=1+2", "'  =1+2",
  'メモ\n=次の行', 'カット,カラー;眉', '"引用"と,区切り', null, undefined, 0, 6900]) {
  test(`安全な内容は文字・改行・引用符・数値を維持する ${JSON.stringify(value)}`, async () => {
    const app = fixture([{ ...RECORD, request: value }]);
    const rows = await app.run();
    assert.deepEqual(rows[0], HEADERS);
    assert.equal(rows[1].length, FIELDS.length);
    assert.equal(rows[1][FIELDS.indexOf('request')], String(value ?? ''));
    const expected = FIELDS.map(field => String(app.snapshots[0][field] ?? ''));
    assert.deepEqual(rows[1], expected);
  });
}

test('全14列を保護し、改行・カンマ・引用符で列や行を増やさず全予約を出力する', async () => {
  const values = ['＝1+2', '\t=1+2', ' \r+1+2', '\n-1+2', '@SUM(1,2)', ' "=メモ",本文\r\n次行'];
  const records = FIELDS.map((field, index) => ({ ...RECORD, [field]: values[index % values.length] }));
  const app = fixture(records);
  const rows = await app.run();
  assert.equal(rows.length, records.length + 1);
  assert.deepEqual(rows[0], HEADERS);
  records.forEach((record, index) => {
    assert.equal(rows[index + 1].length, FIELDS.length);
    FIELDS.forEach(field => {
      const value = String(record[field] ?? '');
      const changed = field === FIELDS[index] && index % values.length !== values.length - 1;
      assert.equal(rows[index + 1][FIELDS.indexOf(field)], (changed ? "'" : '') + value);
    });
  });
  assert.deepEqual(app.snapshots, records);
  assert.deepEqual(app.revoked, ['blob:fixture']);
  assert.equal(app.downloads[0].type, 'text/csv;charset=utf-8;');
  assert.deepEqual([...new Uint8Array(await app.downloads[0].arrayBuffer())].slice(0, 3), [239, 187, 191]);
});

test('未取得の詳細を先に確認し、失敗・再ログインでは不完全なCSVを出力しない', async () => {
  for (const reason of ['失敗', '再ログイン']) {
    const app = fixture();
    app.context.hasPendingReservationDetails = () => true;
    app.context.loadReservationDetails = async () => {
      if (reason === '再ログイン') app.context.dashboardGeneration++;
      else app.context.reservationDetailsError = '架空の履歴取得失敗';
      return false;
    };
    assert.equal(await app.run(), null);
    assert.deepEqual(app.downloads, []);
    assert.deepEqual(app.alerts, reason === '失敗' ? ['架空の履歴取得失敗'] : []);
  }
});

test('予約0件は空のCSVを出さず、案内だけ表示する', async () => {
  const app = fixture([]);
  assert.equal(await app.run(), null);
  assert.deepEqual(app.alerts, ['出力できる予約がありません。']);
  assert.deepEqual(app.revoked, []);
});
