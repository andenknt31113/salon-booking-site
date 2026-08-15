/* 全ページを1枚のHTMLにまとめる（スマホ確認用プレビュー）
   Artifact は1ファイルしか置けないため、各ページの <main> を
   data-route つきの箱に入れ、ハッシュで切り替える。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(R, f), 'utf8');

const PAGES = ['index.html', 'gallery.html', 'staff.html', 'menu.html',
               'reviews.html', 'reserve.html', 'mypage.html', 'admin.html', 'privacy.html'];

const routes = PAGES.map(f => {
  const main = read(f).match(/<main[^>]*>([\s\S]*?)<\/main>/)[1];
  return `<div data-route="${f}" hidden>${main}</div>`;
}).join('\n');

const shim = `
/* ============================================================
   プレビュー専用：1ファイル内でページを切り替える仕組み
   （本番サイトはページごとに独立したHTMLなので、この処理は入りません）
   ============================================================ */
(function () {
  const routes = () => Array.from(document.querySelectorAll('[data-route]'));
  const has = page => routes().some(r => r.dataset.route === page);
  let pendingAnchor = '';

  // ハッシュは "reserve.html?menu=cp01" の形も取る。
  // ページ名と検索文字列に分けて扱う。
  const splitHash = () => {
    const raw = location.hash.replace(/^#/, '');
    const i = raw.indexOf('?');
    return i < 0 ? [raw, ''] : [raw.slice(0, i), raw.slice(i)];
  };

  // 現在地をURLのハッシュから判定するよう差し替える
  currentPage = () => {
    const p = splitHash()[0];
    return has(p) ? p : 'index.html';
  };

  /* 管理ページで保存した内容は、本番ならページを開き直したときに反映されます。
     ここは開き直しが起きないので、管理ページから離れるときに取り直します。
     これが無いと「ロゴを選んだのにサイトに出ない」ように見えます。 */
  let lastPage = '';
  async function refreshAfterAdmin() {
    Catalog.loaded = false;
    Catalog.loading = null;
    await Catalog.load();
    Availability.loaded = false;
    Availability.booked = null;
    [initHome, initMenuPage, initStaffPage, initGalleryPage, initReviewsPage]
      .forEach(fn => { try { fn(); } catch (err) { console.warn(err); } });
    try {
      renderCouponChoices(); renderMenuChoices('all'); updateSummary();
      renderHeader(); renderFooter(); wireImageFallbacks();
    } catch (err) { console.warn(err); }
  }

  function show(page) {
    if (lastPage === 'admin.html' && page !== 'admin.html') refreshAfterAdmin();
    lastPage = page;
    routes().forEach(r => { r.hidden = r.dataset.route !== page; });
    document.body.dataset.page = page.replace('.html', '');
    renderHeader();
    /* フッターも描き直す。画面下に貼りつくボタンはフッターと一緒に作られるので、
       ここを飛ばすと、最初に開いたページのボタンが居座り続ける
       （予約ページなのに「24時間ネット予約」が出たままになる） */
    renderFooter();
    try { if (page === 'reserve.html') renderStepCta(); } catch (err) { /* noop */ }

    // 本番はページを開き直すたびに描画されるが、ここでは再読込が起きないため
    // 予約データを見るページだけ手動で描き直す
    try {
      if (page === 'mypage.html') render();
      if (page === 'admin.html' && !document.getElementById('dashboard').hidden) renderAll();
    } catch (err) { console.warn(err); }

    // 本番では reserve.html?menu=... を開き直すとURLから事前選択が入る。
    // ここは再読込が起きないので、同じことを手で行う。
    const search = splitHash()[1];
    if (page === 'reserve.html' && search) {
      try {
        applyQueryParams(search);
        resetDateTime();
        state.step = 1;
        renderCouponChoices();
        renderMenuChoices('all');
        renderStaffChoices();
        updateSummary();
        renderStep();
        saveDraft();
      } catch (err) { console.warn(err); }
    }

    if (pendingAnchor) {
      const el = document.getElementById(pendingAnchor);
      pendingAnchor = '';
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
    window.scrollTo({ top: 0 });
  }

  // ページ内リンクをハッシュ遷移に変える
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const raw = a.getAttribute('href');
    if (!raw || !raw.includes('.html')) return;
    // "reserve.html?staff=st01#anchor" を ファイル名 / 検索文字列 / アンカー に分ける。
    // 検索文字列を落とすと has() が外れ、リンクがそのまま外部遷移して 404 になる。
    const [pathQuery, anchor] = raw.split('#');
    const q = pathQuery.indexOf('?');
    const path = q < 0 ? pathQuery : pathQuery.slice(0, q);
    const query = q < 0 ? '' : pathQuery.slice(q);
    const file = path.split('/').pop();
    if (!has(file)) return;
    e.preventDefault();
    pendingAnchor = anchor || '';
    const target = file + query;
    if (location.hash.replace(/^#/, '') === target) show(file);
    else location.hash = target;
  });

  window.addEventListener('hashchange', () => show(currentPage()));

  document.addEventListener('DOMContentLoaded', async () => {
    await Catalog.load();
    // 全ページのDOMが同時に存在するので、各ページの描画を一度ずつ実行する
    [initHome, initMenuPage, initStaffPage, initGalleryPage, initReviewsPage]
      .forEach(fn => { try { fn(); } catch (err) { console.warn(err); } });
    show(currentPage());
  });
})();
`;

const out = `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ZER01 barber/lounge</title>
<style>
${read('assets/css/style.css').replace(/^@charset "UTF-8";\n/, '')}
/* 見本であることの断り書き（本番サイトには入りません） */
.preview-note {
  background: #1B1815; color: #F1ECE0; font-size: 12px; line-height: 1.8;
  padding: 12px 16px calc(12px + env(safe-area-inset-top));
}
.preview-note b { color: #E8C97A; }
.preview-note button {
  display: inline-block; margin-left: 8px; background: none; color: #F1ECE0;
  border: 1px solid rgba(241,236,224,.5); padding: 5px 11px; font-size: 11.5px; cursor: pointer;
}
</style>

<div class="preview-note">
  <b>これは見本です。</b>
  予約は<b>この端末の中だけ</b>に保存され、お店には届きません。
  取った予約は、下の「スタッフ用 予約管理」（パスワード <b>zer01</b>）で見られます。
  <button type="button" onclick="プレビューを初期化()">見本を最初の状態に戻す</button>
</div>
<div id="site-header"></div>
<main>
${routes}
</main>
<div id="site-footer"></div>

<script>
${read('assets/js/data.js')}
${read('tools/preview-backend.js')}
${read('assets/js/common.js')}
${read('assets/js/pages.js')}
${read('assets/js/reserve.js')}
${read('assets/js/mypage.js')}
${read('assets/js/admin.js')}
${read('assets/js/privacy.js')}
${shim}
</script>
`;

const dest = process.env.OUT || '/tmp/salon-preview.html';
writeFileSync(dest, out);
console.log('ページ数:', PAGES.length, '/ bytes:', out.length, '/ assets参照:', /assets\//.test(out.replace(/ogp\.png/g, '')));
