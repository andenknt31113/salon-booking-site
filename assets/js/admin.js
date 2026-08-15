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

/* 記憶した合鍵の置き場所。パスワードそのものは保存しません。
   合鍵は Apps Script 側で発行・失効させるため、盗まれても店側で無効にできます。 */
const TOKEN_KEY = 'salon.adminToken.v1';

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
  adminToken = '';
  adminPw = '';
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* noop */ }
  location.reload();
}

async function openDashboard() {
  const res = await adminPost({ type: 'adminData' });
  if (!res.ok) {
    $('#gate-error').textContent = res.error || '読み込みに失敗しました。';
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

  $('#gate').hidden = true;
  $('#dashboard').hidden = false;
  renderStats();
  renderReservations();
  renderCustomers();
  renderClosed();
  renderRows('menus', MENU_COLS, '#menu-rows');
  renderRows('coupons', COUPON_COLS, '#coupon-rows');
  renderRows('styles', STYLE_COLS, '#style-rows');
  renderReviews();
  renderSettings();
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
  const week = new Date(); week.setDate(week.getDate() + 7);
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

function renderReservations() {
  const list = filteredReservations();
  if (!list.length) {
    $('#admin-rows').innerHTML = '<p class="empty-state">該当する予約はありません。</p>';
    return;
  }

  /* 来店日ごとにまとめ、早い順に並べます。
     カードが縦に並ぶだけだと、その日が何件なのか数えないと分かりません。
     朝いちばんに開いて「今日は何時から何件か」を見るのが主な使い方なので、
     日付で区切って件数を添えます。 */
  const byDate = new Map();
  [...list]
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .forEach(r => {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    });

  $('#admin-rows').innerHTML = [...byDate].map(([date, rows]) => {
    const h = dayHeading(date);
    const live = rows.filter(r => r.status !== 'キャンセル').length;
    const count = live ? `${live}件` : `キャンセル${rows.length}件のみ`;
    return `
      <div class="day-heading">
        ${h.label ? `<span class="day-badge">${esc(h.label)}</span>` : ''}
        <span class="day-date">${esc(h.text)}</span>
        <span class="day-count">${esc(count)}</span>
      </div>
      ${rows.map(reservationCard).join('')}`;
  }).join('');
}

function reservationCard(r) {
  const off = r.status === 'キャンセル';
  return `
    <article class="booking-card ${off ? 'is-cancelled' : ''}">
      <div class="booking-head">
        <span class="booking-time">${esc(r.time)}〜${esc(r.endTime)}</span>
        ${off ? '<span class="status-chip is-cancelled">キャンセル</span>' : ''}
        <span class="booking-code">${esc(r.code)}</span>
      </div>
      <p class="booking-name">${esc(r.name)} 様<small>${esc(r.visit || '—')}</small></p>
      <p class="booking-detail">${esc(r.menu)}／${esc(r.staffName)}</p>
      <p class="booking-detail">${yen(r.price)}／
        <a href="tel:${esc(r.tel.replace(/[^0-9]/g, ''))}" style="text-decoration:underline">${esc(r.tel)}</a>
      </p>
      ${r.request ? `<p class="booking-request">ご要望：${esc(r.request)}</p>` : ''}
      ${off ? '' : `<div style="margin-top:12px;">
        <button class="btn btn-ghost btn-sm" type="button" data-admin-cancel="${esc(r.code)}">キャンセルにする</button>
      </div>`}
    </article>`;
}

/* ---------- お客様 ----------
   顧客名簿を別に作ってはいません。**予約台帳をまとめ直しているだけ**です。
   同じ人かどうかは電話番号で見ます。お名前は表記ゆれがあり、
   メールは端末を変えると変わることがあるためです。
   新しい情報を集めていないので、消すときも予約台帳の行を消すだけで済みます。 */
function telKey(tel) {
  return String(tel || '').replace(/[^0-9]/g, '');
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
    c.done = c.visits.filter(v => v.status !== 'キャンセル');
    c.spent = c.done.reduce((s, v) => s + (Number(v.price) || 0), 0);
    return c;
  });
}

function renderCustomers() {
  const q = ($('#customer-search') || {}).value || '';
  const sort = ($('#customer-sort') || {}).value || 'recent';
  const needle = q.trim().toLowerCase();
  const digits = telKey(q);

  let list = buildCustomers().filter(c => !needle
    || String(c.name || '').toLowerCase().includes(needle)
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
    /* 来店回数は「キャンセルを除いた予約の数」です。
       実際に来られたかどうかまでは分からないので、そう書いておきます。 */
    return `
      <article class="booking-card">
        <div class="booking-head">
          <span class="customer-name">${esc(c.name || '（お名前なし）')}</span>
          <span class="status-chip">${c.done.length}回</span>
        </div>
        <p class="booking-detail">
          <a href="tel:${esc(telKey(c.tel))}" style="text-decoration:underline">${esc(c.tel)}</a>
          ${c.email ? `／ ${esc(c.email)}` : ''}
        </p>
        <p class="booking-detail">ご予約の合計 ${yen(c.spent)}</p>
        ${latest ? `<p class="booking-detail">前回：${formatDateJa(latest.date)}／${esc(latest.menu)}</p>` : ''}
        <details class="customer-history">
          <summary>ご来店の履歴（${c.visits.length}件）</summary>
          <ul>
            ${c.visits.map(v => `
              <li${v.status === 'キャンセル' ? ' class="is-cancelled"' : ''}>
                <span class="hist-date">${formatDateJa(v.date)} ${esc(v.time)}</span>
                <span class="hist-menu">${esc(v.menu)}${v.status === 'キャンセル' ? '（キャンセル）' : ''}</span>
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
function imageField(label, url, attrs, slot) {
  const v = url == null ? '' : String(url);
  return `
    <div class="form-field" style="margin:0 0 10px;">
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
  if (col === '画像') {
    return imageField('画像',
      v,
      `data-target="${target}" data-index="${index}" data-col="画像"`,
      target + '-' + index);
  }
  if (col === '表示') {
    return `<label class="checkbox-line" style="margin-top:8px;">
        <input type="checkbox" data-target="${target}" data-index="${index}" data-col="${esc(col)}"
               ${String(v).trim() === '×' ? '' : 'checked'} />
        <span>サイトに表示する</span>
      </label>`;
  }
  // 価格は「4000〜」と書けるようにしたいので number にはしない
  const type = (col === '通常価格' || col === '所要(分)') ? 'number'
    : col === '休業日' ? 'date' : 'text';
  return `
    <label class="form-field" style="margin:0 0 10px;">
      <span style="display:block;font-size:12px;color:var(--muted);margin-bottom:5px;">${esc(col)}</span>
      <input class="input" type="${type}" value="${esc(v)}"
             data-target="${target}" data-index="${index}" data-col="${esc(col)}" />
    </label>`;
}

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
  renderRows('closed', ['休業日', 'メモ'], '#closed-rows');
}

/* 追加ボタンで作られる空の行 */
const BLANK_ROW = {
  closed:  { '休業日': '', 'メモ': '' },
  menus:   { '区分': 'カット', 'メニュー名': '', '価格': '', '所要(分)': 60, '説明': '', '画像': '', '表示': '○' },
  coupons: { 'メニュー名': '', '価格': '', '通常価格': '', '所要(分)': 60, '説明': '', '条件': '', '対象': '全員', '画像': '', '表示': '○' },
  styles:  { 'タイトル': '', '分類': 'ショート', 'タグ': '', '画像': '', '表示': '○' }
};

/* どのタブの一覧を描き直すか */
const PANE = {
  closed:  [['休業日', 'メモ'], '#closed-rows'],
  menus:   [MENU_COLS, '#menu-rows'],
  coupons: [COUPON_COLS, '#coupon-rows'],
  styles:  [STYLE_COLS, '#style-rows']
};
function redraw(target) {
  if (target === 'reviews') { renderReviews(); return; }
  const pane = PANE[target];
  if (pane) renderRows(target, pane[0], pane[1]);
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
  ok.textContent = '保存しました。サイトに反映されています。';
  ok.style.display = 'block';
}

/* ---------- CSV ---------- */
function exportCsv() {
  const list = filteredReservations();
  if (!list.length) { alert('出力できる予約がありません。'); return; }
  const head = ['予約番号', '来店日', '開始', '終了', 'メニュー', '担当', '金額',
    'お名前', '電話番号', 'メール', '来店回数', 'ご要望', '状態'];
  const body = list.map(r => [r.code, r.date, r.time, r.endTime, r.menu, r.staffName,
    r.price, r.name, r.tel, r.email, r.visit, r.request, r.status]);
  const csv = [head, ...body]
    .map(cols => cols.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
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
  if (!SALON.reservationEndpoint) {
    $('#gate-message').textContent =
      'この管理ページは、Google Apps Script を設置してから使えるようになります。'
      + '設置手順は README をご覧ください。';
    $('#passcode').disabled = true;
    $('#gate-btn').disabled = true;
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
      return;
    }
    if (el.dataset.target === undefined) return;
    const row = edits[el.dataset.target][Number(el.dataset.index)];
    if (!row) return;
    row[el.dataset.col] = el.type === 'checkbox' ? (el.checked ? '○' : '×') : el.value;
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.reviewState !== undefined && el.checked) {
      const row = edits.reviews[Number(el.dataset.reviewState)];
      if (row) row['状態'] = el.value;
      return;
    }
    if (el.type === 'checkbox' && el.dataset.target !== undefined) {
      const row = edits[el.dataset.target][Number(el.dataset.index)];
      if (row) row[el.dataset.col] = el.checked ? '○' : '×';
    }
  });

  // 行の追加・削除・保存
  document.addEventListener('click', async e => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const t = add.dataset.add;
      edits[t].push(BLANK_ROW[t] ? { ...BLANK_ROW[t] } : {});
      redraw(t);
      return;
    }

    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const t = rm.dataset.remove;
      edits[t].splice(Number(rm.dataset.index), 1);
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
      const res = await sendToEndpoint({ type: 'cancel', code, date: r.date, time: r.time, name: r.name });
      if (!res.ok) {
        cx.disabled = false;
        alert('キャンセルできませんでした。' + (res.error ? '\n' + res.error : ''));
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
