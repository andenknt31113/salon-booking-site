/* ============================================================
 *  一覧系ページ（TOP / メニュー / スタッフ / スタイル / 口コミ）の描画
 * ============================================================ */

/* ---------- 共通パーツ ---------- */

/* 写真が用意できていない箇所は、バーバーポールを思わせる斜めのストライプで埋めます。
   「画像が抜けている」ではなく、意図した意匠に見せるためです。
   写真（image）が指定されていれば、そちらを優先します。 */
function placeholder(hue, label, cls) {
  return `
    <div class="${cls} ph" style="--ph-hue:${hue};">
      <span class="ph-stripes" aria-hidden="true"></span>
      ${label ? `<span class="ph-label">${esc(label)}</span>` : ''}
    </div>`;
}

/* 写真は意匠の上に重ねる。ファイルが無ければ img が取り除かれ、
   下のストライプがそのまま見えるので、置くだけで切り替わります。 */
function photoOrPlaceholder(item, label, cls, alt) {
  return `
    <div class="${cls} ph" style="--ph-hue:${item.hue};">
      <span class="ph-stripes" aria-hidden="true"></span>
      ${label ? `<span class="ph-label">${esc(label)}</span>` : ''}
      ${item.image ? `<img class="ph-photo" src="${esc(item.image)}" alt="${esc(alt)}" loading="lazy" />` : ''}
    </div>`;
}

/* 価格の表示。
   0 は「デザインにより変動」「相談」の意味なので金額を出さない。
   priceFrom が true のものは「〜」を付ける（掲載が ¥4,000〜 の形式）。 */
function priceLabel(item) {
  if (!item.price) return '<span class="price-quote">カウンセリングでお見積り</span>';
  return `${yen(item.price)}${item.priceFrom ? '〜' : ''}<small>（税込）</small>`;
}

function couponCard(c) {
  const badgeClass = c.badge === '再来' ? ' is-repeat' : c.badge === '全員' ? ' is-all' : '';
  const off = c.listPrice && c.listPrice > c.price
    ? `<div class="price-list">通常 ${yen(c.listPrice)}</div>` : '';
  return `
    <article class="coupon">
      ${c.image ? `<img class="coupon-photo ph-photo-opt" src="${esc(c.image)}" alt="" />` : ''}
      <div>
        <span class="coupon-badge${badgeClass}">${esc(c.badge)}</span>
        <h3>${esc(c.title)}</h3>
        <p class="coupon-detail">${esc(c.detail)}</p>
        <p class="coupon-terms">※${esc(c.terms)}</p>
      </div>
      <div class="coupon-price">
        <div>
          ${off}
          <div class="price-now">${priceLabel(c)}</div>
          <div class="price-min">所要 約${formatDuration(c.minutes)}</div>
        </div>
        <a class="btn btn-primary btn-sm" href="reserve.html?menu=${encodeURIComponent(c.id)}">このメニューで予約</a>
      </div>
    </article>`;
}

function staffCard(s) {
  const fee = s.nominationFee > 0 ? `指名料 ${yen(s.nominationFee)}` : '指名料なし';
  const meta = [s.kana, s.years ? `経験${s.years}年` : ''].filter(Boolean).join('／');
  // 在籍1名のサロンでは、グリッドに1枚だけ置くと寂しいので横並びの大きめカードにする
  const solo = SALON.staff.length === 1 ? ' staff-card-solo' : '';

  return `
    <article class="staff-card${solo}">
      <div class="avatar ph" style="--ph-hue:${s.hue};">
        <span class="ph-stripes" aria-hidden="true"></span>
        <span class="avatar-initial">${esc(s.name.slice(0, 1))}</span>
        ${s.image ? `<img class="ph-photo" src="${esc(s.image)}" alt="${esc(s.name)}" loading="lazy" />` : ''}
      </div>
      <div class="staff-body">
        <p class="staff-role">${esc(s.role)}</p>
        <h3 class="staff-name">${esc(s.name)}</h3>
        ${meta ? `<p class="staff-kana">${esc(meta)}</p>` : ''}
        <ul class="tag-list">${s.tags.map(t => `<li class="tag">${esc(t)}</li>`).join('')}</ul>
        <p class="staff-message">${esc(s.message)}</p>
        <p class="staff-fee">${esc(fee)}</p>
        <a class="btn btn-outline btn-sm" href="reserve.html?staff=${encodeURIComponent(s.id)}">${esc(s.name)}を指名して予約</a>
      </div>
    </article>`;
}

function styleCard(sy) {
  const st = findStaff(sy.staffId);
  return `
    <article class="style-card">
      ${photoOrPlaceholder(sy, sy.length, 'style-thumb', sy.title)}
      <div class="style-body">
        <h3 class="style-title">${esc(sy.title)}</h3>
        <p class="style-meta">${esc(sy.length)}${st ? '／' + esc(st.name) : ''}</p>
        <p class="style-meta">${sy.tags.map(t => `#${esc(t)}`).join(' ')}</p>
      </div>
    </article>`;
}

function reviewCard(r) {
  const st = findStaff(r.staffId);
  return `
    <article class="review">
      <div class="review-head">
        <span class="review-score">${stars(r.score)}</span>
        <strong style="font-family:var(--font-en);">${r.score.toFixed(1)}</strong>
        <span class="review-user">${esc(r.nickname)}さん（${esc(r.age)}・${esc(r.gender)}）／${formatDateJa(r.date, { short: true })}</span>
      </div>
      <h3>${esc(r.title)}</h3>
      <p class="review-body">${esc(r.body)}</p>
      <p class="review-foot">担当：${esc(st ? st.name : '指名なし')}／ご利用メニュー：${esc(r.menu)}</p>
    </article>`;
}

function menuGroupHtml(cat) {
  const rows = cat.items.map(m => `
    <div class="menu-row">
      ${m.image ? `<img class="menu-row-photo ph-photo-opt" src="${esc(m.image)}" alt="" />` : ''}
      <div>
        <p class="menu-row-name">${esc(m.name)}</p>
        ${m.note ? `<p class="menu-row-note">${esc(m.note)}</p>` : ''}
      </div>
      <div class="menu-row-meta">
        <p class="menu-row-price">${m.price ? yen(m.price) + (m.priceFrom ? '〜' : '') : 'ご相談'}</p>
        <p class="menu-row-time">約${formatDuration(m.minutes)}</p>
      </div>
    </div>`).join('');
  return `<div class="menu-group" id="cat-${esc(cat.id)}"><h3>${esc(cat.name)}</h3>${rows}</div>`;
}

/* ---------- FAQ ---------- */
function renderFaq(host) {
  if (!host) return;
  host.innerHTML = SALON.faq.map((f, i) => `
    <div class="faq-item" data-faq="${i}">
      <button class="faq-q" type="button" aria-expanded="false">${esc(f.q)}</button>
      <div class="faq-a"><span>${esc(f.a)}</span></div>
    </div>`).join('');

  host.addEventListener('click', e => {
    const btn = e.target.closest('.faq-q');
    if (!btn) return;
    const item = btn.closest('.faq-item');
    const open = item.classList.toggle('is-open');
    btn.setAttribute('aria-expanded', String(open));
  });
}

/* ---------- 店舗情報 ---------- */
function renderSalonInfo(host) {
  if (!host) return;
  const b = SALON.business;
  const closed = b.closedWeekdays.map(d => WEEKDAY_JA[d] + '曜日').join('・') || '年中無休';
  const hours = `${b.openTime}〜${b.closeTime}（最終受付 ${b.lastOrder}）`
    + (b.note ? `\n※${b.note}` : '');

  const rows = [
    ['店名', SALON.fullName || `${SALON.name} ${SALON.nameSub || ''}`.trim()],
    ['電話番号', SALON.tel],
    ['住所', SALON.address],
    ['アクセス', SALON.access],
    ['道案内', SALON.directions],
    ['営業時間', hours],
    ['定休日', closed],
    ['席数', SALON.seats],
    ['スタッフ数', SALON.staffCount],
    ['駐車場', SALON.parking],
    ['支払方法', SALON.payment],
    ['こだわり条件', (SALON.features || []).join('／')]
  ];
  // 未確認で空にしてある項目は、行ごと出さない
  host.innerHTML = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v).replace(/\n/g, '<br />')}</td></tr>`)
    .join('');

  renderMapLinks(host.closest('section'));
}

/* 地図へのボタン。
   Googleマップの埋め込みは第三者のiframeを読み込むことになり、
   こちらの環境では表示確認ができないため、確実に動くリンクにしてあります。
   カーナビ・Googleマップ用の検索語は directions に書いたものと同じ。 */
function mapQuery() {
  return SALON.mapQuery || SALON.address;
}

function renderMapLinks(section) {
  if (!section || $('.map-actions', section)) return;
  const q = encodeURIComponent(mapQuery());
  const table = $('.info-table', section);
  if (!table) return;

  table.insertAdjacentHTML('afterend', `
    <div class="map-actions">
      <a class="btn btn-outline" target="_blank" rel="noopener"
         href="https://www.google.com/maps/search/?api=1&query=${q}">地図で見る</a>
      <a class="btn btn-primary" target="_blank" rel="noopener"
         href="https://www.google.com/maps/dir/?api=1&destination=${q}">ここへの経路を調べる</a>
    </div>
    <p class="map-note">「経路を調べる」を押すと、今いる場所からの道順がGoogleマップで開きます。</p>`);
}

/* ---------- ページごとの初期化 ---------- */
function initHome() {
  const _wire = () => wireImageFallbacks();
  // 評価は実際に集まってから出す（rating が null のあいだは表示しない）
  if (SALON.rating) {
    $('#hero-score').textContent = SALON.rating.toFixed(1);
    $('#hero-stars').textContent = stars(SALON.rating);
    $('#hero-count').textContent = `口コミ ${SALON.reviewCount.toLocaleString('ja-JP')}件`;
  } else {
    $('.hero-rating').hidden = true;
  }
  // トップの大きい写真。設定されていればストライプの意匠に重ねる
  const hero = $('.hero');
  if (hero && SALON.heroImage) {
    hero.classList.add('has-photo');
    hero.insertAdjacentHTML('afterbegin',
      `<img class="hero-photo ph-photo-opt" src="${esc(SALON.heroImage)}" alt="" />`);
  }

  const heroBrand = $('#hero-brand');
  if (heroBrand) heroBrand.innerHTML = brandLockup({ size: 'lg', height: 120 });
  $('#hero-catch').textContent = SALON.catch;
  $('#hero-desc').textContent = SALON.description;
  $('#lead-hours').textContent = SALON.business.minLeadHours;

  $('#hero-meta').innerHTML = [
    SALON.access || SALON.address,
    `${SALON.business.openTime}〜${SALON.business.closeTime}`,
    `定休日 ${SALON.business.closedWeekdays.map(d => WEEKDAY_JA[d]).join('・') || 'なし'}`
  ].filter(Boolean).map(t => `<li>◍ ${esc(t)}</li>`).join('');

  $('#home-coupons').innerHTML = SALON.coupons.slice(0, 3).map(couponCard).join('');
  $('#home-styles').innerHTML = SALON.styles.slice(0, 4).map(styleCard).join('');
  $('#home-staff').innerHTML = SALON.staff.map(staffCard).join('');
  $('#home-reviews').innerHTML = SALON.reviews.length
    ? SALON.reviews.slice(0, 2).map(reviewCard).join('')
    : '<p class="empty-state">口コミはまだ届いていません。ご来店後のアンケートにご協力いただけると励みになります。</p>';
  renderSalonInfo($('#salon-info'));
  renderFaq($('#faq-list'));
  _wire();
}

function initMenuPage() {
  $('#coupon-list').innerHTML = SALON.coupons.map(couponCard).join('');

  const tabsHost = $('#menu-tabs');
  const listHost = $('#menu-list');
  const cats = SALON.menuCategories;
  tabsHost.innerHTML = [{ id: 'all', name: 'すべて' }, ...cats]
    .map((c, i) => `<button class="tab" type="button" role="tab" data-cat="${esc(c.id)}" aria-selected="${i === 0}">${esc(c.name)}</button>`)
    .join('');

  const draw = catId => {
    const target = catId === 'all' ? cats : cats.filter(c => c.id === catId);
    listHost.innerHTML = target.map(menuGroupHtml).join('');
    wireImageFallbacks(listHost);
  };
  draw('all');
  wireImageFallbacks($('#coupon-list'));

  tabsHost.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab', tabsHost).forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    draw(tab.dataset.cat);
  });
}

function initStaffPage() {
  $('#staff-list').innerHTML = SALON.staff.map(staffCard).join('');
  wireImageFallbacks();
}

function initGalleryPage() {
  const host = $('#style-list');
  const tabsHost = $('#style-tabs');
  const lengths = ['すべて', ...new Set(SALON.styles.map(s => s.length))];
  tabsHost.innerHTML = lengths
    .map((l, i) => `<button class="tab" type="button" data-len="${esc(l)}" aria-selected="${i === 0}">${esc(l)}</button>`)
    .join('');

  const draw = len => {
    const list = len === 'すべて' ? SALON.styles : SALON.styles.filter(s => s.length === len);
    host.innerHTML = list.map(styleCard).join('');
    wireImageFallbacks(host);
  };
  draw('すべて');

  tabsHost.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab', tabsHost).forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    draw(tab.dataset.len);
  });
}

function initReviewsPage() {
  $('#review-summary').innerHTML = SALON.rating
    ? `<div style="text-align:center;">
         <div class="rating-score" style="font-size:44px;">${SALON.rating.toFixed(1)}</div>
         <div class="stars" style="font-size:20px;">${stars(SALON.rating)}</div>
         <p style="font-size:12.5px;color:var(--muted);margin-top:6px;">全 ${SALON.reviewCount.toLocaleString('ja-JP')}件の口コミ</p>
       </div>`
    : '';
  $('#review-list').innerHTML = SALON.reviews.length
    ? SALON.reviews.map(reviewCard).join('')
    : `<p class="empty-state">${SALON.reviewCount
        ? `${SALON.reviewCount}件の評価をいただいています。<br />個別の口コミはただいま準備中です。`
        : '口コミはまだ届いていません。<br />ご来店後のアンケートにご協力いただけると励みになります。'}</p>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  // スプレッドシートにメニューがあれば取り込む（無ければ data.js のまま）
  await Catalog.load();

  const page = document.body.dataset.page;
  ({
    home: initHome,
    menu: initMenuPage,
    staff: initStaffPage,
    gallery: initGalleryPage,
    reviews: initReviewsPage
  }[page] || (() => {}))();
});
