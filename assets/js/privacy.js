/* ============================================================
 *  プライバシーポリシーページ
 *  連絡先は data.js の内容から組み立てます。
 * ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
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

  // 注意書きは公開準備が済んだら消す
  if (!SALON.draft) {
    const notice = document.querySelector('main .notice');
    if (notice) notice.remove();
  }
});
