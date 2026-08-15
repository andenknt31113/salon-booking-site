/* ============================================================
 *  予約確認・キャンセル（お客様向け）
 * ============================================================ */

let filterCode = '';
/* 直前に照会したご予約。別端末から日時変更するときに使います */
let lastLookup = null;

/** 予約が過去のものか */
function isPast(r) {
  const dt = fromKey(r.date);
  dt.setMinutes(toMinutes(r.time));
  return dt.getTime() < Date.now();
}

/** キャンセル可能か（前日18時まで） */
function isCancellable(r) {
  if (r.status === 'cancelled' || isPast(r)) return false;
  const deadline = fromKey(r.date);
  deadline.setDate(deadline.getDate() - 1);
  deadline.setHours(18, 0, 0, 0);
  return Date.now() < deadline.getTime();
}

/* 日時変更の受け渡し（CHANGE_KEY は common.js で定義） */
function startChange(reservation) {
  try {
    sessionStorage.setItem(CHANGE_KEY, JSON.stringify(reservation));
  } catch (e) {
    alert('この設定では日時変更をご利用いただけません。お手数ですが店舗までご連絡ください。');
    return;
  }
  location.href = 'reserve.html?change=1';
}

function changeBtn(code) {
  return `<button class="btn btn-outline btn-sm" type="button" data-change="${esc(code)}">日時を変更する</button>`;
}

function bookingCard(r) {
  const cancelled = r.status === 'cancelled';
  const past = isPast(r);
  const chip = cancelled
    ? '<span class="status-chip is-cancelled">キャンセル済み</span>'
    : past
      ? '<span class="status-chip is-past">ご来店済み</span>'
      : '<span class="status-chip">予約確定</span>';

  const actions = isCancellable(r)
    ? changeBtn(r.code)
      + `<button class="btn btn-ghost btn-sm" type="button" data-cancel="${esc(r.code)}">この予約をキャンセルする</button>`
    : (!cancelled && !past)
      ? '<p style="font-size:12px;color:var(--ink-3);">※変更・キャンセルの受付期限を過ぎています。お手数ですが店舗までご連絡ください。</p>'
      : '';

  return `
    <article class="booking-card ${cancelled ? 'is-cancelled' : ''}">
      <div class="booking-head">
        ${chip}
        <span class="booking-code">予約番号 ${esc(r.code)}</span>
      </div>
      <p class="booking-when">${formatDateJa(r.date)} ${esc(r.time)}〜${esc(r.endTime || '')}</p>
      <p class="booking-detail">ご担当：${esc(r.staffName)}${r.nominationFee > 0 ? `（指名料 ${yen(r.nominationFee)}）` : ''}</p>
      <p class="booking-detail">メニュー：${r.menus.map(m => esc(m.name)).join(' ／ ')}</p>
      <p class="booking-detail">合計：<strong>${r.totalLabel || yen(r.totalPrice)}</strong>（${r.totalPrice ? '税込・' : ''}約${formatDuration(r.totalMinutes)}）</p>
      ${r.customer.request ? `<p class="booking-detail">ご要望：${esc(r.customer.request)}</p>` : ''}
      <div class="booking-actions">${actions}</div>
    </article>`;
}

function render() {
  let list = Store.all();
  if (filterCode) {
    list = list.filter(r => r.code.toUpperCase().includes(filterCode.toUpperCase()));
  }

  const upcoming = list.filter(r => !isPast(r) && r.status !== 'cancelled')
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const past = list.filter(r => isPast(r) || r.status === 'cancelled')
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));

  $('#upcoming-list').innerHTML = upcoming.length
    ? upcoming.map(bookingCard).join('')
    : `<div class="empty-state">
         ${filterCode ? 'ご指定の予約番号は見つかりませんでした。' : '現在お受けしているご予約はありません。'}
       </div>`;

  $('#past-list').innerHTML = past.length
    ? past.map(bookingCard).join('')
    : '<div class="empty-state">過去のご予約はありません。</div>';
}

/* ============================================================
 *  予約番号 + 電話番号での照会
 * ============================================================ */
function renderLookupResult(r) {
  const cancelled = r.status === 'キャンセル';
  const dt = fromKey(r.date);
  dt.setMinutes(toMinutes(r.time));
  const past = dt.getTime() < Date.now();

  const deadline = fromKey(r.date);
  deadline.setDate(deadline.getDate() - 1);
  deadline.setHours(18, 0, 0, 0);
  const canCancel = !cancelled && !past && Date.now() < deadline.getTime();

  const chip = cancelled
    ? '<span class="status-chip is-cancelled">キャンセル済み</span>'
    : past
      ? '<span class="status-chip is-past">ご来店済み</span>'
      : '<span class="status-chip">予約確定</span>';

  $('#lookup-result').innerHTML = `
    <article class="booking-card ${cancelled ? 'is-cancelled' : ''}">
      <div class="booking-head">
        ${chip}
        <span class="booking-code">予約番号 ${esc(r.code)}</span>
      </div>
      <p class="booking-when">${formatDateJa(r.date)} ${esc(r.time)}〜${esc(r.endTime || '')}</p>
      <p class="booking-detail">${esc(r.name)} 様</p>
      <p class="booking-detail">メニュー：${esc(r.menuText)}</p>
      <p class="booking-detail">ご担当：${esc(r.staffName)}</p>
      <p class="booking-detail">合計：<strong>${r.totalLabel || yen(r.totalPrice)}</strong>（${r.totalPrice ? '税込・' : ''}約${formatDuration(r.totalMinutes)}）</p>
      ${canCancel
        ? `<div class="booking-actions">
             ${changeBtn(r.code)}
             <button class="btn btn-ghost btn-sm" type="button" data-lookup-cancel="${esc(r.code)}">この予約をキャンセルする</button>
           </div>`
        : (!cancelled && !past)
          ? '<p style="font-size:12px;color:var(--muted);margin-top:12px;">※変更・キャンセルの受付期限を過ぎています。店舗までご連絡ください。</p>'
          : ''}
    </article>`;
}

async function doLookup() {
  const btn = $('#lookup-btn');
  const code = $('#lookup-code').value.trim();
  const tel = $('#lookup-tel').value.trim();
  const err = $('#lookup-error');

  err.style.display = 'none';
  $('#lookup-result').innerHTML = '';

  if (!code || !tel) {
    err.textContent = 'ご予約番号とお電話番号の両方をご入力ください。';
    err.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = '照会中…';
  const res = await lookupReservation(code, tel);
  btn.disabled = false;
  btn.textContent = 'ご予約を確認する';

  if (!res.ok) {
    err.textContent = res.error || 'ご予約が見つかりませんでした。';
    err.style.display = 'block';
    return;
  }
  lastLookup = res.reservation;
  renderLookupResult(res.reservation);
}

document.addEventListener('DOMContentLoaded', () => {
  const tel = $('#tel-link');
  if (SALON.tel) {
    tel.textContent = SALON.tel;
    tel.href = 'tel:' + SALON.tel.replace(/-/g, '');
  } else {
    // 電話番号が未設定のあいだはリンクにしない
    tel.replaceWith(document.createTextNode('店舗'));
  }

  render();

  $('#search-btn').addEventListener('click', () => {
    filterCode = $('#search-code').value.trim();
    render();
  });
  $('#search-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#search-btn').click();
  });
  $('#clear-btn').addEventListener('click', () => {
    filterCode = '';
    $('#search-code').value = '';
    render();
  });

  // 照会フォーム
  $('#lookup-btn').addEventListener('click', doLookup);
  $('#lookup-tel').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLookup();
  });
  // 受信先が未設定のあいだは照会が使えないので、その旨を出しておく
  if (!SALON.reservationEndpoint) {
    $('#lookup-box').innerHTML =
      '<p class="empty-state" style="padding:20px;">'
      + 'ご予約番号での照会は、オンライン受付の準備が整い次第ご利用いただけます。'
      + '</p>';
  }

  // 照会結果からのキャンセル（電話番号の一致を店舗側でも確認します）
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-lookup-cancel]');
    if (!btn) return;
    if (!confirm('このご予約をキャンセルします。よろしいですか？')) return;
    btn.disabled = true;
    const code = btn.dataset.lookupCancel;
    await sendToEndpoint({ type: 'cancel', code, tel: $('#lookup-tel').value.trim() });
    Store.cancel(code); // この端末にも記録があれば同期する
    await doLookup();
    render();
  });

  /* 日時の変更。
     予約の中身（メニュー・担当・お客様情報）はそのままに、
     日時だけ選び直してもらいます。予約番号も変わりません。 */
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-change]');
    if (!btn) return;
    const code = btn.dataset.change;

    // この端末で取った予約
    const mine = Store.find(code);
    if (mine) { startChange(mine); return; }

    // 予約番号＋電話番号で照会した予約
    if (lastLookup && lastLookup.code === code) {
      startChange({
        code: lastLookup.code,
        date: lastLookup.date,
        time: lastLookup.time,
        endTime: lastLookup.endTime,
        totalMinutes: lastLookup.totalMinutes,
        staffName: lastLookup.staffName,
        menuText: lastLookup.menuText,
        totalPrice: lastLookup.totalPrice,
        totalLabel: lastLookup.totalLabel,
        // 照会では個人情報を返していないので、変更時に電話番号で本人確認する
        lookupTel: $('#lookup-tel').value.trim()
      });
      return;
    }
    alert('ご予約が見つかりませんでした。お手数ですが、もう一度照会してください。');
  });

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-cancel]');
    if (!btn) return;
    const code = btn.dataset.cancel;
    const r = Store.find(code);
    if (!r) return;
    const ok = confirm(
      `以下のご予約をキャンセルします。よろしいですか？\n\n` +
      `${formatDateJa(r.date)} ${r.time}〜\n${r.menus.map(m => m.name).join(' / ')}\n\n` +
      `※この操作は取り消せません。`
    );
    if (!ok) return;
    Store.cancel(code);
    sendCancellation(r); // 予約台帳の状態も「キャンセル」に更新する
    render();
  });
});
