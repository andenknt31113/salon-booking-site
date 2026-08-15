/* 受け口（gas/Code.gs）に、おかしな入力を投げてみる試験。

   この受け口は「全員」に公開されています。そうしないとお客様から
   予約が届かないためです。つまり画面を通さない送信も届きます。
   ここは「正しく断ること」だけを確かめます。

   Google側のAPIは差し替えるので、Googleには一切つなぎません。
   ブラウザも要りません。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(R, 'gas', 'Code.gs'), 'utf8');
const HEAD = ['予約番号','受付日時','来店日','開始','終了','所要(分)','メニュー','担当','担当ID',
              '指名料','合計金額','お名前','フリガナ','電話番号','メール','来店回数','ご要望','状態','カレンダーID'];

function makeSheet(rows = []) {
  const data = rows.map(r => HEAD.map(h => (r[h] !== undefined ? r[h] : '')));
  const sheet = {
    getLastRow: () => data.length + 1,
    appendRow: r => data.push(r),
    getRange: (row, col, nr, nc) => ({
      getValues: () => {
        if (row === 2 && nc === 1) return data.map(r => [r[0]]);
        if (nc === HEAD.length) return data.slice(row - 2, row - 2 + (nr || 1));
        return [[]];
      },
      setValue: v => { if (data[row - 2]) data[row - 2][col - 1] = v; },
      setFontWeight: () => ({ setBackground: () => {} }),
      setFontLine: () => ({ setFontColor: () => {} }),
      setNote: () => {}, setValues: () => {}, clearContent: () => {}
    }),
    setFrozenRows: () => {}, setColumnWidth: () => {},
    getParent: () => ({ getSheetByName: () => null, insertSheet: () => sheet }),
    _data: data
  };
  return sheet;
}

function run(fnName, sheet, payload) {
  const mails = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    MailApp: { sendEmail: (to, s, b) => mails.push({ to, s, b }) },
    UrlFetchApp: { fetch: () => {} },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent: () => ({ getId: () => 'ev' }) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty(){}, deleteProperty(){} }) },
    LockService: { getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => sheet.getParent(), getUi: () => { throw new Error('no ui'); } },
    DriveApp: {},
    ContentService: { createTextOutput: t => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
    Utilities: {
      /* 本番は Asia/Tokyo で日付を出します。
         ここをUTCのままにすると、時間帯によって1日ずれた判定になります。 */
      formatDate: (d, tz, f) => {
        const jst = new Date(new Date(d).getTime() + 9 * 3600 * 1000);
        const p = n => String(n).padStart(2, '0');
        return f === 'HH:mm'
          ? `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`
          : `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}`;
      },
      getUuid: () => 'uuid', computeDigest: () => [1,2,3],
      DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      newBlob: () => ({}), base64Decode: () => [], base64Encode: () => ''
    }
  };
  vm.createContext(ctx);
  vm.runInContext(src + `;globalThis.__r = ${fnName};`, ctx);
  return { out: ctx.__r(sheet, payload), mails };
}

/* 受け口は日本時間で日付を判定します。
   ここをこの機械の時間帯で作ると、実行した時刻によって1日ずれて
   「当日の予約が過去扱い」のような、実際には起きない失敗になります。 */
const jstKey = t => {
  const d = new Date(t + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};
const day = n => jstKey(Date.now() + n * 864e5);

let seq = 0;
const base = (over = {}) => ({
  code: 'PR-' + (seq++).toString().padStart(5, '0'),
  createdAt: new Date().toISOString(),
  date: day(15 + (seq % 25)), time: '10:00', endTime: '11:00', totalMinutes: 60,
  menus: [{ name: 'カット' }], staffName: 'MATTEO', staffId: 'st01',
  nominationFee: 0, totalPrice: 4000,
  customer: { name: 'テスト', kana: 'テスト', tel: '09000000000', email: 'a@b.co', visit: '初めて' },
  ...over
});

const found = [];
const note = (t, m) => { found.push(`${t}（${m}）`); console.log(`  ❌ ${t} — ${m}`); };
const ok = t => console.log(`  ✅ ${t}`);
const col = n => HEAD.indexOf(n);

function tryOne(label, payload, judge) {
  const sheet = makeSheet();
  const { out, mails } = run('doReserve_', sheet, payload);
  judge(out, sheet._data[0], mails, label);
}

console.log('\n【本物の Code.gs】ふつうの予約は今までどおり通るか');
tryOne('ふつうの予約', base({}),
  (o, row, m, l) => o.ok ? ok(l + 'は通る') : note(l, 'が断られてしまう：' + o.error));
tryOne('メールなし（任意項目）', base({ customer: { name: 'あ', tel: '09011112222' } }),
  (o, row, m, l) => o.ok ? ok(l + 'でも通る') : note(l, 'で断られる：' + o.error));
tryOne('ハイフン入りの電話番号', base({ customer: { name: 'あ', tel: '090-1111-2222' } }),
  (o, row, m, l) => o.ok ? ok(l + 'でも通る') : note(l, 'で断られる：' + o.error));
tryOne('金額未定（お見積り）', base({ totalPrice: 0, totalLabel: 'お見積り' }),
  (o, row, m, l) => o.ok ? ok(l + 'でも通る') : note(l, 'で断られる：' + o.error));
tryOne('当日の予約', base({ date: day(0), time: '15:00' }),
  (o, row, m, l) => o.ok ? ok(l + 'は通る') : note(l, 'が断られる：' + o.error));
tryOne('60日後ちょうど', base({ date: day(60) }),
  (o, row, m, l) => o.ok ? ok(l + 'は通る') : note(l, 'が断られる：' + o.error));
tryOne('3時間の施術（9:00〜12:00）', base({ time: '09:00', totalMinutes: 180 }),
  (o, row, m, l) => o.ok ? ok(l + 'は通る') : note(l, 'が断られる：' + o.error));

console.log('\n【本物の Code.gs】受け付けてはいけない入力');
tryOne('過去の日付', base({ date: '2020-01-01' }),
  (o, row, m, l) => o.ok ? note(l, '台帳に書かれる') : ok(l + 'は断られる'));
tryOne('400日後', base({ date: day(400) }),
  (o, row, m, l) => o.ok ? note(l, '台帳に書かれる') : ok(l + 'は断られる'));
tryOne('深夜3時', base({ time: '03:00', endTime: '04:00' }),
  (o, row, m, l) => o.ok ? note(l, '営業時間外なのに書かれる') : ok(l + 'は断られる'));
tryOne('壊れた時刻 25:99', base({ time: '25:99' }),
  (o, row, m, l) => o.ok ? note(l, `台帳に「${row && row[col('開始')]}」が入る`) : ok(l + 'は断られる'));
tryOne('所要時間 -60分', base({ totalMinutes: -60 }),
  (o, row, m, l) => o.ok ? note(l, '書かれる（枠の計算が壊れる）') : ok(l + 'は断られる'));
tryOne('所要時間 100000分', base({ totalMinutes: 100000 }),
  (o, row, m, l) => o.ok ? note(l, '書かれる（丸何日も塞がる）') : ok(l + 'は断られる'));
tryOne('金額 -99999円', base({ totalPrice: -99999 }),
  (o, row, m, l) => o.ok ? note(l, '書かれる（売上見込がおかしくなる）') : ok(l + 'は断られる'));
tryOne('お名前なし', base({ customer: { tel: '09000000000' } }),
  (o, row, m, l) => o.ok ? note(l, '誰の予約か分からない行が残る') : ok(l + 'は断られる'));
tryOne('電話番号なし', base({ customer: { name: 'あ' } }),
  (o, row, m, l) => o.ok ? note(l, '連絡手段が無い予約が入る') : ok(l + 'は断られる'));
tryOne('メニューなし', base({ menus: [] }),
  (o, row, m, l) => o.ok ? note(l, '何をするのか分からない行が残る') : ok(l + 'は断られる'));

console.log('\n【本物の Code.gs】台帳・メールが壊れないか');
/* 長い文字は断らず、切って受け取ります。
   お名前が長いだけで予約できないほうが困るためです。
   ただし台帳とメールが読めなくなる長さにはしません。 */
tryOne('2万文字の名前', base({ customer: { name: 'あ'.repeat(20000), tel: '09000000000' } }),
  (o, row, m, l) => {
    if (!o.ok) return ok(l + ' → 断られる');
    const n = String(row[col('お名前')]).length;
    const mail = m[0] ? m[0].b.length : 0;
    if (n > 100) return note(l, `台帳に ${n} 文字入る`);
    if (mail > 3000) return note(l, `メール本文が ${mail} 文字になる`);
    ok(`${l} → 台帳 ${n} 文字・メール ${mail} 文字に収まる`);
  });

tryOne('数式に見える名前 =1+1', base({ customer: { name: '=1+1', tel: '09000000000' } }),
  (o, row, m, l) => {
    const v = String(row && row[col('お名前')]);
    v.startsWith('=') ? note(l, `台帳に「${v}」がそのまま入る（表計算の数式として動きます）`)
                      : ok(l + 'は無害化される');
  });
tryOne('数式に見えるご要望 =HYPERLINK(..)', base({ customer: { name: 'あ', tel: '09000000000', request: '=HYPERLINK("http://x","ここ")' } }),
  (o, row, m, l) => {
    const v = String(row && row[col('ご要望')]);
    v.startsWith('=') ? note(l, `台帳に「${v.slice(0,24)}…」がそのまま入る`) : ok(l + 'は無害化される');
  });

const row = (over={}) => ({
  予約番号:'LM-AAAAA', 来店日: day(20), 開始:'10:00', 終了:'11:00', '所要(分)':60,
  メニュー:'カット', 担当:'MATTEO', 担当ID:'st01', 合計金額:6900,
  お名前:'照会 太郎', 電話番号:"'09011112222", メール:'a@b.co', 状態:'予約確定', ...over });

console.log('\n【照会】');
{
  let r = run('doLookup_', makeSheet([row()]), { code:'LM-AAAAA', tel:'09011112222' });
  r.out.ok ? ok('正しい電話番号で照会できる') : note('照会', '正しくても照会できない: ' + JSON.stringify(r.out));

  r = run('doLookup_', makeSheet([row()]), { code:'LM-AAAAA', tel:'09099999999' });
  r.out.ok ? note('照会', '電話番号が違っても見える') : ok('電話番号が違えば見えない');

  r = run('doLookup_', makeSheet([row()]), { code:'LM-AAAAA' });
  r.out.ok ? note('照会', '電話番号なしで見える') : ok('電話番号なしでは見えない');

  r = run('doLookup_', makeSheet([row()]), { code:'LM-AAAAA', tel:'090-1111-2222' });
  r.out.ok ? ok('ハイフン付きでも照会できる') : note('照会', 'ハイフン付きだと照会できない');

  r = run('doLookup_', makeSheet([row()]), { code:'lm-aaaaa', tel:'09011112222' });
  console.log(`  小文字の予約番号 → ${r.out.ok ? '照会できる' : '照会できない'}`);

  const res = run('doLookup_', makeSheet([row()]), { code:'LM-AAAAA', tel:'09011112222' }).out;
  const keys = res.reservation ? Object.keys(res.reservation) : [];
  console.log('  返ってくる項目:', keys.join(',') || '（なし）');
}

console.log('\n【キャンセル】');
{
  let r = run('doCancel_', makeSheet([row()]), { code:'LM-AAAAA', tel:'09099999999' });
  r.out.ok ? note('キャンセル', '他人の電話番号でもキャンセルできる') : ok('電話番号が違えばキャンセルできない');

  r = run('doCancel_', makeSheet([row()]), { code:'LM-AAAAA' });
  r.out.ok ? note('キャンセル', '電話番号なしでキャンセルできる') : ok('電話番号なしではキャンセルできない');

  const sheet = makeSheet([row()]);
  r = run('doCancel_', sheet, { code:'LM-AAAAA', tel:'09011112222' });
  r.out.ok ? ok('本人ならキャンセルできる') : note('キャンセル', '本人でもできない: ' + JSON.stringify(r.out));
}

console.log('\n【日時変更】');
{
  let r = run('doChange_', makeSheet([row()]), { code:'LM-AAAAA', tel:'09099999999', date: day(21), time:'10:00', minutes:60 });
  r.out.ok ? note('日時変更', '他人の電話番号でも変更できる') : ok('電話番号が違えば変更できない');

  r = run('doChange_', makeSheet([row()]), { code:'LM-AAAAA', tel:'09011112222', date: day(-5), time:'10:00', minutes:60 });
  r.out.ok ? note('日時変更', '過去の日付に変更できる') : ok('過去の日付には変更できない');

  r = run('doChange_', makeSheet([row()]), { code:'LM-AAAAA', tel:'09011112222', date: day(300), time:'10:00', minutes:60 });
  r.out.ok ? note('日時変更', '受付範囲外に変更できる') : ok('受付範囲外には変更できない');

  r = run('doChange_', makeSheet([row()]), { code:'LM-AAAAA', tel:'09011112222', date: day(21), time:'03:00', minutes:60 });
  r.out.ok ? note('日時変更', '営業時間外に変更できる') : ok('営業時間外には変更できない');

  r = run('doChange_', makeSheet([row()]), { code:'LM-AAAAA', tel:'09011112222', date: day(21), time:'10:00', minutes:60 });
  r.out.ok ? ok('本人なら変更できる') : note('日時変更', '本人でもできない: ' + JSON.stringify(r.out));
}

console.log('\n【口コミ】');
{
  const past = row({ 来店日: day(-3), 予約番号:'LM-RV001' });
  let r = run('doReview_', makeSheet([past]), { code:'LM-RV001', tel:'09099999999', body:'よかった', score:5 });
  r.out.ok ? note('口コミ', '他人の電話番号でも投稿できる') : ok('電話番号が違えば投稿できない');

  r = run('doReview_', makeSheet([past]), { code:'LM-RV001', tel:'09011112222', body:'', score:5 });
  r.out.ok ? note('口コミ', '本文が空でも投稿できる') : ok('本文が空だと投稿できない');

  r = run('doReview_', makeSheet([past]), { code:'LM-RV001', tel:'09011112222', body:'よかった', score:999 });
  console.log(`  評価999 → ${r.out.ok ? '受け付ける（値を確認）' : '断られる'}`);

  const future = row({ 来店日: day(20), 予約番号:'LM-RV002' });
  r = run('doReview_', makeSheet([future]), { code:'LM-RV002', tel:'09011112222', body:'まだ来てない', score:5 });
  r.out.ok ? note('口コミ', '**来店前でも投稿できる**') : ok('来店前は投稿できない');

  const many = makeSheet([past]);
  run('doReview_', many, { code:'LM-RV001', tel:'09011112222', body:'1回目', score:5 });
  r = run('doReview_', many, { code:'LM-RV001', tel:'09011112222', body:'2回目', score:1 });
  r.out.ok ? note('口コミ', '同じ予約から何度でも投稿できる') : ok('同じ予約からは1回だけ');
}


console.log('\n' + '='.repeat(52));
if (found.length) {
  console.log(`断れていないもの ${found.length}件`);
  found.forEach(f => console.log('  ❌ ' + f));
  process.exitCode = 1;
} else {
  console.log('おかしな入力はすべて断られました');
}
