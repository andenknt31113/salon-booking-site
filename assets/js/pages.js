/* ============================================================
 *  一覧系ページ（TOP / メニュー / スタッフ / スタイル / 口コミ）の描画
 * ============================================================ */

/* ---------- 共通パーツ ---------- */
function gradientStyle(hue, from = 58, to = 34) {
  return `background:linear-gradient(150deg, hsl(${hue} 42% ${from}%), hsl(${(hue + 28) % 360} 38% ${to}%));`;
}

function couponCard(c) {
  const badgeClass = c.badge === '再来' ? ' is-repeat' : c.badge === '全員' ? ' is-all' : '';
  const off = c.listPrice && c.listPrice > c.price
    ? `<div class="price-list">通常 ${yen(c.listPrice)}</div>` : '';
  return `
    <article class="coupon">
      <div>
        <span class="coupon-badge${badgeClass}">${esc(c.badge)}</span>
        <h3>${esc(c.title)}</h3>
        <p class="coupon-detail">${esc(c.detail)}</p>
        <p class="coupon-terms">※${esc(c.terms)}</p>
      </div>
      <div class="coupon-price">
        <div>
          ${off}
          <div class="price-now">${yen(c.price)}<small>（税込）</small></div>
          <div class="price-min">所要 約${formatDuration(c.minutes)}</div>
        </div>
        <a class="btn btn-primary btn-sm" href="reserve.html?menu=${encodeURIComponent(c.id)}">このクーポンで予約</a>
      </div>
    </article>`;
}

function staffCard(s) {
  const fee = s.nominationFee > 0 ? `指名料 ${yen(s.nominationFee)}` : '指名料なし';
  return `
    <article class="staff-card">
      <div class="avatar" style="${gradientStyle(s.hue)}">
        <span class="avatar-initial">${esc(s.name.slice(0, 1))}</span>
      </div>
      <div class="staff-body">
        <p class="staff-role">${esc(s.role)}</p>
        <h3 class="staff-name">${esc(s.name)}</h3>
        <p class="staff-kana">${esc(s.kana)}／経験${s.years}年</p>
        <ul class="tag-list">${s.tags.map(t => `<li class="tag">${esc(t)}</li>`).join('')}</ul>
        <p class="staff-message">${esc(s.message)}</p>
        <p class="staff-fee">${esc(fee)}／出勤：${s.workdays.map(d => WEEKDAY_JA[d]).join('・')}</p>
        <a class="btn btn-outline btn-sm" href="reserve.html?staff=${encodeURIComponent(s.id)}">${esc(s.name)}を指名して予約</a>
      </div>
    </article>`;
}

function styleCard(sy) {
  const st = findStaff(sy.staffId);
  return `
    <article class="style-card">
      <div class="style-thumb" style="${gradientStyle(sy.hue, 62, 38)}">
        <span>${esc(sy.length.toUpperCase())}</span>
      </div>
      <div class="style-body">
        <h3 class="style-title">${esc(sy.title)}</h3>
        <p class="style-meta">${esc(sy.length)}／${esc(st ? st.name : '')}</p>
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
      <div>
        <p class="menu-row-name">${esc(m.name)}</p>
        ${m.note ? `<p class="menu-row-note">${esc(m.note)}</p>` : ''}
      </div>
      <div class="menu-row-meta">
        <p class="menu-row-price">${yen(m.price)}</p>
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
  const rows = [
    ['店名', `${SALON.name} ${SALON.nameSub || ''}（${SALON.nameJa}）`.trim()],
    ['電話番号', SALON.tel],
    ['住所', SALON.address],
    ['アクセス', SALON.access],
    ['営業時間', `${b.openTime}〜${b.closeTime}（最終受付 ${b.lastOrder}）`],
    ['定休日', closed],
    ['席数', SALON.seats],
    ['支払方法', SALON.payment],
    ['駐車場', SALON.parking]
  ];
  host.innerHTML = rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
}

/* ---------- ページごとの初期化 ---------- */
function initHome() {
  // 評価は実際に集まってから出す（rating が null のあいだは表示しない）
  if (SALON.rating) {
    $('#hero-score').textContent = SALON.rating.toFixed(1);
    $('#hero-stars').textContent = stars(SALON.rating);
    $('#hero-count').textContent = `口コミ ${SALON.reviewCount.toLocaleString('ja-JP')}件`;
  } else {
    $('.hero-rating').hidden = true;
  }
  $('#hero-catch').textContent = SALON.catch;
  $('#hero-desc').textContent = SALON.description;
  $('#lead-hours').textContent = SALON.business.minLeadHours;

  $('#hero-meta').innerHTML = [
    `◍ ${SALON.access}`,
    `◍ ${SALON.business.openTime}〜${SALON.business.closeTime}`,
    `◍ 定休日 ${SALON.business.closedWeekdays.map(d => WEEKDAY_JA[d]).join('・') || 'なし'}`
  ].map(t => `<li>${esc(t)}</li>`).join('');

  $('#home-coupons').innerHTML = SALON.coupons.slice(0, 3).map(couponCard).join('');
  $('#home-styles').innerHTML = SALON.styles.slice(0, 4).map(styleCard).join('');
  $('#home-staff').innerHTML = SALON.staff.map(staffCard).join('');
  $('#home-reviews').innerHTML = SALON.reviews.length
    ? SALON.reviews.slice(0, 2).map(reviewCard).join('')
    : '<p class="empty-state">口コミはまだ届いていません。ご来店後のアンケートにご協力いただけると励みになります。</p>';
  renderSalonInfo($('#salon-info'));
  renderFaq($('#faq-list'));
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
  };
  draw('all');

  tabsHost.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab', tabsHost).forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    draw(tab.dataset.cat);
  });
}

function initStaffPage() {
  $('#staff-list').innerHTML = SALON.staff.map(staffCard).join('');
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
    : '<p class="empty-state">口コミはまだ届いていません。<br />ご来店後のアンケートにご協力いただけると励みになります。</p>';
}

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  ({
    home: initHome,
    menu: initMenuPage,
    staff: initStaffPage,
    gallery: initGalleryPage,
    reviews: initReviewsPage
  }[page] || (() => {}))();
});
