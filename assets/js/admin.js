/* ============================================================
 *  管理ページ
 *
 *  パスワードはサイトのソースには持たせず、入力された値を
 *  Google Apps Script 側に送って照合します。
 *  （スクリプトプロパティ ADMIN_PASSWORD に保存）
 *  そのため、ソースを読まれてもパスワードは分かりません。
 * ============================================================ */

let adminPw = '';          // 入力されたパスワード（この画面を開いている間だけ保持）
let adminToken = '';       // 「この端末を記憶する」で受け取った合鍵
let adminData = null;      // 取得した内容
/* 読み込んだ時点のシートの印。保存時に送って、
   そのあいだに別の端末から保存されていないかを見てもらう。 */
let stamps = {};
const edits = { closed: [], menus: [], coupons: [], styles: [], reviews: [], settings: {} };

/* いま入力欄を開いている行（メニュー・おすすめメニュー・写真）。
   -1 なら一覧だけ。

   なぜ「1件だけ」か：以前はメニュー4件ぶんの入力欄が縦に全部並んでいて、
   単品メニューのタブは3648pxありました（画面は844px）。
   どんなメニューがあるのかを見るだけでも、全項目を読みながら
   何度も指を送ることになり、直したい1件を探せませんでした。 */
const openRow = { menus: 0, coupons: 0, styles: 0 };

/* 読み込んだ時点の中身。「まだ保存していない」を出すために使います。

   保存は「edits に溜めて、保存ボタンで一括」です。1件直して一覧に戻ると
   見た目は落ち着くので、そこで手が離れて保存を押し忘れます。
   押し忘れたまま画面を閉じると、直した値段は消えて元のままになります。

   行そのもの（オブジェクト）を鍵にします。番号で覚えると、
   途中で1件消したときに残りの行の番号がずれ、直していない行まで
   「未保存」と出て、どれを直したのか分からなくなります。 */
const rowBase = new WeakMap();
const baseCount = {};
let settingsBase = '';
/* 保存できたことを、そのタブの保存バーに残しておくための控え */
const savedNote = {};

/* 記憶した合鍵の置き場所。パスワードそのものは保存しません。
   合鍵は Apps Script 側で発行・失効させるため、盗まれても店側で無効にできます。 */
const TOKEN_KEY = 'salon.adminToken.v1';

/* 休業日は「終日」と「この時間帯だけ」の両方を扱います。
   開始・終了が空なら終日、入っていればその帯だけ止まります。 */
const CLOSED_COLS = ['休業日', '開始', '終了', 'メモ'];
const MENU_COLS = ['区分', 'メニュー名', '価格', '所要(分)', '説明', '画像', '表示'];
const COUPON_COLS = ['メニュー名', '価格', '通常価格', '所要(分)', '説明', '条件', '対象', '画像', '表示'];
const STYLE_COLS = ['タイトル', '分類', 'タグ', '画像', '表示'];
const REVIEW_COLS = ['投稿日', '予約番号', 'ニックネーム', '年代', '性別',
                     '評価', 'タイトル', '本文', '担当', 'メニュー', '状態'];
const SETTING_KEYS = [
  ['電話番号', 'tel', '例）0297-00-0000。空欄にすると電話ボタンを出しません'],
  ['営業開始', 'time', ''],
  ['営業終了', 'time', ''],
  ['最終受付', 'time', ''],
  ['キャッチコピー', 'text', 'トップの大見出しに出ます'],
  ['お知らせ', 'text', 'トップの上部に帯で出ます。空欄なら出ません'],
  ['LINE友だち追加URL', 'url',
   'LINE公式アカウントの「友だち追加」URL（https://lin.ee/… ）。入れると予約完了画面とフッターに案内が出ます'],
  ['Google口コミURL', 'url',
   'Googleビジネスプロフィールの「クチコミを書く」URL。空欄なら案内を出しません'],
  ['ロゴ画像', 'image', 'ヘッダーとトップに出るロゴ。写真を選ぶと自動で入ります'],
  ['スタッフ写真', 'image', 'スタッフ紹介に出る写真'],
  ['メイン写真', 'image', 'トップの一番上に大きく出る写真。店内や施術中の写真がおすすめです']
];
const WEEK_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/* ---------- 受信先とのやりとり ---------- */
async function adminPost(payload) {
  if (!SALON.reservationEndpoint) {
    return { ok: false, error: '受信先（Google Apps Script）が未設定です。' };
  }
  try {
    const res = await fetch(SALON.reservationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, password: adminPw, token: adminToken })
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: '通信に失敗しました。' };
  }
}

/* ---------- ログイン ---------- */
async function login() {
  const btn = $('#gate-btn');
  const err = $('#gate-error');
  adminPw = $('#passcode').value;
  err.style.display = 'none';

  if (!adminPw) {
    err.textContent = 'パスワードを入力してください。';
    err.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = '確認中…';
  const remember = !!($('#remember-me') || {}).checked;
  const res = await adminPost({ type: 'adminLogin', remember });
  btn.disabled = false;
  btn.textContent = 'ログイン';

  if (!res.ok) {
    adminPw = '';
    err.textContent = res.error || 'ログインできませんでした。';
    err.style.display = 'block';
    return;
  }
  if (res.token) {
    adminToken = res.token;
    try { localStorage.setItem(TOKEN_KEY, res.token); } catch (e) { /* 保存できなくても続行 */ }
  }
  await openDashboard();
}

/** 記憶した合鍵を捨てて、もう一度パスワードを聞く状態に戻す */
function forgetDevice() {
  /* このボタンはタブの列に並んでいます。スマホではタブが折り返して
     すぐ隣に来るので、タブを押したつもりで当たります。
     押した瞬間にパスワードからやり直しになり、
     お客様を待たせている最中だと手が止まります。 */
  if (!confirm('この端末の記憶を消します。次からはパスワードの入力が必要になります。よろしいですか？')) return;
  adminToken = '';
  adminPw = '';
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* noop */ }
  location.reload();
}

async function openDashboard() {
  const res = await adminPost({ type: 'adminData' });
  if (!res.ok) {
    const message = res.error || '読み込みに失敗しました。';
    /* 開いたあとの読み直し（キャンセルの反映など）で失敗したときは、
       ログイン画面のエラー欄は隠れたままで誰も読めません。
       黙って古い予定を出しておくと、キャンセルが通ったのかどうか
       分からないまま、その枠を空きだと思って別のお客様を入れてしまいます。 */
    if (!$('#dashboard').hidden) {
      alert('最新の予定を読み込めませんでした。\n' + message
        + '\n電波の届くところで、この画面を開き直してください。');
      return false;
    }
    $('#gate-error').textContent = message;
    $('#gate-error').style.display = 'block';
    return false;
  }
  adminData = res;
  edits.closed = (res.closedDates || []).map(r => ({ ...r }));
  edits.menus = (res.menus || []).map(r => ({ ...r }));
  edits.coupons = (res.coupons || []).map(r => ({ ...r }));
  edits.styles = (res.styles || []).map(r => ({ ...r }));
  edits.reviews = (res.reviews || []).map(r => ({ ...r }));
  edits.settings = { ...(res.settings || {}) };
  stamps = { ...(res.stamps || {}) };

  /* 読み直したので、前に開いていた行の番号はもう当てになりません。
     先頭に戻します（先頭を開いておく理由は renderList のところに書いています）。 */
  openRow.menus = 0; openRow.coupons = 0; openRow.styles = 0;
  ['closed', 'menus', 'coupons', 'styles', 'reviews', 'settings'].forEach(markSaved);

  $('#gate').hidden = true;
  $('#dashboard').hidden = false;
  renderStats();
  renderReservations();
  renderCustomers();
  renderClosed();
  renderList('menus');
  renderList('coupons');
  renderList('styles');
  renderReviews();
  renderSettings();
  updateDirty();
  return true;
}

/* ---------- 予約一覧 ---------- */
function filteredReservations() {
  const date = $('#filter-date').value;
  const status = $('#filter-status').value;
  return (adminData.reservations || [])
    .filter(r => !date || r.date === date)
    .filter(r => status === 'all'
      || (status === 'cancelled' ? r.status === 'キャンセル' : r.status !== 'キャンセル'));
}

function renderStats() {
  const live = (adminData.reservations || []).filter(r => r.status !== 'キャンセル');
  const today = toKey(new Date());
  /* 「今後7日間」は今日を1日目に数えます。+7 だと今日を入れて8日分になり、
     売上見込みが1日ぶん多く出ます。仕入れの判断に使う数字なので合わせます。 */
  const week = new Date(); week.setDate(week.getDate() + 6);
  const weekKey = toKey(week);
  const inWeek = live.filter(r => r.date >= today && r.date <= weekKey);

  $('#stats').innerHTML = [
    ['本日のご予約', `${live.filter(r => r.date === today).length}件`],
    ['今後7日間', `${inWeek.length}件`],
    ['7日間の売上見込', yen(inWeek.reduce((s, r) => s + (Number(r.price) || 0), 0))],
    ['キャンセル', `${(adminData.reservations || []).filter(r => r.status === 'キャンセル').length}件`]
  ].map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
}

/* 日付の見出し。今日・明日は日付より先に、その言葉で分かるようにします */
function dayHeading(date) {
  const today = toKey(new Date());
  const t = new Date(); t.setDate(t.getDate() + 1);
  const tomorrow = toKey(t);
  const label = date === today ? '本日' : date === tomorrow ? '明日' : '';
  return { label, text: formatDateJa(date) };
}

/* 休業日タブで入れた「受けない時間帯」を、その日の予定に混ぜて返します。
   設定したのに予定表に出てこないと、入れたこと自体を忘れて
   「なぜかこの時間だけ予約が来ない」と悩むことになります。 */
function closedBlocksOn(date) {
  return (adminData.closedDates || [])
    .filter(r => r['休業日'] === date && r['開始'] && r['終了'])
    .map(r => ({ 受付停止: true, date, time: r['開始'], endTime: r['終了'], memo: r['メモ'] || '' }));
}
function closedAllDay(date) {
  return (adminData.closedDates || [])
    .some(r => r['休業日'] === date && !(r['開始'] && r['終了']));
}

/* 過ぎたご予約を出しているか。
   日付を選んでいないときは、本日より前を畳んでおきます。
   台帳は消さずに溜まっていくので、半年も使えば古い日が何十件も先に並び、
   本日にたどり着くまで指を動かし続けることになります。
   この画面の主な使い方は、朝いちばんに「今日は何時から何件か」を見ることです。 */
let showPast = false;

function renderReservations() {
  const list = filteredReservations();

  /* 来店日ごとにまとめ、早い順に並べます。
     カードが縦に並ぶだけだと、その日が何件なのか数えないと分かりません。
     朝いちばんに開いて「今日は何時から何件か」を見るのが主な使い方なので、
     日付で区切って件数を添えます。 */
  const byDate = new Map();
  list.forEach(r => {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  });

  // 予約が1件も無い日でも、受付を止めているならその日は出します
  const dateFilter = $('#filter-date').value;
  (adminData.closedDates || []).forEach(r => {
    const d = r['休業日'];
    if (!d || (dateFilter && d !== dateFilter)) return;
    if (!byDate.has(d)) byDate.set(d, []);
  });

  /* 日付を選んでいるときは、それが過ぎた日でもそのまま出します。
     わざわざ選んだ日が出てこないほうが困ります。 */
  const today = toKey(new Date());
  const sorted = [...byDate.keys()].sort();
  const pastKeys = dateFilter ? [] : sorted.filter(d => d < today);
  const pastCount = pastKeys.reduce((n, d) => n + byDate.get(d).length, 0);
  const keys = (pastKeys.length && !showPast) ? sorted.filter(d => d >= today) : sorted;

  /* 過去は捨てずに、押せば出します。「先月の◯◯さんは何をしたか」を
     見たいことがありますし、消えていると台帳から落ちたように見えます。 */
  const pastButton = pastKeys.length
    ? `<button class="btn btn-ghost btn-sm" type="button" data-toggle-past style="margin-bottom:14px;">${
        showPast ? '過ぎたご予約を畳む' : `過ぎたご予約（${pastCount}件）も見る`}</button>`
    : '';

  if (!keys.length) {
    /* 「該当する予約はありません」だけだと、絞り込んだままなのか
       本当に1件も無いのかが分かりません。片方を思い込むと、
       入っているはずの予約を見落とすか、入っていない予約を待つことになります。 */
    const total = (adminData.reservations || []).length;
    const message = (dateFilter || $('#filter-status').value !== 'all')
      ? 'この条件に合うご予約はありません。上の「条件をクリア」で戻せます。'
      : total ? '本日より先のご予約は、まだありません。'
        : 'まだご予約はありません。電話で受けたご予約は「＋ 電話予約を入れる」から台帳に入れてください。';
    $('#admin-rows').innerHTML = pastButton + `<p class="empty-state">${esc(message)}</p>`;
    return;
  }

  $('#admin-rows').innerHTML = pastButton + keys.map(date => {
    const rows = byDate.get(date);
    const h = dayHeading(date);
    const live = rows.filter(r => r.status !== 'キャンセル').length;
    const allDay = closedAllDay(date);
    /* 休みにした日に予約が残っていることがあります（先に入っていた分）。
       件数を隠すと気づけないので、両方まとめて出します。 */
    const count = allDay
      ? (live ? `終日お休み・予約${live}件あり` : '終日お休み')
      : live ? `${live}件`
        : rows.length ? `キャンセル${rows.length}件のみ` : '予約なし';

    // 予約と「受けない時間帯」を、時刻順に混ぜて並べます
    const items = rows.concat(closedBlocksOn(date))
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));

    return `
      <div class="day-heading">
        ${h.label ? `<span class="day-badge">${esc(h.label)}</span>` : ''}
        <span class="day-date">${esc(h.text)}</span>
        <span class="day-count">${esc(count)}</span>
      </div>
      ${allDay ? `<div class="closed-block is-allday">この日は終日、予約を受け付けていません${
        live ? '（下のご予約は、休みにする前に入っていたものです）' : ''}</div>` : ''}
      ${items.map(x => (x.受付停止 ? closedCard(x) : reservationCard(x))).join('')}`;
  }).join('');
}

function closedCard(c) {
  return `
    <div class="closed-block">
      <span class="booking-time">${esc(c.time)}〜${esc(c.endTime)}</span>
      <span>予約を受け付けていません${c.memo ? `（${esc(c.memo)}）` : ''}</span>
    </div>`;
}

function reservationCard(r) {
  const off = r.status === 'キャンセル';
  /* 電話で受けた予約は、番号を控えていないことがあります。
     そのまま空のリンクを出すと、押しても何も起きない場所ができます。 */
  const tel = telKey(r.tel);
  return `
    <article class="booking-card ${off ? 'is-cancelled' : ''}">
      <div class="booking-head">
        <span class="booking-time">${esc(r.time)}〜${esc(r.endTime)}</span>
        ${off ? '<span class="status-chip is-cancelled">キャンセル</span>' : ''}
        <span class="booking-code">${esc(r.code)}</span>
      </div>
      <p class="booking-name">${esc(r.name)} 様<small>${esc(r.visit || '—')}</small></p>
      <p class="booking-detail">${esc(r.menu)}／${esc(r.staffName)}</p>
      <p class="booking-detail">${yen(r.price)}／${tel
        ? `<a href="tel:${tel}" style="text-decoration:underline">${esc(r.tel)}</a>`
        : '電話番号の控えなし'}
      </p>
      ${r.request ? `<p class="booking-request">ご要望：${esc(r.request)}</p>` : ''}
      ${off ? '' : `<div style="margin-top:12px;">
        <button class="btn btn-ghost btn-sm" type="button" data-admin-cancel="${esc(r.code)}">キャンセルにする</button>
      </div>`}
    </article>`;
}

/* ---------- 電話・来店で受けた予約を台帳に入れる ----------
   ここが無いと、電話で受けた分が台帳に無いまま残り、
   同じ時間にネット予約が入ります。 */
function toggleAddBooking(open) {
  $('#add-booking-form').hidden = !open;
  $('#ab-error').style.display = 'none';
  // 前に入れたぶんの結果が残っていると、今入れた結果と読み違えます
  if (open) $('#add-result').hidden = true;
  if (open) {
    // 何も入っていなければ今日を入れておく（毎回打つのは面倒なので）
    if (!$('#ab-date').value) $('#ab-date').value = toKey(new Date());
    $('#ab-name').focus();
  }
}

/* 数字の欄に打たれた「４５００」「4,500円」「90分」を数にします。
   店主は日本語入力のまま打つので、数字は全角になります。
   全角を読み落とすと、金額は0円、所要は既定の60分として黙って登録され、
   90分の施術に60分の枠しか押さえられず、次のお客様と重なります。 */
function numberOf(value, fallback) {
  const t = toHalfWidth(value).replace(/[,¥￥円分\s]/g, '').trim();
  if (t === '') return fallback;
  const n = Number(t);
  return isFinite(n) ? n : NaN;
}

async function saveAddBooking(force = false) {
  const err = $('#ab-error');
  const btn = $('#ab-save');
  err.style.display = 'none';

  const minutes = numberOf($('#ab-minutes').value, 60);
  const price = numberOf($('#ab-price').value, 0);
  const payload = {
    type: 'adminAdd', force,
    date: $('#ab-date').value,
    time: $('#ab-time').value,
    minutes,
    price,
    name: $('#ab-name').value.trim(),
    /* 全角のまま台帳に入れると、お客様タブでまとめられず（番号なし扱い）、
       カードの電話をかけるリンクも押せなくなります。 */
    tel: normalizeTel($('#ab-tel').value),
    menu: $('#ab-menu').value.trim(),
    memo: $('#ab-memo').value.trim()
  };
  if (!payload.date || !payload.time) { showAddError('来店日と開始時刻をお選びください。'); return; }
  if (!payload.name) { showAddError('お名前をご入力ください。'); return; }
  /* 所要が0や負だと、終わりの時刻が始まりより前になります。
     押さえた気になっているのに枠が空いたままで、同じ時間にネット予約が入ります。 */
  if (!(minutes >= 15 && minutes <= 480)) {
    showAddError('所要（分）は15〜480の数字でご入力ください。'); return;
  }
  if (!(price >= 0)) { showAddError('金額は数字でご入力ください（空欄でもかまいません）。'); return; }
  /* スマホの日付は目盛りを回して選ぶので、指がすべると年や月ごと動きます。
     過ぎた日で入れると畳んだ過去側に入って一覧に出ないため、
     入っていないと思ってもう一度入れることになります。 */
  if (!force && payload.date < toKey(new Date())
      && !confirm(`${formatDateJa(payload.date)}は過ぎた日付です。このまま台帳に入れますか？`)) {
    return;
  }

  btn.disabled = true;
  btn.textContent = '登録中…';
  const res = await adminPost(payload);
  btn.disabled = false;
  btn.textContent = '台帳に入れる';

  /* 重なり・休業日は止めずに確認します。
     店が承知のうえで入れることがあるためです。 */
  if (!res.ok && res.confirm) {
    if (confirm(res.error + '\n\n※ネット予約とは別に、店側の判断で入れられます。')) {
      return saveAddBooking(true);
    }
    return;
  }
  if (!res.ok) { showAddError(res.error || '登録できませんでした。'); return; }

  // 画面上の一覧にもすぐ足す（読み込み直さなくても見えるように）
  (adminData.reservations = adminData.reservations || []).push({
    code: res.code, date: payload.date, time: payload.time, endTime: res.endTime,
    menu: payload.menu || '（電話予約）', staffName: '', price: payload.price,
    name: payload.name, tel: payload.tel, email: '', visit: '電話・来店',
    request: payload.memo, status: '予約確定'
  });
  /* 過ぎた日で入れたときは、過去を開いた状態にします。
     承知のうえで入れた（先週ぶんの記録など）のに一覧から消えると、
     入っていないと思ってもう一度入れることになります。 */
  if (payload.date < toKey(new Date())) showPast = true;
  renderStats();
  renderReservations();
  ['#ab-name', '#ab-tel', '#ab-menu', '#ab-memo', '#ab-price'].forEach(id => { $(id).value = ''; });
  toggleAddBooking(false);

  /* 結果は一覧の手前に出して、その場まで画面を送ります。
     ページのいちばん下の保存メッセージは、予約カードの下に隠れていて、
     スマホでは見えません。入れたのに何も出ないと、
     もう一度押して同じ予約を二重に入れてしまいます。 */
  const note = $('#add-result');
  const filterDate = $('#filter-date').value;
  const outOfView = (filterDate && filterDate !== payload.date)
    || $('#filter-status').value === 'cancelled';
  note.textContent = `台帳に入れました（予約番号 ${res.code}）。`
    + `${formatDateJa(payload.date)} ${payload.time}〜 は、ネット予約から埋まります。`
    + (outOfView ? '（いま絞り込み中のため、下の一覧には出ていません）' : '');
  note.hidden = false;
  note.scrollIntoView({ block: 'center' });
}

function showAddError(message) {
  const err = $('#ab-error');
  err.textContent = message;
  err.style.display = 'block';
  // 入力欄が長いので、押したボタンから離れた場所に出ると読まれません
  err.scrollIntoView({ block: 'center' });
}

/* ---------- お客様 ----------
   顧客名簿を別に作ってはいません。**予約台帳をまとめ直しているだけ**です。
   同じ人かどうかは電話番号で見ます。お名前は表記ゆれがあり、
   メールは端末を変えると変わることがあるためです。
   新しい情報を集めていないので、消すときも予約台帳の行を消すだけで済みます。 */
function telKey(tel) {
  /* 全角で控えられた番号（０９０…）も同じ番号として扱います。
     半角だけ見ていると、その行は「番号なし」としてお客様タブから丸ごと消え、
     カードの電話リンクも空になります。シートに直接打たれた行や、
     店主が全角のまま入れた電話予約が、ここに来ます。 */
  return toHalfWidth(tel).replace(/[^0-9]/g, '');
}

/* 探すときの文字のゆれを、こちらで吸収します。
   店主は日本語入力を切り替えずに打つので、番号もスペースも全角になります。
   出てこないと「そのお客様は初めて」と思い込み、前回のご要望を見ないまま
   施術に入ることになります。 */
function searchKey(v) {
  return toKatakana(toHalfWidth(v)).replace(/\s+/g, '').toLowerCase();
}

function buildCustomers() {
  const map = new Map();
  (adminData.reservations || []).forEach(r => {
    const key = telKey(r.tel);
    if (!key) return;                       // 電話番号が無い行はまとめようがない
    if (!map.has(key)) {
      map.set(key, { tel: r.tel, name: r.name, email: r.email, visits: [] });
    }
    const c = map.get(key);
    c.visits.push(r);
    // お名前とメールは、いちばん新しい予約のものを採ります
    if (!c.last || r.date > c.last) { c.last = r.date; c.name = r.name; c.email = r.email; }
  });
  return [...map.values()].map(c => {
    c.visits.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    /* 1つの番号を家族で使う店です（固定電話、親子でご来店）。
       いちばん新しいお名前だけ覚えていると、ご主人の履歴が奥様の名前で並び、
       前回のご要望を取り違えます。また、古いほうのお名前で探しても
       出てこなくなります。使われたお名前は全部持っておきます。 */
    c.names = [...new Set(c.visits.map(v => String(v.name || '').trim()).filter(Boolean))];
    c.done = c.visits.filter(v => v.status !== 'キャンセル');
    c.spent = c.done.reduce((s, v) => s + (Number(v.price) || 0), 0);
    return c;
  });
}

function renderCustomers() {
  const q = ($('#customer-search') || {}).value || '';
  const sort = ($('#customer-sort') || {}).value || 'recent';
  const needle = searchKey(q);
  const digits = telKey(q);

  let list = buildCustomers().filter(c => !needle
    || c.names.some(n => searchKey(n).includes(needle))
    || (digits && telKey(c.tel).includes(digits)));

  list.sort((a, b) => sort === 'visits' ? b.done.length - a.done.length
    : sort === 'name' ? String(a.name).localeCompare(String(b.name), 'ja')
      : String(b.last).localeCompare(String(a.last)));

  if (!list.length) {
    $('#customer-rows').innerHTML = (adminData.reservations || []).length
      ? '<p class="empty-state">該当するお客様はいません。</p>'
      : '<p class="empty-state">ご予約が入ると、ここにお客様が並びます。</p>';
    return;
  }

  $('#customer-rows').innerHTML = list.map(c => {
    const latest = c.done[0] || c.visits[0];
    // 家族で番号を分け合っているときだけ、どなたのご来店かを添えます
    const shared = c.names.length > 1;
    const who = v => (shared ? esc(v.name || '（お名前なし）') + '／' : '');
    /* 来店回数は「キャンセルを除いた予約の数」です。
       実際に来られたかどうかまでは分からないので、そう書いておきます。 */
    return `
      <article class="booking-card">
        <div class="booking-head">
          <span class="customer-name">${esc(c.name || '（お名前なし）')}</span>
          <span class="status-chip">${c.done.length}回</span>
        </div>
        ${shared ? `<p class="booking-detail">この番号でご予約：${esc(c.names.join('・'))} 様</p>` : ''}
        <p class="booking-detail">
          <a href="tel:${esc(telKey(c.tel))}" style="text-decoration:underline">${esc(c.tel)}</a>
          ${c.email ? `／ ${esc(c.email)}` : ''}
        </p>
        <p class="booking-detail">ご予約の合計 ${yen(c.spent)}</p>
        ${latest ? `<p class="booking-detail">前回：${formatDateJa(latest.date)}／${who(latest)}${
          esc(latest.menu)}${latest.status === 'キャンセル' ? '（キャンセル）' : ''}</p>` : ''}
        <details class="customer-history">
          <summary>ご来店の履歴（${c.visits.length}件）</summary>
          <ul>
            ${c.visits.map(v => `
              <li${v.status === 'キャンセル' ? ' class="is-cancelled"' : ''}>
                <span class="hist-date">${formatDateJa(v.date)} ${esc(v.time)}</span>
                <span class="hist-menu">${who(v)}${esc(v.menu)}${v.status === 'キャンセル' ? '（キャンセル）' : ''}</span>
                ${v.request ? `<span class="hist-request">ご要望：${esc(v.request)}</span>` : ''}
              </li>`).join('')}
          </ul>
        </details>
      </article>`;
  }).join('');
}

/* ---------- 写真 ----------
   選んだ写真をブラウザ側で長辺1200pxまで縮めてから送ります。
   スマホの写真はそのままだと数MBあり、Apps Script が受け取りきれないためです。
   縮めた画像は Apps Script が Google ドライブに保存し、
   サイトから表示できるURLを返してきます。ファイル名も向こうで付け直します。 */
const MAX_EDGE = 1200;

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('画像として開けませんでした。'));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        // PNG は透過を保つためそのまま、それ以外は JPEG に寄せて軽くする
        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve({ dataUrl: canvas.toDataURL(mime, 0.85), mimeType: mime });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function uploadImage(file, slot) {
  if (!file.type || file.type.indexOf('image/') !== 0) {
    throw new Error('画像ファイルを選んでください。');
  }
  const { dataUrl, mimeType } = await shrinkImage(file);
  const res = await adminPost({ type: 'adminUpload', slot, mimeType, dataBase64: dataUrl });
  if (!res.ok) throw new Error(res.error || 'アップロードに失敗しました。');
  return res.url;
}

/** 画像1つぶんの入力欄。URL欄・選択ボタン・小さな見本 */
function imageField(label, url, attrs, slot, mark = '') {
  const v = url == null ? '' : String(url);
  return `
    <div class="form-field"${mark} style="margin:0 0 10px;">
      <span style="display:block;font-size:12px;color:var(--muted);margin-bottom:5px;">${esc(label)}</span>
      <div class="image-picker">
        <div class="image-preview">${v ? `<img src="${esc(v)}" alt="" />` : '<span>写真なし</span>'}</div>
        <div class="image-picker-body">
          <input class="input" type="text" value="${esc(v)}" placeholder="写真を選ぶと自動で入ります" ${attrs} />
          <div class="image-picker-actions">
            <label class="btn btn-outline btn-sm">
              写真を選ぶ
              <input type="file" accept="image/*" hidden data-upload="${esc(slot)}" />
            </label>
            ${v ? '<button class="btn btn-ghost btn-sm" type="button" data-clear-image>削除</button>' : ''}
          </div>
          <p class="image-picker-note" hidden></p>
        </div>
      </div>
    </div>`;
}

/* 写真を選んだときの共通処理。どの入力欄に結果を書くかは、
   同じ .image-picker の中の text 入力を見て決めます。 */
async function handleUpload(input) {
  const file = (input.files || [])[0];
  if (!file) return;
  const picker = input.closest('.image-picker');
  const note = picker.querySelector('.image-picker-note');
  const text = picker.querySelector('input[type="text"]');
  note.hidden = false;
  note.style.color = 'var(--muted)';
  note.textContent = 'アップロード中…';

  try {
    const url = await uploadImage(file, input.dataset.upload);
    text.value = url;
    // 手入力と同じ扱いにして、編集内容に反映させる
    text.dispatchEvent(new Event('input', { bubbles: true }));
    picker.querySelector('.image-preview').innerHTML = `<img src="${esc(url)}" alt="" />`;
    note.style.color = 'var(--ok)';
    note.textContent = '写真を登録しました。保存を押すとサイトに出ます。';
  } catch (err) {
    note.style.color = 'var(--danger)';
    note.textContent = String(err.message || err);
  } finally {
    input.value = '';
  }
}

/* ---------- 行の編集（休業日 / メニュー / おすすめメニュー / 写真） ---------- */
function fieldFor(col, value, target, index) {
  const v = value == null ? '' : value;
  /* どの欄かをCSSから見分けられるようにしておきます。
     価格・所要のような短い欄を横に2つ並べて、入力欄の縦を詰めるためです。
     縦に全部並べると、1件ぶんだけで画面1つぶんを超えて、
     いちばん下の「表示」に届く前に何を直していたか分からなくなります。 */
  const mark = ` data-field="${esc(col)}"`;
  if (col === '画像') {
    return imageField('画像',
      v,
      `data-target="${target}" data-index="${index}" data-col="画像"`,
      target + '-' + index, mark);
  }
  if (col === '表示') {
    return `<label class="checkbox-line"${mark} style="margin-top:8px;">
        <input type="checkbox" data-target="${target}" data-index="${index}" data-col="${esc(col)}"
               ${String(v).trim() === '×' ? '' : 'checked'} />
        <span>サイトに表示する</span>
      </label>`;
  }
  // 価格は「4000〜」と書けるようにしたいので number にはしない
  const type = (col === '通常価格' || col === '所要(分)') ? 'number'
    : col === '休業日' ? 'date'
      : (col === '開始' || col === '終了') ? 'time' : 'text';
  const hint = col === '開始' ? '空欄なら終日お休みになります'
    : col === '終了' ? '例）14:00〜16:00 だけ止める' : '';
  return `
    <label class="form-field"${mark} style="margin:0 0 10px;">
      <span style="display:block;font-size:12px;color:var(--muted);margin-bottom:5px;">${esc(col)}${
        hint ? `<small style="margin-left:8px;font-weight:400;">${esc(hint)}</small>` : ''}</span>
      <input class="input" type="${type}" value="${esc(v)}"
             data-target="${target}" data-index="${index}" data-col="${esc(col)}" />
    </label>`;
}

/* 休業日だけは、日付・開始・終了・メモの4つしかなく、
   しかも入れたその場で見比べたい（同じ日が2つ無いか）ので、
   いままでどおり全部そのまま並べます。 */
function renderRows(target, cols, host) {
  const rows = edits[target];
  $(host).innerHTML = rows.length
    ? rows.map((row, i) => `
        <div class="booking-card" style="border-left-color:var(--line);">
          ${cols.map(c => fieldFor(c, row[c], target, i)).join('')}
          <button class="btn btn-ghost btn-sm" type="button" data-remove="${target}" data-index="${i}"
                  style="margin-top:10px;">この行を削除</button>
        </div>`).join('')
    : '<p class="empty-state">まだ登録がありません。下のボタンから追加してください。</p>';
}

function renderClosed() {
  renderRows('closed', CLOSED_COLS, '#closed-rows');
}

/* ============================================================
   一覧 → 押した1件だけ入力欄を開く（メニュー／おすすめメニュー／写真）

   直す前は、1件ぶんの入力欄（区分・メニュー名・価格・所要・説明・画像・表示）が
   件数ぶん縦に並んでいるだけでした。単品メニュー4件で縦3648px、画面の4画面ぶんです。
   ・どんなメニューがあるのか、一覧では分からない
   ・カードの先頭が「区分」なので、何を編集しているのか2つ目の欄まで読まないと分からない
   ・保存がいちばん下にあるので、1件の値段を直すだけで長い往復になる
   という状態でした。

   そこで「1行1件の一覧」を上に置き、押した1件ぶんだけ入力欄を一覧の下に出します。
   一覧は上に残したままなので、直したあとも何があるかを見失いません。

   はじめは先頭の1件を開いた形で出します（openRow の初期値）。全部閉じていると、
   行が押せること自体に気づけません。使うのはコードを触らない方で、
   説明を読まずに触ります。いちばん上は必ず目に入るので、そこが開いていれば
   「押すと、その1件が開く」と分かります。
   ============================================================ */

/* 一覧の1行に何を出すか。タブごとに「何を見れば、その1件だと分かるか」が違います */
const LIST_VIEW = {
  menus: {
    title: r => r['メニュー名'],
    sub: r => `${priceText(r['価格'])} ・ ${minutesText(r['所要(分)'])}`,
    thumb: false,
    addLabel: '＋ メニューを追加',
    empty: 'まだメニューがありません。下の「＋ メニューを追加」から入れてください。'
  },
  coupons: {
    title: r => r['メニュー名'],
    sub: r => {
      const list = String(r['通常価格'] ?? '').trim();
      return `${priceText(r['価格'])}${list ? `（通常 ${priceText(list)}）` : ''}`
        + ` ・ ${minutesText(r['所要(分)'])}`;
    },
    thumb: false,
    addLabel: '＋ おすすめメニューを追加',
    empty: 'まだおすすめメニューがありません。下の「＋ おすすめメニューを追加」から入れてください。'
  },
  styles: {
    title: r => r['タイトル'],
    /* 写真タブだけは一覧にも写真を出します。
       タイトルだけ並べても、どの写真のことか思い出せません。 */
    /* タグはシートに「ショート,フェード」のように区切って入っています。
       打たれたままだと読点が並んで読みにくいので、サイト側と同じ区切りで割り直します。 */
    sub: r => [String(r['分類'] || '').trim() || '分類なし',
               String(r['タグ'] || '').split(/[,、・\s]+/).filter(Boolean).join('・')]
      .filter(Boolean).join(' ・ '),
    thumb: true,
    addLabel: '＋ 写真を追加',
    empty: 'まだ写真がありません。下の「＋ 写真を追加」から入れてください。'
  }
};

/* どのタブが、どの列と、どの置き場所を使うか */
const PANE = {
  closed:  [CLOSED_COLS, '#closed-rows'],
  menus:   [MENU_COLS, '#menu-rows'],
  coupons: [COUPON_COLS, '#coupon-rows'],
  styles:  [STYLE_COLS, '#style-rows']
};

/* 一覧に出す金額。シートには「4000〜」「2500」「￥3,000」など、
   店主が打ったままの形で入っています。そのまま出すと桁が読み取れないので、
   数として読めたものだけ ¥4,000〜 の形に直します。
   読めなかったときは、打たれたままを出します（勝手に消さない）。 */
function priceText(v) {
  const t = String(v ?? '').trim();
  if (!t) return '価格未設定';
  const half = toHalfWidth(t);
  const n = Number(half.replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || !/[0-9]/.test(half)) return t;
  return yen(n) + (/[〜~]/.test(half) ? '〜' : '');
}
function minutesText(v) {
  const n = Number(toHalfWidth(String(v ?? '')).replace(/[^0-9]/g, ''));
  return n ? `${n}分` : '所要未設定';
}
/* 名前が空のままの行。一覧から消すと、消えたと思って同じものを作り直します */
const rowTitle = (target, row) =>
  String(LIST_VIEW[target].title(row) || '').trim() || '（名前がまだ入っていません）';

/* 削除の確認に出す「何を消そうとしているか」。
   「削除しますか？」だけだと、どの行を押したのか分からないまま はい を押します。 */
function removeLabel(target, row) {
  if (target === 'closed') {
    const d = String(row['休業日'] || '').trim();
    if (!d) return '休業日（日付がまだ入っていません）';
    return `休業日：${d}`
      + (row['開始'] && row['終了'] ? `　${row['開始']}〜${row['終了']}` : '　終日');
  }
  if (target === 'reviews') {
    const who = String(row['ニックネーム'] || 'お客様').trim();
    const what = String(row['タイトル'] || row['本文'] || '').trim().slice(0, 24);
    return `口コミ：${who} 様${what ? `「${what}」` : ''}`;
  }
  return rowTitle(target, row);
}

/** 一覧（1行1件）＋「＋ 追加」ボタン */
function listHtml(target) {
  const view = LIST_VIEW[target];
  const rows = edits[target];
  const body = rows.length ? rows.map((row, i) => {
    /* 「表示」を外した行も必ず一覧に出します。隠すと、消したつもりが無いのに
       消えたように見えて、同じメニューをもう1件作ってしまいます。 */
    const off = String(row['表示'] ?? '').trim() === '×';
    const img = String(row['画像'] || '').trim();
    const marks = [
      off ? '<span class="admin-mark is-off">非表示</span>' : '',
      /* 写真タブは左の見本で分かるので、印は出しません */
      (!view.thumb && img) ? '<span class="admin-mark">写真あり</span>' : '',
      rowDirty(row) ? '<span class="admin-mark is-dirty">未保存</span>' : ''
    ].join('');
    return `
      <button class="admin-row${i === openRow[target] ? ' is-open' : ''}${off ? ' is-off' : ''}"
              type="button" data-open="${esc(target)}" data-index="${i}"
              aria-expanded="${i === openRow[target] ? 'true' : 'false'}">
        ${view.thumb ? `<span class="admin-row-thumb">${img
          ? `<img src="${esc(img)}" alt="" />` : '<span>写真なし</span>'}</span>` : ''}
        <span class="admin-row-main">
          <span class="admin-row-title">${esc(rowTitle(target, row))}</span>
          <span class="admin-row-sub">${esc(view.sub(row))}</span>
        </span>
        ${marks ? `<span class="admin-row-marks">${marks}</span>` : ''}
        <span class="admin-row-chev" aria-hidden="true">›</span>
      </button>`;
  }).join('') : `<p class="empty-state">${esc(view.empty)}</p>`;

  return `<div class="admin-list-body">${body}</div>
    <button class="btn btn-ghost btn-sm admin-add" type="button"
            data-add="${esc(target)}">${esc(view.addLabel)}</button>`;
}

/** 開いている1件ぶんの入力欄。開いていなければ空 */
function editorHtml(target) {
  const i = openRow[target];
  const row = edits[target][i];
  if (!row) return '';
  const cols = PANE[target][0];
  return `
    <div class="admin-editor" data-editor="${esc(target)}">
      <div class="admin-editor-head">
        <span class="admin-editor-title">編集中：${esc(rowTitle(target, row))}</span>
        <button class="btn btn-ghost btn-sm" type="button"
                data-close-editor="${esc(target)}">閉じる</button>
      </div>
      ${cols.map(c => fieldFor(c, row[c], target, i)).join('')}
      <div class="admin-editor-foot">
        <button class="btn btn-outline btn-sm" type="button"
                data-close-editor="${esc(target)}">一覧に戻る</button>
        <button class="btn btn-ghost btn-sm" type="button"
                data-remove="${esc(target)}" data-index="${i}">この行を削除</button>
      </div>
    </div>`;
}

/* 一覧と、開いている1件ぶんの入力欄をまとめて描き直します。
   入力欄は一覧の「下」に置きます。行と行のあいだに挟むと、
   開けた瞬間に下の行が画面外へ押し出され、何件あるのか見えなくなります。 */
function renderList(target) {
  $(PANE[target][1]).innerHTML =
    `<div class="admin-list" data-list="${esc(target)}">${listHtml(target)}</div>`
    + editorHtml(target);
}

/* 打っている最中に呼ばれます。一覧の行だけ描き直して、入力欄には触りません。
   入力欄まで描き直すと、1文字打つたびにカーソルが飛んで先が打てなくなります。 */
function refreshList(target) {
  const box = document.querySelector(`[data-list="${target}"]`);
  if (!box) return;                     // 休業日・口コミ・店舗情報には一覧がありません
  box.innerHTML = listHtml(target);
  const title = document.querySelector(`[data-editor="${target}"] .admin-editor-title`);
  const row = edits[target][openRow[target]];
  if (title && row) title.textContent = '編集中：' + rowTitle(target, row);
}

/* ---------- まだ保存していない、を出す ---------- */
function markSaved(target) {
  if (target === 'settings') { settingsBase = JSON.stringify(edits.settings); return; }
  (edits[target] || []).forEach(r => rowBase.set(r, JSON.stringify(r)));
  baseCount[target] = (edits[target] || []).length;
}
/** その行が、読み込んだときから変わっているか（足したばかりの行も「変わっている」） */
function rowDirty(row) {
  return !rowBase.has(row) || rowBase.get(row) !== JSON.stringify(row);
}
function isDirty(target) {
  if (target === 'settings') return JSON.stringify(edits.settings) !== settingsBase;
  const rows = edits[target] || [];
  return rows.length !== (baseCount[target] || 0) || rows.some(rowDirty);
}
function dirtyText(target) {
  if (target === 'settings') return 'まだ保存していません。下の保存ボタンを押してください。';
  const rows = edits[target] || [];
  const changed = rows.filter(rowDirty).length;
  const removed = Math.max(0, (baseCount[target] || 0) - rows.length);
  const bits = [];
  if (changed) bits.push(`${changed}件`);
  if (removed) bits.push(`削除${removed}件`);
  return `まだ保存していません（${bits.join('・') || '変更あり'}）。下の保存ボタンを押してください。`;
}

/* 保存バーの文言・タブの赤い点・一覧の「未保存」を、まとめて出し直します */
function updateDirty() {
  ['closed', 'menus', 'coupons', 'styles', 'reviews', 'settings'].forEach(t => {
    const dirty = isDirty(t);
    if (dirty) savedNote[t] = '';       // 直したのに「保存しました」が残っていると読み違えます
    const note = document.querySelector(`[data-note="${t}"]`);
    if (note) {
      note.textContent = dirty ? dirtyText(t) : (savedNote[t] || '');
      note.className = 'admin-savebar-note'
        + (dirty ? ' is-dirty' : savedNote[t] ? ' is-ok' : '');
    }
    const bar = note && note.closest('.admin-savebar');
    if (bar) bar.classList.toggle('is-dirty', dirty);
    /* タブを離れても気づけるように、タブそのものにも印を付けます。
       別のタブに移ってから保存を押しに戻れるのは、この点があるからです。 */
    const tab = document.querySelector(`#admin-tabs .tab[data-pane="${t}"]`);
    if (tab) tab.classList.toggle('admin-tab-dirty', dirty);
  });
}

/* 追加ボタンで作られる空の行 */
const BLANK_ROW = {
  closed:  { '休業日': '', '開始': '', '終了': '', 'メモ': '' },
  menus:   { '区分': 'カット', 'メニュー名': '', '価格': '', '所要(分)': 60, '説明': '', '画像': '', '表示': '○' },
  coupons: { 'メニュー名': '', '価格': '', '通常価格': '', '所要(分)': 60, '説明': '', '条件': '', '対象': '全員', '画像': '', '表示': '○' },
  styles:  { 'タイトル': '', '分類': 'ショート', 'タグ': '', '画像': '', '表示': '○' }
};

/* そのタブを丸ごと描き直します（追加・削除・保存のあと） */
function redraw(target) {
  if (target === 'reviews') renderReviews();
  else if (target === 'closed') renderClosed();
  else if (LIST_VIEW[target]) renderList(target);
  updateDirty();
}

function renderSettings() {
  const closedRaw = String(edits.settings['定休曜日'] ?? '');
  const closedSet = new Set(closedRaw.split(/[,、・\s]+/).map(t => t.replace(/曜日?$/, '')).filter(Boolean));

  const weekBox = `
    <div class="form-field">
      <span style="display:block;font-size:13px;font-weight:700;margin-bottom:6px;">定休曜日</span>
      <div class="weekday-picker">
        ${WEEK_LABELS.map(w => `
          <label class="radio-chip">
            <input type="checkbox" data-weekday="${w}" ${closedSet.has(w) ? 'checked' : ''} />
            <span>${w}</span>
          </label>`).join('')}
      </div>
      <span style="display:block;font-size:11.5px;color:var(--muted);margin-top:5px;">
        選んだ曜日は毎週ずっと予約できなくなります。1日だけ休むときは「休業日」タブをお使いください。
      </span>
    </div>`;

  $('#setting-rows').innerHTML = SETTING_KEYS.map(([key, type, hint]) => {
    if (type === 'image') {
      return imageField(key, edits.settings[key] ?? '', `data-setting="${esc(key)}"`, 'setting-' + key)
        + (hint ? `<p style="font-size:11.5px;color:var(--muted);margin:-4px 0 12px;">${esc(hint)}</p>` : '');
    }
    return `
    <label class="form-field">
      <span style="display:block;font-size:13px;font-weight:700;margin-bottom:6px;">${esc(key)}</span>
      <input class="input" type="${type === 'time' ? 'time' : type === 'url' ? 'url' : 'text'}"
             ${type === 'url' ? 'inputmode="url" placeholder="https://" ' : ''}
             value="${esc(edits.settings[key] ?? '')}" data-setting="${esc(key)}" />
      ${hint ? `<span style="display:block;font-size:11.5px;color:var(--muted);margin-top:5px;">${esc(hint)}</span>` : ''}
    </label>`;
  }).join('') + weekBox;
}

/** 曜日のチェックから「日,水」の形にまとめて設定に入れる */
function collectWeekdays() {
  const on = $$('[data-weekday]').filter(el => el.checked).map(el => el.dataset.weekday);
  edits.settings['定休曜日'] = on.join(',');
}

/* 口コミは他のシートと扱いが違う。
   お客様が書いた本文・評価・お名前は表示のみにして、
   店舗が触れるのは「掲載するかどうか」と削除だけにしてある。 */
const REVIEW_STATES = ['未承認', '掲載中', '非掲載'];

function renderReviews() {
  const host = $('#review-rows');
  if (!host) return;
  const rows = edits.reviews;

  host.innerHTML = rows.length
    ? rows.map((r, i) => {
        const state = String(r['状態'] || '未承認');
        const who = [r['ニックネーム'], r['年代'], r['性別']].filter(Boolean).join('・');
        return `
        <div class="booking-card" style="border-left-color:${state === '掲載中' ? 'var(--ok)' : 'var(--line)'};">
          <div class="booking-head">
            <span class="status-chip ${state === '掲載中' ? '' : 'is-cancelled'}">${esc(state)}</span>
            <span class="booking-code">${esc(r['投稿日'] || '')}／${esc(r['予約番号'] || '')}</span>
          </div>
          <p class="booking-detail"><strong>${esc(stars(Number(r['評価']) || 5))}</strong> ${esc(who)}</p>
          ${r['タイトル'] ? `<p class="booking-when" style="font-size:15px;">${esc(r['タイトル'])}</p>` : ''}
          <p class="booking-detail" style="white-space:pre-wrap;">${esc(r['本文'] || '')}</p>
          <p class="booking-detail" style="font-size:12px;color:var(--muted);">
            ${esc(r['メニュー'] || '')}${r['担当'] ? '／' + esc(r['担当']) : ''}
          </p>
          <div class="booking-actions">
            ${REVIEW_STATES.map(v => `
              <label class="radio-chip">
                <input type="radio" name="rvstate${i}" value="${esc(v)}"
                       data-review-state="${i}" ${state === v ? 'checked' : ''} />
                <span>${esc(v)}</span>
              </label>`).join('')}
            <button class="btn btn-ghost btn-sm" type="button" data-remove="reviews" data-index="${i}">削除</button>
          </div>
        </div>`;
      }).join('')
    : '<p class="empty-state">まだ口コミは届いていません。</p>';
}

/* ---------- 保存 ---------- */
async function save(target) {
  const err = $('#save-error');
  const ok = $('#save-ok');
  err.style.display = 'none';
  ok.style.display = 'none';

  const btn = document.querySelector(`[data-save="${target}"]`);
  btn.disabled = true;
  btn.textContent = '保存中…';

  if (target === 'settings') collectWeekdays();

  const payload = target === 'settings'
    ? { type: 'adminSave', target, rows: edits.settings, stamp: stamps[target] }
    : { type: 'adminSave', target, rows: edits[target], stamp: stamps[target] };

  const res = await adminPost(payload);
  btn.disabled = false;
  btn.textContent = btn.dataset.label;

  if (!res.ok) {
    err.textContent = res.error || '保存に失敗しました。';
    err.style.display = 'block';
    // 別の端末で変更されていた場合は、読み込み直す手段をその場に出す
    if (res.stale) {
      err.insertAdjacentHTML('beforeend',
        ' <button class="btn btn-outline btn-sm" type="button" id="reload-admin">読み込み直す</button>');
      const reload = $('#reload-admin');
      if (reload) reload.addEventListener('click', () => location.reload());
    }
    return;
  }
  if (res.stamps) stamps = { ...res.stamps };
  /* 休業日は予約一覧にも出しているので、保存したらそちらも描き直します。
     保存したのに予定表が前のままだと、保存できたのか分かりません。 */
  if (target === 'closed') {
    adminData.closedDates = edits.closed.map(r => ({ ...r }));
    renderReservations();
  }
  ok.textContent = '保存しました。サイトに反映されています。';
  ok.style.display = 'block';
  /* ここが保存の折り返し地点です。いま画面にある内容を「保存済み」として覚え直し、
     一覧の「未保存」とタブの点を消します。消さないと、保存したのに
     まだ残っているように見えて、同じ内容をもう一度送ることになります。 */
  markSaved(target);
  savedNote[target] = '保存しました。サイトに反映されています。';
  redraw(target);
}

/* ---------- CSV ---------- */
function exportCsv() {
  const list = filteredReservations();
  if (!list.length) { alert('出力できる予約がありません。'); return; }
  const head = ['予約番号', '来店日', '開始', '終了', 'メニュー', '担当', '金額',
    'お名前', '電話番号', 'メール', '来店回数', 'ご要望', '状態'];
  const body = list.map(r => [r.code, r.date, r.time, r.endTime, r.menu, r.staffName,
    r.price, r.name, r.tel, r.email, r.visit, r.request, r.status]);
  /* 「=」「+」「-」「@」で始まる文字は、ExcelやGoogleスプレッドシートで
     開いたときに数式として実行されます。お名前欄に式を書いて予約した人がいると、
     このCSVを開いた店側の端末でそれが動きます。先頭に ' を足して文字に固定します。 */
  const safe = v => {
    const t = String(v ?? '');
    return (/^[=+\-@]/.test(t) ? "'" + t : t).replace(/"/g, '""');
  };
  const csv = [head, ...body]
    .map(cols => cols.map(c => `"${safe(c)}"`).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `reservations_${toKey(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------- 起動 ---------- */
document.addEventListener('DOMContentLoaded', () => {
  /* 受け口が入っていないとき。
     以前はここで入力欄とボタンを disabled にしていましたが、
     設置作業中の人が「文字が入れられない」で止まりました。
     欄が死んでいる理由は、上の案内文からは読み取れません。

     しかも、この案内文はしばしば嘘になります。設置は済んでいるのに、
     ブラウザや GitHub Pages が古い data.js を握っているだけ、という
     ことが起きます（実際に起きました）。そのときに
     「まだ設置していません」と言い切るのは、間違った方向へ人を送ります。

     なので欄は生かしたままにして、押した人に両方の可能性を伝えます。 */
  if (!SALON.reservationEndpoint) {
    $('#gate-message').textContent =
      '予約の受け口（Apps Script のURL）が読み込めていません。'
      + 'まず、このページを読み込み直してください。';
    const err = $('#gate-error');
    $('#gate-btn').addEventListener('click', () => {
      err.innerHTML =
        'この画面はまだ受け口につながっていません。<br>'
        + '① キーボードの <b>Ctrl+Shift+R</b>（Mac は <b>⌘+Shift+R</b>）で読み込み直す<br>'
        + '　 設置した直後は、古い内容が数分残ることがあります。<br>'
        + '② それでも変わらなければ、Apps Script の設置がまだ済んでいません。'
        + '設置手順は README をご覧ください。';
      err.style.display = 'block';
    });
    $('#passcode').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('#gate-btn').click();
    });
    return;
  }

  $$('[data-save]').forEach(b => { b.dataset.label = b.textContent; });

  $('#gate-btn').addEventListener('click', login);
  $('#passcode').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

  // タブ切り替え
  $('#admin-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab', $('#admin-tabs')).forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    $$('.admin-pane').forEach(p => { p.hidden = p.dataset.pane !== tab.dataset.pane; });
  });

  // 入力の反映
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.setting !== undefined) {
      edits.settings[el.dataset.setting] = el.value;
      updateDirty();
      return;
    }
    if (el.dataset.target === undefined) return;
    const target = el.dataset.target;
    const row = edits[target][Number(el.dataset.index)];
    if (!row) return;
    row[el.dataset.col] = el.type === 'checkbox' ? (el.checked ? '○' : '×') : el.value;
    /* 一覧の行だけ描き直します（入力欄には触りません）。
       名前や値段を打った先から一覧に出ないと、どの行を直しているのか
       分からなくなりますが、入力欄まで描き直すとカーソルが飛びます。 */
    refreshList(target);
    updateDirty();
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.reviewState !== undefined && el.checked) {
      const row = edits.reviews[Number(el.dataset.reviewState)];
      if (row) row['状態'] = el.value;
      updateDirty();
      return;
    }
    /* 定休曜日は保存時にまとめていたので、押しても「未保存」が出ませんでした。
       出ないと、押しただけで決まったと思って画面を離れます。 */
    if (el.dataset.weekday !== undefined) { collectWeekdays(); updateDirty(); return; }
    if (el.type === 'checkbox' && el.dataset.target !== undefined) {
      const row = edits[el.dataset.target][Number(el.dataset.index)];
      if (row) row[el.dataset.col] = el.checked ? '○' : '×';
      refreshList(el.dataset.target);
      updateDirty();
    }
  });

  // 行の追加・削除・保存
  document.addEventListener('click', async e => {
    const past = e.target.closest('[data-toggle-past]');
    if (past) { showPast = !showPast; renderReservations(); return; }

    /* 一覧の行を押した。押した1件だけを開き、ほかは閉じたままにする。
       もう一度同じ行を押せば閉じて、一覧だけに戻る。 */
    const op = e.target.closest('[data-open]');
    if (op) {
      const t = op.dataset.open;
      const i = Number(op.dataset.index);
      openRow[t] = (openRow[t] === i) ? -1 : i;
      redraw(t);
      /* 入力欄は一覧の下に出ます。写真が何十枚もあると一覧が長くなり、
         押しても画面が変わらないように見えるので、その場まで送ります。 */
      const ed = document.querySelector(`[data-editor="${t}"]`);
      if (ed) ed.scrollIntoView({ block: 'start' });
      return;
    }

    const cl = e.target.closest('[data-close-editor]');
    if (cl) {
      const t = cl.dataset.closeEditor;
      openRow[t] = -1;
      redraw(t);
      const list = document.querySelector(`[data-list="${t}"]`);
      if (list) list.scrollIntoView({ block: 'start' });
      return;
    }

    const add = e.target.closest('[data-add]');
    if (add) {
      const t = add.dataset.add;
      edits[t].push(BLANK_ROW[t] ? { ...BLANK_ROW[t] } : {});
      // 足した行は、そのまま打ち込めるように開いておく
      if (openRow[t] !== undefined) openRow[t] = edits[t].length - 1;
      redraw(t);
      const ed = document.querySelector(`[data-editor="${t}"]`);
      if (ed) ed.scrollIntoView({ block: 'start' });
      return;
    }

    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const t = rm.dataset.remove;
      const i = Number(rm.dataset.index);
      const row = edits[t][i];
      if (!row) return;
      /* 確かめずに消していました。指がすべって消えると、何が入っていたか
         思い出せません（説明や写真は打ち直せません）。 */
      if (!confirm(`${removeLabel(t, row)}\n\nこの行を削除します。よろしいですか？\n`
          + '※「保存」を押すまで、サイトはまだ変わりません。')) return;
      edits[t].splice(i, 1);
      if (openRow[t] !== undefined) openRow[t] = -1;
      redraw(t);
      return;
    }

    const sv = e.target.closest('[data-save]');
    if (sv) { await save(sv.dataset.save); return; }

    const cx = e.target.closest('[data-admin-cancel]');
    if (cx) {
      const code = cx.dataset.adminCancel;
      if (!confirm(`予約番号 ${code} をキャンセル扱いにします。よろしいですか？`)) return;
      cx.disabled = true;
      const r = (adminData.reservations || []).find(x => x.code === code) || {};
      /* 店としてのキャンセルなので、パスワード（または記憶した合鍵）を添えます。
         お客様の電話番号を打ち直さずに反映できます。 */
      const res = await adminPost({ type: 'cancel', code, date: r.date, time: r.time, name: r.name });
      if (!res.ok) {
        cx.disabled = false;
        /* 受信側は「前日18時まで」でキャンセルを断ります。お客様向けの決まりですが、
           店から入れた当日のキャンセルも同じ理由で断られます。
           そのままの文言を出すと「店舗までご連絡ください」と自分に言われることになり、
           何をすれば枠が空くのか分かりません。 */
        alert(res.deadline
          ? `予約番号 ${code} は、受付期限を過ぎているとして断られました。\n\n`
            + '台帳（スプレッドシート）の「状態」欄をキャンセルにすると、この枠は空きます。\n'
            + '※お客様へのキャンセルのお知らせは送られません。'
          : 'キャンセルできませんでした。' + (res.error ? '\n' + res.error : ''));
        return;
      }
      await openDashboard();
    }
  });

  // 写真の選択
  document.addEventListener('change', e => {
    if (e.target.dataset && e.target.dataset.upload !== undefined) handleUpload(e.target);
  });
  document.addEventListener('click', e => {
    const clr = e.target.closest('[data-clear-image]');
    if (!clr) return;
    const picker = clr.closest('.image-picker');
    const text = picker.querySelector('input[type="text"]');
    text.value = '';
    text.dispatchEvent(new Event('input', { bubbles: true }));
    picker.querySelector('.image-preview').innerHTML = '<span>写真なし</span>';
    clr.remove();
  });

  const forget = $('#forget-device');
  if (forget) forget.addEventListener('click', forgetDevice);

  $('#filter-date').addEventListener('change', renderReservations);
  $('#filter-status').addEventListener('change', renderReservations);
  $('#customer-search').addEventListener('input', renderCustomers);
  $('#customer-sort').addEventListener('change', renderCustomers);
  $('#add-booking').addEventListener('click', () => toggleAddBooking($('#add-booking-form').hidden));
  $('#ab-cancel').addEventListener('click', () => toggleAddBooking(false));
  $('#ab-save').addEventListener('click', () => saveAddBooking(false));
  $('#filter-reset').addEventListener('click', () => {
    $('#filter-date').value = '';
    $('#filter-status').value = 'all';
    renderReservations();
  });
  $('#export-csv').addEventListener('click', exportCsv);

  /* 前に「この端末を記憶する」を選んでいれば、合鍵で黙って入る。
     合鍵が期限切れ・失効していれば、いつもどおりパスワードを聞く画面のままにする。 */
  let saved = '';
  try { saved = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* noop */ }
  if (saved) {
    adminToken = saved;
    const message = $('#gate-message').textContent;
    $('#gate-message').textContent = 'この端末は記憶されています。読み込み中…';
    openDashboard().then(ok => {
      if (ok) return;
      // 合鍵が切れていた。捨てて、いつものパスワード入力に戻す
      adminToken = '';
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* noop */ }
      $('#gate-message').textContent = message;
      $('#gate-error').textContent = '記憶した端末の有効期限が切れました。もう一度パスワードを入力してください。';
      $('#gate-error').style.display = 'block';
    }).catch(() => { $('#gate-message').textContent = message; });
  }
});
