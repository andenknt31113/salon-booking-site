/* ============================================================
   サロン設定
   ここを書き換えるだけで自社サロン用になります
   ============================================================ */
const SALON = {
  name: 'Salon LUMIÈRE',
  branch: '表参道店',
  tel: '03-1234-5678',
  address: '東京都渋谷区神宮前0-0-0 LUMIÈRE BLDG 3F',
  access: '表参道駅 A2出口より徒歩4分',
  catch: '“なりたい”を、いちばん似合うかたちで。',
  desc: '骨格・髪質・ライフスタイルに合わせたオーダーメイドの施術をご提供します。',
  payment: '現金 / クレジットカード / QRコード決済',

  open: '10:00',        // 営業開始
  close: '20:00',       // 営業終了
  lastOrder: '19:00',   // 最終受付
  slot: 30,             // 予約枠の刻み（分）
  closedWeekdays: [2],  // 定休日 0=日 1=月 2=火 …
  closedDates: [],      // 臨時休業日 '2026-08-20' の形式
  showDays: 14,         // 日付の選択肢を何日分出すか
  leadHours: 2,         // 当日予約の締め切り（施術の何時間前まで）

  /* 予約の送信先。空ならこの端末に保存するだけ（デモ）。
     Google Apps Script などのURLを入れると予約内容がJSONで送信されます。 */
  endpoint: '',

  menus: [
    {
      cat: 'カット', items: [
        { id: 'm1', name: 'カット', note: 'シャンプー・ブロー込み', price: 6600, min: 60 },
        { id: 'm2', name: '前髪カット', note: '', price: 1100, min: 20 },
        { id: 'm3', name: 'メンズカット', note: '', price: 5500, min: 50 }
      ]
    },
    {
      cat: 'カラー', items: [
        { id: 'm4', name: 'リタッチカラー', note: '根元3cmまで', price: 6600, min: 70 },
        { id: 'm5', name: 'カット + カラー', note: '人気No.1', price: 12100, min: 120 },
        { id: 'm6', name: 'ブリーチオンカラー', note: 'ダメージ診断つき', price: 18700, min: 180 }
      ]
    },
    {
      cat: 'パーマ・ストレート', items: [
        { id: 'm7', name: 'デジタルパーマ', note: '', price: 14300, min: 150 },
        { id: 'm8', name: '縮毛矯正（全体）', note: '', price: 19800, min: 180 }
      ]
    },
    {
      cat: 'トリートメント', items: [
        { id: 'm9', name: '髪質改善トリートメント', note: '', price: 7700, min: 60 },
        { id: 'm10', name: 'ヘッドスパ 30分', note: 'アロマ選択可', price: 4400, min: 30 }
      ]
    }
  ],

  staff: [
    { id: 's1', name: '佐藤 美咲', role: '店長 / トップスタイリスト', fee: 1100,
      tags: '#髪質改善 #ショート', msg: 'くせ・うねりのお悩みはお任せください。乾かすだけで決まる髪をつくります。',
      days: [1, 3, 4, 5, 6], hue: 340 },
    { id: 's2', name: '田中 陽介', role: 'ディレクター', fee: 880,
      tags: '#メンズ #ハイトーン', msg: 'ダメージを抑えた設計で、伸びてもきれいなハイトーンをご提案します。',
      days: [0, 1, 3, 5, 6], hue: 210 },
    { id: 's3', name: '鈴木 かおり', role: 'スタイリスト', fee: 550,
      tags: '#ボブ #ヘッドスパ', msg: '骨格とパーソナルカラーから、無理なく続けられるスタイルをご提案します。',
      days: [0, 2, 3, 4, 6], hue: 30 },
    { id: 's4', name: '高橋 蓮', role: 'ジュニアスタイリスト', fee: 0,
      tags: '#学割 #トレンド', msg: 'トレンド感のあるレイヤースタイルが得意です。初めての方もお気軽に。',
      days: [0, 1, 4, 5, 6], hue: 160 }
  ]
};

/* ============================================================
   ユーティリティ
   ============================================================ */
const $ = s => document.querySelector(s);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
const p2 = n => String(n).padStart(2, '0');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const key = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = m => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
const dur = m => (m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? m % 60 + '分' : ''}` : `${m}分`);
const dateJa = k => { const d = fromKey(k); return `${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})`; };

/* 同じ入力なら常に同じ値を返す擬似乱数（空き状況のサンプル生成用） */
function rand(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

const allMenus = () => SALON.menus.flatMap(c => c.items);
const findMenu = id => allMenus().find(m => m.id === id);
const findStaff = id => SALON.staff.find(s => s.id === id);

/* ============================================================
   予約データ（この端末に保存）
   ============================================================ */
const KEY = 'salon.bookings.v1';
let memory = null; // localStorage が使えない環境（プライベートモード等）での代替

const Store = {
  all() {
    if (memory) return memory;
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch (e) { memory = []; return memory; }
  },
  save(l) {
    if (memory) { memory = l; return; }
    try { localStorage.setItem(KEY, JSON.stringify(l)); }
    catch (e) { memory = l; }
  },
  add(b) { const l = this.all(); l.push(b); this.save(l); },
  find(code) { return this.all().find(b => b.code === code) || null; },
  cancel(code) {
    const l = this.all();
    const t = l.find(b => b.code === code);
    if (t) { t.cancelled = true; this.save(l); }
  },
  live() { return this.all().filter(b => !b.cancelled); },
  newCode() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = 'R-' + Array.from({ length: 5 }, () => c[Math.floor(Math.random() * c.length)]).join(''); }
    while (this.all().some(b => b.code === code));
    return code;
  }
};

/* ============================================================
   空き状況
   ============================================================ */
const isClosed = k =>
  SALON.closedWeekdays.includes(fromKey(k).getDay()) || SALON.closedDates.includes(k);

/* サンプルの「先約」を作る。実運用では予約管理システムの空き状況に差し替えてください。
   1日に1〜3件の施術が入っている想定でブロックを生成します。 */
const blockCache = new Map();
function busyBlocks(staffId, dateKey) {
  const ck = staffId + dateKey;
  if (blockCache.has(ck)) return blockCache.get(ck);

  const blocks = [];
  const count = 1 + Math.floor(rand(`${dateKey}|${staffId}|n`) * 3);      // 1〜3件
  for (let i = 0; i < count; i++) {
    const openMin = mins(SALON.open);
    const span = (mins(SALON.lastOrder) - openMin) / SALON.slot;
    const start = openMin + Math.floor(rand(`${dateKey}|${staffId}|s${i}`) * span) * SALON.slot;
    const len = (2 + Math.floor(rand(`${dateKey}|${staffId}|l${i}`) * 4)) * SALON.slot; // 60〜150分
    blocks.push([start, start + len]);
  }
  blockCache.set(ck, blocks);
  return blocks;
}

/** そのスタッフが指定枠に空いているか（1枠ぶん） */
function staffFree(staffId, dateKey, time) {
  const st = findStaff(staffId);
  if (!st || !st.days.includes(fromKey(dateKey).getDay())) return false;

  const t = mins(time);

  // すでにこの端末から入っている予約と重なるか
  const booked = Store.live().some(b =>
    b.date === dateKey && b.staffId === staffId && t >= mins(b.time) && t < mins(b.time) + b.min);
  if (booked) return false;

  return !busyBlocks(staffId, dateKey).some(([s, e]) => t >= s && t < e);
}

/** 施術時間ぶん連続で空いている担当が何人いるか */
function freeCount(dateKey, time, staffId, minutes) {
  if (isClosed(dateKey)) return 0;
  if (mins(time) + minutes > mins(SALON.close)) return 0;

  const start = fromKey(dateKey);
  start.setMinutes(mins(time));
  if (start.getTime() - Date.now() < SALON.leadHours * 3600e3) return 0;

  const need = Math.ceil(minutes / SALON.slot);
  const targets = staffId ? [findStaff(staffId)].filter(Boolean) : SALON.staff;
  return targets.filter(st => {
    for (let i = 0; i < need; i++) {
      if (!staffFree(st.id, dateKey, hhmm(mins(time) + i * SALON.slot))) return false;
    }
    return true;
  }).length;
}

/* ============================================================
   選択中の状態
   ============================================================ */
const pick = { menuId: null, staffId: null, date: null, time: null };

const pickedMenu = () => (pick.menuId ? findMenu(pick.menuId) : null);
const pickedFee = () => (pick.staffId ? findStaff(pick.staffId).fee : 0);
const total = () => (pickedMenu() ? pickedMenu().price : 0) + pickedFee();
const totalMin = () => (pickedMenu() ? pickedMenu().min : SALON.slot);

/* ============================================================
   画面の描画
   ============================================================ */
function renderStatic() {
  const initials = SALON.name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'S';
  const telHref = 'tel:' + SALON.tel.replace(/-/g, '');

  $('#hd-mark').textContent = initials;
  $('#hd-name').textContent = SALON.name;
  $('#hd-branch').textContent = SALON.branch;
  $('#hd-tel').href = telHref;
  $('#cta-tel').href = telHref;

  $('#hero-catch').textContent = SALON.catch;
  $('#hero-desc').textContent = SALON.desc;
  $('#hero-info').innerHTML = [
    SALON.access,
    `${SALON.open}〜${SALON.close}（最終受付 ${SALON.lastOrder}）`,
    `定休日 ${SALON.closedWeekdays.map(d => WD[d]).join('・') || 'なし'}曜日`
  ].map(t => `<li>◍ ${esc(t)}</li>`).join('');

  $('#menu-list').innerHTML = SALON.menus.map(c => `
    <p class="menu-cat">${esc(c.cat)}</p>
    ${c.items.map(m => `
      <div class="menu-row">
        <div>
          <b>${esc(m.name)}</b>
          ${m.note ? `<em>${esc(m.note)}</em>` : ''}
        </div>
        <span><b>${yen(m.price)}</b><em>約${dur(m.min)}</em></span>
      </div>`).join('')}
  `).join('');

  $('#staff-list').innerHTML = SALON.staff.map(s => `
    <div class="staff">
      <div class="staff-av" style="background:linear-gradient(150deg,hsl(${s.hue} 42% 58%),hsl(${(s.hue + 28) % 360} 38% 34%))">
        ${esc(s.name.slice(0, 1))}
      </div>
      <div>
        <p class="role">${esc(s.role)}</p>
        <h3>${esc(s.name)}</h3>
        <p class="tags">${esc(s.tags)}／出勤 ${s.days.map(d => WD[d]).join('・')}</p>
        <p class="msg">${esc(s.msg)}</p>
      </div>
    </div>`).join('');

  $('#info').innerHTML = [
    ['店名', `${SALON.name} ${SALON.branch}`],
    ['電話', SALON.tel],
    ['住所', SALON.address],
    ['アクセス', SALON.access],
    ['営業時間', `${SALON.open}〜${SALON.close}（最終受付 ${SALON.lastOrder}）`],
    ['定休日', SALON.closedWeekdays.map(d => WD[d] + '曜日').join('・') || '年中無休'],
    ['支払方法', SALON.payment]
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

  $('#map-link').href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(SALON.address);

  $('#ft-name').textContent = `${SALON.name} ${SALON.branch}`;
  $('#ft-addr').textContent = `${SALON.address}／TEL ${SALON.tel}`;
  $('#ft-copy').textContent = `© ${new Date().getFullYear()} ${SALON.name}`;

  document.title = `${SALON.name} ${SALON.branch}｜ネット予約`;
}

function renderMenuPicker() {
  $('#pick-menu').innerHTML = SALON.menus.map(c => c.items.map(m => `
    <button class="chip chip-menu" type="button" data-menu="${m.id}"
            aria-pressed="${pick.menuId === m.id}">
      <b>${esc(m.name)}<small>${esc(c.cat)}／約${dur(m.min)}</small></b>
      <span>${yen(m.price)}</span>
    </button>`).join('')).join('');
}

function renderStaffPicker() {
  const none = `<button class="chip" type="button" data-staff=""
      aria-pressed="${pick.staffId === null}">指名なし<small>おまかせ</small></button>`;
  $('#pick-staff').innerHTML = none + SALON.staff.map(s => `
    <button class="chip" type="button" data-staff="${s.id}" aria-pressed="${pick.staffId === s.id}">
      ${esc(s.name)}<small>${s.fee ? '指名料 ' + yen(s.fee) : '指名料なし'}</small>
    </button>`).join('');
}

function renderDatePicker() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const html = [];
  for (let i = 0; i < SALON.showDays; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    const k = key(d);
    const wd = d.getDay();
    const cls = wd === 0 ? ' is-sun' : wd === 6 ? ' is-sat' : '';
    html.push(`
      <button class="chip chip-date${cls}" type="button" data-date="${k}"
              aria-pressed="${pick.date === k}" ${isClosed(k) ? 'disabled' : ''}>
        ${d.getMonth() + 1}/${d.getDate()}
        <small>${WD[wd]}${isClosed(k) ? '・休' : ''}</small>
      </button>`);
  }
  $('#pick-date').innerHTML = html.join('');
}

function renderTimePicker() {
  const host = $('#pick-time');
  if (!pick.date) {
    host.innerHTML = '<p class="hint">先にご来店日をお選びください。</p>';
    return;
  }
  const m = totalMin();
  const html = [];
  for (let t = mins(SALON.open); t <= mins(SALON.lastOrder); t += SALON.slot) {
    const time = hhmm(t);
    const ok = freeCount(pick.date, time, pick.staffId, m) > 0;
    html.push(`
      <button class="chip" type="button" data-time="${time}"
              aria-pressed="${pick.time === time}" ${ok ? '' : 'disabled'}>${time}</button>`);
  }
  host.innerHTML = html.join('');
  if (!html.length || !host.querySelector('.chip:not(:disabled)')) {
    host.innerHTML = '<p class="hint">この日は空きがありません。別の日をお選びください。</p>';
  }
}

function renderTotal() {
  $('#total').textContent = yen(total());
  const m = pickedMenu();
  $('#total-sub').textContent = m
    ? `${m.name}（約${dur(m.min)}）${pickedFee() ? ' ＋ 指名料 ' + yen(pickedFee()) : ''}`
    : 'メニューをお選びください';
}

function renderMyList() {
  const list = Store.all().sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  if (!list.length) {
    $('#my-list').innerHTML = '<p class="empty">この端末からのご予約はまだありません。</p>';
    return;
  }
  $('#my-list').innerHTML = list.map(b => {
    const past = fromKey(b.date).setMinutes(mins(b.time)) < Date.now();
    const off = b.cancelled || past;
    const label = b.cancelled ? 'キャンセル済み' : past ? 'ご来店済み' : '予約確定';
    return `
      <div class="bk ${off ? 'off' : ''}">
        <div class="bk-top">
          <span class="bk-st">${label}</span>
          <span class="bk-code">${esc(b.code)}</span>
        </div>
        <p class="bk-when">${dateJa(b.date)} ${esc(b.time)}〜</p>
        <p class="bk-d">${esc(b.menuName)}／${esc(b.staffName)}</p>
        <p class="bk-d">${yen(b.price)}（税込・約${dur(b.min)}）</p>
        ${off ? '' : `<button class="bk-cancel" type="button" data-cancel="${esc(b.code)}">キャンセルする</button>`}
      </div>`;
  }).join('');
}

/* ============================================================
   受信先への送信
   ============================================================ */
/* Content-Type を text/plain にしているのは意図的です。
   application/json にするとブラウザが事前確認（OPTIONS）を送りますが、
   Google Apps Script はこれに応答できず、送信が必ず失敗します。
   text/plain なら事前確認なしで届き、GAS 側は e.postData.contents で
   そのまま JSON として読めます。 */
async function send(payload) {
  if (!SALON.endpoint) return false;
  try {
    await fetch(SALON.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return true;
  } catch (err) {
    console.warn('送信に失敗しました。この端末には保存されています。', err);
    return false;
  }
}

/* ============================================================
   入力チェックと送信
   ============================================================ */
function setErr(id, on) { $('#err-' + id).classList.toggle('on', on); }

function validate() {
  const name = $('#f-name').value.trim();
  const tel = $('#f-tel').value.replace(/[-\s]/g, '');
  const checks = [
    ['menu', !pick.menuId],
    ['date', !pick.date],
    ['time', !pick.time],
    ['name', !name],
    ['tel', !/^0\d{9,10}$/.test(tel)]
  ];
  checks.forEach(([id, bad]) => setErr(id, bad));
  const first = checks.find(([, bad]) => bad);
  if (first) {
    $('#err-' + first[0]).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return null;
  }
  return { name, tel };
}

async function submit(e) {
  e.preventDefault();
  const c = validate();
  if (!c) return;

  const m = pickedMenu();
  const st = pick.staffId ? findStaff(pick.staffId) : null;
  const booking = {
    code: Store.newCode(),
    createdAt: new Date().toISOString(),
    date: pick.date,
    time: pick.time,
    endTime: hhmm(mins(pick.time) + m.min),
    menuId: m.id,
    menuName: m.name,
    staffId: pick.staffId,
    staffName: st ? st.name : '指名なし',
    fee: pickedFee(),
    price: total(),
    min: m.min,
    name: c.name,
    tel: c.tel,
    memo: $('#f-memo').value.trim(),
    cancelled: false
  };

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = '送信中…';

  await send({ type: 'reserve', ...booking });
  Store.add(booking);

  $('#done-code').textContent = booking.code;
  $('#done-list').innerHTML = [
    ['日時', `${dateJa(booking.date)} ${booking.time}〜${booking.endTime}`],
    ['メニュー', booking.menuName],
    ['ご担当', booking.staffName],
    ['お名前', booking.name + ' 様'],
    ['合計', yen(booking.price) + '（税込）']
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

  $('#form').hidden = true;
  $('#done').hidden = false;
  btn.disabled = false;
  btn.textContent = 'この内容で予約する';
  renderMyList();
  $('#done').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetForm() {
  pick.menuId = null; pick.staffId = null; pick.date = null; pick.time = null;
  $('#form').reset();
  $('#form').hidden = false;
  $('#done').hidden = true;
  ['menu', 'date', 'time', 'name', 'tel'].forEach(id => setErr(id, false));
  renderMenuPicker(); renderStaffPicker(); renderDatePicker(); renderTimePicker(); renderTotal();
  $('#reserve').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ============================================================
   起動
   ============================================================ */
renderStatic();
renderMenuPicker();
renderStaffPicker();
renderDatePicker();
renderTimePicker();
renderTotal();
renderMyList();

$('#pick-menu').addEventListener('click', e => {
  const b = e.target.closest('[data-menu]'); if (!b) return;
  pick.menuId = pick.menuId === b.dataset.menu ? null : b.dataset.menu;
  pick.time = null;
  setErr('menu', false);
  renderMenuPicker(); renderTimePicker(); renderTotal();
});

$('#pick-staff').addEventListener('click', e => {
  const b = e.target.closest('[data-staff]'); if (!b) return;
  pick.staffId = b.dataset.staff || null;
  pick.time = null;
  renderStaffPicker(); renderTimePicker(); renderTotal();
});

$('#pick-date').addEventListener('click', e => {
  const b = e.target.closest('[data-date]'); if (!b || b.disabled) return;
  pick.date = b.dataset.date;
  pick.time = null;
  setErr('date', false);
  renderDatePicker(); renderTimePicker();
});

$('#pick-time').addEventListener('click', e => {
  const b = e.target.closest('[data-time]'); if (!b || b.disabled) return;
  pick.time = b.dataset.time;
  setErr('time', false);
  renderTimePicker();
});

$('#form').addEventListener('submit', submit);
$('#again').addEventListener('click', resetForm);

$('#my-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-cancel]'); if (!btn) return;
  const code = btn.dataset.cancel;
  const b = Store.find(code);
  if (!b) return;
  if (!confirm(`${dateJa(b.date)} ${b.time}〜 のご予約をキャンセルします。\nよろしいですか？`)) return;

  Store.cancel(code);
  // 台帳側もキャンセル扱いに更新する
  send({ type: 'cancel', code, date: b.date, time: b.time, name: b.name });
  renderMyList();
  renderTimePicker();
});
