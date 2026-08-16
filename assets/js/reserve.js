/* ============================================================
 *  予約フロー（STEP1〜5 + 完了）
 * ============================================================ */

const DRAFT_KEY = 'salon.reserveDraft.v1';
/* 日時変更モード。予約確認ページから渡された予約が入ります。
   null なら通常の新規予約です。 */
let changing = null;

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
/* IDだけでなく「名前」も一緒に控えます。
   メニューをスプレッドシート管理にすると、同じメニューでもIDが変わります
   （cp01 → sc0）。IDだけだと、読み込み直したときに選択が消えます。 */
function draftNames() {
  const coupon = state.couponId
    ? (SALON.coupons.find(c => c.id === state.couponId) || {}).title : '';
  const menus = state.menuIds
    .map(id => (allMenuItems().find(m => m.id === id) || {}).name)
    .filter(Boolean);
  return { couponName: coupon || '', menuNames: menus };
}

function saveDraft() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...state, ...draftNames() }));
  } catch (e) { /* プライベートモード等では保存しない */ }
}
function loadDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.step === 6) return null; // 完了済みの下書きは復元しない
    Object.assign(state, saved, { calOffset: 0 });
    return saved;
  } catch (e) { return null; }   // 破損時は無視
}
function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* noop */ }
}

/* ---------- お客様情報を「この端末」に覚えておく ----------
   2回目以降の予約はLINEからこのページに来ていただく想定なので、
   同じ端末なら名前・電話番号・メールを入力し直さずに済むようにします。
   保存先はその端末の localStorage だけで、店やサーバーには送りません。
   （LINEのアカウントと結びつけるにはLINEログインの契約が要るため、
     まずは端末に覚えておく方式にしています） */
const PROFILE_KEY = 'salon.customer.v1';

function saveProfile(c) {
  if (!c || !c.name || !c.tel) return;
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({
      name: c.name, kana: c.kana, tel: c.tel, email: c.email
    }));
  } catch (e) { /* プライベートモード等では覚えない */ }
}
function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    if (!saved || !saved.name || !saved.tel) return null;
    return saved;
  } catch (e) { return null; }
}
function clearProfile() {
  try { localStorage.removeItem(PROFILE_KEY); } catch (e) { /* noop */ }
}

/* 下書きに残っていたIDが、いまのメニューに無いことがあります。
   スプレッドシート管理に切り替えるとIDが変わるためです（cp01 → sc0）。

   そのまま消すと、読み込み直しただけで選択が消えて最初からになります。
   まず**名前で**同じものを探し、見つからないときだけ諦めます。
   （消さずに残すと「選択済みに見えるのに合計が0円」になります） */
function reconcileSelections(saved) {
  const byName = (list, name) => list.find(x => (x.title || x.name) === name);

  if (state.couponId && !SALON.coupons.some(c => c.id === state.couponId)) {
    const c = saved && saved.couponName ? byName(SALON.coupons, saved.couponName) : null;
    state.couponId = c ? c.id : null;
  }
  const known = new Set(allMenuItems().map(m => m.id));
  const names = (saved && saved.menuNames) || [];
  state.menuIds = state.menuIds.map((id, i) => {
    if (known.has(id)) return id;
    const m = names[i] ? byName(allMenuItems(), names[i]) : null;
    return m ? m.id : null;
  }).filter(Boolean);
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
  const fromChange = changeMinutes();
  if (fromChange) return fromChange;
  return selectedMenus().reduce((sum, m) => sum + m.minutes, 0) || SALON.business.slotMinutes;
}
function hasMenu() {
  // 変更モードでは、メニューは元の予約のものが確定している
  return !!changing || selectedMenus().length > 0;
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
  /* まだ何も選んでいないとき「¥0」と出していました。
     金額の欄に0円と書いてあれば、それは「無料」と読めます。
     すぐ下に「メニューをお選びいただくと合計金額が表示されます」と
     書いてあるのに、その上で0円と言っているので、矛盾もしています。 */
  if (!menus.length) return '—';
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
      ${c.detail ? `<span class="selectable-sub">${esc(c.detail)}</span>` : ''}
      <span class="selectable-meta">
        <strong class="${c.price ? '' : 'is-quote'}">${priceText(c)}</strong>
        <span class="selectable-time">約${formatDuration(c.minutes)}</span>
      </span>
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
        <span class="selectable-meta">
          <strong class="${m.price ? '' : 'is-quote'}">${priceText(m)}</strong>
          <span class="selectable-time">約${formatDuration(m.minutes)}</span>
        </span>
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

  bindOnce('menu-cat-tabs', () => tabsHost.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab', tabsHost).forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    renderMenuChoices(tab.dataset.cat);
  }));

  bindOnce('coupon-choices', () => $('#coupon-choices').addEventListener('click', e => {
    const btn = e.target.closest('[data-coupon]');
    if (!btn) return;
    const id = btn.dataset.coupon;
    state.couponId = state.couponId === id ? null : id; // 再クリックで解除
    resetDateTime();
    renderCouponChoices();
    updateSummary();
    saveDraft();
  }));

  bindOnce('menu-choices', () => $('#menu-choices').addEventListener('click', e => {
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
  }));
}

/* ============================================================
 *  STEP2: スタッフ選択
 * ============================================================ */
/* スタイリストが1名の店では「指名」という考え方そのものがありません。
   誰に切ってもらうかは選びようがなく、指名料も発生しません。
   それでも「ご指名のスタッフをお選びください」「指名なしの場合は当日
   空いているスタッフが」と書いていたため、お客様は在りもしない
   「指名なし」を探すことになっていました（staff.html では
   すでに直っている言い方に、予約画面もそろえます）。 */
const soloStylist = () => SALON.staff.length <= 1;

function renderStaffLead() {
  const head = $('#h-step2');
  const lead = $('#staff-lead');
  if (!head || !lead) return;
  const solo = soloStylist();
  head.textContent = solo ? 'ご担当のご確認' : 'ご指名のスタッフをお選びください';
  lead.textContent = solo
    ? `当店は${SALON.staff[0] ? SALON.staff[0].name : 'スタイリスト'}が`
      + 'マンツーマンでお受けしています。そのまま日時の選択へお進みください。'
    : '指名なしの場合は、当日空いているスタッフが担当いたします。';
  // ステップ表示と、STEP1 の「進む」ボタンの言い方もそろえる
  const chip = $('#step2-label');
  if (chip) chip.textContent = solo ? 'ご担当' : 'スタッフ';
  const btn = $('#to-staff');
  if (btn) btn.textContent = solo ? 'ご担当の確認へ進む' : 'スタッフ選択へ進む';
}

function renderStaffChoices() {
  // スタイリストが1名のサロンでは「指名なし」は出さない
  const none = soloStylist() ? '' : `
    <button class="selectable ${state.staffChosen && !state.staffId ? 'is-selected' : ''}" type="button" data-staff="">
      <span class="selectable-title">指名なし（おまかせ）</span>
      <span class="selectable-sub">当日空いているスタッフが担当いたします。指名料はかかりません。</span>
      <span class="selectable-meta"><span>指名料 <strong>¥0</strong></span></span>
    </button>`;

  const list = SALON.staff.map(s => {
    /* 選びようがなく、かからない指名料を「¥0」と書いても読む理由がありません。
       1名の店では、その行ごと出しません。 */
    const fee = (soloStylist() && !s.nominationFee) ? ''
      : `<span class="selectable-meta"><span>指名料 <strong>${s.nominationFee > 0 ? yen(s.nominationFee) : '¥0'}</strong></span></span>`;
    return `
    <button class="selectable ${state.staffId === s.id ? 'is-selected' : ''}" type="button" data-staff="${esc(s.id)}">
      <span class="selectable-title">${esc(s.name)}（${esc(s.role)}）</span>
      <span class="selectable-sub">${esc(s.tags.map(t => '#' + t).join(' '))}／出勤：${s.workdays.map(d => WEEKDAY_JA[d]).join('・')}曜</span>
      ${fee}
    </button>`;
  }).join('');

  $('#staff-choices').innerHTML = none + list;
}

function initStep2() {
  renderStaffLead();
  renderStaffChoices();
  bindOnce('staff-choices', () => $('#staff-choices').addEventListener('click', e => {
    const btn = e.target.closest('[data-staff]');
    if (!btn) return;
    state.staffId = btn.dataset.staff || null;
    state.staffChosen = true;
    resetDateTime();
    renderStaffChoices();
    updateSummary();
    saveDraft();
  }));
}

/* ============================================================
 *  STEP3: 空席カレンダー
 * ============================================================ */
function resetDateTime() {
  state.date = null;
  state.time = null;
}

/* カレンダーの記号の説明。
   ◎（余裕あり）と △（残りわずか）は、担当を指定したときと
   スタイリストが1名の店では slotInfo が返しません。
   出ない記号を並べておくと、お客様は「◎の日を探そう」として
   いつまでも見つけられません。出るものだけ書きます。 */
function renderLegend() {
  const host = $('#cal-legend');
  if (!host) return;
  const graded = !soloStylist() && !state.staffId;
  host.innerHTML = [
    graded ? '<li><b>◎</b> 空きに余裕あり</li>' : '',
    '<li><b>○</b> 予約できます</li>',
    graded ? '<li><span class="few">△</span> 残りわずか</li>' : '',
    '<li><span class="none">×</span> 予約できません</li>',
    '<li><span class="none">-</span> 休業日</li>'
  ].filter(Boolean).join('');
}

/* 他のお客様の予約状況を取りにいっているあいだの表示。
   届く前のカレンダーは、この端末の記録だけで描いた古い空き状況です。
   黙って出しておくと、それを最新だと思って選ばれます。 */
function showCalendarLoading(on) {
  const el = $('#cal-status');
  if (el) el.hidden = !on;
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

  renderLegend();
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

/* 予約が取れた直後は、LINEの友だち追加をいちばんお願いしやすい瞬間です。
   ここで登録していただけると、次回からホットペッパーを通さずに来ていただけます。
   data.js の lineAddUrl が空のあいだは何も出しません。 */
function renderLineInvite() {
  const host = $('#line-invite');
  if (!host || !SALON.lineAddUrl) return;
  host.innerHTML = `
    <p class="line-invite-title">次回のご予約は、LINEからワンタップで</p>
    <p class="line-invite-text">
      友だち追加していただくと、前日のリマインドが届き、
      次回のご予約もこの画面まで一度で開けます。
    </p>
    <a class="btn btn-line" href="${esc(SALON.lineAddUrl)}" target="_blank" rel="noopener">
      LINEで友だち追加
    </a>`;
  host.hidden = false;
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

/* 日本語入力のままでも困らないように、読み取れる形に直します。

   打っている最中に書き換えると、変換の途中で文字が飛んだり、
   カーソルが末尾へ跳んだりします。ですから直すのは、その欄から
   離れたときと、送る直前だけです。直した内容は入力欄にも書き戻し、
   お客様自身が「これで送られる」と確かめられるようにします。 */
const TIDY = {
  name: v => v.trim(),
  kana: v => toKatakana(v).trim(),
  tel: v => normalizeTel(v),
  email: v => normalizeEmail(v)
};

function tidyField(input) {
  const made = TIDY[input && input.name];
  if (!made) return;
  const next = made(input.value);
  if (next !== input.value) input.value = next;
}

function tidyForm() {
  const form = $('#customer-form');
  Object.keys(TIDY).forEach(k => { if (form[k]) tidyField(form[k]); });
}

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
  tidyForm();
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
    // 覚えてある内容を畳んで隠しているときに不備が見つかったら、
    // 直せるように入力欄を開いてから案内する
    if (firstInvalid.hidden) showProfileForm();
    firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = firstInvalid.querySelector('input, textarea');
    if (input) input.focus({ preventScroll: true });
  }
  return !firstInvalid;
}

/* 覚えてある内容を出しているあいだは、お名前〜メールの4項目を畳んでおきます。
   ご来店回数・ご要望・同意チェックは毎回ご本人に選んでいただくので残します。 */
const PROFILE_FIELDS = ['name', 'kana', 'tel', 'email'];

function showProfileCard(p) {
  $('#saved-profile-body').innerHTML = [
    ['お名前', `${esc(p.name)}（${esc(p.kana)}）様`],
    ['電話番号', esc(p.tel)],
    ['メールアドレス', esc(p.email)]
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('#saved-profile').hidden = false;
  PROFILE_FIELDS.forEach(f => { $(`[data-field="${f}"]`).hidden = true; });
  // 入力するものがほとんど無いので、見出しも合わせる
  $('#h-step4').textContent = 'お客様情報のご確認';
}

function showProfileForm() {
  $('#saved-profile').hidden = true;
  PROFILE_FIELDS.forEach(f => { $(`[data-field="${f}"]`).hidden = false; });
  $('#h-step4').textContent = 'お客様情報をご入力ください';
}

function applySavedProfile() {
  const p = loadProfile();
  // 下書きに入力済みの内容があるときは、そちらを優先して邪魔しない
  if (!p || state.customer.name) { showProfileForm(); return; }
  Object.assign(state.customer, p);
  // 前にこの端末から予約されている＝初めてではない
  if (!state.customer.visit) state.customer.visit = '2回目以降';
  fillForm();
  showProfileCard(p);
}

function initStep4() {
  const form = $('#customer-form');
  fillForm();
  applySavedProfile();

  bindOnce('profile-edit', () => $('#profile-edit').addEventListener('click', () => {
    showProfileForm();
    form.name.focus();
  }));
  bindOnce('profile-clear', () => $('#profile-clear').addEventListener('click', () => {
    clearProfile();
    PROFILE_FIELDS.forEach(f => { form[f].value = ''; });
    state.customer = readForm();
    saveDraft();
    showProfileForm();
    form.name.focus();
  }));

  form.addEventListener('input', () => {
    state.customer = readForm();
    saveDraft();
  });
  form.addEventListener('change', () => {
    state.customer = readForm();
    saveDraft();
  });
  // 欄から離れたときに、全角の数字や半角カナをそっと直す
  form.addEventListener('focusout', e => {
    if (!e.target || !TIDY[e.target.name]) return;
    tidyField(e.target);
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
  if (changing) return changeSummaryRows();
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

/* 変更モードの確認画面。変更前後が並ぶようにする。 */
function changeSummaryRows() {
  const end = toHHMM(toMinutes(state.time) + totalMinutes());
  const menuText = changing.menus
    ? changing.menus.map(m => m.name).join(' ／ ')
    : (changing.menuText || '');
  return [
    ['ご予約番号', esc(changing.code) + '（変更ありません）'],
    ['変更前', `${formatDateJa(changing.date)} ${esc(changing.time)}〜`],
    ['変更後', `<strong style="color:var(--accent);">${formatDateJa(state.date)} ${esc(state.time)} 〜 ${end}</strong>（約${formatDuration(totalMinutes())}）`],
    ['ご担当', esc(changing.staffName || staffLabel(state.staffId))],
    ['メニュー', esc(menuText)],
    ['合計金額', esc(changing.totalLabel || yen(changing.totalPrice || 0)) + '（変更ありません）']
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
  ].map(foldIcs).join('\r\n');
}

/* カレンダーの決まりでは、1行は75バイトまでです。長い行は、次の行の
   先頭に空白を置いて続けます。日本語は1文字3バイトなので、メニュー名が
   少し長いだけで超えます。折らないと、取り込めないカレンダーがあります。
   文字の途中で切ると化けるので、バイト数を数えながら文字単位で折ります。 */
function foldIcs(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 74) return line;
  const out = [];
  let cur = '', size = 0, limit = 73;   // 続きの行は先頭の空白ぶん1バイト使う
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > limit) { out.push(cur); cur = ''; size = 0; limit = 72; }
    cur += ch; size += n;
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
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

/* 店舗に届かなかったときの文言。
   「予約できました」とだけ出すと、お客様は来店するのに席が用意されない。 */
function deliveryFailureMessage(sent, what) {
  return [
    `申し訳ありません。ご${what}の内容を店舗に送信できませんでした。`,
    sent.error ? `（${sent.error}）` : '',
    '',
    'お手数ですが、少し時間をおいてもう一度お試しいただくか、',
    contactWay()
  ].filter(Boolean).join('\n');
}

function showDeliveryWarning(sent) {
  const box = $('#done-warning');
  if (!box) return;

  /* 見出しも直します。
     警告の上に「✓ ご予約が完了しました」と大きく出ていると、
     急いでいる方はそれだけ見て画面を閉じます。届いていないのですから、
     いちばん大きい文字が「完了」であってはいけません。 */
  const head = $('#h-done');
  if (head) head.textContent = 'ご予約が店舗に届いていません';
  const icon = document.querySelector('#panel-6 .done-icon, [data-panel="6"] .done-icon');
  if (icon) { icon.textContent = '！'; icon.classList.add('is-warn'); }
  const desc = head && head.nextElementSibling;
  if (desc) desc.textContent = 'お手数ですが、下記のご予約番号をお伝えのうえ、店舗までご連絡ください。';

  box.hidden = false;
  box.innerHTML = `
    <b>ご確認ください</b>
    <span>
      この端末にはご予約を保存しましたが、<strong>店舗への送信に失敗しました</strong>。
      ${sent.error ? `（${esc(sent.error)}）` : ''}
      お手数ですが、下記のご予約番号をお控えのうえ${SALON.tel ? `お電話（${esc(SALON.tel)}）で` : '店舗まで'}
      ご連絡ください。席が確保できていない可能性がございます。
    </span>`;
}

/* 選んだ時間がもう取れないときの言い方。理由ごとに変えます。 */
function slotStopMessage(reason) {
  const tail = '\n別の日時をお選びください。';
  if (reason === 'too-soon') {
    return `恐れ入ります。ご選択の時間は、当日のご予約の受付時刻（${SALON.business.minLeadHours}時間前まで）を過ぎました。`
      + tail + `\nお急ぎの場合は${SALON.tel ? `お電話（${SALON.tel}）で` : '店舗まで'}ご相談ください。`;
  }
  if (reason === 'closed' || reason === 'closed-range') {
    return '恐れ入ります。ご選択の時間は、店舗の都合により受付を止めております。' + tail;
  }
  if (reason === 'over-close') {
    return '恐れ入ります。ご選択の時間からですと、閉店までにお時間が足りません。' + tail;
  }
  return '申し訳ありません。ご選択の時間は、ちょうど他のお客様のご予約が入りました。' + tail;
}

/* 送信中であることを、ボタンの文字だけに頼らずに出します。
   電波の細い場所では応答まで数秒かかります。そのあいだボタンが画面の外に
   あると、お客様には何も起きていないように見え、戻るを押されます。
   送信が終わるまではステップ表示からの移動も止めます（飛んだ先で日時を
   選び直されると、送っている内容と画面が食い違うため）。 */
let submitting = false;

function setSubmitting(on) {
  submitting = on;
  const note = $('#sending-note');
  if (note) note.hidden = !on;
  const btn = $('#submit-reservation');
  if (!btn) return;
  btn.disabled = on;
  btn.textContent = on ? '送信中…'
    : (changing ? 'この日時に変更する' : 'この内容で予約する');
  if (on) btn.scrollIntoView({ block: 'center' });
}

async function submitReservation() {
  if (submitting) return;   // 二重送信の入口をここで閉じる
  setSubmitting(true);

  // 選択中に他のお客様が同じ枠を押さえていないか、最新の状況で確認する
  await Remote.load(true);
  const info = Availability.slotInfo(state.date, state.time, state.staffId, totalMinutes());
  if (!info.available) {
    setSubmitting(false);
    /* 断る理由は、そのとおりに伝えます。
       画面を開いたまま時間が過ぎただけなのに「他のお客様のご予約が入りました」と
       出すのは、事実と違います。 */
    alert(slotStopMessage(info.reason));
    state.time = null;
    goTo(3);
    return;
  }

  let reservation;
  if (changing) {
    // 予約番号はそのまま。日時だけ差し替える。
    reservation = { ...changing, date: state.date, time: state.time,
      endTime: toHHMM(toMinutes(state.time) + totalMinutes()) };
    const sent = await sendToEndpoint({
      type: 'change',
      code: changing.code,
      date: state.date,
      time: state.time,
      endTime: reservation.endTime,
      minutes: totalMinutes(),
      // 別端末から照会して変更する場合の本人確認
      tel: changing.lookupTel || (changing.customer && changing.customer.tel) || ''
    });
    /* 店舗に届かなかったときは、日時を書き換えずに知らせる。
       画面だけ変えると、お客様は変更できたつもりで元の時間に来てしまう。 */
    if (!sent.ok && !sent.noEndpoint) {
      setSubmitting(false);
      // 受付期限切れ・枠の埋まりは、送信できなかったのとは理由が違う
      alert(sent.deadline || sent.taken ? sent.error : deliveryFailureMessage(sent, '変更'));
      if (sent.taken) { state.time = null; await Remote.load(true); goTo(3); }
      return;
    }
    reservation.delivered = sent.ok;
    Store.reschedule(changing.code, reservation);
  } else {
    reservation = buildReservation();
    // 送信は common.js の sendToEndpoint（text/plain で送る理由もそちらに記載）
    const sent = await sendToEndpoint({ type: 'reserve', ...reservation });
    /* 端末側で作った予約番号が、別のお客様のものとぶつかっていた場合は
       店舗側で振り直されます。台帳と食い違わないよう、返ってきた番号を採用します。 */
    if (sent.ok && sent.code && sent.code !== reservation.code) {
      reservation.code = sent.code;
    }
    /* 店舗側で「その枠はもう埋まっている」と判断された場合は、
       予約として保存せず日時の選び直しに戻す。
       画面側の確認をすり抜けて同時に押されたときにここへ来る。 */
    if (sent.taken) {
      setSubmitting(false);
      alert(sent.error || 'ご希望の時間は、ちょうど他のお客様のご予約が入りました。');
      state.time = null;
      await Remote.load(true);
      goTo(3);
      return;
    }
    reservation.delivered = sent.ok;
    reservation.deliveryError = sent.ok ? '' : (sent.error || '');
    Store.add(reservation);
    // 受信先を設定しているのに届かなかった場合は、完了画面で正直に伝える
    if (!sent.ok && !sent.noEndpoint) showDeliveryWarning(sent);
  }

  if (changing) {
    $('#h-done').textContent = '日時を変更しました';
    const desc = $('#h-done').nextElementSibling;
    if (desc) desc.textContent = '予約番号は変わりません。変更後の内容はこちらです。';
  }

  $('#done-code').textContent = reservation.code;
  $('#done-body').innerHTML = [
    ['ご来店日時', `${formatDateJa(reservation.date)} ${reservation.time}〜`],
    ['ご担当', reservation.staffName],
    ['メニュー', reservation.menus
      ? reservation.menus.map(m => esc(m.name)).join('<br />')
      : esc(reservation.menuText || '')],
    ['合計金額', `${reservation.totalLabel || yen(reservation.totalPrice)}${reservation.totalPrice ? '（税込）' : ''}`]
  ].map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('');

  // 完了画面の「カレンダーに追加」に、いま取れた予約を渡す
  const calBtn = $('#add-to-calendar');
  if (calBtn) calBtn.onclick = () => downloadIcs(reservation);

  renderDoneFollow(reservation);
  renderLineInvite();

  clearDraft();
  // 次回この端末から予約されるときに入力し直さなくて済むように覚えておく
  saveProfile(state.customer);
  state.step = 6;
  renderStep();
  setSubmitting(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- 完了画面のあとの案内 ----------
   ここまで来たお客様が最後に抱えるのは「本当に取れたのか」と
   「都合が変わったらどうすればいいのか」の2つです。
   その場で答えておかないと、確かめるために店に電話がかかります。
   （届かなかったときは showDeliveryWarning が別の顔に直すので、
     そのときは「メールを送りました」と言い切らないようにします） */
function renderDoneFollow(r) {
  const host = $('#done-follow');
  if (!host) return;
  const rule = SALON.business.cancelDeadline || { daysBefore: 1, hour: 18 };
  const limit = rule.daysBefore === 1 ? `前日${rule.hour}時` : `${rule.daysBefore}日前の${rule.hour}時`;
  const mail = r.delivered && r.customer && r.customer.email
    ? `<span>確認メールを <b>${esc(r.customer.email)}</b> 宛にお送りしました。
         数分たっても届かないときは、迷惑メールフォルダをご確認ください。</span>` : '';
  host.innerHTML = mail
    + `<span>ご都合が変わった場合は、<b>${esc(limit)}まで</b>
         「予約内容を確認する」から日時の変更・キャンセルができます。
         それ以降は${contactWay({ html: true })}</span>`;
}

/* 予約番号を控える。
   外を歩きながら5文字を手で書き写すのは、まず無理です。
   コピーできない端末（対応していない・許可されない）では、
   番号そのものは上に出したままなので行き止まりにはなりません。 */
async function copyCode() {
  const code = ($('#done-code').textContent || '').trim();
  const done = $('#copy-done');
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
  } catch (e) {
    // 許可されない端末では、せめて選択された状態にして手で写せるようにする
    const range = document.createRange();
    range.selectNodeContents($('#done-code'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (done) { done.textContent = '上の番号を長押しでコピーしてください'; done.hidden = false; }
    return;
  }
  if (!done) return;
  done.textContent = 'コピーしました';
  done.hidden = false;
  setTimeout(() => { done.hidden = true; }, 4000);
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
  // 選んだ瞬間に、下のボタンも押せる状態に変える
  renderStepCta();
}

function renderStep() {
  $$('.reserve-panel').forEach(p => {
    p.classList.toggle('is-active', Number(p.dataset.panel) === state.step);
  });
  $$('.step').forEach(s => {
    const n = Number(s.dataset.step);
    s.classList.toggle('is-current', n === state.step);
    s.classList.toggle('is-done', n < state.step);
    // 変更モードで通らないステップは、押せないことが分かるように薄くする
    s.classList.toggle('is-skipped', !!changing && (n === 1 || n === 2 || n === 4));
  });
  $('#steps').style.display = state.step === 6 ? 'none' : '';
  $('#summary').style.display = state.step === 6 ? 'none' : '';
  if (state.step === 6) $('#reserve-layout').style.gridTemplateColumns = '1fr';
  updateSummary();   // この中で下のボタンも描き直します
}

/* 画面下に貼りつく「次へ」。
   メニューは23件あるので、選んでから一覧の最後まで送らないと次に進めない、
   というのは操作としてつらすぎます。選んだ時点で押せるようにします。
   STEP5（確認）には出しません。送信ボタンを2か所に置くと二重送信の元になるためです。 */
/* label が関数なのは、1名の店では「スタッフの選択」という言い方が
   合わないためです（選びようがありません）。 */
const STEP_CTA = {
  1: { to: 2, label: () => (soloStylist() ? 'ご担当の確認へ' : 'スタッフの選択へ'),
       ok: () => hasMenu(), hint: 'メニューをお選びください' },
  2: { to: 3, label: () => '日時の選択へ', ok: () => state.staffChosen, hint: 'ご担当をお選びください' },
  3: { to: 4, label: () => 'お客様情報の入力へ', ok: () => !!(state.date && state.time), hint: 'ご来店日時をお選びください' },
  4: { to: 5, label: () => '入力内容の確認へ', ok: () => true }
};

function renderStepCta() {
  const host = $('#step-cta');
  if (!host) return;
  // 変更モードでは日時だけ選び直すので、STEP3 のときにだけ出します
  const cta = STEP_CTA[state.step];
  if (!cta || (changing && state.step !== 3)) { host.hidden = true; return; }

  const ready = cta.ok();
  const info = ready ? stepCtaInfo() : (cta.hint || '');
  host.innerHTML = `
    <span class="step-cta-info">${esc(info)}</span>
    <button class="btn btn-primary" type="button" data-next="${cta.to}"${ready ? '' : ' disabled'}>
      ${esc(cta.label())}
    </button>`;
  host.hidden = false;
}

/* ボタンの左に出す、いま選ばれている内容の短い要約 */
function stepCtaInfo() {
  if (state.step === 1) {
    const n = (state.couponId ? 1 : 0) + state.menuIds.length;
    // 0件のときに「0件 ／ —」と並べても読む値が無いので、次にすることだけ出します
    return n ? `${n}件 ／ ${totalText()}` : 'メニューをお選びください';
  }
  if (state.step === 2) return staffLabel(state.staffId);
  if (state.step === 3) return `${formatDateJa(state.date)} ${state.time}〜`;
  return '';
}

function goTo(step) {
  /* 変更モードでは、メニュー・担当・お客様情報は元の予約のまま。
     日時（STEP3）から確認（STEP5）へ直行させる。 */
  if (changing) {
    if (step === 4) step = 5;
    if (step === 1 || step === 2) return;
  }

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
    if (state.step === 4 && !changing && !validateForm()) return;
  }

  state.step = step;
  if (step === 3) renderCalendar();
  if (step === 5) renderConfirm();
  saveDraft();
  renderStep();
  window.scrollTo({ top: $('#steps').offsetTop - 130, behavior: 'smooth' });
}

/* ---------- 日時の変更 ----------
   予約確認ページで「日時を変更する」を押すと、対象の予約が
   sessionStorage に置かれた状態でこのページに来ます。
   メニュー・担当・お客様情報はそのまま、日時だけ選び直してもらいます。 */
function loadChangeTarget() {
  let raw = null;
  try { raw = sessionStorage.getItem(CHANGE_KEY); } catch (e) { return false; }
  if (!raw) return false;
  // 一度読んだら消す。戻る操作で変更モードに入り直してしまわないように。
  try { sessionStorage.removeItem(CHANGE_KEY); } catch (e) { /* noop */ }

  let target;
  try { target = JSON.parse(raw); } catch (e) { return false; }
  if (!target || !target.code) return false;

  changing = target;

  // メニューの選択を復元する。IDが分かるのはこの端末で取った予約だけ。
  state.couponId = null;
  state.menuIds = [];
  (target.menus || []).forEach(m => {
    if (SALON.coupons.some(c => c.id === m.id)) state.couponId = m.id;
    else if (allMenuItems().some(x => x.id === m.id)) state.menuIds.push(m.id);
  });

  const staff = SALON.staff.find(x => x.name === target.staffName);
  state.staffId = staff ? staff.id : null;
  state.staffChosen = true;
  state.date = null;
  state.time = null;
  return true;
}

/* 変更モードのとき、所要時間は元の予約のものを使う。
   別端末から照会した予約はメニューIDが分からないため、
   合計時間だけは台帳の値を信用します。 */
function changeMinutes() {
  return (changing && changing.totalMinutes) || null;
}

function renderChangeBanner() {
  if (!changing) return;
  const host = $('#change-notice');
  if (!host) return;
  host.hidden = false;
  host.innerHTML = `
    <b>日時の変更</b>
    <span>
      予約番号 ${esc(changing.code)}（${formatDateJa(changing.date)} ${esc(changing.time)}〜）の日時を変更します。
      メニュー・ご担当・お客様情報はそのままです。新しい日時をお選びください。
    </span>`;
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

/* スプレッドシートが届いたあと、選択を引き継ぐ。
   シート管理に切り替わるとメニューのIDが変わる（cp01 → sc0）ため、
   IDでは追えない。名前で同じものを探し直す。
   取得を待たずに描いているので、待っているあいだに選ばれることがある。 */
function remapSelection(before) {
  if (!before.couponId && !before.menuIds.length) return;

  const sameName = (list, name) => list.find(x => (x.title || x.name) === name);

  if (before.couponName) {
    const c = sameName(SALON.coupons, before.couponName);
    state.couponId = c ? c.id : null;
  }
  state.menuIds = before.menuNames
    .map(n => { const m = sameName(allMenuItems(), n); return m ? m.id : null; })
    .filter(Boolean);

  // 見つからなかったものがあれば、日時は選び直してもらう（所要時間が変わるため）
  const lost = (before.couponName && !state.couponId)
    || state.menuIds.length !== before.menuIds.length;
  if (lost) resetDateTime();
}

/* ---------- 起動 ---------- */
document.addEventListener('DOMContentLoaded', () => {
  const draft = loadDraft();
  reconcileSelections(draft);

  /* 日時変更で来た場合は、下書きより変更対象を優先する。
     変更中の予約自身は空き枠の判定から除いておく（元の時間の前後を選べるように）。 */
  if (loadChangeTarget()) {
    Availability.ignoreCode = changing.code;
    Availability.ignoreSlot = { date: changing.date, time: changing.time, staffId: state.staffId };
    clearDraft();
    renderChangeBanner();
    state.step = 3;
    // ボタンの文言も「予約」ではなく「変更」にする
    $('#submit-reservation').textContent = 'この日時に変更する';
    const lead = $('#confirm-lead');
    if (lead) lead.textContent = '変更後の内容をご確認のうえ、「この日時に変更する」を押してください。';
  } else {
    applyQueryParams();
    if (state.step === 6) state.step = 1;
    /* 選択が見当たらないときは最初からにします。
       ただしシート管理のときは、この時点ではまだ data.js の内容しか無く、
       IDが違うだけで「消えた」ように見えます。
       名前で引き継げる見込みがあるなら、シートが届くまで判断を待ちます。 */
    const mayRecover = !!SALON.reservationEndpoint && !!draft
      && !!(draft.couponName || (draft.menuNames && draft.menuNames.length));
    if (!hasMenu() && !mayRecover) state.step = 1;
  }

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
  $('#copy-code').addEventListener('click', copyCode);

  /* メニューをスプレッドシートから取り込む。
     待ってから描くと、応答が遅いあいだ選択肢が1つも出ません。
     先に掲載中の内容で描き、届いたら中身だけ入れ替えます。 */
  Catalog.load().then(source => {
    if (source !== 'sheet') return;
    /* いま選ばれているものを、名前で新しいメニューに引き継ぎます。

       読み込み直した直後は、まだ data.js の内容しか無い状態で
       下書きを復元しています。そのとき引き継げなかったぶんは、
       **下書きに残っている名前**で、ここでもう一度探します。
       これをしないと、読み込み直しただけで選択が消えます。 */
    const names = draftNames();
    const before = {
      couponId: state.couponId,
      couponName: names.couponName || (draft && draft.couponName) || '',
      menuIds: [...state.menuIds],
      menuNames: names.menuNames.length ? names.menuNames
        : ((draft && draft.menuNames) || [])
    };
    if (!before.couponId && before.couponName) before.couponId = 'pending';
    if (!before.menuIds.length && before.menuNames.length) {
      before.menuIds = before.menuNames.map(() => 'pending');
    }
    remapSelection(before);
    // 引き継げなかったときは、ここで最初に戻します（待っていた判断）
    if (!hasMenu() && !changing) state.step = 1;
    initStep1();
    renderStaffChoices();
    if (state.step === 3) renderCalendar();
    updateSummary();
    renderStep();
    saveDraft();
  });

  /* 他のお客様の予約状況を取得し、届いたらカレンダーを描き直す。
     取りにいっているあいだは、そう書いておきます。届く前のカレンダーは
     この端末の記録だけで描いた古いもので、黙って出しておくと
     お客様はそれを最新だと思って選びます。 */
  showCalendarLoading(true);
  Remote.load().then(ok => {
    showCalendarLoading(false);
    if (ok && state.step === 3) renderCalendar();
  });

  /* 開きっぱなしのカレンダーを、戻ってきたときに描き直します。

     スマホは、ほかの用事のあいだ画面をそのまま残します。朝に開いた
     カレンダーを昼に見ると、もう過ぎた時間が「空いています」の顔で
     並んでいます。それを選んで、お名前も電話番号も入れたところで
     断られるのは、いちばん徒労です。

     選んでいた時間がもう取れないときは、その場でお伝えして選び直して
     いただきます。黙って選択を外すと、何が起きたのか分かりません。 */
  const refreshCalendar = async () => {
    if (state.step !== 3 || document.hidden) return;
    const had = state.date && state.time
      ? { date: state.date, time: state.time } : null;
    showCalendarLoading(true);
    await Remote.load(true);
    showCalendarLoading(false);
    if (had && !Availability.slotInfo(had.date, had.time, state.staffId, totalMinutes()).available) {
      state.time = null;
      renderCalendar();
      updateSummary();
      renderStepCta();
      alert(`${formatDateJa(had.date)} ${had.time} は、ただいまお受けできなくなりました。\n`
        + '別の日時をお選びください。');
      return;
    }
    renderCalendar();
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCalendar(); });
  window.addEventListener('focus', refreshCalendar);
  // 開いたまま眺めているあいだも、5分ごとに見直します
  setInterval(refreshCalendar, 5 * 60 * 1000);

  // ステップ表示をクリックして戻れるように
  $('#steps').addEventListener('click', e => {
    const step = e.target.closest('.step');
    if (!step) return;
    // 送信中に飛ばれると、送っている内容と画面が食い違う
    if (submitting) return;
    const n = Number(step.dataset.step);
    if (n < state.step) goTo(n);
  });

  renderStep();
});
