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

/* 日本語入力を切り替えずに打つと、数字も記号も全角になります。
   番号は合っているのに断られる、が起きないことを確かめます。 */
tryOne('全角の電話番号 ０９０…', base({ customer: { name: 'あ', tel: '０９０１１１１２２２２' } }),
  (o, row, m, l) => {
    if (!o.ok) return note(l, 'で断られる：' + o.error);
    const v = String(row[col('電話番号')]).replace(/^'/, '');
    /[０-９]/.test(v) ? note(l, `台帳に全角のまま「${v}」が入る（そこから発信できません）`)
                     : ok(`${l}でも通り、台帳には「${v}」と入る`);
  });
tryOne('全角ハイフンの電話番号 ０９０ー…', base({ customer: { name: 'あ', tel: '０９０ー１１１１ー２２２２' } }),
  (o, row, m, l) => o.ok ? ok(l + 'でも通る') : note(l, 'で断られる：' + o.error));
tryOne('全角のメール ａ＠ｂ．ｃｏ', base({ customer: { name: 'あ', tel: '09011112222', email: 'ａ＠ｂ．ｃｏ' } }),
  (o, row, m, l) => {
    if (!o.ok) return note(l, 'で断られる：' + o.error);
    const v = String(row[col('メール')]);
    /[＠．ａ-ｚ]/.test(v) ? note(l, `台帳に全角のまま「${v}」が入る（送っても届きません）`)
                        : ok(`${l}でも通り、台帳には「${v}」と入る`);
  });

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

/* ============================================================
   席は1つ

   電話で受けた予約は担当を空のまま入ることがあります。
   以前は担当が違えば別の予約として扱っていたので、同じ時間に
   電話予約とサイトからの予約が2件入りました。席は1つです。
   ============================================================ */
console.log('\n【二重予約】席は1つしかない');
{
  const at = day(12);
  const taken = (over, payload) => {
    const sheet = makeSheet([row(Object.assign({
      来店日: at, 開始: '11:00', 終了: '12:00', '所要(分)': 60, 予約番号: 'LM-SEAT1' }, over))]);
    return run('doReserve_', sheet, base(Object.assign({ date: at, time: '11:00', endTime: '12:00', totalMinutes: 60 }, payload))).out;
  };

  taken({}, {}).ok ? note('二重予約', '同じ担当・同じ時間に2件入る') : ok('同じ時間には二重に入らない');
  taken({ 担当ID: '' }, {}).ok
    ? note('二重予約', '電話予約（担当なし）の上に、サイトから予約が入る')
    : ok('担当なしの電話予約があれば、その時間は取れない');
  taken({ 担当ID: 'st01' }, { staffId: '' }).ok
    ? note('二重予約', '指名なしで送れば、埋まっている時間に入れる')
    : ok('指名なしで送っても、埋まっている時間には入れない');
  taken({ 担当ID: 'st99' }, {}).ok
    ? note('二重予約', '担当IDを変えれば、埋まっている時間に入れる')
    : ok('担当IDを変えても、埋まっている時間には入れない');

  /* 重なっていなければ、続けて受けられます */
  const sheet = makeSheet([row({ 来店日: at, 開始: '11:00', 終了: '12:00', '所要(分)': 60, 予約番号: 'LM-SEAT2' })]);
  run('doReserve_', sheet, base({ date: at, time: '12:00', endTime: '13:00', totalMinutes: 60 })).out.ok
    ? ok('終わった直後（12:00）からは取れる') : note('12:00', 'が取れない（続けて受けられません）');

  const cancelled = makeSheet([row({ 来店日: at, 開始: '11:00', 終了: '12:00', 状態: 'キャンセル', 予約番号: 'LM-SEAT3' })]);
  run('doReserve_', cancelled, base({ date: at, time: '11:00', endTime: '12:00', totalMinutes: 60 })).out.ok
    ? ok('キャンセルされた枠は取れる') : note('キャンセル済みの枠', 'が空きに戻らない');
}

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

  /* 予約番号は控えを見ながら打ちます。日本語入力のままだと
     「LM-」が「ＬＭー」になり、iPhoneでは小文字にもなります。
     番号自体は合っているので、通してあげないと問い合わせになります。 */
  r = run('doLookup_', makeSheet([row()]), { code:'lm-aaaaa', tel:'09011112222' });
  r.out.ok ? ok('小文字で打っても照会できる') : note('照会', '小文字だと照会できない');

  r = run('doLookup_', makeSheet([row()]), { code:'ＬＭー'+'ＡＡＡＡＡ', tel:'09011112222' });
  r.out.ok ? ok('全角で打っても照会できる') : note('照会', '全角だと照会できない');

  r = run('doLookup_', makeSheet([row()]), { code:'LMAAAAA', tel:'09011112222' });
  r.out.ok ? ok('ハイフンを抜いても照会できる') : note('照会', 'ハイフンを抜くと照会できない');

  r = run('doLookup_', makeSheet([row()]), { code:' LM-AAAAA ', tel:'09011112222' });
  r.out.ok ? ok('前後に空白があっても照会できる') : note('照会', '空白が混ざると照会できない');

  r = run('doLookup_', makeSheet([row()]), { code:'', tel:'09011112222' });
  r.out.ok ? note('照会', '予約番号が空でも何かが返る') : ok('予約番号が空なら照会できない');

  r = run('doLookup_', makeSheet([row()]), { code:'LM-AAAAA', tel:'０９０１１１１２２２２' });
  r.out.ok ? ok('全角の電話番号でも照会できる') : note('照会', '全角の電話番号だと照会できない');

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

  r = run('doChange_', makeSheet([row()]), { code:'LM-AAAAA', date: day(21), time:'10:00', minutes:60 });
  r.out.ok ? note('日時変更', '電話番号を送らなければ誰でも変更できる') : ok('電話番号なしでは変更できない');

  r = run('doChange_', makeSheet([row()]), { code:'LM-AAAAA', tel:'', date: day(21), time:'10:00', minutes:60 });
  r.out.ok ? note('日時変更', '電話番号が空でも変更できる') : ok('電話番号が空でも変更できない');

  r = run('doChange_', makeSheet([row()]), { code:'LM-AAAAA', tel:'09011112222', date: day(21), time:'10:00', minutes:60 });
  r.out.ok ? ok('本人なら変更できる') : note('日時変更', '本人でもできない: ' + JSON.stringify(r.out));

  r = run('doChange_', makeSheet([row()]), { code:'lm-aaaaa', tel:'090-1111-2222', date: day(21), time:'10:00', minutes:60 });
  r.out.ok ? ok('小文字・ハイフン付きでも変更できる') : note('日時変更', '打ち方のゆれで変更できない');
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


/* ============================================================
   シートに手で書いた値を、どこまで読めるか

   休業日もメニューも、最後は店長がスプレッドシートに手で書きます。
   「2026/9/1」「60分」「４０００」――どれもふつうの書き方です。
   ここで読み落とすと、休みにしたはずの日に予約が入ったり、
   施術の長さが30分に化けて次のお客様と重なったりします。
   しかも画面には何も出ません。だから毎回ここを見ます。
   ============================================================ */
function readSheets(sheets, fnName) {
  const ctx = {
    console: { log(){}, warn(){}, error(){} },
    MailApp: { sendEmail(){} }, UrlFetchApp: { fetch(){} },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent: () => ({ getId: () => 'ev' }) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty(){}, deleteProperty(){}, getKeys: () => [] }) },
    LockService: { getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
    DriveApp: {}, ContentService: { createTextOutput: t => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
    Utilities: {
      formatDate: (d, tz, f) => {
        const j = new Date(new Date(d).getTime() + 9 * 3600e3);
        const p = n => String(n).padStart(2, '0');
        return f === 'HH:mm' ? `${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`
          : `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`;
      },
      getUuid: () => 'uuid', computeDigest: () => [1], DigestAlgorithm: { MD5: 'md5' },
      Charset: { UTF_8: 'utf8' }, newBlob: () => ({}), base64Decode: () => [], base64Encode: () => ''
    }
  };
  vm.createContext(ctx);
  /* 日付型のセルは、この中で作らないと本物と同じ扱いになりません
     （別の器で作った Date は instanceof Date が成り立ちません）。 */
  ctx.__mk = rows => rows.map(r => r.map(c => (c && c.__date
    ? vm.runInContext(`new Date(${c.__date})`, ctx) : c)));
  const built = {};
  Object.keys(sheets).forEach(name => {
    const rows = ctx.__mk(sheets[name]);
    built[name] = {
      getLastRow: () => rows.length + 1,
      getLastColumn: () => (rows[0] || []).length,
      getRange: (r, c, nr, nc) => ({
        getValues: () => rows.slice(r - 2, r - 2 + nr).map(x => x.slice(c - 1, c - 1 + nc))
      })
    };
  });
  ctx.__ss = { getSheetByName: n => built[n] || null, insertSheet: () => null };
  ctx.SpreadsheetApp = { getActiveSpreadsheet: () => ctx.__ss, getUi: () => { throw new Error('no ui'); } };
  vm.runInContext(src + `;globalThis.__s = ${fnName};`, ctx);
  try { return ctx.__s(ctx.__ss); } catch (e) { return { threw: String(e && e.message) }; }
}
/* 日付型のセルを表す印。上の readSheets が本物の Date に変えます。 */
const dateCell = ms => ({ __date: ms });

console.log('\n【シート】休業日の書き方');
{
  const want = '2026-09-01';
  const cases = [
    ['2026-09-01', '2026-09-01'],
    ['2026/09/01', '2026/09/01'],
    ['2026/9/1', '2026/9/1'],
    ['2026-9-1', '2026-9-1'],
    ['2026年9月1日', '2026年9月1日'],
    ['前後に空白', ' 2026-09-01 '],
    ['日付として入力（セルが日付型）', dateCell(Date.UTC(2026, 8, 1) - 9 * 3600e3)]
  ];
  for (const [label, cell] of cases) {
    const got = readSheets({ '休業日': [[cell, '', '']] }, 'readClosedSheet_');
    const hit = Array.isArray(got) && got.some(x => x === want || (x && x.date === want));
    hit ? ok(`休業日「${label}」は休みとして読める`)
        : note(`休業日「${label}」`, 'が読めない → 休みにしたはずの日に予約が入ります');
  }
}

console.log('\n【シート】受けない時間帯の書き方');
{
  for (const [label, s, e] of [['9:00', '9:00', '12:00'], ['09:00', '09:00', '12:00'],
                               ['全角', '０９：００', '１２：００'], ['9時', '9時', '12時']]) {
    const got = readSheets({ '休業日': [['2026-09-01', s, e]] }, 'readClosedSheet_');
    const band = Array.isArray(got) && got[0] && got[0].start === '09:00' && got[0].end === '12:00';
    band ? ok(`時間帯「${label}」は 09:00〜12:00 として読める`)
         : note(`時間帯「${label}」`, `が帯にならない（${JSON.stringify(got)}）`);
  }
  const allDay = readSheets({ '休業日': [['2026-09-01', '', '']] }, 'readClosedSheet_');
  allDay[0] === '2026-09-01' ? ok('時間を空けておけば終日休みになる') : note('終日休み', 'にならない');
}

console.log('\n【シート】メニューの価格と所要時間');
{
  const menu = (price, min) => ({ 'メニュー': [['カット', 'テスト', price, min, '', '', '○']] });
  const item = g => (g && g[0] && g[0].items[0]) || {};
  for (const [label, cell] of [['4000', 4000], ['4,000', '4,000'], ['¥4,000', '¥4,000'],
                               ['4000円', '4000円'], ['４０００（全角）', '４０００'], ['4000〜', '4000〜']]) {
    const v = item(readSheets(menu(cell, 60), 'readMenuSheet_')).price;
    v === 4000 ? ok(`価格「${label}」は 4000円と読める`) : note(`価格「${label}」`, `${v} と読まれる`);
  }
  const from = item(readSheets(menu('4000〜', 60), 'readMenuSheet_')).priceFrom;
  from ? ok('「4000〜」は「〜から」として扱う') : note('「4000〜」', 'の「〜」が消える');

  for (const [label, cell] of [['60', 60], ['60分', '60分'], ['６０（全角）', '６０']]) {
    const v = item(readSheets(menu(4000, cell), 'readMenuSheet_')).minutes;
    v === 60 ? ok(`所要「${label}」は 60分と読める`)
             : note(`所要「${label}」`, `${v}分と読まれる → 次のお客様と重なります`);
  }
}

console.log('\n【シート】隠したいときの書き方');
{
  const shown = cell => !!readSheets({ 'メニュー': [['カット', 'テスト', 4000, 60, '', '', cell]] }, 'readMenuSheet_');
  for (const c of ['×', '✕', '✖', 'x', 'X', '非表示', '休止', ' × ']) {
    shown(c) ? note(`「${c}」`, 'と書いても掲載されたまま') : ok(`「${c}」と書けば隠れる`);
  }
  shown('○') ? ok('「○」なら掲載される') : note('「○」', 'と書いたのに隠れる');
  shown('') ? ok('空欄なら掲載される') : note('空欄', 'だと隠れる');
}

/* ここから先は店側の入口です。合言葉と、端末に残す合い札を確かめます。
   台帳のある表ではなく、空の表に対して呼びます。断ることだけが要点なので、
   中身は要りません。 */
function admin(fnName, payload, store = { ADMIN_PASSWORD: 'himitsu' }) {
  const made = {};
  const mk = name => {
    const d = [];
    return { getName: () => name, getLastRow: () => d.length, getLastColumn: () => 3,
      appendRow: r => d.push(r),
      getRange: () => ({ getValues: () => d, setValue(){}, setValues(){}, clearContent(){},
        setFontWeight: () => ({ setBackground: () => {} }), setNote(){},
        setFontLine: () => ({ setFontColor: () => {} }) }),
      setFrozenRows(){}, setColumnWidth(){}, clear(){}, deleteRows(){}, _data: d };
  };
  const ss = { getSheetByName: n => (made[n] = made[n] || null), insertSheet: n => (made[n] = mk(n)) };
  const ctx = {
    console: { log(){}, warn(){}, error(){} },
    MailApp: { sendEmail: () => {} }, UrlFetchApp: { fetch: () => {} },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent: () => ({ getId: () => 'ev' }) }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = v; },
      deleteProperty: k => { delete store[k]; },
      getKeys: () => Object.keys(store) }) },
    LockService: { getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => { throw new Error('no ui'); } },
    /* 写真の保存先。Googleドライブにはつなぎません。 */
    DriveApp: {
      getFoldersByName: () => ({ hasNext: () => true, next: () => ({
        createFile: () => ({ getId: () => 'fileid', setSharing() {} }) }) }),
      createFolder: () => ({ createFile: () => ({ getId: () => 'fileid', setSharing() {} }) }),
      Access: { ANYONE_WITH_LINK: 'link' }, Permission: { VIEW: 'view' }
    },
    ContentService: { createTextOutput: t => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyyMMdd-HHmmss'
        ? new Date(d).toISOString().slice(0, 10).replace(/-/g, '') + '-000000'
        : new Date(d).toISOString().slice(0, 10)),
      getUuid: () => 'uuid-' + (seq++), computeDigest: () => [1, 2, 3],
      DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      newBlob: (bytes, mime, name) => ({ bytes, mime, name, setSharing() {} }),
      base64Decode: s => ({ length: Math.floor(String(s).length * 3 / 4) }), base64Encode: () => '' }
  };
  vm.createContext(ctx);
  vm.runInContext(src + `;globalThis.__a = ${fnName};`, ctx);
  let out;
  try { out = ctx.__a(payload); } catch (e) { out = { ok: false, threw: String(e && e.message) }; }
  return { out, store };
}

console.log('\n【店側の入口】合言葉');
{
  let r = admin('doAdminData_', {});
  r.out.ok ? note('合言葉なし', '台帳が読める') : ok('合言葉なしでは読めない');

  r = admin('doAdminData_', { password: '' });
  r.out.ok ? note('空の合言葉', '台帳が読める') : ok('空の合言葉では読めない');

  r = admin('doAdminData_', { password: 'chigau' });
  r.out.ok ? note('違う合言葉', '台帳が読める') : ok('違う合言葉では読めない');

  r = admin('doAdminData_', { password: 'himitsu' });
  r.out.ok ? ok('正しい合言葉なら読める') : note('正しい合言葉', '読めない：' + JSON.stringify(r.out));

  /* 合言葉を入れ忘れたまま公開してしまったときに、
     「無い＝素通り」になっていないかを見ます。 */
  r = admin('doAdminData_', { password: '' }, {});
  r.out.ok ? note('合言葉を設定していない', '誰でも台帳が読める') : ok('合言葉を設定していなければ誰も読めない');

  r = admin('doAdminData_', { token: 'にせの合い札' });
  r.out.ok ? note('でたらめな合い札', '台帳が読める') : ok('でたらめな合い札では読めない');
}

console.log('\n【店側の入口】合い札');
{
  const login = admin('doAdminLogin_', { password: 'himitsu', remember: true });
  const token = login.out.token;
  if (!token) note('合い札', '「この端末を記憶する」を選んでも出ない');
  else {
    let r = admin('doAdminData_', { token }, login.store);
    r.out.ok ? ok('出した合い札で読める') : note('合い札', '出したのに読めない');

    r = admin('doAdminData_', { token: token + 'x' }, login.store);
    r.out.ok ? note('合い札', '1文字変えても読める（当てられます）') : ok('合い札を1文字変えると読めない');
  }
  const no = admin('doAdminLogin_', { password: 'himitsu', remember: false });
  no.out.token ? note('合い札', '記憶しない選択なのに端末に残る') : ok('記憶しない選択なら合い札を出さない');

  const bad = admin('doAdminLogin_', { password: 'chigau', remember: true });
  bad.out.ok ? note('入店', '違う合言葉でも入れる') : ok('違う合言葉では入れない');
}

console.log('\n【店側の入口】まちがいが続いたら');
{
  /* 受け口は誰でも呼べるので、合言葉は何度でも試せます。
     短い合言葉が当てられないよう、続けてまちがえたら少し止めます。 */
  const store = { ADMIN_PASSWORD: 'himitsu' };
  let last;
  for (let i = 0; i < 12; i++) last = admin('doAdminData_', { password: 'hazure' + i }, store);
  last.out.ok ? note('総当たり', '何度でも試せる') : ok('まちがいを続けても入れない');

  const right = admin('doAdminData_', { password: 'himitsu' }, store);
  right.out.ok
    ? note('総当たり', '10回まちがえた直後でも、すぐ試し続けられる')
    : ok('まちがいが続いたら、正しい合言葉でもしばらく待たせる');
  console.log('  そのときの返事:', String(right.out.error || right.out.threw).slice(0, 40));

  /* 店の人まで締め出さないこと。記憶させた端末は通します。 */
  const clean = { ADMIN_PASSWORD: 'himitsu' };
  const login = admin('doAdminLogin_', { password: 'himitsu', remember: true }, clean);
  for (let i = 0; i < 12; i++) admin('doAdminData_', { password: 'hazure' + i }, login.store);
  admin('doAdminData_', { token: login.out.token }, login.store).out.ok
    ? ok('記憶させた端末は、止めているあいだも入れる')
    : note('記憶させた端末', 'まで入れなくなる（困るのは店です）');

  /* お客様のキャンセルは合言葉を送りません。それを数えてはいけません。 */
  const shop2 = { ADMIN_PASSWORD: 'himitsu' };
  for (let i = 0; i < 12; i++) {
    run('doCancel_', makeSheet([row()]), { code: 'LM-AAAAA', tel: '09011112222' });
  }
  admin('doAdminData_', { password: 'himitsu' }, shop2).out.ok
    ? ok('お客様のキャンセルは、まちがい回数に数えない')
    : note('お客様のキャンセル', 'が回数に数えられ、店が入れなくなる');
}

console.log('\n【店側の入口】保存');
{
  let r = admin('doAdminSave_', { target: 'menus', rows: [] });
  r.out.ok ? note('合言葉なしの保存', 'メニューを消せてしまう') : ok('合言葉なしでは保存できない');

  r = admin('doAdminSave_', { password: 'himitsu', target: '../../etc', rows: [] });
  r.out.ok ? note('知らない保存先', '受け付ける') : ok('知らない保存先は断る');

  r = admin('doAdminSave_', { password: 'himitsu', target: '予約一覧', rows: [] });
  r.out.ok ? note('保存先に予約台帳', '予約を全部消せてしまう') : ok('予約台帳は保存先にできない');
}

/* ============================================================
   2台で同じ画面を開いていたとき / お客様の言葉

   管理ページはシートをまるごと書き換えます。開いてから保存するまでに
   別の端末が保存していたら、そのまま上書きすると相手の変更が黙って消えます。
   口コミのほうは逆で、店側から変えてよいのは「載せるかどうか」だけです。
   文面や評価をこちらで直せると、それはもうお客様の声ではありません。
   ============================================================ */
function shop(sheetsInit = {}) {
  const store = { ADMIN_PASSWORD: 'himitsu' };
  const sheets = {};
  const mk = (name, rows = []) => {
    const data = rows.map(r => r.slice());
    return {
      getName: () => name, getLastRow: () => data.length + 1,
      getLastColumn: () => (data[0] || []).length, appendRow: r => data.push(r),
      getRange: (rw, c, nr, nc) => ({
        getValues: () => data.slice(rw - 2, rw - 2 + (nr || 1)).map(x => x.slice(c - 1, c - 1 + (nc || x.length))),
        setValues: v => { v.forEach((r, i) => { data[rw - 2 + i] = r.slice(); }); },
        setValue() {}, clearContent: () => { data.length = 0; },
        setFontWeight: () => ({ setBackground: () => {} }), setNote() {},
        setFontLine: () => ({ setFontColor: () => {} })
      }),
      getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
      setFrozenRows() {}, setColumnWidth() {}, clear() {}, deleteRows() {}, _data: data
    };
  };
  Object.keys(sheetsInit).forEach(n => { sheets[n] = mk(n, sheetsInit[n]); });
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mk(n)) };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    MailApp: { sendEmail() {} }, UrlFetchApp: { fetch() {} },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent: () => ({ getId: () => 'ev' }) }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; },
      deleteProperty: k => { delete store[k]; }, getKeys: () => Object.keys(store) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => { throw new Error('no ui'); } },
    DriveApp: {}, ContentService: { createTextOutput: t => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
    Utilities: { formatDate: d => new Date(d).toISOString().slice(0, 10), getUuid: () => 'uuid',
      /* 印は中身から作ります。中身が変われば印も変わる必要があります。 */
      computeDigest: (alg, text) => { let h = 0; for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) | 0;
        return [(h >> 24) & 255, (h >> 16) & 255, (h >> 8) & 255, h & 255]; },
      DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      newBlob: () => ({}), base64Decode: () => [], base64Encode: () => '' }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return {
    call: (fn, payload) => {
      vm.runInContext(`globalThis.__w = ${fn};`, ctx);
      try { return ctx.__w(payload); } catch (e) { return { ok: false, threw: String(e && e.message) }; }
    }, sheets
  };
}

console.log('\n【店側の入口】2台で同時に開いていたら');
{
  const menuRow = name => ({ 区分: 'カット', メニュー名: name, 価格: 4500, '所要(分)': 60, 説明: '', 画像: '', 表示: '○' });
  const w = shop({ 'メニュー': [['カット', 'A', '4000', '60', '', '', '○']] });
  const opened = w.call('doAdminData_', { password: 'himitsu' });
  const stamp = opened.stamps && opened.stamps.menus;

  stamp ? ok('画面を開くと、いまの中身の印を受け取る') : note('印', 'が返ってこない');

  w.call('doAdminSave_', { password: 'himitsu', target: 'menus', stamp, rows: [menuRow('Aを直した')] }).ok
    ? ok('先に保存した側は通る') : note('先の保存', 'が通らない');

  w.call('doAdminSave_', { password: 'himitsu', target: 'menus', stamp, rows: [menuRow('Bが別に直した')] }).ok
    ? note('あとから保存した側', 'も通る（先に保存した内容が黙って消えます）')
    : ok('あとから保存した側は「読み込み直して」と断る');

  const after = w.call('doAdminData_', { password: 'himitsu' });
  (after.menus || [])[0] && after.menus[0]['メニュー名'] === 'Aを直した'
    ? ok('先に保存した内容が残っている') : note('先の保存', 'が消えている');

  w.call('doAdminSave_', { password: 'himitsu', target: 'menus', stamp: after.stamps.menus, rows: [menuRow('読み直した')] }).ok
    ? ok('読み込み直せば保存できる') : note('読み直し後の保存', 'も断られる');

  w.call('doAdminSave_', { password: 'himitsu', target: 'menus', rows: [menuRow('印なし')] }).ok
    ? note('印を付けない保存', 'は通る（外して送れば上書きできます）') : ok('印を付けない保存も断る');
}

console.log('\n【口コミ】お客様の言葉は店側から変えられない');
{
  const RVH = ['投稿日','予約番号','ニックネーム','年代','性別','評価','タイトル','本文','担当','メニュー','状態'];
  const orig = ['2026-08-01','LM-RV001','ケンタ','30代','男性',2,'うーん','待ち時間が長かったです','MATTEO','カット','未承認'];
  const w = shop({ '口コミ': [orig.slice()] });
  /* 保存には、いまの中身の印が要ります（2台で同時に開いたときの取り合いを防ぐため）。
     読み込んでから保存する、という管理ページと同じ手順を踏みます。 */
  const saveReviews = rows => {
    const stamp = w.call('doAdminData_', { password: 'himitsu' }).stamps.reviews;
    return w.call('doAdminSave_', { password: 'himitsu', target: 'reviews', stamp, rows });
  };

  saveReviews([
    { 投稿日:'2026-08-01', 予約番号:'LM-RV001', ニックネーム:'ケンタ', 年代:'30代', 性別:'男性',
      評価: 5, タイトル:'最高でした', 本文:'最高の店でした！', 担当:'MATTEO', メニュー:'カット', 状態:'掲載中' }
  ]);
  const now = w.sheets['口コミ']._data[0] || [];
  const at = h => now[RVH.indexOf(h)];
  at('本文') === '待ち時間が長かったです' ? ok('本文は元のまま') : note('本文', `が「${at('本文')}」に書き換わる`);
  Number(at('評価')) === 2 ? ok('評価も元のまま') : note('評価', `が ${at('評価')} に書き換わる`);
  at('ニックネーム') === 'ケンタ' ? ok('お名前も元のまま') : note('ニックネーム', 'が書き換わる');
  at('状態') === '掲載中' ? ok('載せるかどうかは変えられる') : note('状態', `が変えられない（${at('状態')}）`);

  saveReviews([{ 予約番号: 'LM-RV001', 状態: 'でたらめ' }]);
  ['未承認', '掲載中', '非掲載'].includes(String(w.sheets['口コミ']._data[0][RVH.indexOf('状態')]))
    ? ok('決められた3つ以外の状態は入らない') : note('状態', 'に何でも書ける');

  saveReviews([
    { 予約番号: 'LM-RV001', 状態: '掲載中' },
    { 投稿日: '2026-08-10', 予約番号: 'LM-FAKE1', ニックネーム: 'サクラ', 評価: 5, 本文: '最高の店です', 状態: '掲載中' }
  ]);
  const codes = w.sheets['口コミ']._data.map(r => r[RVH.indexOf('予約番号')]);
  codes.includes('LM-FAKE1')
    ? note('来ていない口コミ', 'を足せる（作り話の口コミは景品表示法に触れます）')
    : ok('来ていない口コミは足せない');

  saveReviews([]);
  w.sheets['口コミ']._data.length === 0 ? ok('要らない口コミは消せる') : note('口コミ', 'が消せない');
}

console.log('\n【店側の入口】写真');
{
  const img = 'A'.repeat(1000);
  const up = (over, store) => admin('doAdminUpload_',
    Object.assign({ password: 'himitsu', slot: 'logo', mimeType: 'image/jpeg', dataBase64: img }, over), store).out;

  up({}).ok ? ok('JPEGは受け取る') : note('JPEG', 'が受け取れない');
  up({ mimeType: 'image/png', dataBase64: 'data:image/png;base64,' + img }).ok
    ? ok('PNGも受け取る') : note('PNG', 'が受け取れない');
  up({ mimeType: 'image/svg+xml' }).ok
    ? note('SVG', 'を受け取ってしまう（中に命令を書ける形式です）') : ok('SVGは断る');
  up({ mimeType: 'text/html' }).ok ? note('HTML', 'を画像として受け取ってしまう') : ok('HTMLは断る');
  up({ dataBase64: 'A'.repeat(40 * 1024 * 1024) }).ok
    ? note('40MBの画像', 'を受け取ってしまう（保存先を食いつぶします）') : ok('大きすぎる画像は断る');
  up({ dataBase64: '' }).ok ? note('空の画像', 'を受け取ってしまう') : ok('空の画像は断る');
  admin('doAdminUpload_', { slot: 'logo', mimeType: 'image/jpeg', dataBase64: img }).out.ok
    ? note('合言葉なしの写真送信', '誰でも保存できる') : ok('合言葉なしでは写真を送れない');

  const odd = up({ slot: '../../etc/passwd' });
  /^[A-Za-z0-9_-]+-[\d-]+\.(jpg|png|webp)$/.test(String(odd.name || ''))
    ? ok(`用途名が変でも、保存名は無害になる（${odd.name}）`)
    : note('用途名', `そのまま保存名になる（${odd.name}）`);
}

/* ============================================================
   空き状況の応答

   この応答だけは、合言葉なしで誰でも受け取れます。そうしないと
   お客様の画面に空き時間を出せないためです。
   だからこそ、ここに人の名前や電話番号が1つでも混ざってはいけません。
   ここは毎回、必ず確かめます。
   ============================================================ */
console.log('\n【空き状況】誰でも受け取れる応答の中身');
{
  const sheet = makeSheet([row({
    お名前: '安田 健汰', フリガナ: 'ヤスダ ケンタ', 電話番号: "'08044987036",
    メール: 'kenta@example.com', ご要望: 'いつもの感じで', メニュー: 'メンズカット',
    来店日: day(10), 予約番号: 'LM-PRIV1'
  })]);
  const { out } = run('doAvailability_', sheet, undefined);
  const text = JSON.stringify(out);
  console.log('  返ってくる中身:', text);
  for (const [label, needle] of [['お名前', '安田'], ['フリガナ', 'ヤスダ'], ['電話番号', '08044987036'],
                                 ['メール', 'kenta@example.com'], ['ご要望', 'いつもの'],
                                 ['メニュー', 'メンズカット'], ['予約番号', 'LM-PRIV1']]) {
    text.includes(needle) ? note('空き状況に' + label, 'が入っている') : ok(label + 'は出ていない');
  }
  const b = (out.booked || [])[0] || {};
  (b.date && b.time && b.minutes) ? ok('埋まっている時間帯は分かる')
                                  : note('空き状況', '埋まっている時間が分からない');
}

console.log('\n' + '='.repeat(52));
if (found.length) {
  console.log(`断れていないもの ${found.length}件`);
  found.forEach(f => console.log('  ❌ ' + f));
  process.exitCode = 1;
} else {
  console.log('おかしな入力はすべて断られました');
}
