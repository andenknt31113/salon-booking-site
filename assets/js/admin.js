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
const edits = { closed: [], menus: [], coupons: [], settings: {} };

/* 記憶した合鍵の置き場所。パスワードそのものは保存しません。
   合鍵は Apps Script 側で発行・失効させるため、盗まれても店側で無効にできます。 */
const TOKEN_KEY = 'salon.adminToken.v1';

const MENU_COLS = ['区分', 'メニュー名', '価格', '所要(分)', '説明', '画像', '表示'];
const COUPON_COLS = ['クーポン名', '価格', '通常価格', '所要(分)', '説明', '条件', '対象', '画像', '表示'];
const SETTING_KEYS = [
  ['電話番号', 'tel', '例）0297-00-0000。空欄にすると電話ボタンを出しません'],
  ['営業開始', 'time', ''],
  ['営業終了', 'time', ''],
  ['最終受付', 'time', ''],
  ['キャッチコピー', 'text', 'トップの大見出しに出ます'],
  ['お知らせ', 'text', 'トップの上部に帯で出ます。空欄なら出ません'],
  ['ロゴ画像', 'image', 'ヘッダーとトップに出るロゴ。写真を選ぶと自動で入ります'],
  ['スタッフ写真', 'image', 'スタッフ紹介に出る写真']
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
  edits.settings = { ...(res.settings || {}) };

  $('#gate').hidden = true;
  $('#dashboard').hidden = false;
  renderStats();
  renderReservations();
  renderClosed();
  renderRows('menus', MENU_COLS, '#menu-rows');
  renderRows('coupons', COUPON_COLS, '#coupon-rows');
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

function renderReservations() {
  const list = filteredReservations();
  if (!list.length) {
    $('#admin-rows').innerHTML = '<p class="empty-state">該当する予約はありません。</p>';
    return;
  }
  $('#admin-rows').innerHTML = list.map(r => {
    const off = r.status === 'キャンセル';
    return `
      <article class="booking-card ${off ? 'is-cancelled' : ''}">
        <div class="booking-head">
          <span class="status-chip ${off ? 'is-cancelled' : ''}">${esc(r.status || '予約確定')}</span>
          <span class="booking-code">${esc(r.code)}</span>
        </div>
        <p class="booking-when">${formatDateJa(r.date)} ${esc(r.time)}〜${esc(r.endTime)}</p>
        <p class="booking-detail">${esc(r.name)} 様（${esc(r.visit || '—')}）</p>
        <p class="booking-detail">${esc(r.menu)}／${esc(r.staffName)}</p>
        <p class="booking-detail">${yen(r.price)}／
          <a href="tel:${esc(r.tel.replace(/[^0-9]/g, ''))}" style="text-decoration:underline">${esc(r.tel)}</a>
        </p>
        ${r.request ? `<p class="booking-detail">ご要望：${esc(r.request)}</p>` : ''}
        ${off ? '' : `<div style="margin-top:12px;">
          <button class="btn btn-ghost btn-sm" type="button" data-admin-cancel="${esc(r.code)}">キャンセルにする</button>
        </div>`}
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

/* ---------- 行の編集（休業日 / メニュー / クーポン） ---------- */
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
      <input class="input" type="${type === 'time' ? 'time' : 'text'}"
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
    ? { type: 'adminSave', target, rows: edits.settings }
    : { type: 'adminSave', target, rows: edits[target] };

  const res = await adminPost(payload);
  btn.disabled = false;
  btn.textContent = btn.dataset.label;

  if (!res.ok) {
    err.textContent = res.error || '保存に失敗しました。';
    err.style.display = 'block';
    return;
  }
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
      edits[t].push(t === 'closed' ? { '休業日': '', 'メモ': '' }
        : t === 'menus' ? { '区分': 'カット', 'メニュー名': '', '価格': '', '所要(分)': 60, '説明': '', '画像': '', '表示': '○' }
        : { 'クーポン名': '', '価格': '', '通常価格': '', '所要(分)': 60, '説明': '', '条件': '', '対象': '全員', '画像': '', '表示': '○' });
      if (t === 'closed') renderClosed();
      else renderRows(t, t === 'menus' ? MENU_COLS : COUPON_COLS, t === 'menus' ? '#menu-rows' : '#coupon-rows');
      return;
    }

    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const t = rm.dataset.remove;
      edits[t].splice(Number(rm.dataset.index), 1);
      if (t === 'closed') renderClosed();
      else renderRows(t, t === 'menus' ? MENU_COLS : COUPON_COLS, t === 'menus' ? '#menu-rows' : '#coupon-rows');
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
      if (res) await openDashboard();
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
