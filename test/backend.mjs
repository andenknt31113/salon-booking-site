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
const MENU_H   = ['区分', 'メニュー名', '価格', '所要(分)', '説明', '画像', '表示'];
const COUPON_H = ['メニュー名', '価格', '通常価格', '所要(分)', '説明', '条件', '対象', '画像', '表示'];
const STYLE_H  = ['タイトル', '分類', 'タグ', '説明', '画像', '表示'];

const HEAD = ['予約番号','受付日時','来店日','開始','終了','所要(分)','メニュー','担当','担当ID',
              '指名料','合計金額','お名前','フリガナ','電話番号','メール','来店回数','予約の入口','ご要望',
              '状態','カレンダーID'];
/* 「予約の入口」を足す前の台帳。すでに使っている店のシートはこの並びです */
const OLD_HEAD = HEAD.filter(h => h !== '予約の入口');

/* 本物の台帳と同じで、1行目は見出しです。
   店の人が列を足すこともあるので、見出しの並びを差し替えられるようにしてあります。 */
function makeSheet(rows = [], head = HEAD) {
  const data = rows.map(r => head.map(h => (r[h] !== undefined ? r[h] : '')));
  const all = () => [head.slice()].concat(data);       // 1行目＝見出し
  const sheet = {
    getLastRow: () => data.length + 1,
    getLastColumn: () => head.length,
    appendRow: r => data.push(r.slice()),
    getRange: (row, col, nr, nc) => ({
      getValues: () => all().slice(row - 1, row - 1 + (nr || 1))
        .map(r => r.slice(col - 1, col - 1 + (nc || r.length))),
      setValue: v => { if (data[row - 2]) data[row - 2][col - 1] = v; },
      setFontWeight: () => ({ setBackground: () => {} }),
      setFontLine: () => ({ setFontColor: () => {} }),
      setNote: () => {}, setValues: () => {}, clearContent: () => {}
    }),
    setFrozenRows: () => {}, setColumnWidth: () => {},
    getParent: () => ({ getSheetByName: () => null, insertSheet: () => sheet }),
    _head: head, _data: data,
    /* 見出しの名前で読み直す。列の並びが変わっても、試験のほうがずれません。 */
    at: (rowIndex, name) => data[rowIndex][head.indexOf(name)]
  };
  return sheet;
}

/* store を渡すと、その中身がスクリプトプロパティになります。
   「店として通す」試験では ADMIN_PASSWORD を入れて呼びます。 */
function run(fnName, sheet, payload, store = {}) {
  const mails = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    MailApp: { sendEmail: (to, s, b) => mails.push({ to, s, b }) },
    UrlFetchApp: { fetch: () => {} },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent: () => ({ getId: () => 'ev' }) }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = v; },
      deleteProperty: k => { delete store[k]; },
      getKeys: () => Object.keys(store) }) },
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
/* 当日の予約は「いまから4時間後」で試します。時刻を決め打ちにすると、
   その時刻を過ぎた時間帯に流したときだけ落ちる試験になります。 */
const nowMinJst = () => {
  const d = new Date(Date.now() + 9 * 3600e3);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/* 営業時間（09:00〜22:00・最終受付21:00）に収まる、いまから hours 後の枠 */
const slotIn = hours => {
  const m = Math.ceil((nowMinJst() + hours * 60) / 30) * 30;
  return (m >= 9 * 60 && m <= 21 * 60) ? hhmm(m) : null;
};

{
  const t = slotIn(4);
  if (t) {
    tryOne('当日の予約（4時間後）', base({ date: day(0), time: t, endTime: '', totalMinutes: 60 }),
      (o, row, m, l) => o.ok ? ok(l + 'は通る') : note(l, 'が断られる：' + o.error));
  } else {
    console.log('  － 当日の予約：いまの時刻では営業時間内に4時間後の枠が無いため、この項目は飛ばします');
  }
}
{
  /* 画面は2時間前で締めています。開きっぱなしの画面から送られてくる、
     直前すぎる予約を受け口も断るか。 */
  const t = slotIn(0.5);
  if (t) {
    tryOne('30分後の予約', base({ date: day(0), time: t, endTime: '', totalMinutes: 60 }),
      (o, row, m, l) => o.ok ? note(l, 'が通る（店は気づけないまま席を空けられません）') : ok(l + 'は断られる'));
  } else {
    console.log('  － 30分後の予約：いまの時刻では試せないため飛ばします');
  }
}
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

/* ============================================================
   店の人が台帳に列を足したら

   台帳は毎日開く場所です。「メモ」や「支払い」の列を足したくなるのは
   自然なことで、止める理由もありません。決め打ちの順番で読んでいると、
   そこから先が全部1つずれます。電話番号の欄からメールを読み、
   状態の欄から要望を読む台帳になり、画面には何も出ません。
   ============================================================ */
console.log('\n【台帳】店の人が列を足しても崩れないか');
{
  /* お名前の前に「メモ」、いちばん後ろに「支払い」を足した台帳 */
  const HEAD2 = HEAD.slice(0, HEAD.indexOf('お名前')).concat(['メモ'])
    .concat(HEAD.slice(HEAD.indexOf('お名前'))).concat(['支払い']);

  const sheet = makeSheet([], HEAD2);
  const at = day(9);
  const made = run('doReserve_', sheet, base({ date: at, time: '14:00', endTime: '15:00', totalMinutes: 60,
    customer: { name: '列 太郎', kana: 'レツ タロウ', tel: '09022223333', email: 'r@example.com', visit: '初めて' } })).out;
  made.ok ? ok('列を足した台帳にも予約できる') : note('列を足した台帳', 'に予約できない：' + made.error);

  String(sheet.at(0, 'お名前')) === '列 太郎'
    ? ok('お名前が「お名前」の列に入る') : note('お名前', `が別の列に入る（${JSON.stringify(sheet._data[0])}）`);
  String(sheet.at(0, '電話番号')).replace(/^'/, '') === '09022223333'
    ? ok('電話番号が「電話番号」の列に入る') : note('電話番号', `が別の列に入る（${sheet.at(0, '電話番号')}）`);
  String(sheet.at(0, '状態')) === '予約確定'
    ? ok('状態が「状態」の列に入る') : note('状態', `が別の列に入る（${sheet.at(0, '状態')}）`);
  String(sheet.at(0, 'メモ')) === '' && String(sheet.at(0, '支払い')) === ''
    ? ok('店の人が足した列は空のまま') : note('足した列', 'に別の値が入る');

  const code2 = made.code;
  run('doLookup_', sheet, { code: code2, tel: '09022223333' }).out.ok
    ? ok('列を足した台帳でも照会できる') : note('列を足した台帳', 'では照会できない');
  run('doLookup_', sheet, { code: code2, tel: '09099999999' }).out.ok
    ? note('列を足した台帳', 'では他人の電話番号でも見える') : ok('列を足しても、他人の電話番号では見えない');
  run('doReserve_', sheet, base({ date: at, time: '14:30', endTime: '15:30', totalMinutes: 60 })).out.ok
    ? note('列を足した台帳', 'では重なりを見落とす') : ok('列を足しても、重なりは見つけられる');
  run('doCancel_', sheet, { code: code2, tel: '09022223333' }).out.ok
    ? ok('列を足した台帳でもキャンセルできる') : note('列を足した台帳', 'ではキャンセルできない');
  String(sheet.at(0, '状態')) === 'キャンセル'
    ? ok('キャンセルが「状態」の列に書かれる') : note('キャンセル', 'が別の列に書かれる');
}

/* ============================================================
   届いたのに、返事だけが届かなかったとき

   電波の悪い場所では、送信は通ったのに応答だけ返らないことがあります。
   画面はそれを「失敗」と見て、もう一度同じ内容を送ります。
   同じ予約が2件立つと、店は2人ぶんの席を空けて待つことになります。
   ============================================================ */
console.log('\n【送り直し】同じ予約がもう一度届いたら');
{
  const at = day(13);
  const sheet = makeSheet();
  const payload = base({ date: at, time: '16:00', endTime: '17:00', totalMinutes: 60,
    customer: { name: '再送 太郎', kana: 'サイソウ タロウ', tel: '09044445555', email: 's@example.com', visit: '初めて' } });

  const first = run('doReserve_', sheet, payload).out;
  first.ok ? ok('1回目は通る') : note('1回目', 'が通らない：' + first.error);

  const again = run('doReserve_', sheet, payload).out;
  again.ok ? ok('送り直しも失敗にはしない（お客様には成功と見せる）')
           : note('送り直し', 'が失敗になる（お客様には理由が分かりません）');
  sheet._data.length === 1 ? ok('台帳は1件のまま') : note('送り直し', `で台帳が${sheet._data.length}件になる`);
  again.duplicate ? ok('同じ予約だと分かっている') : note('送り直し', 'が同じ予約だと分かっていない');

  /* 番号がたまたま他のお客様とぶつかった場合は、番号を振り直します */
  const other = run('doReserve_', sheet, base({ code: payload.code, date: at, time: '18:00', endTime: '19:00',
    totalMinutes: 60, customer: { name: '別人 花子', tel: '09066667777' } })).out;
  other.ok ? ok('番号がぶつかった別のお客様も予約できる') : note('番号のぶつかり', 'で予約できない：' + other.error);
  (other.code && other.code !== payload.code)
    ? ok(`番号を振り直して返す（${other.code}）`) : note('番号のぶつかり', 'で同じ番号のまま');
  sheet._data.length === 2 ? ok('台帳は2件になる') : note('台帳', `が${sheet._data.length}件`);
}

console.log('\n【日時変更】変更したら、元の時間は空くか');
{
  const from = day(14), to = day(16);
  const sheet = makeSheet([row({ 来店日: from, 開始: '10:00', 終了: '11:00', '所要(分)': 60, 予約番号: 'LM-MOVE1' })]);
  const moved = run('doChange_', sheet, { code: 'LM-MOVE1', tel: '09011112222', date: to, time: '14:00', minutes: 60 }).out;
  moved.ok ? ok('変更できる') : note('変更', 'できない：' + moved.error);

  run('doReserve_', sheet, base({ date: from, time: '10:00', endTime: '11:00', totalMinutes: 60 })).out.ok
    ? ok('元の時間は空きに戻る') : note('元の時間', 'が空かない（誰も取れない時間が残ります）');
  run('doReserve_', sheet, base({ date: to, time: '14:00', endTime: '15:00', totalMinutes: 60 })).out.ok
    ? note('変更先', 'が空いたままになっている（二重予約になります）') : ok('変更先は埋まっている');
}

/* ============================================================
   受付期限は、お客様の締め切り

   「今日は行けなくなりました」という当日の電話が、いちばん多いキャンセルです。
   ここで店まで断っていると、その予約は台帳に残ったままになり、
   空いたはずの枠がネット予約からも埋まりません。
   ============================================================ */
console.log('\n【受付期限】店は、当日でもキャンセル・変更できるか');
{
  const today = day(0);
  const late = () => makeSheet([row({ 来店日: today, 開始: '21:00', 終了: '21:30', '所要(分)': 30,
    予約番号: 'LM-TODAY1' })]);

  run('doCancel_', late(), { code: 'LM-TODAY1', tel: '09011112222' }).out.deadline
    ? ok('お客様は、当日になったらネットでキャンセルできない') : note('受付期限', 'がお客様に効いていない');

  const shopPw = { ADMIN_PASSWORD: 'himitsu' };
  const byShop = run('doCancel_', late(), { code: 'LM-TODAY1', password: 'himitsu' }, shopPw).out;
  byShop.ok ? ok('店は、当日の電話でのキャンセルを台帳に反映できる')
            : note('当日のキャンセル', `を店も断られる（${byShop.error}）→ 空いた枠が埋まりません`);

  const moved = run('doChange_', late(), { code: 'LM-TODAY1', password: 'himitsu',
    date: today, time: '19:00', minutes: 30 }, shopPw).out;
  moved.ok ? ok('店は、当日の「時間をずらして」にも応えられる')
           : note('当日の時間変更', `を店も断られる（${moved.error}）`);

  /* 合言葉が違えば、もちろん店として扱いません */
  const fake = run('doCancel_', late(), { code: 'LM-TODAY1', password: 'chigau' }, shopPw).out;
  fake.ok ? note('でたらめな合言葉', 'でも店として通ってしまう') : ok('でたらめな合言葉では店として通らない');
}

console.log('\n【口コミ】キャンセルした予約からは書けない');
{
  const past = row({ 来店日: day(-3), 予約番号: 'LM-RVX01', 状態: 'キャンセル' });
  run('doReview_', makeSheet([past]), { code: 'LM-RVX01', tel: '09011112222', body: '来ていませんが', score: 1 }).out.ok
    ? note('口コミ', 'キャンセルした予約からも書ける') : ok('キャンセルした予約からは書けない');
}

/* ============================================================
   店が台帳に手で「キャンセル」と書いたとき

   電話で受けたキャンセルを、管理ページではなく台帳に直接書くことがあります。
   そのときの書き方は人それぞれです。決め打ちの一致だけを見ていると、
   書き方が少し違うだけで「まだ生きている予約」のままになり、
   その時間が空きに戻りません。お客様には、なぜか取れない時間に見えます。
   ============================================================ */
console.log('\n【台帳】手で書いたキャンセルを読めるか');
{
  const at = day(18);
  const freeAgain = state => {
    const sheet = makeSheet([row({ 来店日: at, 開始: '11:00', 終了: '12:00', '所要(分)': 60,
      予約番号: 'LM-CXL01', 状態: state })]);
    return run('doReserve_', sheet, base({ date: at, time: '11:00', endTime: '12:00', totalMinutes: 60 })).out.ok;
  };
  for (const w of ['キャンセル', 'キャンセル済', 'キャンセル済み', '取消', '取り消し', '中止',
                   ' キャンセル ', 'ｷｬﾝｾﾙ']) {
    freeAgain(w) ? ok(`「${w}」と書けば、その時間は空きに戻る`)
                 : note(`「${w}」`, 'と書いても、その時間が空かない（誰も取れません）');
  }
  /* 生きている予約まで空き扱いにしてはいけません */
  freeAgain('予約確定') ? note('「予約確定」', 'の予約が空き扱いになる（二重予約になります）')
                       : ok('「予約確定」はもちろん空かない');
  freeAgain('キャンセル待ち') ? note('「キャンセル待ち」', 'を空き扱いにしている')
                             : ok('「キャンセル待ち」は空き扱いにしない');

  /* 画面には、揃った形で渡します */
  const sheet = makeSheet([row({ 来店日: at, 予約番号: 'LM-CXL02', 状態: '取消' })]);
  const looked = run('doLookup_', sheet, { code: 'LM-CXL02', tel: '09011112222' }).out;
  (looked.reservation || {}).status === 'キャンセル'
    ? ok('画面には「キャンセル」として渡す') : note('画面に渡す状態', `が「${(looked.reservation||{}).status}」のまま`);
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

/* ============================================================
   設定シートの営業時間

   空いたセルに 20:00 と打つと、Googleはそれを「時刻」として覚えます。
   見た目は 20:00 のままですが、中身は日付つきの値です。
   読めないと営業時間の設定が黙って既定の22時に戻り、
   閉めたはずの時間に予約が入ります。
   ============================================================ */
console.log('\n【設定】営業終了を 20:00 にしたつもり');
{
  const closeOf = cell => {
    const out = readSheets({ '設定': [['営業開始', '09:00'], ['営業終了', cell]] }, 'readSettings_');
    return out && out['営業終了'];
  };
  const cases = [
    ['文字で「20:00」', '20:00'],
    /* 時刻型のセル。本物のシートの時刻は日本時間なので、9時間ずらして作ります。 */
    ['時刻として入力（セルが時刻型）', dateCell(Date.UTC(1899, 11, 30, 20 - 9, 0))],
    ['「20時」', '20時'],
    ['全角「２０：００」', '２０：００'],
    ['「20:00〜」', '20:00〜']
  ];
  for (const [label, cell] of cases) {
    const v = closeOf(cell);
    v === '20:00' ? ok(`${label} → 20:00 として読める`)
                  : note(`営業終了 ${label}`, `が「${v}」になる → 閉めたはずの時間に予約が入ります`);
  }
  const blank = readSheets({ '設定': [['営業終了', '']] }, 'readSettings_');
  blank['営業終了'] === '' ? ok('空欄はそのまま空欄（掲載中の営業時間を使う）') : note('空欄', 'が空欄でなくなる');
  const junk = readSheets({ '設定': [['営業終了', 'あとで決める']] }, 'readSettings_');
  junk['営業終了'] === 'あとで決める' ? ok('読めない文字はそのまま返す（画面側が既定値に戻す）')
                                    : note('読めない文字', `が「${junk['営業終了']}」に化ける`);
}

console.log('\n【設定】早く閉める日を設定したら、受け口も従うか');
{
  /* 設定シートで営業終了を20時にしたのに、受け口が22時まで受け続けると、
     画面には出ない時間の予約が入ります。店は気づけません。 */
  const withHours = (close, payload) => {
    const ctx = {
      console: { log() {}, warn() {}, error() {} },
      MailApp: { sendEmail() {} }, UrlFetchApp: { fetch() {} },
      CalendarApp: { getDefaultCalendar: () => ({ createEvent: () => ({ getId: () => 'ev' }) }) },
      PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
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
    const settingRows = [['営業開始', '09:00'], ['営業終了', close]];
    const setting = {
      getLastRow: () => settingRows.length + 1, getLastColumn: () => 2,
      getRange: (r, c, nr, nc) => ({ getValues: () => (r === 1 ? [['項目', '内容']]
        : settingRows.slice(r - 2, r - 2 + (nr || 1)).map(x => x.slice(c - 1, c - 1 + (nc || 2)))) })
    };
    const ledger = makeSheet();
    const ss = { getSheetByName: n => (n === '設定' ? setting : null), insertSheet: () => null };
    ledger.getParent = () => ss;
    ctx.SpreadsheetApp = { getActiveSpreadsheet: () => ss, getUi: () => { throw new Error('no ui'); } };
    vm.createContext(ctx);
    vm.runInContext(src + ';globalThis.__h = doReserve_;', ctx);
    try { return ctx.__h(ledger, payload); } catch (e) { return { ok: false, threw: String(e && e.message) }; }
  };
  const at = day(11);
  withHours('20:00', base({ date: at, time: '21:00', endTime: '22:00', totalMinutes: 60 })).ok
    ? note('早く閉める設定', 'をしても、受け口は22時まで受ける') : ok('20時で閉めると、21時の予約は断られる');
  withHours('20:00', base({ date: at, time: '19:00', endTime: '20:00', totalMinutes: 60 })).ok
    ? ok('20時ちょうどに終わる予約は通る') : note('20時に終わる予約', 'まで断られる');
  withHours('20:00', base({ date: at, time: '19:30', endTime: '20:30', totalMinutes: 60 })).ok
    ? note('閉店をまたぐ予約', 'が通ってしまう') : ok('閉店をまたぐ予約は断られる');
}

console.log('\n【設定】最終受付と定休曜日を、受け口も見ているか');
{
  /* お客様の画面は、最終受付までしか枠を出しませんし、定休曜日は出しません。
     設定を変える前に開いていた画面からは、その時間もまだ送られてきます。
     受け口が見ていないと、締めたはずの時間に予約が入ります。 */
  const withSettings = (rows, fn, payload) => {
    const ctx = {
      console: { log() {}, warn() {}, error() {} },
      MailApp: { sendEmail() {} }, UrlFetchApp: { fetch() {} },
      CalendarApp: { getDefaultCalendar: () => ({ createEvent: () => ({ getId: () => 'ev' }) }) },
      PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
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
    const setting = {
      getLastRow: () => rows.length + 1, getLastColumn: () => 2,
      getRange: (r, c, nr, nc) => ({ getValues: () => (r === 1 ? [['項目', '内容']]
        : rows.slice(r - 2, r - 2 + (nr || 1)).map(x => x.slice(c - 1, c - 1 + (nc || 2)))) })
    };
    const ledger = makeSheet();
    const ss = { getSheetByName: n => (n === '設定' ? setting : null), insertSheet: () => null };
    ledger.getParent = () => ss;
    ctx.SpreadsheetApp = { getActiveSpreadsheet: () => ss, getUi: () => { throw new Error('no ui'); } };
    vm.createContext(ctx);
    vm.runInContext(src + `;globalThis.__g = ${fn};`, ctx);
    try { return ctx.__g(ledger, payload); } catch (e) { return { ok: false, threw: String(e && e.message) }; }
  };

  const hours = [['営業開始', '09:00'], ['営業終了', '22:00'], ['最終受付', '21:00']];
  const at = day(17);
  withSettings(hours, 'doReserve_', base({ date: at, time: '21:30', endTime: '22:00', totalMinutes: 30 })).ok
    ? note('最終受付', 'を過ぎた時間でも受け付ける（締めたはずの時間に予約が入ります）')
    : ok('最終受付（21:00）を過ぎた時間は断られる');
  withSettings(hours, 'doReserve_', base({ date: at, time: '21:00', endTime: '21:30', totalMinutes: 30 })).ok
    ? ok('最終受付ちょうどは通る') : note('最終受付ちょうど', 'まで断られる');

  /* 定休曜日。日曜を休みにして、次の日曜と月曜で試します。 */
  const sunday = (() => { let n = 1; while (new Date(Date.UTC(...day(n).split('-').map((v, i) => i === 1 ? +v - 1 : +v), 12)).getUTCDay() !== 0) n++; return day(n); })();
  const monday = (() => { const p = sunday.split('-').map(Number); const d2 = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1, 12));
    const q = n => String(n).padStart(2, '0');
    return `${d2.getUTCFullYear()}-${q(d2.getUTCMonth() + 1)}-${q(d2.getUTCDate())}`; })();
  const closedSun = hours.concat([['定休曜日', '日']]);

  withSettings(closedSun, 'doReserve_', base({ date: sunday, time: '10:00', endTime: '11:00', totalMinutes: 60 })).ok
    ? note('定休曜日', `の予約を受け付ける（${sunday}）`) : ok(`定休曜日（日）の予約は断られる（${sunday}）`);
  withSettings(closedSun, 'doReserve_', base({ date: monday, time: '10:00', endTime: '11:00', totalMinutes: 60 })).ok
    ? ok(`定休日以外は通る（${monday}）`) : note('定休日以外', `まで断られる（${monday}）`);
  withSettings(hours.concat([['定休曜日', '日曜・水曜']]), 'doReserve_',
    base({ date: sunday, time: '10:00', endTime: '11:00', totalMinutes: 60 })).ok
    ? note('定休曜日「日曜・水曜」', 'の書き方を読めていない') : ok('「日曜・水曜」の書き方でも読める');
  withSettings(hours.concat([['定休曜日', '']]), 'doReserve_',
    base({ date: sunday, time: '10:00', endTime: '11:00', totalMinutes: 60 })).ok
    ? ok('定休曜日が空欄なら、どの曜日も受ける') : note('定休曜日が空欄', 'なのに断られる');
}

console.log('\n【休業日シート】時刻セルで書かれた「受けない時間帯」');
{
  /* 管理ページは、ここで返した値をそのまま時刻欄に入れます。
     日付つきの値のままだと欄が空になり、入れたはずの帯が消えて見えます。 */
  const rows = readSheets({ '休業日': [
    ['2026-09-01', dateCell(Date.UTC(2026, 8, 1, 14 - 9, 0)), dateCell(Date.UTC(2026, 8, 1, 16 - 9, 0)), '外部の仕事']
  ] }, "ss => readSheetRows_(ss, '休業日', CLOSED_HEADERS)");
  const r0 = (rows || [])[0] || {};
  r0['開始'] === '14:00' && r0['終了'] === '16:00'
    ? ok('時刻セルでも 14:00〜16:00 として管理ページに渡る')
    : note('受けない時間帯', `が「${r0['開始']}〜${r0['終了']}」として渡る → 店の画面では空欄になります`);
  r0['メモ'] === '外部の仕事' ? ok('メモはそのまま渡る') : note('メモ', 'が消える');
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
      /* 別の端末から保存されていないかを見る「印」を作るのに使います
         （Code.gs の sheetStamp_）。無いと、管理ページの読み込みごと落ちます。 */
      getDataRange: () => ({ getValues: () => d }),
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
/* シートの中身は、配列そのままなら「見出しの無いシート」、
   { head: [...], rows: [...] } なら「1行目が見出しのシート」として作ります。 */
function shop(sheetsInit = {}) {
  const store = { ADMIN_PASSWORD: 'himitsu' };
  const sheets = {};
  const mk = (name, init = []) => {
    let head = Array.isArray(init) ? null : (init.head || null);
    const rows = Array.isArray(init) ? init : (init.rows || []);
    const data = rows.map(r => r.slice());
    return {
      getName: () => name,
      /* 作りたてのシート（見出しも中身も無い）は 0 を返します。
         本物もそうで、受け口はこの 0 を見て見出しを書きます。
         1 を返していたころは、見出しを書く道が試験から消えていました。 */
      getLastRow: () => ((head || data.length) ? data.length + 1 : 0),
      getLastColumn: () => (head || data[0] || []).length,
      /* 空のシートへの1行目は見出しです（本物もそうです）。
         中身の行として積むと、以降が1行ずつずれます。 */
      appendRow: r => { if (!head && !data.length) head = r.slice(); else data.push(r); },
      /* 本物の setValues は、そのまま .setFontWeight(…) と続けて書ける
         Range を返します。undefined を返していると、書式まで指定している
         本番の書き方（ensureHeaders_）が、ここでだけ落ちます。 */
      getRange: (rw, c, nr, nc) => {
        const range = {
        /* 本物のシートは、1行目が空でも「空の行」を返します。
           ここで [] を返すと、本番では起きない失敗になります。 */
        getValues: () => (rw === 1
          ? [(head || Array(nc || 1).fill('')).slice(c - 1, c - 1 + (nc || (head || []).length || 1))]
          : data.slice(rw - 2, rw - 2 + (nr || 1)).map(x => x.slice(c - 1, c - 1 + (nc || x.length)))),
        /* 本物のシートと同じで、指定した範囲だけ書き換えます。
           行まるごと差し替える作りにしていると、列ごとの書き込みで
           他の列が消え、本番では起きない失敗になります。 */
        setValues: v => {
          /* 1行目は見出しです。本物のシートと同じで、右端に足せるようにします
             （ensureHeaders_ が、あとから増えた列をここに書きます）。
             ここを行の書き込みと同じ扱いにしていると、見出しを足す動きが
             試験に出ず、本番だけ「記録したはずの欄が無い」になります。 */
          if (rw === 1) {
            if (!head) head = [];
            (v[0] || []).forEach((val, j) => { head[c - 1 + j] = val; });
            return range;
          }
          v.forEach((r, i) => {
            const target = data[rw - 2 + i] || (data[rw - 2 + i] = []);
            r.forEach((val, j) => { target[c - 1 + j] = val; });
          });
          return range;
        },
        setValue() {},
        clearContent: () => {
          for (let i = 0; i < (nr || 1); i++) {
            const target = data[rw - 2 + i];
            if (target) for (let j = 0; j < (nc || 1); j++) target[c - 1 + j] = '';
          }
        },
        setFontWeight: () => ({ setBackground: () => {} }), setNote() {},
        setFontLine: () => ({ setFontColor: () => {} })
        };
        return range;
      },
      getDataRange: () => ({ getValues: () => (head ? [head.slice()] : []).concat(data.map(r => r.slice())) }),
      setFrozenRows() {}, setColumnWidth() {}, clear() {}, deleteRows() {}, _data: data,
      // 見出しがどう変わったかを、試験から見るため
      _head: () => (head ? head.slice() : [])
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
    },
    /* 台帳を第1引数に取る入口（doCancel_ など）用。
       この店の予約一覧シートを、本番と同じ getSheet_ で渡します。 */
    callOnLedger: (fn, payload) => {
      vm.runInContext(`globalThis.__w = d => ${fn}(getSheet_(), d);`, ctx);
      try { return ctx.__w(payload); } catch (e) { return { ok: false, threw: String(e && e.message) }; }
    },
    sheets
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

console.log('\n【メニュー表】店の人が自分用の列を足していたら');
{
  /* メニュー表に「原価」を足して使っている、という状況です。
     こちらが知らない列なので、読むときは無視し、保存のときも触りません。
     保存のたびに消えるようでは、その列は使えません。 */
  const HEAD3 = ['区分', '原価', 'メニュー名', '価格', '所要(分)', '説明', '画像', '表示'];
  const w = shop({ 'メニュー': { head: HEAD3, rows: [
    ['カット', 1200, 'メンズカット', '4,000〜', 50, '', '', '○'],
    ['スパ', 500, '炭酸スパ', 3000, 30, '', '', '○']
  ] } });

  const read = w.call('doAdminData_', { password: 'himitsu' });
  const menus = read.menus || [];
  (menus[0] && menus[0]['メニュー名'] === 'メンズカット')
    ? ok('列を足しても、メニュー名を正しく読む')
    : note('メニュー名', `を読み違える（${JSON.stringify(menus[0])}）`);
  (menus[0] && String(menus[0]['価格']) === '4,000〜')
    ? ok('列を足しても、価格を正しく読む') : note('価格', `を読み違える（${menus[0] && menus[0]['価格']}）`);

  w.call('doAdminSave_', { password: 'himitsu', target: 'menus', stamp: read.stamps.menus, rows: [
    { 区分: 'カット', メニュー名: 'メンズカット', 価格: 4500, '所要(分)': 50, 説明: '', 画像: '', 表示: '○' }
  ]});
  const after = w.sheets['メニュー']._data;
  String(after[0][HEAD3.indexOf('価格')]) === '4500'
    ? ok('保存した価格が「価格」の列に入る') : note('保存した価格', `が別の列に入る（${JSON.stringify(after[1])}）`);
  String(after[0][HEAD3.indexOf('原価')]) === '1200'
    ? ok('店の人が足した「原価」は消えない') : note('原価', `が消える（${JSON.stringify(after[0])}）`);
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

  /* 消したあとは、行そのものが残っていても中身が空であればかまいません
     （本物のシートも、消すと空の行が残ります）。読み出す側から
     見えなくなっていることを確かめます。 */
  saveReviews([]);
  const left = w.call('doAdminData_', { password: 'himitsu' }).reviews || [];
  left.length === 0 ? ok('要らない口コミは消せる') : note('口コミ', `が消せない（${left.length}件残る）`);
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
    来店日: day(10), 予約番号: 'LM-PRIV1', '予約の入口': 'LINE'
  })]);
  const { out } = run('doAvailability_', sheet, undefined);
  const text = JSON.stringify(out);
  console.log('  返ってくる中身:', text);
  for (const [label, needle] of [['お名前', '安田'], ['フリガナ', 'ヤスダ'], ['電話番号', '08044987036'],
                                 ['メール', 'kenta@example.com'], ['ご要望', 'いつもの'],
                                 ['メニュー', 'メンズカット'], ['予約番号', 'LM-PRIV1'],
                                 /* 入口は店の判断のための記録です。誰でも受け取れる応答に
                                    載せる理由がありません（載せると、どのお客様がどこから
                                    来たかが外から並べられます）。 */
                                 ['予約の入口', 'LINE']]) {
    text.includes(needle) ? note('空き状況に' + label, 'が入っている') : ok(label + 'は出ていない');
  }
  const b = (out.booked || [])[0] || {};
  (b.date && b.time && b.minutes) ? ok('埋まっている時間帯は分かる')
                                  : note('空き状況', '埋まっている時間が分からない');
}

/* ============================================================
   予約の入口

   台帳に「どこから来ていただいたか」の列を1つ足しました。
   掲載を止めてよいかは、この列が無いと決められません。

   ここで見るのは3つです。
     ・印の付いた予約が、その列に入るか
     ・知らない言葉を送られたときに、台帳へ書かずに済むか
     ・印が無くても、予約そのものは今までどおり通るか
   3つめがいちばん大事です。入口を取るために予約が1件でも
   通らなくなるなら、この仕組み自体をやめたほうがましです。
   ============================================================ */
console.log('\n【予約の入口】台帳に記録されるか');
{
  const at = (label, payload, want) => {
    const sheet = makeSheet();
    const { out } = run('doReserve_', sheet, payload);
    if (!out.ok) { note(label, '予約が断られた：' + out.error); return; }
    const got = String(sheet.at(0, '予約の入口') || '');
    const show = w => (w === '' ? '（空欄）' : w);
    got === want ? ok(`${label} → 台帳に ${show(want)}`)
                 : note(label, `台帳が「${got}」（期待 ${show(want)}）`);
  };
  at('LINEの印を付けた予約', base({ source: 'LINE' }), 'LINE');
  at('地図の印を付けた予約', base({ source: 'Googleマップ' }), 'Googleマップ');
  at('名刺のQRから来た予約', base({ source: '名刺・店内QR' }), '名刺・店内QR');
  at('参照元から言い当てた予約', base({ source: '検索' }), '検索');
  /* 印が無い予約が通らなくなるのが、いちばんまずい壊れ方です */
  at('印が無い予約', base({}), '');
  at('印が空の予約', base({ source: '' }), '');
  /* この受け口は公開されています。一覧に無い言葉を素通しにすると、
     台帳に好きな文字を書き込める欄になります。 */
  at('一覧に無い言葉', base({ source: 'すきな文字' }), '');
  at('数式に見える文字', base({ source: '=IMPORTXML(1,2)' }), '');
  at('長すぎる文字', base({ source: 'あ'.repeat(500) }), '');
  at('文字ですらないもの', base({ source: { a: 1 } }), '');
}

console.log('\n【予約の入口】電話・来店で受けた分と区別できるか');
{
  const w = shop({ '予約一覧': { head: HEAD.slice(), rows: [] },
                   '設定': { head: ['項目', '内容'], rows: [] } });
  const res = w.callOnLedger('doAdminAdd_', { password: 'himitsu', force: true,
    date: day(9), time: '10:00', minutes: 60, price: 4000,
    name: '電話 太郎', tel: '09000000000', menu: 'カット' });
  res.ok ? ok('電話で受けた予約を台帳に入れられる')
         : note('電話予約', 'が入らない：' + (res.error || res.threw));

  const rowOne = w.sheets['予約一覧']._data[0] || [];
  String(rowOne[HEAD.indexOf('予約の入口')] || '') === '電話・来店'
    ? ok('電話で受けた分は「電話・来店」として残る')
    : note('電話予約の入口', `が「${rowOne[HEAD.indexOf('予約の入口')]}」`);

  const seen = (w.call('doAdminData_', { password: 'himitsu' }).reservations || [])[0] || {};
  seen.source === '電話・来店'
    ? ok('管理ページにも「電話・来店」として渡る')
    : note('管理ページに渡る入口', `が「${seen.source}」（サイト経由と混ざります）`);
}

/* ============================================================
   すでに使っている台帳に、あとから列を足す

   この列は、店が使い始めたあとで増えたものです。つまり本番の台帳には
   見出しがありません。見出しの無い列には書けないので、そのままでは
   「記録したつもりで、どこにも残らない」状態になります。

   足すときに壊してよいものは1つもありません。店の人が自分で足した列も、
   すでに入っている予約の値も、位置ごと動かさずに済ませます。
   ============================================================ */
console.log('\n【予約の入口】列が無い台帳に、あとから足す');
{
  // 店の人が自分で「メモ」の列を足して使っている台帳です
  const OLD = OLD_HEAD.concat(['メモ']);
  const before = ['LM-OLD01', '2026/08/01 10:00', day(20), '10:00', '11:00', 60,
    'カット', 'MATTEO', 'st01', 0, 4000, '常連 一郎', 'ジョウレン', "'09011112222",
    'a@b.co', '2回目以降', 'いつもの長さで', '予約確定', 'ev1', '駐車場のうしろ'];
  const w = shop({ '予約一覧': { head: OLD.slice(), rows: [before.slice()] },
                   '設定': { head: ['項目', '内容'], rows: [] } });

  const sent = w.callOnLedger('doReserve_', base({ source: 'LINE', date: day(21) }));
  sent.ok ? ok('列が無い台帳でも、予約はそのまま通る')
          : note('列が無い台帳', 'で予約が断られる：' + (sent.error || sent.threw));

  const head = w.sheets['予約一覧']._head();
  head[OLD.length] === '予約の入口'
    ? ok('見出しは右端に足される（空の列を挟まない）')
    : note('足した見出し', `の場所が違う（${JSON.stringify(head.slice(OLD.length - 1))}）`);
  head.slice(0, OLD.length).join('|') === OLD.join('|')
    ? ok('もとの見出しは動かない（店の人が足した「メモ」も残る）')
    : note('もとの見出し', 'が動いた：' + head.slice(0, OLD.length).join('|'));

  const kept = w.sheets['予約一覧']._data[0] || [];
  kept.slice(0, OLD.length).join('|') === before.join('|')
    ? ok('足す前からあった予約の値は、1つも変わらない')
    : note('もとの行', 'が壊れた：' + JSON.stringify(kept));

  const added = w.sheets['予約一覧']._data[1] || [];
  String(added[head.indexOf('予約の入口')] || '') === 'LINE'
    ? ok('足したあとの予約は、その列に入る')
    : note('足した列', `に入らない（${JSON.stringify(added)}）`);
  String(added[head.indexOf('ご要望')] || '') === ''
    && String(added[head.indexOf('お名前')] || '') === 'テスト'
    ? ok('ほかの欄も、ずれずにそれぞれの列へ入る')
    : note('ほかの欄', `がずれた（${JSON.stringify(added)}）`);

  w.callOnLedger('doReserve_', base({ source: 'LINE', date: day(22) }));
  w.sheets['予約一覧']._head().filter(h => h === '予約の入口').length === 1
    ? ok('予約が入るたびに、同じ列が増えることはない')
    : note('見出し', '予約のたびに増えていく');

  const read = (w.call('doAdminData_', { password: 'himitsu' }).reservations || []);
  (read.find(r => r.code === 'LM-OLD01') || {}).source === ''
    ? ok('列を足す前の予約は、空のまま（あとから作らない）')
    : note('列を足す前の予約', 'に入口が入っている（実績ではありません）');
}

/* ============================================================
   設定シートに項目を足したとき

   店主が触れる項目を増やすたびに、設定シートの行が増えます。
   ところが、すでにシートを作ってある店では、増えた行がありません。
   足りないまま管理ページを開かせると、管理ページは画面にある項目を
   まとめて保存するので、シートに無い項目まで空欄として書き込まれ、
   触ってもいない住所や支払い方法がサイトから消えます。
   店の人には、勝手に消えたようにしか見えません。
   ============================================================ */
console.log('\n【設定シート】あとから項目を足したとき');
{
  /* 古い設定シート。当時あった3項目だけが入っています。
     電話番号は店主が自分で書き換えてあります。 */
  const w = shop({ '設定': { head: ['項目', '内容'], rows: [
    ['電話番号', '0297-00-0000'],
    ['営業開始', '10:00'],
    ['営業終了', '20:00']
  ] } });

  const read = w.call('doAdminData_', { password: 'himitsu' });
  const st = read.settings || {};

  st['電話番号'] === '0297-00-0000'
    ? ok('もとからあった行は、店主が書いた値のまま')
    : note('もとからあった行', `が書き換わる（${st['電話番号']}）`);
  st['営業開始'] === '10:00'
    ? ok('営業開始も書き換わらない') : note('営業開始', `が書き換わる（${st['営業開始']}）`);

  st['住所'] ? ok('足りない項目が足される（住所）') : note('住所', 'の行が足されない');
  st['支払い方法'] ? ok('足りない項目が足される（支払い方法）') : note('支払い方法', 'の行が足されない');
  /* 空で足してはいけません。足した直後の保存で、そのまま消えます。 */
  String(st['住所'] || '').includes('龍ケ崎')
    ? ok('足した項目には、いま掲載している内容が入っている')
    : note('足した項目', `が空のまま（${JSON.stringify(st['住所'])}）`);
  st['事業者名'] === ''
    ? ok('もともと空の項目（事業者名）は、空のまま足される')
    : note('事業者名', `に何か入っている（${JSON.stringify(st['事業者名'])}）`);

  /* 店主が電話番号だけ直して保存した、という場面です。 */
  const saved = w.call('doAdminSave_', { password: 'himitsu', target: 'settings',
    stamp: read.stamps.settings, rows: Object.assign({}, st, { '電話番号': '080-1111-2222' }) });
  saved.ok ? ok('店舗情報を保存できる') : note('店舗情報の保存', `ができない（${saved.error || saved.threw}）`);

  const after = (w.call('doAdminData_', { password: 'himitsu' }).settings) || {};
  after['電話番号'] === '080-1111-2222'
    ? ok('直した電話番号が入っている') : note('電話番号', `が入らない（${after['電話番号']}）`);
  String(after['支払い方法'] || '').includes('現金')
    ? ok('触っていない支払い方法は消えていない')
    : note('触っていない支払い方法', `が消える（${JSON.stringify(after['支払い方法'])}）`);
  String(after['道案内'] || '').includes('ロイヤルヤエ')
    ? ok('触っていない道案内も消えていない')
    : note('触っていない道案内', 'が消える');

  /* 2度目に開いても、同じ行がもう1回足されないこと */
  const twice = (w.call('doAdminData_', { password: 'himitsu' }).settings) || {};
  Object.keys(twice).length === Object.keys(after).length
    ? ok('もう一度開いても、同じ項目が増えない')
    : note('設定シート', `を開くたびに項目が増える（${Object.keys(after).length}→${Object.keys(twice).length}）`);
}

console.log('\n【設定シート】受付期限を店主が変えたら、受け口も同じ期限で断る');
{
  /* 受付期限は設定シートが正です。ここを画面側だけの設定にすると、
     画面では「まだ変更できます」と出るのに、送ると断られます。 */
  const at = day(3);
  const guest = { code: 'LM-DDL01', tel: '09011112222' };
  const ledger = [['LM-DDL01', '', at, '10:00', '11:00', 60, 'カット', 'MATTEO', 'st01', 0, 4000,
    'テスト', 'テスト', "'09011112222", 'a@b.co', '初めて', '', '', '', '']];

  /* 前日18時まで（初期値）なら、3日後のご予約はまだ変更できます */
  const near = shop({ '予約一覧': { head: HEAD, rows: ledger.map(r => r.slice()) },
    '設定': { head: ['項目', '内容'], rows: [] } });
  near.callOnLedger('doCancel_', guest).ok
    ? ok('初期値（前日18時）なら、3日後のご予約はキャンセルできる')
    : note('初期値の期限', '3日後のご予約すらキャンセルできない');

  /* 店主が「7日前まで」に変えたら、3日後のご予約はもう受け付けません */
  const far = shop({ '予約一覧': { head: HEAD, rows: ledger.map(r => r.slice()) },
    '設定': { head: ['項目', '内容'], rows: [
      ['変更・キャンセル期限（何日前）', 7], ['変更・キャンセル期限（何時）', 18]] } });
  const res = far.callOnLedger('doCancel_', guest);
  res.ok
    ? note('シートで変えた期限', 'を受け口が見ていない（画面だけ変わります）')
    : ok('シートで変えた期限を、受け口も見ている');
  String(res.error || '').includes('7日前の18時')
    ? ok('断る文にも、シートで変えた期限が出る')
    : note('断る文', `が古い期限のまま（${res.error}）`);
}

/* ============================================================
   シートを掲載内容に入れ替えるとき、写真が消えないか

   これは一度きりの、シートを消して書き直す操作です。店主が実行します。
   ここで写真が飛ぶと、1枚ずつ選び直すことになります。
   実際、既定の写真を用意した直後は「店主が入れた写真を既定で上書きする」
   状態になっていました（引き継ぎ機能の目的そのものを壊していた）。
   ============================================================ */
console.log('\n【入れ替え】掲載内容に戻すとき、写真が消えないか');
{
  const UP = 'https://lh3.googleusercontent.com/d/AAA=w1200';   // 店主が管理ページから入れた写真
  const w = shop({
    'メニュー': { head: MENU_H, rows: [['カット', 'カットコース', 7000, 70, '', UP, '○']] },
    'おすすめメニュー': { head: COUPON_H, rows: [
      ['【地毛より綺麗】自然に柔らかく仕上げるメンズ縮毛矯正', 22000, '', 180, '前任の作文', '', '全員', UP, '○'],
      ['ヘアセット ※シャンプーブロー込み', 4000, '', 40, '', '', '全員', '', '○']] },
    'スタイル': { head: STYLE_H, rows: [['白髪ぼかし・ホワイトメッシュ', 'カラー', '', '', '', '○']] },
    '設定': { head: ['項目', '内容'], rows: [] }
  });
  w.call('メニューを掲載内容に入れ替える', {});

  const imgOf = (sheetName, head, name, key) => {
    const rows = w.sheets[sheetName]._data;
    const r = rows.find(x => String(x[head.indexOf(key)]).trim() === name);
    return r ? String(r[head.indexOf('画像')] || '').trim() : '(行が無い)';
  };

  // 掲載の12件が入り、写真も一緒に入る（空だとサイトから写真が消えます）
  const styles = w.sheets['スタイル']._data;
  styles.length === 12
    ? ok('スタイルが掲載の12件になる')
    : note('スタイルの件数', `が ${styles.length} 件`);
  imgOf('スタイル', STYLE_H, 'ナチュラルセンターパート/曲がる縮毛矯正', 'タイトル') === 'assets/style1.jpg'
    ? ok('スタイルに写真の場所が入る')
    : note('スタイルの写真', `が ${imgOf('スタイル', STYLE_H, 'ナチュラルセンターパート/曲がる縮毛矯正', 'タイトル')}`);

  // 施術が一致するものには写真、合わないものは空のまま
  imgOf('おすすめメニュー', COUPON_H, '【毎朝のセット1分】品よく決まるお悩み解決メンズパーマ', 'メニュー名') === 'assets/skill2.jpg'
    ? ok('パーマのメニューにパーマの写真が入る')
    : note('パーマの写真', 'が入っていない');
  imgOf('おすすめメニュー', COUPON_H, '【髪のハリ.ツヤ.コシ全てのチャージ】髪質改善トリートメント', 'メニュー名') === ''
    ? ok('合う写真が無いものは空のまま')
    : note('合わない写真', 'を貼っている');

  /* ★ここが本題。店主が入れた写真は、こちらの既定より優先されます */
  imgOf('おすすめメニュー', COUPON_H, '【地毛より綺麗】自然に柔らかく仕上げるメンズ縮毛矯正', 'メニュー名') === UP
    ? ok('店主が入れた写真が、既定で上書きされない')
    : note('店主の写真', 'が既定の写真で消えた');
  imgOf('メニュー', MENU_H, 'カットコース', 'メニュー名') === UP
    ? ok('単品メニューでも店主の写真が残る')
    : note('単品メニューの店主の写真', 'が消えた');

  /* ★前にこちらが入れた既定（assets/…）は引き継がない。
     引き継ぐと、割り当てを直しても入れ替えのたびに古いものが生き残ります。
     実際、眉カットの欄に店のロゴが入ったまま残りました。 */
  const w2 = shop({
    'おすすめメニュー': { head: COUPON_H, rows: [
      ["【清潔感と品が続く】men's骨格補正カット＋眉カット", 6900, '', 70, '', '', '全員', '', 'assets/skill5.jpg', '○']] },
    'メニュー': { head: MENU_H, rows: [] },
    'スタイル': { head: STYLE_H, rows: [] },
    '設定': { head: ['項目', '内容'], rows: [] }
  });
  w2.call('メニューを掲載内容に入れ替える', {});
  const after = w2.sheets['おすすめメニュー']._data
    .find(x => String(x[0]).indexOf('骨格補正') >= 0);
  String(after && after[COUPON_H.indexOf('画像')] || '') === 'assets/style11.jpg'
    ? ok('前に入れた既定は、直した割り当てで置き換わる')
    : note('古い既定', `が生き残った（${after && after[COUPON_H.indexOf('画像')]}）`);

  // 前任が書いた説明文は消える（掲載に無い文なので）
  const cp = w.sheets['おすすめメニュー']._data
    .find(x => String(x[0]).indexOf('自然に柔らかく') >= 0);
  String(cp && cp[COUPON_H.indexOf('説明')] || '') === ''
    ? ok('掲載に無い説明文は消える')
    : note('掲載に無い説明文', 'が残っている');
}

console.log('\n' + '='.repeat(52));
if (found.length) {
  console.log(`断れていないもの ${found.length}件`);
  found.forEach(f => console.log('  ❌ ' + f));
  process.exitCode = 1;
} else {
  console.log('おかしな入力はすべて断られました');
}
