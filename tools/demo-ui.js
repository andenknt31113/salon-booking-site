document.addEventListener('DOMContentLoaded', async () => {
  if (location.hostname !== '127.0.0.1' || !document.body.dataset.demo) return;
  const showError = message => {
    const error = document.querySelector('#demo-error');
    error.textContent = message;
    error.hidden = false;
  };
  document.querySelector('#demo-reset').addEventListener('click', async () => {
    if (!confirm('このデモ内の変更を消し、架空データの初期状態に戻します。よろしいですか？')) return;
    try {
      const response = await fetch('/exec', { method: 'POST', body: JSON.stringify({ type: 'reset' }) });
      if (!response.ok || !(await response.json()).ok) throw new Error();
      localStorage.removeItem('zer01-phone-request:' + SALON.reservationEndpoint);
      location.reload();
    } catch (error) {
      showError('初期化の結果を確認できません。デモサーバーが動いているか確認してください。');
    }
  });
  if (document.body.dataset.page !== 'admin') return;
  document.querySelector('#gate').hidden = true;
  document.querySelector('#forget-device').hidden = true;
  try {
    if (!(await openDashboard())) showError('デモを読み込めませんでした。デモサーバーが動いているか確認してください。');
  } catch (error) {
    showError('デモ画面を開けませんでした。画面を再読み込みしてください。');
  }
});
