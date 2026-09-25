const AdminNotifications = (() => {
  let previous = null;
  const notices = new Map();
  let timer;
  let busy = false;
  let opening = false;
  let paused = false;

  function snapshot(rows) {
    return new Map(rows.map(row => [row.code, {
      code: row.code, name: row.name || 'お名前なし', date: row.date,
      time: row.time, endTime: row.endTime, cancelled: isCancelled(row)
    }]));
  }

  function receive(rows) {
    const next = snapshot(rows);
    if (previous) next.forEach((row, code) => {
      const old = previous.get(code);
      const label = !old ? (row.cancelled ? 'キャンセル' : '新しい予約')
        : old.cancelled !== row.cancelled ? (row.cancelled ? 'キャンセル' : '予約の再開')
        : old.date !== row.date || old.time !== row.time || old.endTime !== row.endTime ? '日時変更' : '';
      if (!label) return;
      notices.delete(code);
      notices.set(code, { ...row, label, read: false });
    });
    previous = next;
    render();
  }

  function render() {
    const unread = [...notices.values()].filter(notice => !notice.read).length;
    $('#notification-count').textContent = `未読${unread}件`;
    $('#notification-read').disabled = unread === 0;
    $('#notification-list').innerHTML = notices.size ? [...notices.values()].reverse().map(notice => `
      <p><button class="btn btn-outline btn-sm" type="button" data-notification="${esc(notice.code)}">
        ${notice.read ? '確認済み' : '未読'}：${esc(notice.label)} — ${esc(notice.name)}様
        ${esc(notice.date)} ${esc(notice.time)}
      </button></p>`).join('') : '<p>この画面を開いてからの新しい通知はありません。</p>';
  }

  function schedule() {
    clearTimeout(timer);
    if (!paused && previous && !document.hidden) {
      timer = setTimeout(check, Number($('#booking-notifications').dataset.pollMs));
    }
  }

  async function check() {
    if (!previous || busy || document.hidden) return;
    busy = true;
    clearTimeout(timer);
    $('#notification-check').disabled = true;
    try {
      const result = await adminPost({ type: 'adminData' });
      if (!result.ok || !Array.isArray(result.reservations)) throw new Error('通知を確認できません');
      receive(result.reservations);
      paused = false;
      $('#notification-status').textContent = `通知の最終確認：${new Date().toLocaleString('ja-JP')}。予定表の読込時刻とは別です。`;
    } catch {
      paused = true;
      $('#notification-status').textContent = '通知を確認できないため自動確認を停止しました。表示中の通知は最新とは限りません。接続を確認して「今すぐ確認」を押してください。再ログインが必要な場合もあります。';
    } finally {
      busy = false;
      $('#notification-check').disabled = false;
      schedule();
    }
  }

  async function open(code) {
    if (opening) return;
    if (hasUnsavedReservationNotes()) {
      $('#notification-status').textContent = '書きかけの施術メモを保存してから予約を開いてください。通知は未読のまま残しています。';
      return;
    }
    opening = true;
    const notice = notices.get(code);
    try {
      const refreshed = await refreshReservations();
      if (!refreshed || hasUnsavedReservationNotes()) {
        $('#notification-status').textContent = '予約を開けませんでした。予約一覧の読込メッセージを確認してください。通知は未読のままです。';
        return;
      }
      if (!(adminData.reservations || []).some(row => row.code === code)) {
        $('#notification-status').textContent = 'この予約は最新の台帳に見つかりません。店舗の台帳を確認してください。';
        return;
      }
      $('#admin-tabs [data-pane="reserve"]').click();
      focusBooking(code);
      if (notices.get(code) === notice) notice.read = true;
      render();
      $('#booking-notifications').open = false;
    } finally {
      opening = false;
    }
  }

  function start(rows) {
    if (previous) return;
    receive(rows);
    $('#notification-status').textContent = 'ログイン時の予約を基準に、新しい変更を確認します。';
    $('#notification-check').addEventListener('click', check);
    $('#notification-read').addEventListener('click', () => {
      notices.forEach(notice => { notice.read = true; });
      render();
    });
    $('#notification-list').addEventListener('click', event => {
      const button = event.target.closest('[data-notification]');
      if (button) open(button.dataset.notification);
    });
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('pagehide', () => clearTimeout(timer));
    schedule();
  }

  return { start, check };
})();
