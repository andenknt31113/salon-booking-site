/* ============================================================
 *  プライバシーポリシーページ
 *  連絡先は data.js の内容から組み立てます。
 *  公開ページは設定シートを読まないため、内容の変更にはサイト更新が必要です。
 * ============================================================ */
function renderPrivacy() {
  const rows = [
    ['事業者名', SALON.operator || `${SALON.name} ${SALON.nameSub || ''}`.trim()],
    ['代表者', SALON.operatorName],
    ['所在地', SALON.address],
    ['電話番号', SALON.tel],
    ['お問い合わせ', SALON.contactEmail]
  ];

  // 未設定の項目は行ごと出さない
  $('#privacy-contact').innerHTML = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join('');

  // 連絡先が1つも設定されていないときは、その旨を出しておく
  if (!SALON.tel && !SALON.contactEmail) {
    $('#privacy-contact').insertAdjacentHTML('beforeend',
      '<tr><th>ご連絡先</th><td>準備中です。ご来店時に直接お尋ねください。</td></tr>');
  }

  $('#privacy-updated').textContent = '制定日：' + (SALON.privacyUpdated || '準備中');

  // 公開用データの準備中設定を外したときだけ注意書きを消す
  if (!SALON.draft) {
    const notice = document.querySelector('main .notice');
    if (notice) notice.remove();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderPrivacy();
});
