/* ============================================================
 *  共通処理：ヘッダー/フッター描画・ユーティリティ・
 *  予約データ保存・空席計算エンジン
 * ============================================================ */

/* ---------- 短縮セレクタ ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- フォーマット ---------- */
const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
const pad2 = n => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD'（ローカルタイム基準） */
function toKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** 'YYYY-MM-DD' -> Date（ローカル0時） */
function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
/** 'YYYY-MM-DD' -> '8月17日(月)' */
function formatDateJa(key, opt = {}) {
  const d = fromKey(key);
  const wd = WEEKDAY_JA[d.getDay()];
  return opt.short
    ? `${d.getMonth() + 1}/${d.getDate()}(${wd})`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${wd})`;
}
/** '10:30' -> 630（分） */
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
/** 630 -> '10:30' */
function toHHMM(min) {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}
/** 所要時間の表示（90 -> '1時間30分'） */
function formatDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}時間${m}分`;
  if (h) return `${h}時間`;
  return `${m}分`;
}
/** 文字列から 0〜1 の決定的な擬似乱数（同じ入力なら常に同じ値） */
function seededRandom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
/** HTMLエスケープ */
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
/** 星表示 */
function stars(score) {
  const full = Math.round(score);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

/* ---------- マスタ参照ヘルパー ---------- */
const allMenuItems = () => SALON.menuCategories.flatMap(c => c.items);
const findMenu = id => allMenuItems().find(m => m.id === id) || SALON.coupons.find(c => c.id === id) || null;
const findStaff = id => SALON.staff.find(s => s.id === id) || null;
const staffLabel = id => (id ? (findStaff(id)?.name ?? '不明') : '指名なし');

/* ============================================================
 *  予約データストア
 *  GitHub Pages は静的サイトのためブラウザの localStorage に保存します。
 *  SALON.reservationEndpoint を設定すると外部へも送信します。
 * ============================================================ */
const STORE_KEY = 'salon.reservations.v1';

let memory = null; // localStorage が使えない環境（プライベートモード等）での代替

const Store = {
  all() {
    if (memory) return memory;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      memory = [];
      return memory;
    }
  },
  save(list) {
    if (memory) { memory = list; return; }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch (e) {
      memory = list; // 保存できない環境ではメモリ上に保持する
    }
  },
  add(reservation) {
    const list = this.all();
    list.push(reservation);
    this.save(list);
    return reservation;
  },
  find(code) {
    return this.all().find(r => r.code === code) || null;
  },
  cancel(code) {
    const list = this.all();
    const target = list.find(r => r.code === code);
    if (!target) return false;
    target.status = 'cancelled';
    target.cancelledAt = new Date().toISOString();
    this.save(list);
    return true;
  },
  /** 有効な（キャンセルされていない）予約のみ */
  active() {
    return this.all().filter(r => r.status !== 'cancelled');
  },
  /** 予約番号を発行（例: LM-8F3K2） */
  issueCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = 'LM-' + Array.from({ length: 5 }, () =>
        chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (this.find(code));
    return code;
  }
};

/* ============================================================
 *  空席計算エンジン
 * ============================================================ */
const Availability = {
  /** 予約枠の時刻リスト（最終受付まで） */
  timeSlots() {
    const { openTime, lastOrder, slotMinutes } = SALON.business;
    const out = [];
    for (let m = toMinutes(openTime); m <= toMinutes(lastOrder); m += slotMinutes) {
      out.push(toHHMM(m));
    }
    return out;
  },

  /** 休業日か */
  isClosed(dateKey) {
    const d = fromKey(dateKey);
    return SALON.business.closedWeekdays.includes(d.getDay())
      || SALON.business.closedDates.includes(dateKey);
  },

  /** 受付可能な日付か（過去・休業日・予約可能期間外を除く） */
  isBookableDate(dateKey) {
    if (this.isClosed(dateKey)) return false;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = fromKey(dateKey);
    if (target < today) return false;
    const limit = new Date(today);
    limit.setDate(limit.getDate() + SALON.business.bookableDays);
    return target <= limit;
  },

  /** 受付締め切りを過ぎた枠か（当日の直近） */
  isTooSoon(dateKey, time) {
    const now = new Date();
    const slot = fromKey(dateKey);
    slot.setMinutes(toMinutes(time));
    return slot.getTime() - now.getTime() < SALON.business.minLeadHours * 3600 * 1000;
  },

  /** そのスタッフがその日出勤しているか */
  isWorking(staffId, dateKey) {
    const staff = findStaff(staffId);
    if (!staff) return false;
    return staff.workdays.includes(fromKey(dateKey).getDay());
  },

  /** 既存予約でそのスタッフの枠が埋まっているか（指名なし予約は特定スタッフを塞がない）
   *  この端末の予約と、受信先から取得した他のお客様の予約の両方を見ます。 */
  isBooked(staffId, dateKey, time) {
    const slotStart = toMinutes(time);
    const overlaps = (date, start, minutes) =>
      date === dateKey
      && slotStart >= toMinutes(start)
      && slotStart < toMinutes(start) + (minutes || SALON.business.slotMinutes);

    const mine = Store.active().some(r =>
      r.staffId === staffId && overlaps(r.date, r.time, r.totalMinutes));

    return mine || Remote.isBusy(staffId, dateKey, time);
  },

  /* サンプルの「先約」を作る。実運用では予約管理システムの空き状況に差し替えてください。
     1日に1〜3件の施術が入っている想定でブロックを生成します。
     30分ごとに独立して判定すると、長いメニューで連続枠がまず取れなくなるため、
     まとまった時間の先約として作ります。 */
  _blocks: new Map(),
  busyBlocks(staffId, dateKey) {
    const ck = staffId + dateKey;
    if (this._blocks.has(ck)) return this._blocks.get(ck);

    const { openTime, lastOrder, slotMinutes } = SALON.business;
    const span = (toMinutes(lastOrder) - toMinutes(openTime)) / slotMinutes;
    const blocks = [];
    const count = 1 + Math.floor(seededRandom(`${dateKey}|${staffId}|n`) * 3);
    for (let i = 0; i < count; i++) {
      const start = toMinutes(openTime)
        + Math.floor(seededRandom(`${dateKey}|${staffId}|s${i}`) * span) * slotMinutes;
      const len = (2 + Math.floor(seededRandom(`${dateKey}|${staffId}|l${i}`) * 4)) * slotMinutes;
      blocks.push([start, start + len]);
    }
    this._blocks.set(ck, blocks);
    return blocks;
  },

  /** 1枠単位で、そのスタッフが空いているか */
  isStaffSlotFree(staffId, dateKey, time) {
    if (!this.isWorking(staffId, dateKey)) return false;
    if (this.isBooked(staffId, dateKey, time)) return false;
    const t = toMinutes(time);
    return !this.busyBlocks(staffId, dateKey).some(([s, e]) => t >= s && t < e);
  },

  /**
   * 指定枠の空き状況を返す
   * @returns {{ symbol:string, free:number, available:boolean, reason:string }}
   */
  slotInfo(dateKey, time, staffId = null, durationMin = SALON.business.slotMinutes) {
    if (!this.isBookableDate(dateKey)) return { symbol: '-', free: 0, available: false, reason: 'closed' };
    if (this.isTooSoon(dateKey, time)) return { symbol: '×', free: 0, available: false, reason: 'too-soon' };

    const { slotMinutes, closeTime } = SALON.business;
    const need = Math.max(1, Math.ceil(durationMin / slotMinutes));
    const start = toMinutes(time);
    if (start + durationMin > toMinutes(closeTime)) {
      return { symbol: '×', free: 0, available: false, reason: 'over-close' };
    }

    const targets = staffId ? [findStaff(staffId)].filter(Boolean) : SALON.staff;
    // 施術時間ぶん連続で空いているスタッフを数える
    const free = targets.filter(st => {
      for (let i = 0; i < need; i++) {
        if (!this.isStaffSlotFree(st.id, dateKey, toHHMM(start + i * slotMinutes))) return false;
      }
      return true;
    }).length;

    if (free === 0) return { symbol: '×', free: 0, available: false, reason: 'full' };
    // 対象が1名のときは「空きの多さ」に意味がないので ○ で表示する
    if (staffId || SALON.staff.length === 1) return { symbol: '○', free, available: true, reason: '' };
    if (free === 1) return { symbol: '△', free, available: true, reason: '' };
    if (free === 2) return { symbol: '○', free, available: true, reason: '' };
    return { symbol: '◎', free, available: true, reason: '' };
  },

  /** カレンダー表示用の日付配列を返す */
  dateRange(startOffset = 0, days = SALON.business.calendarDays) {
    const base = new Date(); base.setHours(0, 0, 0, 0);
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + startOffset + i);
      return toKey(d);
    });
  }
};

/* ============================================================
 *  受信先（Google Apps Script など）への送信
 * ============================================================ */
/* Content-Type を text/plain にしているのは意図的です。
   application/json にするとブラウザが事前確認（OPTIONS）を送りますが、
   Google Apps Script はこれに応答できず、送信が必ず失敗します。
   text/plain なら事前確認なしで届き、GAS 側は e.postData.contents で
   そのまま JSON として読めます。 */
async function sendToEndpoint(payload) {
  if (!SALON.reservationEndpoint) return false;
  try {
    await fetch(SALON.reservationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return true;
  } catch (e) {
    console.warn('受信先への送信に失敗しました。この端末には保存されています。', e);
    return false;
  }
}

/* ============================================================
 *  他のお客様の予約状況（ダブルブッキング防止）
 *  受信先から「埋まっている枠」だけを取得します。
 *  氏名・電話番号などは一切受け取りません。
 * ============================================================ */
const Remote = {
  booked: null,       // null = 未取得または取得失敗
  loaded: false,
  loading: null,

  /** 受信先から予約済み枠を取得する（多重呼び出しは1回にまとめる） */
  load(force = false) {
    if (!SALON.reservationEndpoint) { this.loaded = true; return Promise.resolve(false); }
    if (this.loading) return this.loading;
    if (this.loaded && !force) return Promise.resolve(this.booked !== null);

    this.loading = (async () => {
      try {
        const res = await fetch(SALON.reservationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ type: 'availability' })
        });
        const data = await res.json();
        this.booked = Array.isArray(data.booked) ? data.booked : [];
        return true;
      } catch (e) {
        // 取得できないときはこの端末の予約だけで判定する（予約自体は続行できる）
        console.warn('空席状況を取得できませんでした。', e);
        this.booked = null;
        return false;
      } finally {
        this.loaded = true;
        this.loading = null;
      }
    })();
    return this.loading;
  },

  /** 他のお客様の予約でその枠が埋まっているか */
  isBusy(staffId, dateKey, time) {
    if (!this.booked) return false;
    const t = toMinutes(time);
    return this.booked.some(b =>
      b.date === dateKey
      && b.staffId === staffId
      && t >= toMinutes(b.time)
      && t < toMinutes(b.time) + (b.minutes || SALON.business.slotMinutes));
  }
};

/* ============================================================
 *  メニュー・クーポンの取り込み
 *  スプレッドシートの「メニュー」「クーポン」シートに行があれば、
 *  そちらを優先して使います。無ければ data.js の内容のまま動きます。
 * ============================================================ */
const Catalog = {
  loaded: false,
  source: 'local',   // 'local' = data.js / 'sheet' = スプレッドシート

  async load() {
    if (this.loaded) return this.source;
    this.loaded = true;
    if (!SALON.reservationEndpoint) return this.source;

    try {
      const res = await fetch(SALON.reservationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ type: 'menu' })
      });
      const data = await res.json();

      // 中身があるときだけ差し替える（空のシートで消えてしまわないように）
      if (Array.isArray(data.categories) && data.categories.length) {
        SALON.menuCategories = data.categories;
        this.source = 'sheet';
      }
      if (Array.isArray(data.coupons) && data.coupons.length) {
        SALON.coupons = data.coupons;
        this.source = 'sheet';
      }
    } catch (e) {
      console.warn('メニューを取得できませんでした。掲載中の内容で表示します。', e);
    }
    return this.source;
  }
};

/** 予約番号と電話番号でご予約を照会する（ログインの代わり） */
async function lookupReservation(code, tel) {
  if (!SALON.reservationEndpoint) {
    return { ok: false, error: 'ただいまオンラインでの照会をご利用いただけません。' };
  }
  try {
    const res = await fetch(SALON.reservationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ type: 'lookup', code: code, tel: tel })
    });
    return await res.json();
  } catch (e) {
    console.warn('照会に失敗しました', e);
    return { ok: false, error: '通信に失敗しました。時間をおいてお試しください。' };
  }
}

/** キャンセルを受信先へ通知する（予約台帳の状態を更新するため） */
function sendCancellation(reservation) {
  return sendToEndpoint({
    type: 'cancel',
    code: reservation.code,
    date: reservation.date,
    time: reservation.time,
    name: reservation.customer ? reservation.customer.name : ''
  });
}

/* ============================================================
 *  ヘッダー / フッターの描画
 * ============================================================ */
const NAV_ITEMS = [
  { href: 'index.html', label: 'サロンTOP' },
  { href: 'gallery.html', label: 'スタイル' },
  { href: 'staff.html', label: 'スタッフ' },
  { href: 'menu.html', label: 'クーポン・メニュー' },
  { href: 'reviews.html', label: '口コミ' },
  { href: 'reserve.html', label: '空席・予約' },
  { href: 'mypage.html', label: '予約確認' }
];

function currentPage() {
  const path = location.pathname.split('/').pop();
  return path === '' ? 'index.html' : path;
}

function renderHeader() {
  const host = $('#site-header');
  if (!host) return;
  const page = currentPage();
  const initials = SALON.mark
    || SALON.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
    || 'SL';
  const nav = NAV_ITEMS.map(item => {
    const cur = item.href === page ? ' aria-current="page"' : '';
    return `<li><a href="${item.href}"${cur}>${item.label}</a></li>`;
  }).join('');

  const draft = SALON.draft
    ? `<div class="draft-banner">${esc(SALON.draftNote || '準備中：内容は仮のものです')}</div>`
    : '';

  host.innerHTML = `
    ${draft}
    <header class="site-header">
      <div class="container header-top">
        <a class="brand" href="index.html">
          <span class="brand-mark" aria-hidden="true">${esc(initials)}</span>
          <span class="brand-text">
            <span class="brand-name">${esc(SALON.name)}</span>
            <span class="brand-sub">${esc(SALON.nameSub || SALON.branch)}</span>
          </span>
        </a>
        <div class="header-actions">
          ${SALON.tel ? `
          <a class="header-tel" href="tel:${esc(SALON.tel.replace(/-/g, ''))}">
            <span>TEL / 受付 ${esc(SALON.business.openTime)}-${esc(SALON.business.closeTime)}</span>
            <strong>${esc(SALON.tel)}</strong>
          </a>` : ''}
          <a class="btn btn-primary btn-sm" href="reserve.html">ネット予約</a>
        </div>
      </div>
      <nav class="site-nav" aria-label="メインメニュー">
        <div class="container"><ul>${nav}</ul></div>
      </nav>
    </header>`;
}

function renderFooter() {
  const host = $('#site-footer');
  if (!host) return;
  const year = new Date().getFullYear();
  host.innerHTML = `
    <footer class="site-footer">
      <div class="container">
        <div class="footer-grid">
          <div>
            <p class="footer-brand-name">${esc(SALON.name)} ${esc(SALON.nameSub || SALON.branch)}</p>
            <p>${esc(SALON.address)}</p>
            ${SALON.access ? `<p>${esc(SALON.access)}</p>` : ''}
            ${SALON.tel ? `<p style="margin-top:10px;">TEL ${esc(SALON.tel)}</p>` : ''}
            <p>営業時間 ${esc(SALON.business.openTime)}〜${esc(SALON.business.closeTime)}（最終受付 ${esc(SALON.business.lastOrder)}）</p>
            <p>定休日 ${SALON.business.closedWeekdays.map(d => WEEKDAY_JA[d] + '曜日').join('・') || 'なし'}</p>
          </div>
          <div>
            <h4>MENU</h4>
            <ul>
              <li><a href="index.html">サロンTOP</a></li>
              <li><a href="gallery.html">ヘアスタイル</a></li>
              <li><a href="staff.html">スタッフ一覧</a></li>
              <li><a href="menu.html">クーポン・メニュー</a></li>
              <li><a href="reviews.html">口コミ</a></li>
            </ul>
          </div>
          <div>
            <h4>RESERVATION</h4>
            <ul>
              <li><a href="reserve.html">空席状況・ネット予約</a></li>
              <li><a href="mypage.html">ご予約の確認・キャンセル</a></li>
              <li><a href="index.html#faq">よくあるご質問</a></li>
              <li><a href="privacy.html">プライバシーポリシー</a></li>
              <li><a href="admin.html">スタッフ用 予約管理</a></li>
            </ul>
          </div>
        </div>
        <p class="copyright">&copy; ${year} ${esc(SALON.name)}. All rights reserved.</p>
      </div>
    </footer>
    <div class="sp-cta">
      ${SALON.tel ? `<a class="btn btn-ghost" href="tel:${esc(SALON.tel.replace(/-/g, ''))}">電話</a>` : ''}
      <a class="btn btn-primary" href="reserve.html">24時間ネット予約</a>
    </div>`;
}

/* ============================================================
 *  構造化データ（Google検索・マップ向け）
 *  店舗情報を data.js から組み立てて埋め込みます。
 * ============================================================ */
function injectStructuredData() {
  if (currentPage() !== 'index.html') return;

  const b = SALON.business;
  const prices = SALON.coupons.map(c => c.price)
    .concat(allMenuItems().map(m => m.price))
    .filter(Boolean);

  const data = {
    '@context': 'https://schema.org',
    '@type': 'HairSalon',
    name: SALON.fullName || `${SALON.name} ${SALON.nameSub || ''}`.trim(),
    alternateName: SALON.nameJa,
    description: SALON.description,
    address: {
      '@type': 'PostalAddress',
      addressCountry: 'JP',
      addressRegion: '茨城県',
      addressLocality: '龍ケ崎市',
      streetAddress: SALON.address.replace(/^茨城県龍ケ崎市/, '')
    },
    openingHours: `Mo-Su ${b.openTime}-${b.closeTime}`,
    url: location.origin + location.pathname.replace(/index\.html$/, ''),
    image: location.origin + location.pathname.replace(/index\.html$/, '') + 'assets/ogp.png'
  };

  if (SALON.tel) data.telephone = SALON.tel;
  if (prices.length) {
    data.priceRange = `¥${Math.min(...prices).toLocaleString()}〜¥${Math.max(...prices).toLocaleString()}`;
  }
  if (SALON.rating && SALON.reviewCount) {
    data.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: SALON.rating,
      reviewCount: SALON.reviewCount,
      bestRating: 5
    };
  }

  const tag = document.createElement('script');
  tag.type = 'application/ld+json';
  tag.textContent = JSON.stringify(data);
  document.head.appendChild(tag);
}

/* ページタイトルを設定ファイルから補完 */
function applyDocumentTitle() {
  const base = `${SALON.name} ${SALON.nameSub || SALON.branch}`.trim();
  document.title = document.title ? `${document.title}｜${base}` : base;
}

document.addEventListener('DOMContentLoaded', () => {
  renderHeader();
  renderFooter();
  applyDocumentTitle();
  injectStructuredData();
});
