/**
 * ZER01 barber/lounge 予約サイト 受信スクリプト（Google Apps Script）
 *
 * このスプレッドシートが、サロンボードにあたる管理画面になります。
 *   ・予約一覧  … 入った予約が1行ずつ溜まります
 *   ・メニュー  … 行を足すとサイトのメニューが増えます
 *   ・クーポン  … 同上
 *
 * 予約が入ると、店舗へのメール通知・お客様への確認メール・
 * Googleカレンダーへの登録（任意）が同時に行われます。
 *
 * 設置手順は README.md を参照してください。
 */

/* ============================================================
   設定：ここだけ書き換えてください
   ============================================================ */
const SHEET_NAME    = '予約一覧';
const MENU_SHEET    = 'メニュー';
const COUPON_SHEET  = 'クーポン';

const NOTIFY_EMAIL  = 'salon@example.com';       // 店舗の通知先メール（空にすると通知しません）
const SALON_NAME    = 'ZER01 barber/lounge';
const SALON_TEL     = '';                        // ★要確認（未確認のうちは空のまま）
const SALON_ADDRESS = '茨城県龍ケ崎市中根台1丁目1-1 ロイヤルヤエ 002';
const SITE_URL      = 'https://andenknt31113.github.io/salon-booking-site/';

/* お客様へ予約確認メールを送るか（false にすると店舗への通知のみ） */
const MAIL_TO_CUSTOMER = true;

/* 予約をGoogleカレンダーにも入れる場合はカレンダーIDを設定。
   自分のメインカレンダーに入れるなら 'primary'。
   空にすると連携しません。
   予約用のカレンダーを分けたい場合は、Googleカレンダーで新しいカレンダーを作り、
   設定画面の「カレンダーの統合」にあるカレンダーIDを貼ってください。 */
const CALENDAR_ID = '';

/* ============================================================
   シートの列（順番を変えるとスクリプトも直す必要があります）
   ============================================================ */
const HEADERS = [
  '予約番号', '受付日時', '来店日', '開始', '終了', '所要(分)',
  'メニュー', '担当', '担当ID', '指名料', '合計金額',
  'お名前', 'フリガナ', '電話番号', 'メール', '来店回数', 'ご要望',
  '状態', 'カレンダーID'
];

const MENU_HEADERS   = ['区分', 'メニュー名', '価格', '所要(分)', '説明', '表示'];
const COUPON_HEADERS = ['クーポン名', '価格', '通常価格', '所要(分)', '説明', '条件', '対象', '表示'];

/* ============================================================
   受信の入口
   ============================================================ */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // 同時に予約が来ても行が壊れないよう順番待ちさせる
    lock.waitLock(20000);

    const data = JSON.parse(e.postData.contents);

    if (data.type === 'menu')         return json_(doMenu_());
    if (data.type === 'availability') return json_(doAvailability_(getSheet_()));
    if (data.type === 'lookup')       return json_(doLookup_(getSheet_(), data));
    if (data.type === 'cancel')       return json_(doCancel_(getSheet_(), data));
    return json_(doReserve_(getSheet_(), data));

  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** 設置確認用。ブラウザでURLを開くとこれが返ります */
function doGet() {
  return json_({ ok: true, message: '予約の受信先として動作しています' });
}

/* ============================================================
   予約の追記
   ============================================================ */
function doReserve_(sheet, d) {
  const c = d.customer || {};
  const menuText = (d.menus || []).map(m => m.name).join(' / ');
  const eventId = addToCalendar_(d, c, menuText);

  sheet.appendRow([
    d.code,
    formatTime_(d.createdAt),
    d.date,
    d.time,
    d.endTime,
    d.totalMinutes,
    menuText,
    d.staffName,
    d.staffId || '',
    d.nominationFee,
    d.totalPrice,
    c.name,
    c.kana,
    "'" + (c.tel || ''),   // 先頭の0が消えないよう文字列として保存
    c.email,
    c.visit,
    c.request || '',
    '予約確定',
    eventId
  ]);

  notify_(
    `【新規予約】${d.date} ${d.time} ${c.name}様`,
    [
      `予約番号：${d.code}`,
      `来店日時：${d.date} ${d.time}〜${d.endTime}（約${d.totalMinutes}分）`,
      `メニュー：${menuText}`,
      `担当　　：${d.staffName}`,
      '',
      `お名前　：${c.name} 様（${c.kana}）`,
      `電話番号：${c.tel}`,
      `メール　：${c.email}`,
      `来店回数：${c.visit}`,
      `合計金額：${Number(d.totalPrice).toLocaleString()}円（税込）`,
      `ご要望　：${c.request || 'なし'}`
    ].join('\n')
  );

  mailCustomer_(c.email, `ご予約を承りました（${d.date} ${d.time}）`, [
    `${c.name} 様`,
    '',
    `この度は${SALON_NAME}へのご予約をありがとうございます。`,
    '下記の内容で承りました。',
    '',
    '───────────────',
    `ご予約番号：${d.code}`,
    `ご来店日時：${d.date} ${d.time}〜${d.endTime}`,
    `メニュー　：${menuText}`,
    `ご担当　　：${d.staffName}`,
    `合計金額　：${Number(d.totalPrice).toLocaleString()}円（税込）`,
    '───────────────',
    '',
    '【ご予約の確認・キャンセル】',
    `${SITE_URL}mypage.html`,
    'ご予約番号と電話番号を入力すると、どの端末からでもご確認いただけます。',
    '前日18時を過ぎてからのご変更・キャンセルは、お手数ですが店舗までご連絡ください。',
    '',
    `${SALON_NAME}`,
    SALON_TEL ? `TEL ${SALON_TEL}` : '',
    SALON_ADDRESS
  ].filter(Boolean).join('\n'));

  return { ok: true, code: d.code };
}

/* ============================================================
   Googleカレンダー連携（CALENDAR_ID が空なら何もしない）
   ============================================================ */
function addToCalendar_(d, c, menuText) {
  if (!CALENDAR_ID) return '';
  try {
    const cal = CALENDAR_ID === 'primary'
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(CALENDAR_ID);
    if (!cal) return '';

    const start = parseDateTime_(d.date, d.time);
    const end = new Date(start.getTime() + (Number(d.totalMinutes) || 30) * 60000);

    const event = cal.createEvent(
      `${c.name || 'お客様'}様 / ${menuText}`,
      start, end,
      {
        description: [
          `予約番号：${d.code}`,
          `メニュー：${menuText}`,
          `担当：${d.staffName}`,
          `電話：${c.tel || ''}`,
          `メール：${c.email || ''}`,
          `来店回数：${c.visit || ''}`,
          `ご要望：${c.request || 'なし'}`,
          `金額：${Number(d.totalPrice).toLocaleString()}円`
        ].join('\n'),
        location: SALON_ADDRESS
      }
    );
    return event.getId();
  } catch (err) {
    // カレンダーの失敗で予約の記録まで止めない
    console.warn('カレンダー登録に失敗しました', err);
    return '';
  }
}

function removeFromCalendar_(eventId) {
  if (!CALENDAR_ID || !eventId) return;
  try {
    const cal = CALENDAR_ID === 'primary'
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(CALENDAR_ID);
    if (!cal) return;
    const event = cal.getEventById(eventId);
    if (event) event.deleteEvent();
  } catch (err) {
    console.warn('カレンダーの削除に失敗しました', err);
  }
}

/* ============================================================
   空席状況の応答（ダブルブッキング防止）
   埋まっている枠だけを返します。
   氏名・電話番号などの個人情報は一切含めません。
   ============================================================ */
function doAvailability_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return { ok: true, booked: [] };

  const rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const col = name => HEADERS.indexOf(name);
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  const booked = rows
    .filter(r => String(r[col('状態')]).trim() !== 'キャンセル')
    .map(r => ({
      date: normalizeDate_(r[col('来店日')]),
      time: normalizeTime_(r[col('開始')]),
      minutes: Number(r[col('所要(分)')]) || 30,
      staffId: String(r[col('担当ID')] || '') || null
    }))
    .filter(b => b.date && b.time && b.date >= today);

  return { ok: true, booked: booked };
}

/* ============================================================
   メニュー・クーポンの応答
   「メニュー」「クーポン」シートの内容をサイトに反映します。
   シートが無い場合は空を返し、サイトは data.js の内容で動きます。
   ============================================================ */
function doMenu_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    ok: true,
    categories: readMenuSheet_(ss),
    coupons: readCouponSheet_(ss)
  };
}

function readMenuSheet_(ss) {
  const sheet = ss.getSheetByName(MENU_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, MENU_HEADERS.length).getValues();
  const col = n => MENU_HEADERS.indexOf(n);
  const groups = [];

  rows.forEach((r, i) => {
    const name = String(r[col('メニュー名')] || '').trim();
    if (!name) return;
    if (!isShown_(r[col('表示')])) return;

    const catName = String(r[col('区分')] || 'メニュー').trim();
    let group = groups.find(g => g.name === catName);
    if (!group) {
      group = { id: 'cat' + groups.length, name: catName, items: [] };
      groups.push(group);
    }
    group.items.push({
      id: 'sm' + i,
      name: name,
      price: Number(r[col('価格')]) || 0,
      minutes: Number(r[col('所要(分)')]) || 30,
      note: String(r[col('説明')] || '')
    });
  });

  return groups.length ? groups : null;
}

function readCouponSheet_(ss) {
  const sheet = ss.getSheetByName(COUPON_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, COUPON_HEADERS.length).getValues();
  const col = n => COUPON_HEADERS.indexOf(n);
  const out = [];

  rows.forEach((r, i) => {
    const title = String(r[col('クーポン名')] || '').trim();
    if (!title) return;
    if (!isShown_(r[col('表示')])) return;

    const list = Number(r[col('通常価格')]) || null;
    out.push({
      id: 'sc' + i,
      badge: String(r[col('対象')] || '全員').trim(),
      title: title,
      detail: String(r[col('説明')] || ''),
      price: Number(r[col('価格')]) || 0,
      listPrice: list,
      minutes: Number(r[col('所要(分)')]) || 30,
      terms: String(r[col('条件')] || '')
    });
  });

  return out.length ? out : null;
}

/** 「表示」列の判定。空欄は表示扱い。×・✕・x・非表示・FALSE は非表示 */
function isShown_(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '') return true;
  return !['×', '✕', 'x', '✗', '非表示', 'false', 'no', 'off', '0'].includes(s);
}

/* ============================================================
   予約の照会（予約番号 + 電話番号）
   ログイン機能の代わりです。両方が一致した場合だけ返します。
   ============================================================ */
function doLookup_(sheet, d) {
  const row = findRowByCode_(sheet, d.code);
  if (row === -1) return { ok: false, error: 'ご予約が見つかりませんでした。' };

  const r = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  const col = n => HEADERS.indexOf(n);

  if (digits_(r[col('電話番号')]) !== digits_(d.tel)) {
    return { ok: false, error: 'ご予約が見つかりませんでした。' };
  }

  return {
    ok: true,
    reservation: {
      code: String(r[col('予約番号')]),
      date: normalizeDate_(r[col('来店日')]),
      time: normalizeTime_(r[col('開始')]),
      endTime: normalizeTime_(r[col('終了')]),
      totalMinutes: Number(r[col('所要(分)')]) || 30,
      menuText: String(r[col('メニュー')] || ''),
      staffName: String(r[col('担当')] || ''),
      totalPrice: Number(r[col('合計金額')]) || 0,
      name: String(r[col('お名前')] || ''),
      status: String(r[col('状態')] || '')
    }
  };
}

/** 数字だけを取り出して比較する（ハイフン・全角・先頭の ' を無視） */
function digits_(v) {
  return String(v == null ? '' : v)
    .replace(/^'/, '')
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/\D/g, '');
}

/* ============================================================
   キャンセルの反映
   ============================================================ */
function doCancel_(sheet, d) {
  const row = findRowByCode_(sheet, d.code);
  if (row === -1) return { ok: false, error: '該当する予約が見つかりません: ' + d.code };

  const before = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  const col = n => HEADERS.indexOf(n);

  // 照会経由のキャンセルは電話番号の一致を確認する
  if (d.tel && digits_(before[col('電話番号')]) !== digits_(d.tel)) {
    return { ok: false, error: 'ご予約が確認できませんでした。' };
  }

  const email = String(before[col('メール')] || '');
  const name = d.name || String(before[col('お名前')] || '');

  sheet.getRange(row, col('状態') + 1).setValue('キャンセル');
  sheet.getRange(row, 1, 1, HEADERS.length)
    .setFontLine('line-through')
    .setFontColor('#999999');

  removeFromCalendar_(String(before[col('カレンダーID')] || ''));

  mailCustomer_(email, `ご予約をキャンセルしました（${d.date} ${d.time}）`, [
    `${name} 様`,
    '',
    '下記のご予約をキャンセルいたしました。',
    '',
    `ご予約番号：${d.code}`,
    `ご来店日時：${d.date} ${d.time}〜`,
    '',
    'またのご利用をお待ちしております。',
    `ご予約はこちら： ${SITE_URL}`,
    '',
    `${SALON_NAME}`,
    SALON_TEL ? `TEL ${SALON_TEL}` : ''
  ].filter(Boolean).join('\n'));

  notify_(
    `【キャンセル】${d.date} ${d.time} ${name}様`,
    [
      `予約番号：${d.code}`,
      `来店日時：${d.date} ${d.time}〜`,
      `お名前　：${name} 様`,
      '',
      'キャンセルにより枠が空きました。'
    ].join('\n')
  );

  return { ok: true };
}

/* ============================================================
   補助
   ============================================================ */
function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(HEADERS.indexOf('メニュー') + 1, 240);
    sheet.setColumnWidth(HEADERS.indexOf('ご要望') + 1, 260);
  }
  return sheet;
}

function findRowByCode_(sheet, code) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const codes = sheet.getRange(2, 1, last - 1, 1).getValues();
  const i = codes.findIndex(r => String(r[0]).trim() === String(code).trim());
  return i === -1 ? -1 : i + 2;
}

function notify_(subject, body) {
  if (!NOTIFY_EMAIL) return;
  try {
    MailApp.sendEmail(NOTIFY_EMAIL, `${SALON_NAME} ${subject}`, body);
  } catch (err) {
    console.warn('メール送信に失敗しました', err);
  }
}

function mailCustomer_(email, subject, body) {
  if (!MAIL_TO_CUSTOMER) return;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return;
  try {
    MailApp.sendEmail(String(email).trim(), `【${SALON_NAME}】${subject}`, body);
  } catch (err) {
    console.warn('お客様へのメール送信に失敗しました', err);
  }
}

function normalizeDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(v || '').trim();
}

function normalizeTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'HH:mm');
  return String(v || '').trim();
}

function parseDateTime_(dateKey, time) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0);
}

function formatTime_(iso) {
  const d = iso ? new Date(iso) : new Date();
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   初回だけ実行：メニュー・クーポンのシートを作る
   （エディタ上部の関数選択で setupMenuSheets を選んで実行）

   実行すると現在サイトに入っている内容が書き込まれます。
   以降は、このシートの行を足す／消すだけでサイトのメニューが変わります。
   ============================================================ */
function setupMenuSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const menu = ss.getSheetByName(MENU_SHEET) || ss.insertSheet(MENU_SHEET);
  if (menu.getLastRow() === 0) {
    menu.appendRow(MENU_HEADERS);
    menu.getRange(1, 1, 1, MENU_HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
    menu.setFrozenRows(1);
    menu.appendRow(['カット', 'メンズカット', 4000, 50, 'カット価格はこちらから', '○']);
    menu.setColumnWidth(2, 260);
    menu.setColumnWidth(5, 260);
  }

  const coupon = ss.getSheetByName(COUPON_SHEET) || ss.insertSheet(COUPON_SHEET);
  if (coupon.getLastRow() === 0) {
    coupon.appendRow(COUPON_HEADERS);
    coupon.getRange(1, 1, 1, COUPON_HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
    coupon.setFrozenRows(1);
    [
      ["【清潔感と品が続く】men's骨格補正カット＋眉カット", 6900, '', 70,
        '骨格・髪質・雰囲気を見極めた大人メンズカジュアル。眉カットまで整えます。', '', '全員', '○'],
      ['【全ての身嗜み整える＋最高の体験を】ラグジュアリーカットコース', 10000, '', 110,
        'カットに加え、トリートメントとヘッドスパまで。身だしなみをトータルで整えます。', '', '全員', '○'],
      ['【毎朝のセット1分】品よく決まるお悩み解決メンズパーマ', 14500, '', 120,
        '直毛や動きが出にくい髪も、扱いやすく自然なメンズパーマに。', '', '全員', '○'],
      ['【彩で見せるワンランク上のお洒落を】カット＋カラー', 14500, '', 120,
        '髪の状態と仕上がりに合わせて薬剤を選び、品のある色味に仕上げます。', '', '全員', '○'],
      ["【立体感で格が上がる】伸びても自然！白髪ぼかしホワイトメッシュ men's", 19800, '', 150,
        '白髪を隠すのではなく活かす白髪ぼかし。伸びても境目が出にくい仕上がりに。', '', '全員', '○'],
      ['【地毛より綺麗】自然に柔らかく仕上げるメンズ縮毛矯正', 22000, '', 180,
        'クセや広がりを抑えつつ、不自然にならない自然な質感に。', '', '全員', '○']
    ].forEach(r => coupon.appendRow(r));
    coupon.setColumnWidth(1, 320);
    coupon.setColumnWidth(5, 300);
  }

  SpreadsheetApp.getUi
    ? console.log('メニュー・クーポンのシートを作成しました')
    : null;
}

/* ============================================================
   前日リマインドメール（任意）

   使う場合は「トリガー」で
   ・実行する関数 → sendReminders
   ・イベントのソース → 時間主導型
   ・タイプ → 日付ベースのタイマー（例：午後6時〜7時）
   ============================================================ */
function sendReminders() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const target = Utilities.formatDate(tomorrow, 'Asia/Tokyo', 'yyyy-MM-dd');

  const rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const col = n => HEADERS.indexOf(n);
  let sent = 0;

  rows.forEach(r => {
    if (String(r[col('状態')]).trim() === 'キャンセル') return;
    if (normalizeDate_(r[col('来店日')]) !== target) return;

    mailCustomer_(r[col('メール')], `明日のご予約のご案内（${normalizeTime_(r[col('開始')])}〜）`, [
      `${r[col('お名前')]} 様`,
      '',
      '明日のご予約をご案内いたします。お気をつけてお越しください。',
      '',
      `ご予約番号：${r[col('予約番号')]}`,
      `ご来店日時：${target} ${normalizeTime_(r[col('開始')])}〜`,
      `メニュー　：${r[col('メニュー')]}`,
      `ご担当　　：${r[col('担当')]}`,
      '',
      'ご都合が変わられた場合は、お手数ですがご連絡ください。',
      '',
      `${SALON_NAME}`,
      SALON_TEL ? `TEL ${SALON_TEL}` : '',
      SALON_ADDRESS
    ].filter(Boolean).join('\n'));
    sent++;
  });

  console.log(`リマインド送信: ${sent}件（対象日 ${target}）`);
}

/* ============================================================
   動作確認用：サイトを触らずに1件テスト登録する
   ============================================================ */
function testReserve() {
  doReserve_(getSheet_(), {
    code: 'LM-TEST1',
    createdAt: new Date().toISOString(),
    date: '2026-09-01', time: '11:00', endTime: '12:10', totalMinutes: 70,
    menus: [{ name: "【清潔感と品が続く】men's骨格補正カット＋眉カット" }],
    staffId: 'st01', staffName: 'MATTEO', nominationFee: 0, totalPrice: 6900,
    customer: {
      name: 'テスト 太郎', kana: 'テスト タロウ',
      tel: '09000000000', email: 'test@example.com',
      visit: '初めて', request: 'これはテストです'
    }
  });
}
