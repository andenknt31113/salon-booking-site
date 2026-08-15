/* ============================================================
 *  予約フロー（STEP1〜5 + 完了）
 * ============================================================ */

const DRAFT_KEY = 'salon.reserveDraft.v1';

const state = {
  step: 1,
  couponId: null,
  menuIds: [],
  staffId: null,        // null = 指名なし
  staffChosen: false,   // 「指名なし」を明示的に選んだか
  date: null,
  time: null,
  calOffset: 0,
  customer: { name: '', kana: '', tel: '', email: '', visit: '', request: '', agree: false }
};

/* ---------- 下書きの保存・復元 ---------- */
function saveDraft() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(state));
  } catch (e) { /* プライベートモード等では保存しない */ }
}
function loadDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.step === 6) return; // 完了済みの下書きは復元しない
    Object.assign(state, saved, { calOffset: 0 });
  } catch (e) { /* 破損時は無視 */ }
}
function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* noop */ }
}

/* メニューをスプレッドシート管理に切り替えると、data.js 由来のID（cp01 など）と
   シート由来のID（sc0 など）が変わります。下書きに残った古いIDを掃除しないと、
   「選択済みに見えるのに合計が0円」という状態になるため取り除きます。 */
function dropUnknownSelections() {
  if (state.couponId && !SALON.coupons.some(c => c.id === state.couponId)) {
    state.couponId = null;
  }
  const known = new Set(allMenuItems().map(m => m.id));
  state.menuIds = state.menuIds.filter(id => known.has(id));
}

/* ---------- 集計 ---------- */
function selectedMenus() {
  const list = [];
  if (state.couponId) {
    const c = SALON.coupons.find(x => x.id === state.couponId);
    if (c) list.push({ id: c.id, name: c.title, price: c.price, priceFrom: !!c.priceFrom, minutes: c.minutes, isCoupon: true });
  }
  state.menuIds.forEach(id => {
    const m = allMenuItems().find(x => x.id === id);
    if (m) list.push({ id: m.id, name: m.name, price: m.price, priceFrom: !!m.priceFrom, minutes: m.minutes, isCoupon: false });
  });
  return list;
}
function nominationFee() {
  const st = findStaff(state.staffId);
  return st ? st.nominationFee : 0;
}
function totalPrice() {
  return selectedMenus().reduce((sum, m) => sum + m.price, 0) + nominationFee();
}
function totalMinutes() {
  return selectedMenus().reduce((sum, m) => sum + m.minutes, 0) || SALON.business.slotMinutes;
}
function hasMenu() {
  return selectedMenus().length > 0;
}

/* 1件ぶんの金額表示。
   price が 0 のものは金額が決まっていないので「お見積り」と出す。
   priceFrom が true のものは掲載どおり「〜」を付ける。 */
function priceText(m) {
  return m.price ? yen(m.price) + (m.priceFrom ? '〜' : '') : 'お見積り';
}

/* 合計の表示。
   すべて金額未定なら金額を出さず「お見積り」。
   金額未定や「〜」が混ざっていれば、分かっている分に「〜」を付けて出す。 */
function totalText() {
  const menus = selectedMenus();
  const total = totalPrice();
  if (!menus.length) return yen(0);
  const unsure = menus.some(m => !m.price || m.priceFrom);
  if (!total) return 'お見積り';
  return yen(total) + (unsure ? '〜' : '');
}

/* ============================================================
 *  STEP1: メニュー選択
 * ============================================================ */
function renderCouponChoices() {
  $('#coupon-choices').innerHTML = SALON.coupons.map(c => `
    <button class="selectable ${state.couponId === c.id ? 'is-selected' : ''}" type="button" data-coupon="${esc(c.id)}">
      <span class="selectable-title">［${esc(c.badge)}］${esc(c.title)}</span>
      <span class="selectable-sub">${esc(c.detail)}</span>
      <span class="selectable-meta"><strong>${priceText(c)}</strong> ／ 約${formatDuration(c.minutes)}</span>
    </button>`).join('');
}

function renderMenuChoices(catId) {
  const cats = catId === 'all' ? SALON.menuCategories : SALON.menuCategories.filter(c => c.id === catId);
  $('#menu-choices').innerHTML = cats.map(cat => `
    <h4 style="font-size:13px;color:var(--ink-3);margin:18px 0 8px;">${esc(cat.name)}</h4>
    ${cat.items.map(m => `
      <button class="selectable ${state.menuIds.includes(m.id) ? 'is-selected' : ''}" type="button" data-menu="${esc(m.id)}">
        <span class="selectable-title">${esc(m.name)}</span>
        ${m.note ? `<span class="selectable-sub">${esc(m.note)}</span>` : ''}
        <span class="selectable-meta"><strong>${priceText(m)}</strong> ／ 約${formatDuration(m.minutes)}</span>
      </button>`).join('')}
  `).join('');
}

function initStep1() {
  renderCouponChoices();

  const tabsHost = $('#menu-cat-tabs');
  tabsHost.innerHTML = [{ id: 'all', name: 'すべて' }, ...SALON.menuCategories]
    .map((c, i) => `<button class="tab" type="button" data-cat="${esc(c.id)}" aria-selected="${i === 0}">${esc(c.name)}</button>`)
    .join('');
  renderMenuChoices('all');

  tabsHost.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab', tabsHost).forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    renderMenuChoices(tab.dataset.cat);
  });

  $('#coupon-choices').addEventListener('click', e => {
    const btn = e.target.closest('[data-coupon]');
    if (!btn) return;
    const id = btn.dataset.coupon;
    state.couponId = state.couponId === id ? null : id; // 再クリックで解除
    resetDateTime();
    renderCouponChoices();
    updateSummary();
    saveDraft();
  });

  $('#menu-choices').addEventListener('click', e => {
    const btn = e.target.closest('[data-menu]');
    if (!btn) return;
    const id = btn.dataset.menu;
    state.menuIds = state.menuIds.includes(id)
      ? state.menuIds.filter(x => x !== id)
      : [...state.menuIds, id];
    resetDateTime();
    btn.classList.toggle('is-selected', state.menuIds.includes(id));
    updateSummary();
    saveDraft();
  });
}

/* ============================================================
 *  STEP2: スタッフ選択
 * ============================================================ */
function renderStaffChoices() {
  // スタイリストが1名のサロンでは「指名なし」は出さない
  const none = SALON.staff.length <= 1 ? '' : `
    <button class="selectable ${state.staffChosen && !state.staffId ? 'is-selected' : ''}" type="button" data-staff="">
      <span class="selectable-title">指名なし（おまかせ）</span>
      <span class="selectable-sub">当日空いているスタッフが担当いたします。指名料はかかりません。</span>
      <span class="selectable-meta">指名料 <strong>¥0</strong></span>
    </button>`;

  const list = SALON.staff.map(s => `
    <button class="selectable ${state.staffId === s.id ? 'is-selected' : ''}" type="button" data-staff="${esc(s.id)}">
      <span class="selectable-title">${esc(s.name)}（${esc(s.role)}）</span>
      <span class="selectable-sub">${esc(s.tags.map(t => '#' + t).join(' '))}／出勤：${s.workdays.map(d => WEEKDAY_JA[d]).join('・')}曜</span>
      <span class="selectable-meta">指名料 <strong>${s.nominationFee > 0 ? yen(s.nominationFee) : '¥0'}</strong></span>
    </button>`).join('');

  $('#staff-choices').innerHTML = none + list;
}

function initStep2() {
  renderStaffChoices();
  $('#staff-choices').addEventListener('click', e => {
    const btn = e.target.closest('[data-staff]');
    if (!btn) return;
    state.staffId = btn.dataset.staff || null;
    state.staffChosen = true;
    resetDateTime();
    renderStaffChoices();
    updateSummary();
    saveDraft();
  });
}

/* ============================================================
 *  STEP3: 空席カレンダー
 * ============================================================ */
function resetDateTime() {
  state.date = null;
  state.time = null;
}

function renderCalendar() {
  const dates = Availability.dateRange(state.calOffset);
  const times = Availability.timeSlots();
  const duration = totalMinutes();

  $('#cal-duration').textContent = formatDuration(duration);
  $('#cal-range').textContent =
    `${formatDateJa(dates[0], { short: true })} 〜 ${formatDateJa(dates[dates.length - 1], { short: true })}`;
  $('#cal-prev').disabled = state.calOffset === 0;
  $('#cal-next').disabled =
    state.calOffset + SALON.business.calendarDays * 2 > SALON.business.bookableDays;

  $('#cal-head').innerHTML = `<tr><th scope="col">時間</th>${dates.map(d => {
    const wd = fromKey(d).getDay();
    const cls = wd === 0 ? ' class="is-sun"' : wd === 6 ? ' class="is-sat"' : '';
    return `<th scope="col"${cls}>
        <span class="cal-date">${fromKey(d).getMonth() + 1}/${fromKey(d).getDate()}</span>
        <span class="cal-wd">${WEEKDAY_JA[wd]}</span>
      </th>`;
  }).join('')}</tr>`;

  $('#cal-body').innerHTML = times.map(t => `
    <tr>
      <th scope="row">${t}</th>
      ${dates.map(d => {
        const info = Availability.slotInfo(d, t, state.staffId, duration);
        const selected = state.date === d && state.time === t;
        const cls = [
          'slot',
          info.symbol === '△' ? 'is-few' : '',
          selected ? 'is-selected' : ''
        ].filter(Boolean).join(' ');
        const label = info.available
          ? `${formatDateJa(d, { short: true })} ${t} を選択`
          : `${formatDateJa(d, { short: true })} ${t} は予約できません`;
        return `<td><button class="${cls}" type="button" ${info.available ? '' : 'disabled'}
            data-date="${d}" data-time="${t}" aria-label="${esc(label)}">${info.symbol}</button></td>`;
      }).join('')}
    </tr>`).join('');
}

function initStep3() {
  $('#cal-prev').addEventListener('click', () => {
    state.calOffset = Math.max(0, state.calOffset - SALON.business.calendarDays);
    renderCalendar();
  });
  $('#cal-next').addEventListener('click', () => {
    state.calOffset += SALON.business.calendarDays;
    renderCalendar();
  });
  $('#cal-body').addEventListener('click', e => {
    const btn = e.target.closest('.slot');
    if (!btn || btn.disabled) return;
    state.date = btn.dataset.date;
    state.time = btn.dataset.time;
    renderCalendar();
    updateSummary();
    saveDraft();
  });
}

/* ============================================================
 *  STEP4: 入力フォーム
 * ============================================================ */
const VALIDATORS = {
  name: v => v.trim().length > 0,
  kana: v => /^[ァ-ヶー\s　]+$/.test(v.trim()),
  tel: v => /^0\d{9,10}$/.test(v.replace(/[-\s]/g, '')),
  email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
  visit: v => v !== '',
  agree: v => v === true
};

function readForm() {
  const form = $('#customer-form');
  return {
    name: form.name.value,
    kana: form.kana.value,
    tel: form.tel.value,
    email: form.email.value,
    visit: (form.querySelector('input[name="visit"]:checked') || {}).value || '',
    request: form.request.value,
    agree: form.agree.checked
  };
}

function fillForm() {
  const form = $('#customer-form');
  const c = state.customer;
  form.name.value = c.name;
  form.kana.value = c.kana;
  form.tel.value = c.tel;
  form.email.value = c.email;
  form.request.value = c.request;
  form.agree.checked = !!c.agree;
  if (c.visit) {
    const radio = form.querySelector(`input[name="visit"][value="${CSS.escape(c.visit)}"]`);
    if (radio) radio.checked = true;
  }
}

function validateForm(showErrors = true) {
  const c = readForm();
  state.customer = c;
  let firstInvalid = null;

  Object.entries(VALIDATORS).forEach(([key, check]) => {
    const field = $(`[data-field="${key}"]`);
    const ok = check(c[key]);
    if (showErrors) field.classList.toggle('has-error', !ok);
    if (!ok && !firstInvalid) firstInvalid = field;
  });

  if (firstInvalid && showErrors) {
    firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = firstInvalid.querySelector('input, textarea');
    if (input) input.focus({ preventScroll: true });
  }
  return !firstInvalid;
}

function initStep4() {
  const form = $('#customer-form');
  fillForm();
  form.addEventListener('input', () => {
    state.customer = readForm();
    saveDraft();
  });
  form.addEventListener('change', () => {
    state.customer = readForm();
    saveDraft();
  });
  // 入力し直したらエラー表示を解除
  form.addEventListener('input', e => {
    const field = e.target.closest('.form-field');
    if (field) field.classList.remove('has-error');
  });
}

/* ============================================================
 *  STEP5: 確認 → 送信
 * ============================================================ */
function reservationSummaryRows() {
  const menus = selectedMenus();
  const end = toHHMM(toMinutes(state.time) + totalMinutes());
  const fee = nominationFee();
  return [
    ['ご来店日時', `${formatDateJa(state.date)} ${state.time} 〜 ${end}（約${formatDuration(totalMinutes())}）`],
    ['ご担当', staffLabel(state.staffId) + (fee > 0 ? `（指名料 ${yen(fee)}）` : '')],
    ['メニュー', menus.map(m => `${m.name}（${priceText(m)}）`).join('<br />')],
    ['合計金額', `<strong style="font-size:17px;color:var(--accent);">${totalText()}</strong>${totalPrice() ? '（税込）' : ''}`],
    ['お名前', `${esc(state.customer.name)}（${esc(state.customer.kana)}）様`],
    ['電話番号', esc(state.customer.tel)],
    ['メールアドレス', esc(state.customer.email)],
    ['ご来店回数', esc(state.customer.visit)],
    ['ご要望', state.customer.request ? esc(state.customer.request).replace(/\n/g, '<br />') : '—']
  ];
}

function renderConfirm() {
  $('#confirm-body').innerHTML = reservationSummaryRows()
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('');
}

function buildReservation() {
  const menus = selectedMenus();
  return {
    code: Store.issueCode(),
    status: 'reserved',
    createdAt: new Date().toISOString(),
    date: state.date,
    time: state.time,
    endTime: toHHMM(toMinutes(state.time) + totalMinutes()),
    staffId: state.staffId,
    staffName: staffLabel(state.staffId),
    menus: menus.map(m => ({ id: m.id, name: m.name, price: m.price, priceFrom: m.priceFrom, minutes: m.minutes })),
    nominationFee: nominationFee(),
    totalPrice: totalPrice(),
    /* 「お見積り」「¥7,000〜」など、金額をそのまま出せない場合の表示文字列。
       完了画面・予約確認ページで ¥0 と出てしまわないように持たせる。 */
    totalLabel: totalText(),
    totalMinutes: totalMinutes(),
    customer: { ...state.customer }
  };
}

/* ---------- カレンダーへの登録 ----------
   .ics ファイルを作ってダウンロードさせます。
   iPhone・Android・PC のどのカレンダーでも同じ形式で読めます。
   店舗側の予約はGoogleカレンダーに入りますが、これはお客様のための控えです。 */
function icsStamp(dateKey, time) {
  // ローカル時刻のまま書き、TZID で日本時間だと伝える
  return dateKey.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
}

function buildIcs(r) {
  const esc = t => String(t || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const place = [SALON.fullName || SALON.name, SALON.address].filter(Boolean).join(' ');
  const detail = [
    '予約番号：' + r.code,
    'メニュー：' + (r.menus || []).map(m => m.name).join(' / '),
    'ご担当：' + r.staffName,
    '合計：' + (r.totalLabel || yen(r.totalPrice)),
    SALON.tel ? 'TEL：' + SALON.tel : '',
    '予約の確認・キャンセル：' + location.href.replace(/reserve\.html.*$/, 'mypage.html')
  ].filter(Boolean).join('\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ZER01//reservation//JA',
    'CALSCALE:GREGORIAN',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Tokyo',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0900',
    'TZOFFSETTO:+0900',
    'TZNAME:JST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:' + r.code + '@zer01',
    // DTSTAMP は「この予定を書き出した時刻」なので、来店日時ではなく今のUTC
    'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''),
    'DTSTART;TZID=Asia/Tokyo:' + icsStamp(r.date, r.time),
    'DTEND;TZID=Asia/Tokyo:' + icsStamp(r.date, r.endTime),
    'SUMMARY:' + esc((SALON.name || 'サロン') + ' ご予約'),
    'LOCATION:' + esc(place),
    'DESCRIPTION:' + esc(detail),
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    'DESCRIPTION:' + esc((SALON.name || 'サロン') + ' のご予約が2時間後です'),
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

function downloadIcs(r) {
  const blob = new Blob([buildIcs(r)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${SALON.name || 'salon'}-${r.code}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function submitReservation() {
  const btn = $('#submit-reservation');
  btn.disabled = true;
  btn.textContent = '送信中…';

  // 選択中に他のお客様が同じ枠を押さえていないか、最新の状況で確認する
  await Remote.load(true);
  if (!Availability.slotInfo(state.date, state.time, state.staffId, totalMinutes()).available) {
    btn.disabled = false;
    btn.textContent = 'この内容で予約する';
    alert(
      '申し訳ありません。ご選択の時間は、ちょうど他のお客様のご予約が入りました。\n' +
      '別の日時をお選びください。'
    );
    state.time = null;
    goTo(3);
    return;
  }

  const reservation = buildReservation();
  // 送信は common.js の sendToEndpoint（text/plain で送る理由もそちらに記載）
  reservation.delivered = await sendToEndpoint({ type: 'reserve', ...reservation });
  Store.add(reservation);

  $('#done-code').textContent = reservation.code;
  $('#done-body').innerHTML = [
    ['ご来店日時', `${formatDateJa(reservation.date)} ${reservation.time}〜`],
    ['ご担当', reservation.staffName],
    ['メニュー', reservation.menus.map(m => esc(m.name)).join('<br />')],
    ['合計金額', `${reservation.totalLabel || yen(reservation.totalPrice)}${reservation.totalPrice ? '（税込）' : ''}`]
  ].map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('');

  // 完了画面の「カレンダーに追加」に、いま取れた予約を渡す
  const calBtn = $('#add-to-calendar');
  if (calBtn) calBtn.onclick = () => downloadIcs(reservation);

  clearDraft();
  state.step = 6;
  renderStep();
  btn.disabled = false;
  btn.textContent = 'この内容で予約する';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================
 *  サマリー・ステップ制御
 * ============================================================ */
function updateSummary() {
  const menus = selectedMenus();
  const fee = nominationFee();
  const rows = [];

  rows.push(['メニュー', menus.length
    ? menus.map(m => `${esc(m.name)}<br /><small style="color:var(--ink-3)">${priceText(m)}／約${formatDuration(m.minutes)}</small>`).join('<br />')
    : '<span style="color:var(--ink-3)">未選択</span>']);

  rows.push(['ご担当', state.staffChosen
    ? esc(staffLabel(state.staffId)) + (fee > 0 ? `<br /><small style="color:var(--ink-3)">指名料 ${yen(fee)}</small>` : '')
    : '<span style="color:var(--ink-3)">未選択</span>']);

  rows.push(['日時', state.date && state.time
    ? `${formatDateJa(state.date, { short: true })} ${state.time}〜<br /><small style="color:var(--ink-3)">所要 約${formatDuration(totalMinutes())}</small>`
    : '<span style="color:var(--ink-3)">未選択</span>']);

  $('#summary-body').innerHTML = rows
    .map(([k, v]) => `<div class="summary-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#summary-total').textContent = totalText();
  const hasQuote = menus.some(m => !m.price);
  $('#summary-note').textContent = !menus.length
    ? '※メニューをお選びいただくと合計金額が表示されます。'
    : hasQuote
      ? '※価格はカウンセリングのうえでお見積りいたします。'
      : '※髪の長さ・毛量により追加料金をいただく場合がございます。';
}

function renderStep() {
  $$('.reserve-panel').forEach(p => {
    p.classList.toggle('is-active', Number(p.dataset.panel) === state.step);
  });
  $$('.step').forEach(s => {
    const n = Number(s.dataset.step);
    s.classList.toggle('is-current', n === state.step);
    s.classList.toggle('is-done', n < state.step);
  });
  $('#steps').style.display = state.step === 6 ? 'none' : '';
  $('#summary').style.display = state.step === 6 ? 'none' : '';
  if (state.step === 6) $('#reserve-layout').style.gridTemplateColumns = '1fr';
  updateSummary();
}

function goTo(step) {
  // 前に進むときだけ入力チェック
  if (step > state.step) {
    if (state.step === 1 && !hasMenu()) {
      alert('メニューを1つ以上お選びください。');
      return;
    }
    if (state.step === 2 && !state.staffChosen) {
      alert('ご希望のスタッフ、または「指名なし」をお選びください。');
      return;
    }
    if (state.step === 3 && !(state.date && state.time)) {
      alert('ご来店日時をお選びください。');
      return;
    }
    if (state.step === 4 && !validateForm()) return;
  }

  state.step = step;
  if (step === 3) renderCalendar();
  if (step === 5) renderConfirm();
  saveDraft();
  renderStep();
  window.scrollTo({ top: $('#steps').offsetTop - 130, behavior: 'smooth' });
}

/* ---------- URLパラメータからの事前選択 ----------
   search を渡さなければ現在のURLから読む。
   全画面を1ファイルにまとめたプレビュー版から明示的に渡せるようにしてある。 */
function applyQueryParams(search) {
  const params = new URLSearchParams(search || location.search);
  const menu = params.get('menu');
  const staff = params.get('staff');

  if (menu) {
    if (SALON.coupons.some(c => c.id === menu)) {
      state.couponId = menu;
    } else if (allMenuItems().some(m => m.id === menu) && !state.menuIds.includes(menu)) {
      state.menuIds.push(menu);
    }
  }
  if (staff && findStaff(staff)) {
    state.staffId = staff;
    state.staffChosen = true;
  }
}

/* ---------- 起動 ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  // スプレッドシートにメニューがあれば取り込む（無ければ data.js のまま）
  await Catalog.load();

  loadDraft();
  dropUnknownSelections();
  applyQueryParams();
  if (state.step === 6) state.step = 1;
  if (!hasMenu()) state.step = 1;   // 選択が消えた場合は最初から

  // スタイリストが1名なら、その人を初めから選んでおく
  if (SALON.staff.length === 1 && !state.staffChosen) {
    state.staffId = SALON.staff[0].id;
    state.staffChosen = true;
  }

  initStep1();
  initStep2();
  initStep3();
  initStep4();

  $('#reserve-layout').addEventListener('click', e => {
    const next = e.target.closest('[data-next]');
    if (next) { goTo(Number(next.dataset.next)); return; }
    const prev = e.target.closest('[data-prev]');
    if (prev) { goTo(Number(prev.dataset.prev)); }
  });

  $('#submit-reservation').addEventListener('click', submitReservation);

  // 他のお客様の予約状況を取得し、届いたらカレンダーを描き直す
  Remote.load().then(ok => {
    if (ok && state.step === 3) renderCalendar();
  });

  // ステップ表示をクリックして戻れるように
  $('#steps').addEventListener('click', e => {
    const step = e.target.closest('.step');
    if (!step) return;
    const n = Number(step.dataset.step);
    if (n < state.step) goTo(n);
  });

  renderStep();
});
