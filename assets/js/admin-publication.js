const PUBLICATION_ITEM_FIELDS = ['id', 'name', 'price', 'priceFrom', 'minutes', 'note', 'image'];
const PUBLICATION_COUPON_FIELDS = ['id', 'title', 'badge', 'tags', 'detail', 'price', 'priceFrom', 'listPrice', 'minutes', 'terms', 'image'];
let publicationRequest = null;

function publicationCatalog(data) {
  if (!data || !Array.isArray(data.categories) || !Array.isArray(data.coupons)) throw new Error();
  const seen = new Set();
  const item = (value, coupon) => {
    if (!value || typeof value.id !== 'string' || !value.id || seen.has(value.id)
        || typeof value[coupon ? 'title' : 'name'] !== 'string' || !value[coupon ? 'title' : 'name'].trim()
        || !Number.isFinite(Number(value.price)) || Number(value.price) < 0
        || !Number.isFinite(Number(value.minutes)) || Number(value.minutes) <= 0) throw new Error();
    seen.add(value.id);
    const fields = coupon ? PUBLICATION_COUPON_FIELDS : PUBLICATION_ITEM_FIELDS;
    return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  };
  return {
    categories: data.categories.map(category => {
      if (!category || typeof category.id !== 'string' || typeof category.name !== 'string'
          || !Array.isArray(category.items)) throw new Error();
      return { id: category.id, name: category.name, items: category.items.map(value => item(value, false)) };
    }),
    coupons: data.coupons.map(value => item(value, true))
  };
}

function samePublicationCatalog(first, second) {
  const stringify = data => JSON.stringify(publicationCatalog(data), (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return stringify(first) === stringify(second);
}

function renderPublicationStatus(state, message) {
  for (const note of document.querySelectorAll('[data-publication-note]')) {
    note.textContent = message;
    note.dataset.state = state;
  }
  for (const button of document.querySelectorAll('[data-publication-check]')) button.disabled = state === 'loading';
}

function invalidatePublicMenuCheck() {
  publicationRequest?.abort();
  publicationRequest = null;
  renderPublicationStatus('unknown', '公開ページの掲載状況は未確認です。予約用メニューの保存と、公開ページへの反映は別途更新が必要です。');
}

async function checkPublishedMenus() {
  if (!adminData || document.querySelector('#dashboard').hidden || publicationRequest) return;
  if (pendingSaves.has('menus') || pendingSaves.has('coupons')) {
    renderPublicationStatus('unknown', 'メニューの保存が終わってから、掲載状況を確認してください。');
    return;
  }
  const controller = new AbortController();
  const generation = dashboardGeneration;
  publicationRequest = controller;
  renderPublicationStatus('loading', '保存済みの予約用メニューと公開ページを照合しています。入力は続けられます。');
  let timeout;
  const current = () => publicationRequest === controller && generation === dashboardGeneration
    && adminData && !document.querySelector('#dashboard').hidden;
  try {
    const read = async () => {
      const [response, published] = await Promise.all([
        fetch(SALON.reservationEndpoint, {
          method: 'POST', cache: 'no-store', credentials: 'omit', signal: controller.signal,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ type: 'menu', booking: true })
        }),
        fetch(new URL('assets/js/published-menus.js', location.href), {
          cache: 'no-store', credentials: 'omit', signal: controller.signal
        })
      ]);
      if (!response.ok || !published.ok) throw new Error();
      const [booking, source] = await Promise.all([response.json(), published.text()]);
      const match = source.match(/^\s*const PUBLISHED_MENUS\s*=\s*([\s\S]+);\s*$/);
      if (!booking || booking.ok !== true || !match) throw new Error();
      return samePublicationCatalog(booking, JSON.parse(match[1]));
    };
    const deadline = new Promise((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error()); }, CATALOG_REQUEST_TIMEOUT_MS);
    });
    const same = await Promise.race([read(), deadline]);
    if (!current()) return;
    renderPublicationStatus(same ? 'same' : 'different', (same
      ? '保存済みの予約用メニューと公開ページのメニューは一致しています。'
      : '予約用メニューと公開ページのメニューに差分があります。制作担当者へ公開ページの更新を依頼してください。')
      + ' 未保存の入力・店舗情報・スタイル写真は含みません。確認：' + new Date().toLocaleString('ja-JP'));
  } catch {
    if (current()) renderPublicationStatus('unknown', '掲載状況を確認できません。公開済みとは判断せず、時間をおいてもう一度確認してください。入力は残しています。');
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (publicationRequest === controller) {
      publicationRequest = null;
      for (const button of document.querySelectorAll('[data-publication-check]')) button.disabled = false;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  invalidatePublicMenuCheck();
  for (const button of document.querySelectorAll('[data-publication-check]')) button.addEventListener('click', checkPublishedMenus);
});
