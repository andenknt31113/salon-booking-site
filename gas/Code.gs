/**
 * ZER01 barber/lounge 予約サイト 受信スクリプト（Google Apps Script）
 *
 * このスプレッドシートが、サロンボードにあたる管理画面になります。
 *   ・予約一覧  … 入った予約が1行ずつ溜まります
 *   ・メニュー  … 行を足すとサイトのメニューが増えます
 *   ・おすすめメニュー … 同上
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
const COUPON_SHEET  = 'おすすめメニュー';
const CLOSED_SHEET  = '休業日';
const SETTING_SHEET = '設定';
const STYLE_SHEET   = 'スタイル';
const REVIEW_SHEET  = '口コミ';

/* 管理者ページのパスワード。
   ここに直接書かず、スクリプトプロパティに保存します。
   Apps Script の「プロジェクトの設定 → スクリプト プロパティ」で
   ADMIN_PASSWORD という名前で登録してください。
   （サイトのソースには一切現れないため、パスワードが漏れません） */
function adminPassword_() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || '';
}

/* ---- 合言葉の入れまちがいを数える ----

   この受け口は誰でも呼べます（そうしないとお客様の予約が届きません）。
   つまり合言葉は、何度でも試せる状態に置かれています。短い合言葉なら
   いつかは当たります。そこで、まちがいが続いたら、しばらく受け付けません。

   記憶させた端末（トークン）はこの制限を通します。誰かがでたらめを
   送り続けているあいだ、店の人まで管理ページに入れなくなっては、
   困るのは店だからです。 */
const ADMIN_FAIL_PROP = 'ADMIN_FAILS';
const ADMIN_MAX_FAILS = 10;
const ADMIN_LOCK_MINUTES = 15;

function adminFails_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(ADMIN_FAIL_PROP) || '{}'); }
  catch (e) { return {}; }
}
/** まちがいが続いていて、いま止めている状態か。残り分数を返す（0なら通す） */
function adminLockedMinutes_() {
  const f = adminFails_();
  if (!f.n || f.n < ADMIN_MAX_FAILS) return 0;
  const until = Number(f.at || 0) + ADMIN_LOCK_MINUTES * 60 * 1000;
  const left = until - Date.now();
  if (left <= 0) { clearAdminFails_(); return 0; }
  return Math.ceil(left / 60000);
}
function noteAdminFail_() {
  const f = adminFails_();
  const now = Date.now();
  // 前のまちがいから時間が空いていれば、数え直します
  const fresh = Number(f.at || 0) + ADMIN_LOCK_MINUTES * 60 * 1000 > now;
  PropertiesService.getScriptProperties().setProperty(ADMIN_FAIL_PROP,
    JSON.stringify({ n: (fresh ? Number(f.n || 0) : 0) + 1, at: now }));
}
function clearAdminFails_() {
  PropertiesService.getScriptProperties().deleteProperty(ADMIN_FAIL_PROP);
}

/** 管理操作の認証。合っていなければ例外を投げる。
    パスワードそのものか、ログイン時に発行した端末トークンのどちらかで通ります。 */
function requireAdmin_(d) {
  const pw = adminPassword_();
  if (!pw) throw new Error('管理パスワードが未設定です。スクリプトプロパティに ADMIN_PASSWORD を登録してください。');
  // 記憶させた端末は、止めているあいだも通します
  if (d.token && validToken_(String(d.token))) return;

  const left = adminLockedMinutes_();
  if (left) {
    throw new Error(`パスワードのまちがいが続いたため、${left}分ほどお待ちください。`);
  }
  if (String(d.password || '') === pw) { clearAdminFails_(); return; }
  // 合言葉を入れたうえでまちがえたときだけ数えます
  if (String(d.password || '')) noteAdminFail_();
  throw new Error('パスワードが違います。');
}

/** 管理者として通っているか（例外は投げない）。
    店が電話で受けたキャンセルを台帳に反映するときに使います。
    お客様は電話番号で本人確認しますが、店にお客様の番号を
    打たせるのは筋が違うので、こちらは認証で通します。 */
function isAdmin_(d) {
  try {
    const pw = adminPassword_();
    if (!pw) return false;
    if (String(d.password || '') === pw) return true;
    return !!(d.token && validToken_(String(d.token)));
  } catch (e) { return false; }
}

/* ---- 端末トークン ----
   「この端末を記憶する」を選ぶと、パスワードの代わりに使える文字列を発行します。
   パスワード本体を端末に残さずに済み、店側が使うたびに入力しなくてよくなります。
   スクリプトプロパティに保管し、期限切れは読み出し時に捨てます。 */
const TOKEN_PROP = 'ADMIN_TOKENS';
const TOKEN_DAYS = 60;

function readTokens_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(TOKEN_PROP) || '{}'); }
  catch (e) { return {}; }
}
function issueToken_() {
  const tokens = readTokens_();
  const now = Date.now();
  // 期限切れを捨ててから足す（貯まりっぱなしにしない）
  Object.keys(tokens).forEach(k => { if (tokens[k] < now) delete tokens[k]; });
  const t = Utilities.getUuid() + '-' + Utilities.getUuid();
  tokens[t] = now + TOKEN_DAYS * 24 * 60 * 60 * 1000;
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROP, JSON.stringify(tokens));
  return t;
}
function validToken_(t) {
  const tokens = readTokens_();
  return !!tokens[t] && tokens[t] > Date.now();
}
/** 端末を全部ログアウトさせたいときに、エディタから手で実行します */
function revokeAllAdminTokens() {
  PropertiesService.getScriptProperties().deleteProperty(TOKEN_PROP);
  console.log('記憶させた端末をすべて解除しました');
}

/* 変更・キャンセルの受付期限。「来店日の CANCEL_DEADLINE_DAYS_BEFORE 日前の
   CANCEL_DEADLINE_HOUR 時」まで受け付けます（初期値＝前日18時）。
   ★サイト側（assets/js/data.js の business.cancelDeadline）と同じ値にしてください。
   Apps Script からは data.js を読めないため、2か所に書いてあります。 */
const CANCEL_DEADLINE_DAYS_BEFORE = 1;
const CANCEL_DEADLINE_HOUR = 18;

/* 店舗の通知先メール。予約が入るたび、ここに届きます。
   ★ここが空だと通知が飛びません。設置したら必ず入れてください（selfCheck が警告します）。
   以前入れていた zer01.barber.ryugasaki@gmail.com は 2026/08/16 に Google に凍結され、
   もう受け取れません。凍結アドレスを入れたままにすると、予約通知が
   「送ったつもりで誰にも届かない」状態になり、いちばん気づきにくい壊れ方をします。
   そのため、いったん空に戻してあります。 */
const NOTIFY_EMAIL  = '';
const SALON_NAME    = 'ZER01 barber/lounge';
const SALON_TEL     = '080-4498-7036';           // メールの署名に入ります
const SALON_ADDRESS = '茨城県龍ケ崎市中根台1丁目1-1 ロイヤルヤエ 002';
/* 管理ページから電話予約を入れるときの担当。
   assets/js/data.js の staff の1人目と同じにしてください。
   ここがずれると、その予約が空席計算に入らず二重予約になります。 */
const SALON_STAFF_ID   = 'st01';
const SALON_STAFF_NAME = 'MATTEO';
/* 同じ時間に何人まで受けられるか（席の数）。
   1のあいだは、担当が誰であっても時間が重なれば「埋まっている」と見ます。
   スタッフが増えて同時に2人受けられるようになったら、ここを2にしてください。 */
const SEATS = 1;
const SITE_URL      = 'https://andenknt31113.github.io/salon-booking-site/';
/* LINE公式アカウントの友だち追加URL（https://lin.ee/xxxxxxx の形）。
   入れると予約確認メールの末尾にご案内が入ります。空なら何も足しません。
   assets/js/data.js の lineAddUrl と同じものを入れてください。 */
const LINE_ADD_URL  = '';

/* お客様へ予約確認メールを送るか（false にすると店舗への通知のみ） */
const MAIL_TO_CUSTOMER = true;

/* 予約をGoogleカレンダーにも入れる場合はカレンダーIDを設定。
   自分のメインカレンダーに入れるなら 'primary'。
   空にすると連携しません。
   予約用のカレンダーを分けたい場合は、Googleカレンダーで新しいカレンダーを作り、
   設定画面の「カレンダーの統合」にあるカレンダーIDを貼ってください。 */
const CALENDAR_ID = '';

/* LINE公式アカウントに通知を送る場合のみ設定します。
   LINE Developers の Messaging API チャネルで発行する
   「チャネルアクセストークン（長期）」を入れてください。
   空のままなら何もしません。

   LINE_TO には送信先のユーザーIDまたはグループIDを入れます。
   自分（店舗）宛に届けるだけなら、公式アカウントを友だち追加したうえで
   Webhookで取得したユーザーIDを入れてください。

   ▼ 設定する前に一度ご検討ください
   無料プラン（コミュニケーションプラン）の配信上限は月200通です。
   ここを設定すると、予約1件ごとに1通を消費します。
   予約が月100件あれば、それだけで100通です。

   店舗への通知はメールとGoogleカレンダーで足りているため、
   200通はお客様への再来のご案内に取っておくことをおすすめします。
   （1:1トークの返信や自動応答は通数を消費しません） */
const LINE_TOKEN = '';
const LINE_TO    = '';

/* ============================================================
   シートの列（順番を変えるとスクリプトも直す必要があります）
   ============================================================ */
const HEADERS = [
  '予約番号', '受付日時', '来店日', '開始', '終了', '所要(分)',
  'メニュー', '担当', '担当ID', '指名料', '合計金額',
  'お名前', 'フリガナ', '電話番号', 'メール', '来店回数', 'ご要望',
  '状態', 'カレンダーID'
];

const MENU_HEADERS   = ['区分', 'メニュー名', '価格', '所要(分)', '説明', '画像', '表示'];
const COUPON_HEADERS = ['メニュー名', '価格', '通常価格', '所要(分)', '説明', '条件', '対象', '画像', '表示'];
const STYLE_HEADERS  = ['タイトル', '分類', 'タグ', '画像', '表示'];
const REVIEW_HEADERS = ['投稿日', '予約番号', 'ニックネーム', '年代', '性別',
                        '評価', 'タイトル', '本文', '担当', 'メニュー', '状態'];
const CLOSED_HEADERS = ['休業日', '開始', '終了', 'メモ'];

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
    if (data.type === 'adminLogin')   return json_(doAdminLogin_(data));
    if (data.type === 'adminData')    return json_(doAdminData_(data));
    if (data.type === 'adminSave')    return json_(doAdminSave_(data));
    if (data.type === 'adminUpload')  return json_(doAdminUpload_(data));
    if (data.type === 'adminAdd')     return json_(doAdminAdd_(getSheet_(), data));
    if (data.type === 'availability') return json_(doAvailability_(getSheet_()));
    if (data.type === 'lookup')       return json_(doLookup_(getSheet_(), data));
    if (data.type === 'cancel')       return json_(doCancel_(getSheet_(), data));
    if (data.type === 'change')       return json_(doChange_(getSheet_(), data));
    if (data.type === 'review')       return json_(doReview_(getSheet_(), data));
    return json_(doReserve_(getSheet_(), data));

  } catch (err) {
    console.error(err);
    /* 画面にそのまま出る文字です。「Error: 」が頭に付いたままだと、
       店の人には何のことか分かりません。 */
    return json_({ ok: false, error: String(err && err.message ? err.message : err).replace(/^Error:\s*/, '') });
  } finally {
    lock.releaseLock();
  }
}


/* ============================================================
   店が電話で受けた予約を、台帳に入れる
   ------------------------------------------------------------
   ここが無いと、電話で受けた予約が台帳に無いまま残り、
   同じ時間にネット予約が入ります。店で二重に受けるのが
   いちばん起きてはいけないことなので、押さえられるようにします。
   お客様宛のメールは送りません（電話で話がついているため）。
   ============================================================ */
function doAdminAdd_(sheet, d) {
  requireAdmin_(d);

  const date = normalizeDate_(d.date);
  const time = normalizeTime_(d.time);
  const minutes = Number(d.minutes) || 60;
  if (!date || !time) return { ok: false, error: '来店日と開始時刻をご確認ください。' };
  if (!String(d.name || '').trim()) return { ok: false, error: 'お名前をご入力ください。' };

  if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    return { ok: false, error: '所要時間が正しくありません。' };
  }
  if (timeToMin_(time) == null) return { ok: false, error: '開始時刻が正しくありません。' };
  const price = Number(d.price || 0);
  if (!isFinite(price) || price < 0 || price > MAX_PRICE) {
    return { ok: false, error: '金額が正しくありません。' };
  }

  const endTime = addMinutes_(time, minutes);
  const staffId = SALON_STAFF_ID;

  /* 重なりと休みは、止めずに知らせます。
     店が承知のうえで入れる場合（常連さんを無理に入れる等）があるためです。 */
  if (!d.force) {
    if (isTaken_(sheet, date, time, minutes, staffId, '')) {
      return { ok: false, confirm: true,
        error: 'この時間には、すでに別のご予約が入っています。それでも登録しますか？' };
    }
    if (hitsClosed_(sheet, date, time, minutes)) {
      return { ok: false, confirm: true,
        error: 'この時間は、休業日または受付を止めている時間帯です。それでも登録しますか？' };
    }
  }

  const code = issueCode_(sheet);
  const menuText = String(d.menu || '').trim() || '（電話予約）';
  const customer = { name: d.name, tel: d.tel || '', kana: '', email: '', visit: '', request: d.memo || '' };
  const eventId = addToCalendar_(
    { date: date, time: time, endTime: endTime }, customer, menuText);

  sheet.appendRow(rowFor_(sheet, {
    '予約番号': code,
    '受付日時': formatTime_(new Date().toISOString()),
    '来店日': date, '開始': time, '終了': endTime, '所要(分)': minutes,
    'メニュー': cell_(menuText, LIMITS.menu),
    '担当': SALON_STAFF_NAME, '担当ID': staffId,
    '指名料': 0,
    '合計金額': Number(d.price) || 0,
    'お名前': cell_(d.name, LIMITS.name),
    '電話番号': "'" + telText_(d.tel).slice(0, LIMITS.tel),
    '来店回数': '電話・来店',
    'ご要望': cell_(d.memo, LIMITS.request),
    '状態': '予約確定',
    'カレンダーID': eventId
  }));

  return { ok: true, code: code, endTime: endTime };
}

/** 'HH:MM' に分を足す */
function addMinutes_(hhmm, minutes) {
  const total = toMin_(hhmm) + Number(minutes || 0);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
}


/* ============================================================
   受け取った内容の確認
   ------------------------------------------------------------
   この受け口は「全員」に公開されています（そうしないとお客様から
   予約が届きません）。つまり画面を通さない送信も届きます。
   台帳に書く前に、ここで必ず確かめます。
   ============================================================ */

/* 予約を受け付ける範囲。assets/js/data.js の business と合わせてください */
const BOOKABLE_DAYS = 60;    // 何日先まで
const MIN_LEAD_HOURS = 2;    // 何時間前まで受けるか（当日の直近）
const MIN_MINUTES   = 15;    // 所要時間の下限
const MAX_MINUTES   = 480;   // 所要時間の上限（8時間）
const MAX_PRICE     = 1000000;

/* 直前の予約を断るときの、時計のずれを見込んだ余裕。

   画面はお客様の端末の時計で、受け口はGoogleの時計で判断します。
   端末の時計が数分ずれていると、画面には出ていた枠が
   送った瞬間に「直前すぎます」と断られます。お客様には理由が分かりません。
   15分ぶんだけ甘くして、そこだけは通します。
   「10分後の予約」のような、店が本当に困るものは断ります。 */
const LEAD_GRACE_MINUTES = 15;

/* 文字の上限。長すぎる文字は台帳もメールも読めなくします */
const LIMITS = { name: 60, kana: 60, tel: 20, email: 120, visit: 20, request: 1000, menu: 300 };

/* シートに文字を書くときは必ずこれを通します。

   「=」「+」「-」「@」で始まる文字列は、スプレッドシートが
   **数式として実行します**。お名前欄に =IMPORTXML(...) と書いて
   送られると、店の台帳がその式を実行してしまいます。
   先頭に ' を付けると、表示は変わらないまま、ただの文字になります。 */
function cell_(v, limit) {
  let t = String(v == null ? '' : v).trim();
  if (limit && t.length > limit) t = t.slice(0, limit);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

/** 'HH:MM' として読めるか。読めれば分に、読めなければ null */
function timeToMin_(v) {
  /* 「9時」「２０：００」や、時刻型のセルも読めるようにそろえてから見ます。
     ここが読めないと、営業時間の設定が黙って既定値に戻ります。 */
  const m = normalizeTime_(v).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 営業時間。設定シートを見て、読めなければ既定値

    最終受付は「最後に始められる時刻」です。お客様の画面はここまでしか
    枠を出しません。受け口が見ていないと、設定を変える前に開いていた画面から
    送られた予約が、受付を締めたあとの時間に入ります。 */
function openHours_(sheet) {
  let st = {};
  try { st = readSettings_(sheet.getParent()) || {}; } catch (e) { st = {}; }
  const open = timeToMin_(st['営業開始']);
  const close = timeToMin_(st['営業終了']);
  const last = timeToMin_(st['最終受付']);
  const hours = {
    open: open == null ? timeToMin_(DEFAULT_OPEN) : open,
    close: close == null ? timeToMin_(DEFAULT_CLOSE) : close
  };
  hours.last = (last == null || last > hours.close) ? hours.close : last;
  return hours;
}
const DEFAULT_OPEN  = '09:00';
const DEFAULT_CLOSE = '22:00';

/* 定休曜日。設定シートに「日,水」「日曜・水曜」のどちらで書かれていても読みます。
   画面側（common.js）と同じ読み方です。 */
const WEEKDAY_JA_GAS = ['日', '月', '火', '水', '木', '金', '土'];

function closedWeekdays_(sheet) {
  let st = {};
  try { st = readSettings_(sheet.getParent()) || {}; } catch (e) { return []; }
  const raw = String(st['定休曜日'] == null ? '' : st['定休曜日']).trim();
  if (!raw) return [];
  const out = [];
  raw.split(/[,、・\s]+/).forEach(function (t) {
    const i = WEEKDAY_JA_GAS.indexOf(t.replace(/曜日?$/, ''));
    if (i >= 0 && out.indexOf(i) < 0) out.push(i);
  });
  return out;
}

/** その日が定休曜日か（日本時間の曜日で見ます） */
function isClosedWeekday_(sheet, dateKey) {
  const days = closedWeekdays_(sheet);
  if (!days.length) return false;
  const p = String(dateKey).split('-').map(Number);
  if (!p[0]) return false;
  // 時差で前日・翌日にならないよう、正午のUTCで曜日を出します
  const wd = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).getUTCDay();
  return days.indexOf(wd) >= 0;
}

/** 今日（日本時間）の yyyy-MM-dd */
function todayKey_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

/** いま何時何分か（日本時間・0時からの分） */
function nowMinJst_() {
  return timeToMin_(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm')) || 0;
}

/* 予約の内容を確かめる。問題があれば理由を返します。
   お客様の画面はここを通る前に同じ確認をしていますが、
   画面を通さない送信のために、ここでも見ます。 */
function checkReserve_(sheet, d) {
  const c = d.customer || {};

  const date = normalizeDate_(d.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T00:00:00+09:00').getTime())) {
    return '来店日が正しくありません。';
  }
  /* 日付の引き算は、時差や夏時間で1日ずれることがあります。
     どちらも日本時間の「暦の日付」なので、日数だけで比べます。 */
  const dayNo = k => {
    const p = String(k).split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000;
  };
  const ahead = dayNo(date) - dayNo(todayKey_());
  if (ahead < 0) return 'すでに過ぎた日付です。';
  if (ahead > BOOKABLE_DAYS) return `ご予約は${BOOKABLE_DAYS}日先まで承っております。`;

  const start = timeToMin_(normalizeTime_(d.time));
  if (start == null) return '開始時刻が正しくありません。';

  const minutes = Number(d.totalMinutes);
  if (!isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    return '所要時間が正しくありません。';
  }

  const h = openHours_(sheet);
  if (start < h.open || start > h.last || start + minutes > h.close) {
    return '営業時間外のご予約は承れません。';
  }

  /* 毎週の定休日。お客様の画面には出していない日ですが、
     設定を変える前に開いていた画面からは、まだ送られてきます。 */
  if (isClosedWeekday_(sheet, date)) {
    return 'その日は定休日のため、ご予約を承れません。';
  }

  /* 直前すぎる予約。画面は2時間前で締めていますが、
     しばらく開きっぱなしだった画面からは、締めたあとの枠も送られてきます。
     30分後の予約が入っても、店は気づけないまま席を空けられません。 */
  const untilMin = ahead * 1440 + start - nowMinJst_();
  if (untilMin < MIN_LEAD_HOURS * 60 - LEAD_GRACE_MINUTES) {
    return `当日のご予約は${MIN_LEAD_HOURS}時間前までとなっております。お手数ですが店舗までお電話ください。`;
  }

  const price = Number(d.totalPrice || 0);
  if (!isFinite(price) || price < 0 || price > MAX_PRICE) return '金額が正しくありません。';

  if (!String(c.name || '').trim()) return 'お名前をご入力ください。';
  /* 全角のままの番号（０９０…）も digits_ で読み取ります。
     日本語入力を切り替え忘れただけで断られるのは、お客様には
     理由の分からない失敗になります。 */
  const tel = digits_(c.tel);
  if (!/^0\d{9,10}$/.test(tel)) return '電話番号をご確認ください。';
  const email = halfWidth_(c.email).trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'メールアドレスをご確認ください。';

  const menuText = (d.menus || []).map(m => m && m.name).filter(Boolean).join(' / ')
    || String(d.menuText || '').trim();
  if (!menuText) return 'メニューをお選びください。';

  return '';   // 問題なし
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

  /* 予約番号は端末側で作っています。端末は自分が取った予約しか知らないため、
     別のお客様と同じ番号になる可能性が残ります。ここで台帳と突き合わせます。

     すでに同じ番号がある場合は2通りです。
     ・同じ方の再送（送信は届いたが応答が返らず、もう一度送られた）
       → 二重に書かず、そのまま成功として返す
     ・別の方と番号がぶつかった
       → 新しい番号を振り直し、その番号を端末に返す */
  const dup = findRowByCode_(sheet, d.code);
  if (dup !== -1) {
    const hcol = colIndex_(sheet);
    const before = readRow_(sheet, dup);
    const sameGuest = digits_(before[hcol('電話番号')]) === digits_(c.tel)
      && normalizeDate_(before[hcol('来店日')]) === normalizeDate_(d.date)
      && normalizeTime_(before[hcol('開始')]) === normalizeTime_(d.time);
    if (sameGuest) return { ok: true, code: d.code, duplicate: true };
    d.code = issueCode_(sheet);
  }

  /* 送られてきた内容そのものの確認。
     受け口は公開されているので、画面を通さない送信も届きます。 */
  const bad = checkReserve_(sheet, d);
  if (bad) return { ok: false, error: bad };

  /* 枠の最終確認。
     画面側でも送信直前に見ていますが、2人がほぼ同時に押した場合は
     どちらも「空いている」と判断してしまいます。
     ここは doPost が順番待ちしたあとなので、ここで見れば必ず片方が弾かれます。 */
  /* 休業日・受けない時間帯に入っていないか。
     画面側でも×にしていますが、そこを通さずに送られてくることがあります。 */
  if (hitsClosed_(sheet, normalizeDate_(d.date), normalizeTime_(d.time), Number(d.totalMinutes) || 30)) {
    return { ok: false, error: 'ご希望の時間は、店舗の都合により受付を止めております。別の日時をお選びください。' };
  }

  if (isTaken_(sheet, normalizeDate_(d.date), normalizeTime_(d.time),
               Number(d.totalMinutes) || 30, d.staffId || '', d.code)) {
    return {
      ok: false,
      taken: true,
      error: 'ご希望の時間は、ちょうど他のお客様のご予約が入りました。別の日時をお選びください。'
    };
  }

  const menuText = (d.menus || []).map(m => m.name).join(' / ');
  const eventId = addToCalendar_(d, c, menuText);

  /* 文字は必ず cell_ を通します。
     数式として実行されうる先頭文字（= + - @）を無害化し、長さも切ります。

     並べる順番は台帳の見出しに合わせます。店の人が列を足していても、
     それぞれの値が正しい列に入るようにするためです。 */
  sheet.appendRow(rowFor_(sheet, {
    '予約番号': d.code,
    '受付日時': formatTime_(d.createdAt),
    '来店日': normalizeDate_(d.date),
    '開始': normalizeTime_(d.time),
    '終了': normalizeTime_(d.endTime),
    '所要(分)': Number(d.totalMinutes) || 0,
    'メニュー': cell_(menuText, LIMITS.menu),
    '担当': cell_(d.staffName, LIMITS.name),
    '担当ID': cell_(d.staffId, 20),
    '指名料': Number(d.nominationFee) || 0,
    '合計金額': Number(d.totalPrice) || 0,
    'お名前': cell_(c.name, LIMITS.name),
    'フリガナ': cell_(c.kana, LIMITS.kana),
    /* 先頭の0が消えないよう文字列として保存します。
       全角のまま台帳に入ると、店の端末からその番号に発信できません。
       半角に直したうえで、読みやすさのためハイフンは残します。 */
    '電話番号': "'" + telText_(c.tel).slice(0, LIMITS.tel),
    'メール': cell_(halfWidth_(c.email), LIMITS.email),
    '来店回数': cell_(c.visit, LIMITS.visit),
    'ご要望': cell_(c.request, LIMITS.request),
    '状態': '予約確定',
    'カレンダーID': eventId
  }));

  /* 欠けている項目で「undefined」と書かない。
     フォームでは必須にしていますが、この受け口は公開されているため
     項目が欠けたまま届くことがあります。 */
  /* 長さも切ります。台帳側だけ切ってメールに元の文字を使うと、
     そこだけ何万文字にもなり、開けないメールが届きます。 */
  const or_ = (v, alt, limit) => {
    let t = String(v == null ? '' : v).trim();
    const max = limit || 200;
    if (t.length > max) t = t.slice(0, max) + '…';
    return t === '' ? (alt || '—') : t;
  };
  /* 金額が決まっていない予約（デザインカラー等）は「0円」と書かない。
     店舗が無料と受け取ってしまうため。 */
  const priceLine = d.totalLabel && !Number(d.totalPrice)
    ? d.totalLabel
    : `${Number(d.totalPrice || 0).toLocaleString()}円（税込）`;

  notify_(
    `【新規予約】${d.date} ${d.time} ${or_(c.name, 'お客様')}様`,
    [
      `予約番号：${d.code}`,
      `来店日時：${d.date} ${d.time}〜${d.endTime}（約${d.totalMinutes}分）`,
      `メニュー：${menuText}`,
      `担当　　：${or_(d.staffName)}`,
      '',
      `お名前　：${or_(c.name, 'お客様')} 様（${or_(c.kana)}）`,
      `電話番号：${or_(c.tel)}`,
      `メール　：${or_(c.email)}`,
      `来店回数：${or_(c.visit)}`,
      `合計金額：${priceLine}`,
      `ご要望　：${or_(c.request, 'なし')}`
    ].join('\n')
  );

  notifyLine_([
    '【新規予約】',
    `${d.date} ${d.time}〜${d.endTime}`,
    `${or_(c.name, 'お客様')} 様（${or_(c.visit)}）`,
    menuText,
    priceLine,
    `TEL ${or_(c.tel)}`,
    c.request ? `ご要望：${or_(c.request, '', LIMITS.request)}` : ''
  ].filter(Boolean).join('\n'));

  const lineUrl = lineAddUrl_();
  mailCustomer_(c.email, `ご予約を承りました（${d.date} ${d.time}）`, [
    `${or_(c.name, 'お客様')} 様`,
    '',
    `この度は${SALON_NAME}へのご予約をありがとうございます。`,
    '下記の内容で承りました。',
    '',
    '───────────────',
    `ご予約番号：${d.code}`,
    `ご来店日時：${d.date} ${d.time}〜${d.endTime}`,
    `メニュー　：${menuText}`,
    `ご担当　　：${or_(d.staffName)}`,
    `合計金額　：${priceLine}`,
    '───────────────',
    '',
    '【ご予約の確認・キャンセル】',
    `${SITE_URL}mypage.html`,
    'ご予約番号と電話番号を入力すると、どの端末からでもご確認いただけます。',
    '前日18時を過ぎてからのご変更・キャンセルは、お手数ですが店舗までご連絡ください。',
    '',
    lineUrl ? '【次回のご予約はLINEから】' : '',
    lineUrl || '',
    lineUrl ? '友だち追加していただくと、前日のリマインドが届き、次回のご予約もワンタップで開けます。' : '',
    lineUrl ? '' : '',
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
          `ご要望：${or_(c.request, 'なし', LIMITS.request)}`,
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

  const rows = readRows_(sheet);
  const col = colIndex_(sheet);
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  const booked = rows
    .filter(r => !isCancelled_(r[col('状態')]))
    .map(r => ({
      date: normalizeDate_(r[col('来店日')]),
      time: normalizeTime_(r[col('開始')]),
      minutes: parseMinutes_(r[col('所要(分)')], 30),
      staffId: String(r[col('担当ID')] || '') || null
    }))
    .filter(b => b.date && b.time && b.date >= today);

  return { ok: true, booked: booked };
}

/* ============================================================
   メニューの応答
   「メニュー」「おすすめメニュー」シートの内容をサイトに反映します。
   シートが無い場合は空を返し、サイトは data.js の内容で動きます。
   ============================================================ */
function doMenu_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    ok: true,
    categories: readMenuSheet_(ss),
    coupons: readCouponSheet_(ss),
    styles: readStyleSheet_(ss),
    reviews: readReviewSheet_(ss),
    closedDates: readClosedSheet_(ss),
    settings: readSettings_(ss)
  };
}

/* 「休業日」シートに書いた日付を、予約できない日としてサイトに渡します。
   出張や臨時休業はここに1行足すだけで塞げます。 */
/* 休業日シート。時間の指定が無ければ終日、あればその帯だけ止めます。
   サイト側は文字列（終日）とオブジェクト（時間帯）の両方を受け取れます。 */
function readClosedSheet_(ss) {
  const sheet = ss.getSheetByName(CLOSED_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  /* 休業日シートも、列は見出しの名前で探します。
     店の人が「メモ」を前に足しても、日付を読み違えないためです。 */
  const head = sheetHeader_(sheet, CLOSED_HEADERS);
  const at = h => { const i = head.indexOf(h); return i >= 0 ? i : CLOSED_HEADERS.indexOf(h); };
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, head.length).getValues()
    .map(function (r) {
      const date = normalizeDate_(r[at('休業日')]);
      if (!date) return null;
      const start = normalizeTime_(r[at('開始')]);
      const end = normalizeTime_(r[at('終了')]);
      if (!start || !end || toMin_(end) <= toMin_(start)) return date;   // 終日
      return { date: date, start: start, end: end };
    })
    .filter(Boolean);
}

/* その日時が「受けない」帯にかかるか。
   サイト側で止めていても、直接送られてくる場合があるのでここでも見ます。 */
function hitsClosed_(sheet, dateKey, time, minutes) {
  let ss;
  try { ss = sheet.getParent(); } catch (e) { return false; }
  if (!ss) return false;
  const start = toMin_(time);
  const end = start + (Number(minutes) || 30);
  return readClosedSheet_(ss).some(function (c) {
    if (typeof c === 'string') return c === dateKey;      // 終日休み
    if (c.date !== dateKey) return false;
    return start < toMin_(c.end) && toMin_(c.start) < end;
  });
}

function readMenuSheet_(ss) {
  const sheet = ss.getSheetByName(MENU_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const head = sheetHeader_(sheet, MENU_HEADERS);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, head.length).getValues();
  const col = n => { const i = head.indexOf(n); return i >= 0 ? i : MENU_HEADERS.indexOf(n); };
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
    const p = parsePrice_(r[col('価格')]);
    group.items.push({
      id: 'sm' + i,
      name: name,
      price: p.value,
      priceFrom: p.from,
      minutes: parseMinutes_(r[col('所要(分)')], 30),
      note: String(r[col('説明')] || ''),
      image: String(r[col('画像')] || '').trim()
    });
  });

  return groups.length ? groups : null;
}

function readCouponSheet_(ss) {
  const sheet = ss.getSheetByName(COUPON_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const head = sheetHeader_(sheet, COUPON_HEADERS);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, head.length).getValues();
  const col = n => { const i = head.indexOf(n); return i >= 0 ? i : COUPON_HEADERS.indexOf(n); };
  const out = [];

  rows.forEach((r, i) => {
    const title = String(r[col('メニュー名')] || '').trim();
    if (!title) return;
    if (!isShown_(r[col('表示')])) return;

    const list = Number(r[col('通常価格')]) || null;
    const p = parsePrice_(r[col('価格')]);
    out.push({
      id: 'sc' + i,
      badge: String(r[col('対象')] || '全員').trim(),
      title: title,
      detail: String(r[col('説明')] || ''),
      price: p.value,
      priceFrom: p.from,
      listPrice: list,
      minutes: parseMinutes_(r[col('所要(分)')], 30),
      terms: String(r[col('条件')] || ''),
      image: String(r[col('画像')] || '').trim()
    });
  });

  return out.length ? out : null;
}

/* 「スタイル」シート。ヘアカタログと店内写真をここで差し替えます。
   分類はギャラリーの絞り込みタブになります（ショート／カラー／店内 など）。 */
function readStyleSheet_(ss) {
  const sheet = ss.getSheetByName(STYLE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const head = sheetHeader_(sheet, STYLE_HEADERS);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, head.length).getValues();
  const col = n => { const i = head.indexOf(n); return i >= 0 ? i : STYLE_HEADERS.indexOf(n); };
  const out = [];

  rows.forEach((r, i) => {
    const title = String(r[col('タイトル')] || '').trim();
    if (!title) return;
    if (!isShown_(r[col('表示')])) return;
    out.push({
      id: 'ss' + i,
      title: title,
      length: String(r[col('分類')] || 'スタイル').trim(),
      staffId: null,
      tags: String(r[col('タグ')] || '').split(/[,、・\s]+/).filter(Boolean),
      image: String(r[col('画像')] || '').trim(),
      // 写真がまだ無い枠は、意匠の色みを少しずつ変えて並べる
      hue: (i * 37) % 360
    });
  });

  return out.length ? out : null;
}

/* 「口コミ」シート。
   状態が「掲載中」の行だけをサイトに出します。
   投稿された直後は「未承認」なので、店舗が確認するまで公開されません。 */
function readReviewSheet_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const head = sheetHeader_(sheet, REVIEW_HEADERS);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, head.length).getValues();
  const col = n => { const i = head.indexOf(n); return i >= 0 ? i : REVIEW_HEADERS.indexOf(n); };
  const out = [];

  rows.forEach((r, i) => {
    if (String(r[col('状態')] || '').trim() !== '掲載中') return;
    const body = String(r[col('本文')] || '').trim();
    if (!body) return;
    out.push({
      id: 'rv' + i,
      score: Number(r[col('評価')]) || 5,
      nickname: String(r[col('ニックネーム')] || 'お客様'),
      age: String(r[col('年代')] || ''),
      gender: String(r[col('性別')] || ''),
      date: normalizeDate_(r[col('投稿日')]) || '',
      title: String(r[col('タイトル')] || ''),
      body: body,
      staffId: null,
      staffName: String(r[col('担当')] || ''),
      menu: String(r[col('メニュー')] || '')
    });
  });

  // 新しいものから
  out.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return out.length ? out : null;
}

/* 口コミの受付。
   予約番号と電話番号が一致した予約にだけ書けます。
   実際にご来店いただいた方の声だけを載せるためで、
   架空の口コミの掲載は景品表示法（ステルスマーケティング規制）に触れます。 */
function doReview_(sheet, d) {
  const body = String(d.body || '').trim();
  if (!body) return { ok: false, error: 'ご感想をご入力ください。' };
  if (body.length > 2000) return { ok: false, error: 'ご感想が長すぎます（2000文字まで）。' };

  const row = findRowByCode_(sheet, d.code);
  if (row === -1) return { ok: false, error: 'ご予約が確認できませんでした。' };

  const col = colIndex_(sheet);
  const r = readRow_(sheet, row);

  if (digits_(r[col('電話番号')]) !== digits_(d.tel)) {
    return { ok: false, error: 'ご予約が確認できませんでした。' };
  }
  if (isCancelled_(r[col('状態')])) {
    return { ok: false, error: 'キャンセルされたご予約には投稿いただけません。' };
  }

  // 来店前の予約には書けない
  const visit = parseDateTime_(normalizeDate_(r[col('来店日')]), normalizeTime_(r[col('開始')]));
  if (visit && visit.getTime() > Date.now()) {
    return { ok: false, error: 'ご来店後にご投稿いただけます。' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rv = ss.getSheetByName(REVIEW_SHEET) || ss.insertSheet(REVIEW_SHEET);
  if (rv.getLastRow() === 0) {
    rv.appendRow(REVIEW_HEADERS);
    rv.getRange(1, 1, 1, REVIEW_HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
    rv.setFrozenRows(1);
  }
  // 同じ予約からの二重投稿を防ぐ
  if (rv.getLastRow() > 1) {
    const rvHead = sheetHeader_(rv, REVIEW_HEADERS);
    const codeCol = (rvHead.indexOf('予約番号') >= 0 ? rvHead.indexOf('予約番号') : REVIEW_HEADERS.indexOf('予約番号')) + 1;
    const codes = rv.getRange(2, codeCol, rv.getLastRow() - 1, 1).getValues();
    if (codes.some(function (x) { return codeKey_(x[0]) && codeKey_(x[0]) === codeKey_(d.code); })) {
      return { ok: false, error: 'このご予約にはすでにご感想をいただいています。ありがとうございます。' };
    }
  }

  const score = Math.min(5, Math.max(1, Number(d.score) || 5));
  // 口コミもお客様が書く文字なので、台帳と同じく数式として動かないようにします
  const rvHead2 = sheetHeader_(rv, REVIEW_HEADERS);
  const rvValues = {
    '投稿日': Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
    '予約番号': cell_(d.code, 20),
    'ニックネーム': cell_(d.nickname || 'お客様', 30),
    '年代': cell_(d.age, 10),
    '性別': cell_(d.gender, 10),
    '評価': score,
    'タイトル': cell_(d.title, 60),
    '本文': cell_(body, LIMITS.request),
    '担当': cell_(r[col('担当')], LIMITS.name),
    'メニュー': cell_(r[col('メニュー')], LIMITS.menu),
    '状態': '未承認'
  };
  rv.appendRow(rvHead2.map(function (h) {
    return Object.prototype.hasOwnProperty.call(rvValues, h) ? rvValues[h] : '';
  }));

  notify_(
    '【口コミが届きました】' + String(d.nickname || 'お客様'),
    [
      '評価：' + score,
      'タイトル：' + String(d.title || ''),
      '',
      body,
      '',
      '※「未承認」の状態です。管理ページの口コミタブで「掲載中」にすると公開されます。'
    ].join('\n')
  );

  return { ok: true };
}

/* 価格セルの読み取り。
   数値のほか「4000〜」「¥4,000〜」のような書き方も受け取ります。
   「〜」を付けると、サイトでも「¥4,000〜」と出ます。
   空欄・0 は「カウンセリングでお見積り」として扱われます。 */
/* 価格。「¥4,000〜」「4000円」「４０００」のどれで書かれても読みます。 */
function parsePrice_(v) {
  const s = halfWidth_(v).trim();
  const from = /[〜~]/.test(String(v == null ? '' : v));
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return { value: isNaN(n) ? 0 : n, from: from };
}

/** 「表示」列の判定。空欄は表示扱い。×・✕・x・非表示・FALSE は非表示 */
function isShown_(v) {
  const s = halfWidth_(v).trim().toLowerCase();
  if (s === '') return true;
  return !['×', '✕', '✖', '✗', 'x', '非表示', '非公開', '休止', '停止', 'false', 'no', 'off', '0'].includes(s);
}

/* ============================================================
   予約の照会（予約番号 + 電話番号）
   ログイン機能の代わりです。両方が一致した場合だけ返します。
   ============================================================ */
function doLookup_(sheet, d) {
  const row = findRowByCode_(sheet, d.code);
  if (row === -1) return { ok: false, error: 'ご予約が見つかりませんでした。' };

  const r = readRow_(sheet, row);
  const col = colIndex_(sheet);

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
      totalMinutes: parseMinutes_(r[col('所要(分)')], 30),
      menuText: String(r[col('メニュー')] || ''),
      staffName: String(r[col('担当')] || ''),
      totalPrice: Number(r[col('合計金額')]) || 0,
      name: String(r[col('お名前')] || ''),
      /* 書き方のゆれは、ここで一つに揃えてから画面に渡します */
      status: isCancelled_(r[col('状態')]) ? 'キャンセル' : String(r[col('状態')] || '')
    }
  };
}

/** 数字だけを取り出して比較する（ハイフン・全角・先頭の ' を無視） */
/* 全角の英数字・記号を半角に直します。
   日本語入力のままメールアドレスを打つと「＠」になり、そのままでは届きません。 */
function halfWidth_(v) {
  return String(v == null ? '' : v)
    .replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

/* 台帳に残す電話番号。半角に直し、ハイフンは読みやすさのため残します。 */
function telText_(v) {
  return halfWidth_(v).replace(/[‐‑‒–—―ー−ｰ]/g, '-').replace(/[^0-9\-+()]/g, '').trim();
}

/* 半角カナを全角に直します。「ｷｬﾝｾﾙ」と手で書かれても読めるように。 */
const KANA_HALF_GAS = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
const KANA_FULL_GAS = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';

function kanaFull_(v) {
  const t = String(v == null ? '' : v);
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const j = KANA_HALF_GAS.indexOf(t.charAt(i));
    out += j >= 0 ? KANA_FULL_GAS.charAt(j) : t.charAt(i);
  }
  return out;
}

/* その予約はキャンセルされているか。

   台帳の「状態」は、店の人が手で書き換えることもあります。
   「キャンセル」「キャンセル済」「取消」――どれもふつうの書き方です。
   決め打ちで一致だけを見ていると、書き方が少し違うだけで
   「まだ生きている予約」として扱われ、その時間が空きに戻りません。
   お客様には、なぜか取れない時間として見えます。 */
const CANCELLED_WORDS = ['キャンセル', 'キャンセル済', 'キャンセル済み', '取消', '取り消し', '取消済', '中止'];

function isCancelled_(v) {
  const t = kanaFull_(halfWidth_(v)).replace(/\s|　/g, '');
  return t !== '' && CANCELLED_WORDS.indexOf(t) >= 0;
}

function digits_(v) {
  return String(v == null ? '' : v)
    .replace(/^'/, '')
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/\D/g, '');
}

/* ============================================================
   キャンセルの反映
   ============================================================ */
/* ============================================================
   日時の変更

   予約番号はそのままに、来店日時だけ書き換えます。
   キャンセルして取り直すのと違い、そのあいだに枠を他のお客様に
   取られる心配がありません。
   ============================================================ */
function doChange_(sheet, d) {
  const row = findRowByCode_(sheet, d.code);
  if (row === -1) return { ok: false, error: '該当する予約が見つかりません: ' + d.code };

  const col = colIndex_(sheet);
  const before = readRow_(sheet, row);

  /* キャンセルと同じで、日時の変更も本人確認を省略できません。
     以前は「電話番号が送られてきたときだけ」見ていたため、
     番号を空にして送れば他人の予約を動かせる状態でした。
     店（管理ページ）からの変更はパスワードで通します。 */
  if (!isAdmin_(d)
      && (!digits_(d.tel) || digits_(before[col('電話番号')]) !== digits_(d.tel))) {
    return { ok: false, error: 'ご予約が確認できませんでした。電話番号をご確認ください。' };
  }
  if (isCancelled_(before[col('状態')])) {
    return { ok: false, error: 'キャンセル済みのご予約は変更できません。' };
  }
  /* 変更前の来店日で判定する（間近の予約を遠い日へ逃がすのも受付期限の対象）。
     キャンセルと同じで、これはお客様の締め切りです。
     「今日の2時を4時にしてほしい」という電話に、店が応えられなくなります。 */
  if (!isAdmin_(d) && !withinDeadline_(before[col('来店日')])) {
    return { ok: false, deadline: true, error: deadlineMessage_() };
  }

  const newDate = normalizeDate_(d.date);
  const newTime = normalizeTime_(d.time);
  if (!newDate || !newTime) return { ok: false, error: '日時が正しくありません。' };

  // 同じ担当の同じ時間に別の予約が入っていないか確認する。
  // 画面側でも確認していますが、送信までのあいだに埋まることがあります。
  const staffId = String(before[col('担当ID')] || '');
  const minutes = Number(d.minutes) || 30;
  /* 変更先も、新規予約と同じ条件で確かめます。
     ここを見ていないと「予約は今日以降しか取れないのに、
     変更なら過去や営業時間外に動かせる」という抜け道になります。 */
  const dayNo = k => {
    const q = String(k).split('-').map(Number);
    return Date.UTC(q[0], q[1] - 1, q[2]) / 86400000;
  };
  const ahead = dayNo(newDate) - dayNo(todayKey_());
  if (ahead < 0) return { ok: false, error: 'すでに過ぎた日付には変更できません。' };
  if (ahead > BOOKABLE_DAYS) {
    return { ok: false, error: `ご予約は${BOOKABLE_DAYS}日先まで承っております。` };
  }
  const startMin = timeToMin_(newTime);
  if (startMin == null) return { ok: false, error: '開始時刻が正しくありません。' };
  if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    return { ok: false, error: '所要時間が正しくありません。' };
  }
  const hrs = openHours_(sheet);
  if (startMin < hrs.open || startMin > hrs.last || startMin + minutes > hrs.close) {
    return { ok: false, error: '営業時間外のご予約は承れません。' };
  }
  if (isClosedWeekday_(sheet, newDate)) {
    return { ok: false, error: 'その日は定休日のため、ご予約を承れません。' };
  }

  if (hitsClosed_(sheet, newDate, newTime, minutes)) {
    return { ok: false, error: 'ご希望の時間は、店舗の都合により受付を止めております。別の日時をお選びください。' };
  }
  if (isTaken_(sheet, newDate, newTime, minutes, staffId, d.code)) {
    return { ok: false, error: 'ご希望の時間は、ちょうど他のお客様のご予約が入りました。' };
  }

  const oldDate = normalizeDate_(before[col('来店日')]);
  const oldTime = normalizeTime_(before[col('開始')]);
  const name = String(before[col('お名前')] || '');
  const email = String(before[col('メール')] || '');
  const menuText = String(before[col('メニュー')] || '');

  sheet.getRange(row, col('来店日') + 1).setValue(newDate);
  sheet.getRange(row, col('開始') + 1).setValue(newTime);
  sheet.getRange(row, col('終了') + 1).setValue(normalizeTime_(d.endTime));

  // カレンダーの予定も入れ直す
  removeFromCalendar_(String(before[col('カレンダーID')] || ''));
  const eventId = addToCalendar_(
    { date: newDate, time: newTime, endTime: d.endTime, customer: { name: name, tel: String(before[col('電話番号')] || '') } },
    d.code, menuText);
  if (eventId) sheet.getRange(row, col('カレンダーID') + 1).setValue(eventId);

  mailCustomer_(email, `ご予約の日時を変更しました（${newDate} ${newTime}）`, [
    `${name} 様`,
    '',
    'ご予約の日時を変更いたしました。',
    '',
    `ご予約番号：${d.code}（変更ありません）`,
    `変更前　　：${oldDate} ${oldTime}〜`,
    `変更後　　：${newDate} ${newTime}〜`,
    `メニュー　：${menuText}`,
    '',
    'お気をつけてお越しくださいませ。',
    `ご予約の確認： ${SITE_URL}mypage.html`,
    '',
    `${SALON_NAME}`,
    SALON_TEL ? `TEL ${SALON_TEL}` : ''
  ].filter(Boolean).join('\n'));

  notifyLine_([
    '【日時変更】',
    `${oldDate} ${oldTime}〜 → ${newDate} ${newTime}〜`,
    `${name} 様`,
    menuText
  ].join('\n'));

  notify_(
    `【日時変更】${newDate} ${newTime} ${name}様`,
    [
      `予約番号：${d.code}`,
      `変更前　：${oldDate} ${oldTime}〜`,
      `変更後　：${newDate} ${newTime}〜`,
      `お名前　：${name} 様`,
      `メニュー：${menuText}`
    ].join('\n')
  );

  return { ok: true };
}

/* 変更・キャンセルの受付期限内か。
   画面側でも判定していますが、期限の直前にページを開いたまま
   しばらくしてから押されると、画面の判定はすり抜けます。 */
function withinDeadline_(dateKey) {
  const d = normalizeDate_(dateKey);
  if (!d) return true;   // 日付が読めないものは弾かない（店舗側で対応してもらう）
  const parts = d.split('-');
  const limit = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  limit.setDate(limit.getDate() - CANCEL_DEADLINE_DAYS_BEFORE);
  limit.setHours(CANCEL_DEADLINE_HOUR, 0, 0, 0);
  return Date.now() < limit.getTime();
}

function deadlineMessage_() {
  const when = CANCEL_DEADLINE_DAYS_BEFORE === 1
    ? '前日' + CANCEL_DEADLINE_HOUR + '時'
    : CANCEL_DEADLINE_DAYS_BEFORE + '日前の' + CANCEL_DEADLINE_HOUR + '時';
  return 'ネットでの変更・キャンセルは' + when + 'までとなっております。'
    + 'お手数ですが店舗までご連絡ください。'
    + (SALON_TEL ? '（TEL ' + SALON_TEL + '）' : '');
}

/* その枠が既に埋まっているか（自分自身の予約は除く） */
function isTaken_(sheet, dateKey, time, minutes, staffId, ownCode) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const col = colIndex_(sheet);
  const rows = readRows_(sheet);

  const start = toMin_(time);
  const end = start + minutes;

  return rows.some(r => {
    if (codeKey_(r[col('予約番号')]) === codeKey_(ownCode)) return false;
    if (isCancelled_(r[col('状態')])) return false;
    if (normalizeDate_(r[col('来店日')]) !== dateKey) return false;
    /* 席の数で見ます。

       以前は「担当が違えば別の予約」として素通りさせていました。
       この店は席が1つなので、担当が誰であっても、時間が重なれば
       同時には受けられません。指名なし（担当IDが空）で入った電話予約と、
       サイトからの指名予約が、同じ時間に2件入る状態でした。
       席が増えたら SEATS を増やしてください。 */
    if (SEATS === 1) { /* 担当は問わない */ }
    else if (String(r[col('担当ID')] || '') !== String(staffId || '')) return false;
    const s2 = toMin_(normalizeTime_(r[col('開始')]));
    const e2 = toMin_(normalizeTime_(r[col('終了')])) || (s2 + 30);
    return start < e2 && s2 < end;   // 重なっていれば埋まっている
  });
}

function toMin_(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function doCancel_(sheet, d) {
  const row = findRowByCode_(sheet, d.code);
  if (row === -1) return { ok: false, error: '該当する予約が見つかりません: ' + d.code };

  const before = readRow_(sheet, row);
  const col = colIndex_(sheet);

  /* お客様からのキャンセルは、電話番号の一致を必ず確認します。
     以前は「送られてきたときだけ」見ていたため、
     予約番号を知っているだけの人がキャンセルできる状態でした。
     受け口は公開されているので、省略できる確認にしてはいけません。

     店（管理ページ）からのキャンセルは、パスワードで通します。
     電話で受けたキャンセルを反映するのに、
     お客様の番号を打ち直させる必要はありません。 */
  if (!isAdmin_(d)
      && (!digits_(d.tel) || digits_(before[col('電話番号')]) !== digits_(d.tel))) {
    return { ok: false, error: 'ご予約が確認できませんでした。電話番号をご確認ください。' };
  }
  if (isCancelled_(before[col('状態')])) {
    // すでにキャンセル済み。二重に通知やメールを送らない。
    return { ok: true, alreadyCancelled: true };
  }
  /* 受付期限（前日18時）は、お客様の締め切りです。店には掛けません。

     当日の「今日は行けなくなりました」という電話が、いちばん多いキャンセルです。
     ここで店まで断っていると、その予約は台帳に残ったままになり、
     空いたはずの枠がネット予約からも埋まりません。
     店は電話で話を聞いたうえで押しているので、締め切りを見る意味がありません。 */
  if (!isAdmin_(d) && !withinDeadline_(before[col('来店日')])) {
    return { ok: false, deadline: true, error: deadlineMessage_() };
  }

  /* 日時とお名前は台帳から読む。
     予約確認ページの照会からは予約番号と電話番号しか送られてこないため、
     送られてきた値を当てにするとメールが「undefined」になる。 */
  const email = String(before[col('メール')] || '');
  const name = String(before[col('お名前')] || '') || d.name || 'お客様';
  const date = normalizeDate_(before[col('来店日')]) || d.date || '';
  const time = normalizeTime_(before[col('開始')]) || d.time || '';

  sheet.getRange(row, col('状態') + 1).setValue('キャンセル');
  sheet.getRange(row, 1, 1, headerRow_(sheet).length)
    .setFontLine('line-through')
    .setFontColor('#999999');

  removeFromCalendar_(String(before[col('カレンダーID')] || ''));

  mailCustomer_(email, `ご予約をキャンセルしました（${date} ${time}）`, [
    `${name} 様`,
    '',
    '下記のご予約をキャンセルいたしました。',
    '',
    `ご予約番号：${d.code}`,
    `ご来店日時：${date} ${time}〜`,
    '',
    'またのご利用をお待ちしております。',
    `ご予約はこちら： ${SITE_URL}`,
    '',
    `${SALON_NAME}`,
    SALON_TEL ? `TEL ${SALON_TEL}` : ''
  ].filter(Boolean).join('\n'));

  notifyLine_([
    '【キャンセル】',
    `${date} ${time}〜`,
    `${name} 様`,
    '枠が空きました。'
  ].join('\n'));

  notify_(
    `【キャンセル】${date} ${time} ${name}様`,
    [
      `予約番号：${d.code}`,
      `来店日時：${date} ${time}〜`,
      `お名前　：${name} 様`,
      '',
      'キャンセルにより枠が空きました。'
    ].join('\n')
  );

  return { ok: true };
}

/* ============================================================
   管理者ページ用
   ============================================================ */
function doAdminLogin_(d) {
  requireAdmin_(d);
  // 「この端末を記憶する」が選ばれたときだけ発行する
  return d.remember ? { ok: true, token: issueToken_() } : { ok: true };
}

/** 管理者ページに必要な情報をまとめて返す */
function doAdminData_(d) {
  requireAdmin_(d);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  const col = colIndex_(sheet);

  const reservations = last < 2 ? [] :
    readRows_(sheet).map(r => ({
      code: String(r[col('予約番号')]),
      date: normalizeDate_(r[col('来店日')]),
      time: normalizeTime_(r[col('開始')]),
      endTime: normalizeTime_(r[col('終了')]),
      menu: String(r[col('メニュー')] || ''),
      staffName: String(r[col('担当')] || ''),
      price: Number(r[col('合計金額')]) || 0,
      name: String(r[col('お名前')] || ''),
      tel: String(r[col('電話番号')] || '').replace(/^'/, ''),
      email: String(r[col('メール')] || ''),
      visit: String(r[col('来店回数')] || ''),
      request: String(r[col('ご要望')] || ''),
      /* 書き方のゆれは、ここで一つに揃えてから画面に渡します */
      status: isCancelled_(r[col('状態')]) ? 'キャンセル' : String(r[col('状態')] || '')
    })).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));

  return {
    ok: true,
    reservations: reservations,
    menus: readSheetRows_(ss, MENU_SHEET, MENU_HEADERS),
    coupons: readSheetRows_(ss, COUPON_SHEET, COUPON_HEADERS),
    styles: readSheetRows_(ss, STYLE_SHEET, STYLE_HEADERS),
    reviews: readSheetRows_(ss, REVIEW_SHEET, REVIEW_HEADERS),
    closedDates: readSheetRows_(ss, CLOSED_SHEET, CLOSED_HEADERS),
    settings: readSettings_(ss),
    stamps: allStamps_(ss)
  };
}

/* シートの中身から短い印を作る。
   読み込んだときと保存するときで違っていれば、
   そのあいだに誰かが別の端末から保存したということ。 */
function sheetStamp_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() === 0) return '0';
  const text = JSON.stringify(sheet.getDataRange().getValues());
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b & 0xFF) + 0x100).toString(16).slice(1); }).join('').slice(0, 12);
}

const SAVE_TARGETS = {
  menus:    MENU_SHEET,
  coupons:  COUPON_SHEET,
  styles:   STYLE_SHEET,
  reviews:  REVIEW_SHEET,
  closed:   CLOSED_SHEET,
  settings: SETTING_SHEET
};

function allStamps_(ss) {
  const out = {};
  Object.keys(SAVE_TARGETS).forEach(function (k) { out[k] = sheetStamp_(ss, SAVE_TARGETS[k]); });
  return out;
}

/** 管理者ページからの保存。シートまるごと書き換える */
function doAdminSave_(d) {
  requireAdmin_(d);
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  /* 開いてから保存するまでのあいだに、別の端末から保存されていないか。
     このページはシートをまるごと書き換えるため、確認せずに保存すると
     相手の変更が黙って消えます。 */
  const sheetName = SAVE_TARGETS[d.target];
  /* 印が付いていない保存も断ります。以前は「印があるときだけ」見ていたので、
     印を外して送れば、相手の変更ごと上書きできる状態でした。
     管理ページは読み込んだときに必ず印を受け取っています。 */
  if (sheetName && d.stamp !== sheetStamp_(ss, sheetName)) {
    return {
      ok: false,
      stale: true,
      error: 'この内容は、別の端末から変更されています。'
        + '上書きすると相手の変更が消えてしまうため、いったん読み込み直してください。'
    };
  }

  if (d.target === 'menus')   writeSheetRows_(ss, MENU_SHEET, MENU_HEADERS, d.rows);
  else if (d.target === 'coupons') writeSheetRows_(ss, COUPON_SHEET, COUPON_HEADERS, d.rows);
  else if (d.target === 'styles')  writeSheetRows_(ss, STYLE_SHEET, STYLE_HEADERS, d.rows);
  else if (d.target === 'reviews') writeSheetRows_(ss, REVIEW_SHEET, REVIEW_HEADERS, keepReviewWords_(ss, d.rows));
  else if (d.target === 'closed')  writeSheetRows_(ss, CLOSED_SHEET, CLOSED_HEADERS, d.rows);
  else if (d.target === 'settings') writeSettings_(ss, d.rows);
  else return { ok: false, error: '不明な保存先です: ' + d.target };

  // 保存後の印を返す。続けて保存しても弾かれないように。
  return { ok: true, stamps: allStamps_(ss) };
}

/* お客様が書いた言葉は、店側からは書き換えられません。

   管理ページで触れるのは「載せるか、載せないか」と削除だけです。
   画面でもそうしていますが、受け口は公開されているので、ここでも
   同じにします。載せる文言をこちらで直せてしまうと、それは
   お客様の声ではなくなり、景品表示法（いわゆるステマ規制）にも触れます。

   本文・評価・ニックネーム・投稿日は、台帳にある元の言葉に戻します。
   台帳に無い予約番号の行は、こちらで作った口コミなので受け付けません。 */
function keepReviewWords_(ss, rows) {
  const sheet = ss.getSheetByName(REVIEW_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const head = sheetHeader_(sheet, REVIEW_HEADERS);
  const at = h => { const i = head.indexOf(h); return i >= 0 ? i : REVIEW_HEADERS.indexOf(h); };
  const before = sheet.getRange(2, 1, sheet.getLastRow() - 1, head.length).getValues();
  const key = r => codeKey_(r[at('予約番号')]);
  const WRITABLE = ['状態'];

  return (rows || []).map(function (row) {
    const src = before.filter(function (b) { return key(b) === codeKey_(row['予約番号']); })[0];
    if (!src) return null;                       // 元が無い＝こちらで書いた口コミ
    const out = {};
    REVIEW_HEADERS.forEach(function (h) {
      out[h] = WRITABLE.indexOf(h) >= 0 ? row[h] : src[at(h)];
    });
    // 「状態」も決められた3つ以外は受け付けません
    if (['未承認', '掲載中', '非掲載'].indexOf(String(out['状態'])) < 0) {
      out['状態'] = String(src[at('状態')] || '未承認');
    }
    return out;
  }).filter(Boolean);
}

/* ============================================================
   画像のアップロード

   管理者ページで選んだ写真を Google ドライブに保存し、
   サイトから表示できるURLを返します。
   写真は「ZER01サイト画像」フォルダに入り、リンクを知っていれば
   誰でも閲覧できる設定になります（サイトに載せる写真のため）。
   ============================================================ */
const IMAGE_FOLDER = 'ZER01サイト画像';
/* 1枚の上限。長辺1200pxの写真なら、まず超えません。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function imageFolder_() {
  const found = DriveApp.getFoldersByName(IMAGE_FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(IMAGE_FOLDER);
}

function doAdminUpload_(d) {
  requireAdmin_(d);

  const raw = String(d.dataBase64 || '');
  if (!raw) return { ok: false, error: '画像が空です。' };

  // "data:image/jpeg;base64,...." の形で来ても受け取れるようにする
  const body = raw.indexOf(',') >= 0 ? raw.slice(raw.indexOf(',') + 1) : raw;
  const mime = String(d.mimeType || 'image/jpeg');

  /* 受け取る形式は、サイトに載せられる3つだけにします。
     image/ で始まれば何でも通していたので、SVGのように中に命令を書ける
     ファイルまで、誰でも見られる場所に置けてしまいました。 */
  const ext = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
  if (!ext) return { ok: false, error: 'JPEG・PNG・WebP の画像をお選びください。' };

  /* 大きさの上限。画面側で長辺1200pxに縮めてから送っていますが、
     受け口は公開されているので、ここでも見ておきます。
     base64 の文字数は、元の大きさのおよそ4/3です。 */
  if (body.length * 3 / 4 > MAX_IMAGE_BYTES) {
    return { ok: false, error: '画像が大きすぎます。もう少し小さい写真をお選びください。' };
  }

  // 元のファイル名は日本語や重複でつまずくので、用途＋日時で付け直す
  const slot = String(d.slot || 'image').replace(/[^A-Za-z0-9_-]/g, '') || 'image';
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
  const name = slot + '-' + stamp + '.' + ext;

  const blob = Utilities.newBlob(Utilities.base64Decode(body), mime, name);
  const file = imageFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  /* <img> から直接読める形式。ドライブの共有リンクそのままでは表示できません。

     はじめは drive.google.com/thumbnail?id=… を返していましたが、この入口は
     よそのページから続けて読みにいくと Google に断られることがあります。
     断られるかどうかはそのときの回数によるので、同じ写真が「出たり出なかったり」
     しました。店の人には、入れたはずの写真が勝手に消えたように見えます。
     画像用の配信元を通す形にします。 */
  return {
    ok: true,
    name: name,
    url: 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w1200'
  };
}

/** シートを見出し付きの配列として読む（列は名前で探します） */
function readSheetRows_(ss, name, headers) {
  const sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const head = sheetHeader_(sheet, headers);
  const col = h => { const i = head.indexOf(h); return i >= 0 ? i : headers.indexOf(h); };
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, head.length).getValues()
    .map(r => {
      const o = {};
      /* 日付と時刻の欄は、形をそろえてから管理ページに渡します。

         「14:00」と打つとGoogleはそれを時刻として覚えるので、そのまま渡すと
         管理ページの時刻欄には何も入りません。店の人には、入れたはずの
         「受けない時間帯」が消えたように見えます。 */
      headers.forEach(h => {
        const v = r[col(h)];
        if (h === '休業日') { o[h] = normalizeDate_(v); return; }
        if (h === '開始' || h === '終了') { o[h] = v === '' || v === undefined ? '' : normalizeTime_(v); return; }
        o[h] = (v === '' || v === undefined) ? '' : v;
      });
      return o;
    })
    .filter(o => String(o[headers[0]] || '').trim() !== '');
}

/** 見出しを残して中身を入れ替える

    書き換えるのは、こちらが知っている列だけです。店の人がそのシートに
    自分用の列（原価、仕入先など）を足していることがあり、
    保存のたびに消しては使えたものではありません。
    列の位置も、順番ではなく見出しの名前で探します。 */
function writeSheetRows_(ss, name, headers, rows) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f3efea');
    sheet.setFrozenRows(1);
  }
  const head = sheetHeader_(sheet, headers);
  const at = h => { const i = head.indexOf(h); return (i >= 0 ? i : headers.indexOf(h)) + 1; };

  const last = sheet.getLastRow();
  if (last > 1) headers.forEach(h => sheet.getRange(2, at(h), last - 1, 1).clearContent());

  const body = (rows || [])
    .map(r => headers.map(h => (r[h] === undefined || r[h] === null) ? '' : r[h]))
    .filter(cells => String(cells[0]).trim() !== '');
  if (!body.length) return;
  headers.forEach((h, i) => {
    sheet.getRange(2, at(h), body.length, 1).setValues(body.map(cells => [cells[i]]));
  });
}

/* 友だち追加URLは「設定」シートから読みます。
   管理ページから貼れる場所に置いておかないと、
   LINEを開設した日に、コードを触れる人を待つことになるためです。
   シートが空のときだけ、上の LINE_ADD_URL を使います。 */
function lineAddUrl_() {
  try {
    const v = String(readSettings_(SpreadsheetApp.getActiveSpreadsheet())['LINE友だち追加URL'] || '').trim();
    if (/^https?:\/\//i.test(v)) return v;
  } catch (e) { /* シートが読めないときは下の定数で */ }
  return LINE_ADD_URL;
}

/** 設定シート（項目 / 内容 の2列） */
/* 時刻として書く項目。ここに入っているものは、セルが時刻型でも読めるようにします。

   スプレッドシートの空いたセルに 20:00 と打つと、Googleは
   それを「時刻」として覚えます。見た目は 20:00 のままですが、
   中身は日付つきの値です。そのままでは読めず、営業時間の設定が
   黙って既定の22時に戻り、閉めたはずの時間に予約が入ります。 */
const TIME_SETTINGS = ['営業開始', '営業終了', '最終受付'];

function readSettings_(ss) {
  const sheet = ss.getSheetByName(SETTING_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return {};
  const out = {};
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(r => {
    const k = String(r[0] || '').trim();
    if (!k) return;
    if (r[1] === '') { out[k] = ''; return; }
    /* サイトにもこの値がそのまま渡ります。読める形にして渡します。 */
    out[k] = TIME_SETTINGS.indexOf(k) >= 0 ? (normalizeTime_(r[1]) || String(r[1])) : r[1];
  });
  return out;
}

function writeSettings_(ss, obj) {
  const rows = Object.keys(obj || {}).map(k => ({ '項目': k, '内容': obj[k] }));
  writeSheetRows_(ss, SETTING_SHEET, ['項目', '内容'], rows);
}

/* ============================================================
   台帳の列の見つけ方

   台帳は店の人が毎日開く場所です。「メモ」や「支払い」の列を
   途中に足したくなるのは自然なことで、止める理由もありません。

   ところが、決め打ちの順番で読んでいると、列が1つ増えただけで
   全部が1つずれます。電話番号の欄からメールアドレスを読み、
   状態の欄から要望を読む――そんな台帳になります。しかも画面には
   何も出ません。ですから、位置ではなく見出しの名前で探します。
   ============================================================ */
/** どのシートでも使える、1行目の見出しの読み取り */
function sheetHeader_(sheet, fallback) {
  const width = Math.max(sheet.getLastColumn() || 0, fallback.length);
  const row = (sheet.getRange(1, 1, 1, width).getValues()[0] || [])
    .map(v => String(v == null ? '' : v).trim());
  // 見出しが空（作りたてのシート）なら、こちらの並びを使います
  return row.some(Boolean) ? row : fallback.slice();
}

function headerRow_(sheet) {
  return sheetHeader_(sheet, HEADERS);
}

/** 見出しの名前から列番号（0始まり）を返す関数を作ります */
function colIndex_(sheet) {
  const head = headerRow_(sheet);
  return function (name) {
    const i = head.indexOf(name);
    return i >= 0 ? i : HEADERS.indexOf(name);
  };
}

/** 台帳の1行を、いまの列の並びのまま読みます */
function readRow_(sheet, row) {
  return sheet.getRange(row, 1, 1, headerRow_(sheet).length).getValues()[0];
}

/** 台帳の2行目以降を、いまの列の並びのまま読みます */
function readRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, headerRow_(sheet).length).getValues();
}

/** 見出し名で書いた値を、いまの列の並びに並べ替えます */
function rowFor_(sheet, values) {
  return headerRow_(sheet).map(function (h) {
    return Object.prototype.hasOwnProperty.call(values, h) ? values[h] : '';
  });
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

/* 台帳にまだ無い予約番号を作る */
function issueCode_(sheet) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let n = 0; n < 50; n++) {
    let code = 'LM-';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (findRowByCode_(sheet, code) === -1) return code;
  }
  // ここまで来ることはまず無いが、必ず一意になる形で返す
  return 'LM-' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HHmmss');
}

/* 予約番号の「見た目のゆれ」を吸収します。

   お客様は日本語入力のまま打つことがあります。そのとき「-」は「ー」や
   「－」になり、英字は小文字や全角になります。番号は合っているのに
   「見つかりません」と出るのがいちばん困るので、英数字だけを取り出して
   大文字に揃えたものどうしを突き合わせます。 */
function codeKey_(v) {
  return String(v == null ? '' : v)
    .replace(/^'/, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

function findRowByCode_(sheet, code) {
  const key = codeKey_(code);
  if (!key) return -1;              // 空欄が空行に当たらないようにします
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const codes = sheet.getRange(2, 1, last - 1, 1).getValues();
  const i = codes.findIndex(r => codeKey_(r[0]) === key);
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

/** LINE公式アカウントへ通知を送る（LINE_TOKEN が空なら何もしない） */
function notifyLine_(text) {
  if (!LINE_TOKEN || !LINE_TO) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + LINE_TOKEN },
      payload: JSON.stringify({
        to: LINE_TO,
        messages: [{ type: 'text', text: text.slice(0, 4900) }]
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    // 通知の失敗で予約の記録まで止めない
    console.warn('LINE通知に失敗しました', err);
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

/* 日付の書き方をそろえます。

   休業日はスプレッドシートに店長が手で書きます。そのとき
   「2026/9/1」「2026年9月1日」のように書くのがふつうです。
   ここで読めないと、休みにしたはずの日に予約が入ります。
   静かに間違えるので、いちばん気づきにくい壊れ方です。 */
function normalizeDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  const s = halfWidth_(v).trim();
  const m = s.match(/^(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})\D?$/);
  if (!m) return s;
  const p = n => (n.length < 2 ? '0' + n : n);
  return m[1] + '-' + p(m[2]) + '-' + p(m[3]);
}

/* 時刻も同じです。「9:00」「9時」「０９：００」を同じものとして読みます。 */
function normalizeTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'HH:mm');
  const s = halfWidth_(v).trim();
  const m = s.match(/^(\d{1,2})\s*[:：時]\s*(\d{1,2})?/);
  if (!m) return s;
  const p = n => (String(n).length < 2 ? '0' + n : String(n));
  return p(m[1]) + ':' + p(m[2] || '00');
}

/* 「所要(分)」は数字だけで書かれるとは限りません。
   「60分」や全角の「６０」を読み落とすと、施術の長さが既定の30分に
   なり、次のお客様と重なります。 */
function parseMinutes_(v, fallback) {
  const n = parseInt(halfWidth_(v).replace(/[^0-9]/g, ''), 10);
  return isFinite(n) && n > 0 ? n : fallback;
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
   ★ 最初にこれだけ実行してください ★

   エディタ上部の関数選択で「はじめの準備」を選んで実行すると、
   次のことをまとめて行います。

   1. 予約台帳・単品メニュー・おすすめメニュー・スタイル・口コミ・休業日・設定 の7枚を作る
   2. 管理ページのパスワードを決める（下の PASSWORD に書いた文字列）
   3. 足りない設定があれば、実行ログに残りの手順を出す

   実行前に、下の PASSWORD をお好きな文字列に変えてください。
   実行が終わったら、この行は空 '' に戻して構いません
   （パスワードはスクリプトプロパティに保存済みのため、消しても動きます）。
   ============================================================ */
const PASSWORD = '';   // 例）'zer01-2026' のように決めてください

function はじめの準備() {
  const log = [];

  // 1. シートをそろえる
  getSheet_();          // 予約台帳
  setupMenuSheets();    // 単品メニュー・おすすめメニュー・スタイル・休業日・設定
  log.push('✅ シートを作成しました（予約一覧／メニュー／おすすめメニュー／スタイル／口コミ／休業日／設定）');

  // 2. 管理ページのパスワード
  const props = PropertiesService.getScriptProperties();
  if (PASSWORD) {
    props.setProperty('ADMIN_PASSWORD', PASSWORD);
    log.push('✅ 管理ページのパスワードを設定しました');
    log.push('   → 保存できたので、上の PASSWORD の行は空 \'\' に戻してください。'
      + 'コードに書いたまま誰かに画面を見せると、そのまま読まれてしまいます。');
  } else if (props.getProperty('ADMIN_PASSWORD')) {
    log.push('✅ 管理ページのパスワードは設定済みです');
  } else {
    log.push('❌ 管理ページのパスワードが未設定です。'
      + 'このファイル上部の PASSWORD にお好きな文字列を書いて、もう一度実行してください。');
  }

  // 3. 残りの手順
  if (!NOTIFY_EMAIL) {
    log.push('⚠️ 通知先メールが空です。上部の NOTIFY_EMAIL を設定してください。');
  } else {
    log.push('・予約の通知先： ' + NOTIFY_EMAIL + '（違う場合は上部の NOTIFY_EMAIL を直してください）');
  }
  log.push('');
  log.push('--- このあとの手順 ---');
  log.push('1. 「デプロイ → 新しいデプロイ → ウェブアプリ」を開く');
  log.push('2. 次のユーザーとして実行 → 自分／アクセスできるユーザー → 全員');
  log.push('   （「全員」にしないとお客様の予約が届きません）');
  log.push('3. 発行された .../exec のURLを、サイトの assets/js/data.js の');
  log.push('   reservationEndpoint に貼る');

  const text = log.join('\n');
  console.log(text);
  // スプレッドシートから実行したときは画面にも出す
  try { SpreadsheetApp.getUi().alert(text); } catch (e) { /* エディタ実行時は出せない */ }
  return text;
}

/* ============================================================
   初回だけ実行：メニューまわりのシートを作る
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
    menu.appendRow(['カット', 'メンテナンスカット', '4000〜', 40, 'ツーブロック・刈り上げ・フェードのメンテナンス', '', '○']);
    menu.setColumnWidth(2, 260);
    menu.setColumnWidth(5, 260);
    menu.setColumnWidth(6, 280);
    menu.getRange('C2').setNote('「4000〜」と書くと、サイトでも「¥4,000〜」と出ます。空欄はお見積り扱いです。');
    menu.getRange('F1').setNote('画像のURL。管理者ページから写真を選べば自動で入ります。');
  }

  const closed = ss.getSheetByName(CLOSED_SHEET) || ss.insertSheet(CLOSED_SHEET);
  if (closed.getLastRow() === 0) {
    closed.appendRow(CLOSED_HEADERS);
    closed.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#f3efea');
    closed.setFrozenRows(1);
    closed.setColumnWidth(1, 130);
    closed.setColumnWidth(2, 80);
    closed.setColumnWidth(3, 80);
    closed.setColumnWidth(4, 240);
    closed.getRange('A2').setNote('日付を入れるとその日は予約できなくなります（例 2026-09-15）');
    closed.getRange('B2').setNote('開始と終了を入れると、その時間帯だけ予約を止めます（例 14:00〜16:00）。'
      + '空欄のままなら、その日は終日お休みになります。');
  }

  const setting = ss.getSheetByName(SETTING_SHEET) || ss.insertSheet(SETTING_SHEET);
  if (setting.getLastRow() === 0) {
    setting.appendRow(['項目', '内容']);
    setting.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#f3efea');
    setting.setFrozenRows(1);
    setting.setColumnWidth(1, 150);
    setting.setColumnWidth(2, 420);
    [['電話番号', ''], ['営業開始', '09:00'], ['営業終了', '22:00'], ['最終受付', '21:00'],
     ['キャッチコピー', ''], ['お知らせ', ''], ['定休曜日', ''],
     ['LINE友だち追加URL', ''], ['Google口コミURL', ''],
     ['ロゴ画像', ''], ['スタッフ写真', ''], ['メイン写真', '']].forEach(r => setting.appendRow(r));
    setting.getRange('B8').setNote('休みにする曜日を「日,水」のように書きます。毎週その曜日が予約できなくなります。');
    setting.getRange('B9').setNote('LINE公式アカウントの友だち追加URL（https://lin.ee/… ）。入れると予約完了画面に案内が出ます。');
  }

  const style = ss.getSheetByName(STYLE_SHEET) || ss.insertSheet(STYLE_SHEET);
  if (style.getLastRow() === 0) {
    style.appendRow(STYLE_HEADERS);
    style.getRange(1, 1, 1, STYLE_HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
    style.setFrozenRows(1);
    style.setColumnWidth(1, 300);
    style.setColumnWidth(4, 300);
    style.getRange('B2').setNote('ギャラリーの絞り込みタブになります。「ショート」「カラー」「店内」など。');
    [['白髪ぼかし・ホワイトメッシュ', 'カラー', '白髪ぼかし,ホワイトメッシュ', '', '○'],
     ['スパイキーショート', 'ショート', 'ショート,フェード', '', '○'],
     ['シャドウパーマ・マッシュ', 'パーマ', 'パーマ,マッシュ', '', '○'],
     ['店内', '店内', '半個室,ドリンクサービス', '', '○']].forEach(r => style.appendRow(r));
  }

  const review = ss.getSheetByName(REVIEW_SHEET) || ss.insertSheet(REVIEW_SHEET);
  if (review.getLastRow() === 0) {
    review.appendRow(REVIEW_HEADERS);
    review.getRange(1, 1, 1, REVIEW_HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
    review.setFrozenRows(1);
    review.setColumnWidth(REVIEW_HEADERS.indexOf('本文') + 1, 420);
    review.getRange('K1').setNote('「掲載中」にした行だけがサイトに出ます。届いた直後は「未承認」です。');
  }

  const coupon = ss.getSheetByName(COUPON_SHEET) || ss.insertSheet(COUPON_SHEET);
  if (coupon.getLastRow() === 0) {
    coupon.appendRow(COUPON_HEADERS);
    coupon.getRange(1, 1, 1, COUPON_HEADERS.length).setFontWeight('bold').setBackground('#f3efea');
    coupon.setFrozenRows(1);
    [
      ["【清潔感と品が続く】men's骨格補正カット＋眉カット", 6900, '', 70,
        '骨格・髪質・雰囲気を見極めた大人メンズカジュアル。眉カットまで整えます。', '', '全員', '', '○'],
      ['【全ての身嗜み整える＋最高の体験を】ラグジュアリーカットコース', 10000, '', 110,
        'カットに加え、トリートメントとヘッドスパまで。身だしなみをトータルで整えます。', '', '全員', '', '○'],
      ['【毎朝のセット1分】品よく決まるお悩み解決メンズパーマ', 14500, '', 120,
        '直毛や動きが出にくい髪も、扱いやすく自然なメンズパーマに。', '', '全員', '', '○'],
      ['【彩で見せるワンランク上のお洒落を】カット＋カラー', 14500, '', 120,
        '髪の状態と仕上がりに合わせて薬剤を選び、品のある色味に仕上げます。', '', '全員', '', '○'],
      ["【立体感で格が上がる】伸びても自然！白髪ぼかしホワイトメッシュ men's", 19800, '', 150,
        '白髪を隠すのではなく活かす白髪ぼかし。伸びても境目が出にくい仕上がりに。', '', '全員', '', '○'],
      ['【地毛より綺麗】自然に柔らかく仕上げるメンズ縮毛矯正', 22000, '', 180,
        'クセや広がりを抑えつつ、不自然にならない自然な質感に。', '', '全員', '', '○']
    ].forEach(r => coupon.appendRow(r));
    coupon.setColumnWidth(1, 320);
    coupon.setColumnWidth(5, 300);
  }

  SpreadsheetApp.getUi
    ? console.log('メニューのシートを作成しました')
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

  /* 同じ日のぶんを二度送らないようにします。

     トリガーは、こちらが何もしなくても二度動くことがあります。
     動作を確かめようとして手で実行することもあります。そのたびに
     お客様へ「明日のご予約」がもう一通届くのは、店の信用に関わります。
     送った日付を控えておき、同じ日なら何もしません。 */
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('REMINDED_DATE') === target) {
    console.log(`リマインドは送信済みです（対象日 ${target}）`);
    return;
  }
  props.setProperty('REMINDED_DATE', target);

  const rows = readRows_(sheet);
  const col = colIndex_(sheet);
  let sent = 0;

  rows.forEach(r => {
    if (isCancelled_(r[col('状態')])) return;
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
