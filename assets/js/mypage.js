/* ============================================================
 *  予約確認・キャンセル（お客様向け）
 * ============================================================ */

let filterCode = '';

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

function bookingCard(r) {
  const cancelled = r.status === 'cancelled';
  const past = isPast(r);
  const chip = cancelled
    ? '<span class="status-chip is-cancelled">キャンセル済み</span>'
    : past
      ? '<span class="status-chip is-past">ご来店済み</span>'
      : '<span class="status-chip">予約確定</span>';

  const cancelBtn = isCancellable(r)
    ? `<button class="btn btn-ghost btn-sm" type="button" data-cancel="${esc(r.code)}">この予約をキャンセルする</button>`
    : (!cancelled && !past)
      ? '<p style="font-size:12px;color:var(--ink-3);">※キャンセル受付期限を過ぎています。お電話でご連絡ください。</p>'
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
      <p class="booking-detail">合計：<strong>${yen(r.totalPrice)}</strong>（税込・約${formatDuration(r.totalMinutes)}）</p>
      ${r.customer.request ? `<p class="booking-detail">ご要望：${esc(r.customer.request)}</p>` : ''}
      <div style="margin-top:14px;">${cancelBtn}</div>
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
