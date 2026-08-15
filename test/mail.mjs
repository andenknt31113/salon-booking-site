/* Apps Script のメール・通知の文面を、実際に組み立てて確かめる。
   Google側のAPIは差し替えて、送られるはずの文字列だけ受け取る。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'gas', 'Code.gs'), 'utf8');
const sent = [];

function makeSheet(rows) {
  const HEAD = ['予約番号','受付日時','来店日','開始','終了','所要(分)','メニュー','担当','担当ID',
                '指名料','合計金額','お名前','フリガナ','電話番号','メール','来店回数','ご要望','状態','カレンダーID'];
  const data = rows.map(r => HEAD.map(h => r[h] !== undefined ? r[h] : ''));
  return {
    getLastRow: () => data.length + 1,
    appendRow: r => data.push(r),
    getRange: (row, col, nr, nc) => ({
      getValues: () => {
        if (row === 2 && nc === 1) return data.map(r => [r[0]]);           // 予約番号の列
        if (nc === HEAD.length) return data.slice(row - 2, row - 2 + (nr || 1));
        return [[]];
      },
      setValue: v => { if (data[row - 2]) data[row - 2][col - 1] = v; },
      setFontWeight: () => ({ setBackground: () => {} }),
      setFontLine: () => ({ setFontColor: () => {} }),
      setNote: () => {}, setValues: () => {}, clearContent: () => {}
    }),
    setFrozenRows: () => {}, setColumnWidth: () => {},
    _data: data, _HEAD: HEAD
  };
}

/* patch を渡すと Code.gs の中身を差し替えてから動かせます。
   （LINEのURLを入れたときの文面を確かめるのに使っています） */
function run(fnName, sheet, payload, patch) {
  sent.length = 0;
  const code = patch ? patch(src) : src;
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    MailApp: { sendEmail: (to, subject, body) => sent.push({ 宛先: to, 件名: subject, 本文: body }) },
    UrlFetchApp: { fetch: (url, opt) => sent.push({ 宛先: 'LINE', 本文: JSON.parse(opt.payload).messages[0].text }) },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent: () => ({ getId: () => 'ev1' }) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty(){}, deleteProperty(){} }) },
    LockService: { getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => null, insertSheet: () => sheet }), getUi: () => { throw new Error('no ui'); } },
    DriveApp: {},
    ContentService: { createTextOutput: t => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
    Utilities: {
      formatDate: (d, tz, f) => new Date(d).toISOString().slice(0, 10),
      getUuid: () => 'uuid', computeDigest: () => [1, 2, 3],
      DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      newBlob: () => ({}), base64Decode: () => [], base64Encode: () => ''
    }
  };
  vm.createContext(ctx);
  vm.runInContext(code + `;globalThis.__fn = ${fnName};`, ctx);
  const out = ctx.__fn(sheet, payload);
  return { out, sent: sent.map(m => ({ ...m })) };
}

const problems = [];
function inspect(label, messages) {
  console.log(`\n===== ${label} =====`);
  messages.forEach(m => {
    console.log(`--- ${m.宛先}${m.件名 ? ' / ' + m.件名 : ''}`);
    console.log(m.本文.split('\n').map(l => '   ' + l).join('\n'));
    const bad = [];
    if (/undefined/.test(m.本文 + (m.件名 || ''))) bad.push('undefined');
    if (/NaN/.test(m.本文 + (m.件名 || ''))) bad.push('NaN');
    if (/\[object Object\]/.test(m.本文)) bad.push('[object Object]');
    if (bad.length) { problems.push(`${label} / ${m.宛先}: ${bad.join(', ')}`); }
  });
}

/* ---- 1. 情報が欠けた予約 ---- */
{
  const sheet = makeSheet([]);
  const r = run('doReserve_', sheet, {
    code: 'LM-MAIL1', createdAt: new Date().toISOString(),
    date: '2026-09-20', time: '10:00', endTime: '11:10', totalMinutes: 70,
    menus: [{ name: 'カット' }], staffName: 'MATTEO', staffId: 'st01',
    nominationFee: 0, totalPrice: 6900,
    customer: { name: '山田 太郎', tel: '09011112222' }   // フリガナ・メール・来店回数・要望が無い
  });
  inspect('1. フリガナ・メール・ご要望が無い予約', r.sent);
}

/* ---- 2. 金額が「お見積り」の予約 ---- */
{
  const sheet = makeSheet([]);
  const r = run('doReserve_', sheet, {
    code: 'LM-MAIL2', createdAt: new Date().toISOString(),
    date: '2026-09-21', time: '13:00', endTime: '16:00', totalMinutes: 180,
    menus: [{ name: 'カット＋デザインカラー（ブリーチ系）' }],
    staffName: 'MATTEO', staffId: 'st01', nominationFee: 0,
    totalPrice: 0, totalLabel: 'お見積り',
    customer: { name: '佐藤 花子', kana: 'サトウ ハナコ', tel: '09033334444',
                email: 'x@example.com', visit: '初めて', request: '' }
  });
  inspect('2. 金額がお見積りの予約', r.sent);
}

/* ---- 3. 長いメニュー名・改行入りのご要望 ---- */
{
  const sheet = makeSheet([]);
  const r = run('doReserve_', sheet, {
    code: 'LM-MAIL3', createdAt: new Date().toISOString(),
    date: '2026-09-22', time: '09:00', endTime: '12:00', totalMinutes: 180,
    menus: [
      { name: '【立体感で格が上がる】伸びても自然！白髪ぼかしホワイトメッシュ men\'s' },
      { name: '髪質改善トリートメント' }
    ],
    staffName: 'MATTEO', staffId: 'st01', nominationFee: 1000, totalPrice: 26800,
    customer: { name: '鈴木 一郎', kana: 'スズキ イチロウ', tel: '09055556666',
                email: 'y@example.com', visit: '2回目以降',
                request: '前回より短めでお願いします。\n分け目は右です。' }
  });
  inspect('3. 長いメニュー名・改行入りのご要望', r.sent);
}

/* ---- 4. 日時変更 ---- */
{
  const far = new Date(); far.setDate(far.getDate() + 30);
  const k = `${far.getFullYear()}-${String(far.getMonth()+1).padStart(2,'0')}-${String(far.getDate()).padStart(2,'0')}`;
  const sheet = makeSheet([{
    予約番号: 'LM-MAIL4', 来店日: k, 開始: '10:00', 終了: '11:10',
    メニュー: 'カット', 担当: 'MATTEO', 担当ID: 'st01', 合計金額: 6900,
    お名前: '高橋 次郎', 電話番号: "'09077778888", メール: 'z@example.com', 状態: '予約確定'
  }]);
  const later = new Date(); later.setDate(later.getDate() + 31);
  const k2 = `${later.getFullYear()}-${String(later.getMonth()+1).padStart(2,'0')}-${String(later.getDate()).padStart(2,'0')}`;
  const r = run('doChange_', sheet, { code: 'LM-MAIL4', tel: '09077778888',
    date: k2, time: '15:00', endTime: '16:10', minutes: 70 });
  console.log('\n返り値:', JSON.stringify(r.out));
  inspect('4. 日時変更', r.sent);
}

/* ---- 5. キャンセル ---- */
{
  const far = new Date(); far.setDate(far.getDate() + 30);
  const k = `${far.getFullYear()}-${String(far.getMonth()+1).padStart(2,'0')}-${String(far.getDate()).padStart(2,'0')}`;
  const sheet = makeSheet([{
    予約番号: 'LM-MAIL5', 来店日: k, 開始: '10:00', 終了: '11:10',
    メニュー: 'カット', 担当: 'MATTEO', 担当ID: 'st01', 合計金額: 6900,
    お名前: '田中 三郎', 電話番号: "'09099990000", メール: 'w@example.com', 状態: '予約確定'
  }]);
  // 予約確認ページの照会経由では code と tel しか送っていない
  const r = run('doCancel_', sheet, { code: 'LM-MAIL5', tel: '09099990000' });
  console.log('\n返り値:', JSON.stringify(r.out));
  inspect('5. キャンセル', r.sent);
}

/* ---- 6. LINEのURLを入れたとき／入れていないとき ---- */
{
  const payload = {
    code: 'LM-MAIL6', createdAt: new Date().toISOString(),
    date: '2026-09-25', time: '15:00', endTime: '16:10', totalMinutes: 70,
    menus: [{ name: 'メンズカット' }], staffName: 'MATTEO', staffId: 'st01',
    nominationFee: 0, totalPrice: 4000,
    customer: { name: '中村 四郎', kana: 'ナカムラ シロウ', tel: '09012120000',
                email: 'v@example.com', visit: '初めて', request: '' }
  };
  const withLine = run('doReserve_', makeSheet([]), payload,
    s => s.replace("const LINE_ADD_URL  = '';", "const LINE_ADD_URL  = 'https://lin.ee/testtest';"));
  inspect('6. LINEのURLを入れたとき', withLine.sent);
  const toCustomer = withLine.sent.find(m => m.宛先 === 'v@example.com');
  if (!toCustomer || !toCustomer.本文.includes('https://lin.ee/testtest')) {
    problems.push('6. LINEのURLを入れたのに、確認メールに友だち追加の案内が入っていない');
  }

  const without = run('doReserve_', makeSheet([]), payload);
  const plain = without.sent.find(m => m.宛先 === 'v@example.com');
  if (plain && /LINE/.test(plain.本文)) {
    problems.push('6. LINEのURLが空なのに、確認メールにLINEの案内が出ている');
  }
  // 空欄が連続して不自然な空行になっていないか
  if (plain && /\n\n\n/.test(plain.本文)) {
    problems.push('6. LINEのURLが空のとき、確認メールに余計な空行が残っている');
  }
}

console.log('\n' + '='.repeat(52));
if (problems.length) {
  console.log('見つかった問題:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('文面に undefined / NaN / [object Object] は無し');
}
