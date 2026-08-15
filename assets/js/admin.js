/* ============================================================
 *  予約管理（スタッフ用）
 *  ※ブラウザの localStorage に保存された予約を表示します
 * ============================================================ */

const GATE_KEY = 'salon.adminUnlocked.v1';

function currentFilters() {
  return {
    date: $('#filter-date').value,
    staffId: $('#filter-staff').value,
    status: $('#filter-status').value
  };
}

function filteredList() {
  const f = currentFilters();
  return Store.all()
    .filter(r => !f.date || r.date === f.date)
    .filter(r => f.staffId === 'all'
      || (f.staffId === 'none' ? !r.staffId : r.staffId === f.staffId))
    .filter(r => f.status === 'all'
      || (f.status === 'cancelled' ? r.status === 'cancelled' : r.status !== 'cancelled'))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function renderStats() {
  const active = Store.active();
  const today = toKey(new Date());
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndKey = toKey(weekEnd);

  const todays = active.filter(r => r.date === today);
  const week = active.filter(r => r.date >= today && r.date <= weekEndKey);
  const sales = week.reduce((sum, r) => sum + r.totalPrice, 0);
  const cancelled = Store.all().filter(r => r.status === 'cancelled').length;

  $('#stats').innerHTML = [
    ['本日のご予約', `${todays.length}件`],
    ['今後7日間', `${week.length}件`],
    ['7日間の売上見込', yen(sales)],
    ['キャンセル', `${cancelled}件`]
  ].map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
}

function renderRows() {
  const list = filteredList();
  $('#admin-empty').hidden = list.length > 0;

  $('#admin-rows').innerHTML = list.map(r => {
    const cancelled = r.status === 'cancelled';
    const status = cancelled
      ? '<span class="status-chip is-cancelled">キャンセル</span>'
      : '<span class="status-chip">確定</span>';
    const action = cancelled
      ? '—'
      : `<button class="btn btn-ghost btn-sm" type="button" data-admin-cancel="${esc(r.code)}">キャンセル</button>`;
    return `
      <tr${cancelled ? ' style="opacity:.55"' : ''}>
        <td style="font-family:var(--font-en)">${esc(r.code)}</td>
        <td>${formatDateJa(r.date, { short: true })}</td>
        <td>${esc(r.time)}〜${esc(r.endTime || '')}</td>
        <td>${esc(r.staffName)}</td>
        <td>${esc(r.customer.name)}<br /><small style="color:var(--ink-3)">${esc(r.customer.kana)}</small></td>
        <td>${esc(r.customer.tel)}<br /><small style="color:var(--ink-3)">${esc(r.customer.email)}</small></td>
        <td style="white-space:normal;min-width:200px;">${r.menus.map(m => esc(m.name)).join('<br />')}</td>
        <td style="font-family:var(--font-en)">${yen(r.totalPrice)}</td>
        <td>${esc(r.customer.visit || '—')}</td>
        <td>${status}</td>
        <td>${action}</td>
      </tr>`;
  }).join('');
}

function renderAll() {
  renderStats();
  renderRows();
}

/** CSV出力（Excelで開けるよう BOM 付き UTF-8） */
function exportCsv() {
  const list = filteredList();
  if (!list.length) {
    alert('出力できる予約がありません。');
    return;
  }
  const header = ['予約番号', '来店日', '開始', '終了', '担当', 'お名前', 'フリガナ',
    '電話番号', 'メール', '来店回数', 'メニュー', '指名料', '合計金額', '所要分', '状態', '受付日時'];
  const rows = list.map(r => [
    r.code, r.date, r.time, r.endTime || '', r.staffName,
    r.customer.name, r.customer.kana, r.customer.tel, r.customer.email,
    r.customer.visit, r.menus.map(m => m.name).join(' / '),
    r.nominationFee, r.totalPrice, r.totalMinutes,
    r.status === 'cancelled' ? 'キャンセル' : '確定',
    r.createdAt
  ]);
  const csv = [header, ...rows]
    .map(cols => cols.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reservations_${toKey(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openDashboard() {
  $('#gate').hidden = true;
  $('#dashboard').hidden = false;

  $('#filter-staff').innerHTML =
    '<option value="all">すべての担当</option><option value="none">指名なし</option>' +
    SALON.staff.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');

  renderAll();
}

document.addEventListener('DOMContentLoaded', () => {
  const unlock = () => {
    sessionStorage.setItem(GATE_KEY, '1');
    openDashboard();
  };

  if (sessionStorage.getItem(GATE_KEY) === '1') {
    openDashboard();
  }

  $('#gate-btn').addEventListener('click', () => {
    const ok = $('#passcode').value === String(SALON.adminPasscode);
    $('#gate-error').style.display = ok ? 'none' : 'block';
    if (ok) unlock();
  });
  $('#passcode').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#gate-btn').click();
  });

  $('#filter-date').addEventListener('change', renderRows);
  $('#filter-staff').addEventListener('change', renderRows);
  $('#filter-status').addEventListener('change', renderRows);
  $('#filter-reset').addEventListener('click', () => {
    $('#filter-date').value = '';
    $('#filter-staff').value = 'all';
    $('#filter-status').value = 'all';
    renderRows();
  });
  $('#export-csv').addEventListener('click', exportCsv);

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-admin-cancel]');
    if (!btn) return;
    const code = btn.dataset.adminCancel;
    if (!confirm(`予約番号 ${code} をキャンセル扱いにします。よろしいですか？`)) return;
    const r = Store.find(code);
    Store.cancel(code);
    if (r) sendCancellation(r); // 予約台帳の状態も「キャンセル」に更新する
    renderAll();
  });
});
