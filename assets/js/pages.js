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
  /* 説明・条件はシートで空欄にできます（どちらも任意の欄です）。
     そのまま出していたころは、条件が空の行に「※」だけが残り、
     書きかけのメニューを出しているように見えました。中身があるときだけ出します。 */
  const detail = String(c.detail ?? '').trim();
  const terms = String(c.terms ?? '').trim();
  /* 掲載の「カット・カラー」などのタグ。何の施術が入っているのかが
     タイトルからは読み取りにくい（「当日一緒に考えましょう！」など）ので、
     掲載と同じく見出しの下に出します。
     シートから読んだおすすめメニューにはタグ欄がないので、無いこともあります。 */
  const tags = Array.isArray(c.tags) ? c.tags.filter(t => String(t).trim()) : [];
  return `
    <article class="coupon">
      ${c.image ? `<img class="coupon-photo ph-photo-opt" src="${esc(c.image)}" alt="" />` : ''}
      <div>
        <span class="coupon-badge${badgeClass}">${esc(c.badge)}</span>
        <h3>${esc(c.title)}</h3>
        ${tags.length ? `<ul class="tag-list">${tags.map(t => `<li class="tag">${esc(t)}</li>`).join('')}</ul>` : ''}
        ${detail ? `<p class="coupon-detail">${esc(detail)}</p>` : ''}
        ${terms ? `<p class="coupon-terms">※${esc(terms)}</p>` : ''}
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

/* 紹介文と、掲載の「得意な技術」「趣味・マイブーム」。
   後の2つは無い場合もある（シートから読んだスタッフには入っていません）ので、
   中身があるときだけ見出しを付けて出します。
   .staff-message は flex:1 で余白を吸う欄なので、3つ並べると余白の取り合いに
   なります。1つのまとまりとして包み、中で段落を分けています。 */
function staffTextHtml(s) {
  const extra = [['得意な技術', s.skills], ['趣味・マイブーム', s.hobby]]
    .filter(([, v]) => String(v ?? '').trim())
    .map(([label, v]) => `<p style="margin-top:11px;"><b>${esc(label)}</b><br />${esc(v)}</p>`)
    .join('');
  return `<div class="staff-message"><p>${esc(s.message)}</p>${extra}</div>`;
}

function staffCard(s) {
  const fee = s.nominationFee > 0 ? `指名料 ${yen(s.nominationFee)}` : '指名料なし';
  const meta = [s.kana, s.years ? `経験${s.years}年` : ''].filter(Boolean).join('／');
  // 在籍1名のサロンでは、グリッドに1枚だけ置くと寂しいので横並びの大きめカードにする
  const isSolo = SALON.staff.length === 1;
  const solo = isSolo ? ' staff-card-solo' : '';
  /* 在籍1名の店では、予約画面に「指名なし」が出ません（reserve.js）。
     それなのに「指名して予約」と書くと、指名しない道もあるように読めます。
     選ばなかったときの担当を探して、お客様が予約画面で迷います。 */
  const cta = isSolo ? `${esc(s.name)}に予約する` : `${esc(s.name)}を指名して予約`;

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
        ${staffTextHtml(s)}
        <p class="staff-fee">${esc(fee)}</p>
        <a class="btn btn-outline btn-sm" href="reserve.html?staff=${encodeURIComponent(s.id)}">${cta}</a>
      </div>
    </article>`;
}

function styleCard(sy) {
  const st = findStaff(sy.staffId);
  /* 掲載の説明文（「癖毛の方は曲がる縮毛矯正、直毛の方は…」）。
     タイトルとタグだけだと語の羅列に見えて、どういうスタイルなのかが
     いちばん伝わる一文が読めません。シートで空にもできる欄なので、
     中身があるときだけ出します。 */
  const detail = String(sy.detail ?? '').trim();
  return `
    <article class="style-card">
      ${photoOrPlaceholder(sy, sy.length, 'style-thumb', sy.title)}
      <div class="style-body">
        <h3 class="style-title">${esc(sy.title)}</h3>
        <p class="style-meta">${esc(sy.length)}${st ? '／' + esc(st.name) : ''}</p>
        ${/* 灰色のままだと分類・タグと同じ見た目に埋もれるので、本文の色にします
              （style.css は別の作業者が触っているので、ここで指定しています） */ ''}
        ${detail ? `<p class="style-meta" style="color:var(--text-2);">${esc(detail)}</p>` : ''}
        <p class="style-meta">${sy.tags.map(t => `#${esc(t)}`).join(' ')}</p>
        ${/* 押すと、このスタイルの名前をご要望欄まで持っていきます
              （common.js の rememberStyleRequest → 予約ページの takeStyleRequest）。
              以前は一覧の下に「このイメージで予約する」が1つあるだけで、どのスタイルも
              指していませんでした。お客様は名前を自分で書き写すことになっていました。
              URLには載せません。この端末の中だけで渡します。
              文字を2つに分けているのは、折り返す場所を決めるためです。
              1つの文字列だと、狭い画面で「このスタイルで予」「約」と割れます。 */ ''}
        <a class="btn btn-outline btn-sm style-book" href="reserve.html"
           data-style="${esc(sy.title)}"><span>このスタイルで</span><span>予約</span></a>
      </div>
    </article>`;
}

/* スタイルのボタンは、一覧を描き直すたびに作り直されます。
   カード1枚ずつに付けると張り直しになるので、まとめて受けます。 */
function bindStyleBooking() {
  bindOnce('style-book', () => document.addEventListener('click', e => {
    const btn = e.target.closest('.style-book');
    if (btn) rememberStyleRequest(btn.dataset.style);
  }));
}

function reviewCard(r) {
  // 年代・性代はどちらも任意。空の項目で「（30代・）」のようにならないようにする
  const who = [r.age, r.gender].filter(Boolean).join('・');
  const meta = [who ? `（${esc(who)}）` : '', r.date ? '／' + formatDateJa(r.date, { short: true }) : ''].join('');

  // シート由来の口コミは担当を名前で持っている（IDは持たない）
  const st = findStaff(r.staffId);
  const staffName = (st && st.name) || r.staffName || '';

  const foot = [
    staffName ? `担当：${esc(staffName)}` : '',
    r.menu ? `ご利用メニュー：${esc(r.menu)}` : ''
  ].filter(Boolean).join('／');

  return `
    <article class="review">
      <div class="review-head">
        <span class="review-score">${stars(r.score)}</span>
        <strong style="font-family:var(--font-en);">${r.score.toFixed(1)}</strong>
        <span class="review-user">${esc(r.nickname)}さん${meta}</span>
      </div>
      ${r.title ? `<h3>${esc(r.title)}</h3>` : ''}
      <p class="review-body">${esc(r.body)}</p>
      ${foot ? `<p class="review-foot">${foot}</p>` : ''}
    </article>`;
}

/* 価格が決まっていない行（シートの価格欄が空 or 0）の呼び方。
   おすすめメニューは「カウンセリングでお見積り」、単品は場所が狭いので「お見積り」。
   同じ状態を「ご相談」と呼んでいたころは、店が README のとおり価格欄を空にしても
   ページによって別の言葉が出て、値段の付け忘れのように見えていました。
   予約ページ・予約確認ページも「お見積り」なので、そちらに揃えます。 */
function menuGroupHtml(cat) {
  const rows = cat.items.map(m => `
    <div class="menu-row">
      ${m.image ? `<img class="menu-row-photo ph-photo-opt" src="${esc(m.image)}" alt="" />` : ''}
      <div>
        <p class="menu-row-name">${esc(m.name)}</p>
        ${m.note ? `<p class="menu-row-note">${esc(m.note)}</p>` : ''}
      </div>
      <div class="menu-row-meta">
        <p class="menu-row-price">${m.price ? yen(m.price) + (m.priceFrom ? '〜' : '') : 'お見積り'}</p>
        <p class="menu-row-time">約${formatDuration(m.minutes)}</p>
      </div>
    </div>`).join('');
  return `<div class="menu-group" id="cat-${esc(cat.id)}"><h3>${esc(cat.name)}</h3>${rows}</div>`;
}

/* 口コミが1件も無いときの案内。
   架空の口コミは載せないので（景品表示法）、ここは必ず通る道です。

   「ご来店後のアンケートにご協力ください」と書いていましたが、
   アンケートは送っていません。送られてくるものを待たれると、
   いつまでも書いていただけません。書ける場所をそのまま伝えます。
   受信先を入れる前は投稿フォーム自体を出していない（initReviewForm）ので、
   そのあいだは案内も出しません。無いものを探させないためです。 */
function reviewEmptyHtml({ formHere = false } = {}) {
  if (!SALON.reservationEndpoint) {
    return '<p class="empty-state">口コミはまだ届いていません。</p>';
  }
  const where = formHere ? '下のフォーム' : '口コミページのフォーム';
  return `<p class="empty-state">口コミはまだ届いていません。<br />`
    + `ご来店いただいた方は、${where}からご感想をお聞かせください。</p>`;
}

/* トップを開いた方が最初に読む1行。
   いまトップの上半分にあるのは、英字のロゴと「ESTD 2026 — RYUGASAKI, IBARAKI」、
   そのあとに「イタリア発、東京経由。」というキャッチコピーです。
   龍ケ崎で「フェード」「白髪ぼかし」を探して流れてきた方には、
   自分向きの店かどうかがここまで読んでも分かりません。

   店が掲載名に自分で書いている「メンズカット/縮毛矯正 /白髪ぼかし」と、
   住所の市名だけを、日本語で先に出します。
   どちらも data.js にある店の言葉で、こちらで文章は作っていません。
   掲載名の書き方が変わって「」が無くなったときは、何も出しません。

   地名と専門を分けて返すのは、折り返す場所を決めるためです。
   1つの文字列にすると「茨城県龍ケ崎市｜メンズカ／ット/縮毛矯正…」のように
   語の途中で折れます（日本語はどこでも折り返せるため）。 */
function heroTaglineParts() {
  const spec = (String(SALON.fullName || '').match(/「([^」]+)」/) || [])[1] || '';
  const area = (String(SALON.address || '').match(/^.*?[市区町村]/) || [])[0] || '';
  return [area, spec].filter(Boolean);
}

/* 「ご担当」の案内。在籍人数で書き分けます。
   1名の店に「「指名なし」でご予約いただいた場合は空いているスタッフが担当」と
   書いてあると、他にも人がいるように読めます。実際は予約画面に「指名なし」が
   出ず（reserve.js）、お客様は無い選択肢を探すことになります。
   店舗情報の「スタイリスト1名（マンツーマン施術）」とも食い違います。 */
function staffNoteHtml() {
  if (SALON.staff.length === 1) {
    const s = SALON.staff[0];
    return '<b>ご担当について</b><span>当店はスタイリスト1名のマンツーマン施術です。'
      + `カウンセリングから仕上げまで、すべて${esc(s.name)}が担当いたします。`
      + (s.nominationFee > 0 ? '' : '指名料はいただきません。')
      + '</span>';
  }
  return '<b>指名について</b><span>指名料はスタイリストごとに異なります。'
    + '「指名なし」でご予約いただいた場合は、ご来店時に空いているスタッフが担当いたします。</span>';
}

/* ---------- FAQ ---------- */
function renderFaq(host) {
  if (!host) return;
  host.innerHTML = SALON.faq.map((f, i) => `
    <div class="faq-item" data-faq="${i}">
      <button class="faq-q" type="button" aria-expanded="false">${esc(f.q)}</button>
      <div class="faq-a"><span>${esc(f.a)}</span></div>
    </div>`).join('');

  bindOnce('faq', () => host.addEventListener('click', e => {
    const btn = e.target.closest('.faq-q');
    if (!btn) return;
    const item = btn.closest('.faq-item');
    const open = item.classList.toggle('is-open');
    btn.setAttribute('aria-expanded', String(open));
  }));
}

/* ---------- 店舗情報 ---------- */
function renderSalonInfo(host) {
  if (!host) return;
  const b = SALON.business;
  /* 定休日。曜日が決まっていない店で「年中無休」とだけ出すと、
     いつ行っても開いていると読まれます。この店は不定休で、出張の週は
     出勤日数が減ります。掲載の注記（closedNote）があればそれを出します。 */
  const closed = [b.closedWeekdays.map(d => WEEKDAY_JA[d] + '曜日').join('・'), b.closedNote]
    .filter(Boolean).join('\n') || '年中無休';
  const hours = `${b.openTime}〜${b.closeTime}（最終受付 ${b.lastOrder}）`
    + (b.note ? `\n※${b.note}` : '');

  /* 3つ目の要素を入れた行は、その HTML をそのまま出します（入れなければ文字のまま）。
     電話番号だけは押せるようにします。スマホ幅ではヘッダーのTEL表示が消えるので
     （style.css の .header-tel）、番号が出ているのはこの表だけです。
     文字のままだと、当日の遅れを伝えたい方が番号を選んで写す手間を踏みます。 */
  const rows = [
    ['店名', SALON.fullName || `${SALON.name} ${SALON.nameSub || ''}`.trim()],
    ['電話番号', SALON.tel,
      SALON.tel ? `<a href="tel:${esc(SALON.tel.replace(/-/g, ''))}">${esc(SALON.tel)}</a>` : ''],
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
    .map(([k, v, html]) =>
      `<tr><th>${esc(k)}</th><td>${html || esc(v).replace(/\n/g, '<br />')}</td></tr>`)
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

/* トップの「ヘアスタイル」に出す数点。

   ここは一覧ではありません。スタイルの一覧は gallery.html にあります。
   トップの節が答えるべきなのは「この店はどんな仕事をするのか」で、
   先頭から4件そのまま出すと、gallery.html の1画面目と同じものが並び、
   節が2つあるだけになります。掲載の並びが似たスタイルで始まっていると、
   4枚とも同じような髪型になることもあります。

   分類（センターパート・白髪ぼかし・スパイキーショート・パーマ）から
   1点ずつ拾って、店の幅が見えるようにします。分類が4つに満たないときは、
   残りを掲載の並びで埋めます。選んでいるだけで、内容は足していません。 */
function homeStyles(limit = 4) {
  const 出した分類 = new Set();
  const 代表 = SALON.styles.filter(s => {
    if (出した分類.has(s.length)) return false;
    出した分類.add(s.length);
    return true;
  });
  // 分類が少ない店では、そのぶんを掲載の並びから足す
  return [...new Set([...代表, ...SALON.styles])].slice(0, limit);
}

/* トップの「お客様の声」の下にあるボタンの行き先。
   口コミは0件です。それなのに「口コミをすべて見る」と書いてあると、
   押した先には「まだ届いていません」の一文しかありません。行き止まりです。
   架空の口コミは作らないと決めている（DECISIONS.md）以上、必ず通る道なので、
   件数に合わせて行き先のほうを変えます。

   投稿フォームは受信先を入れるまで出しません（initReviewForm）。
   出ていないフォームへ誘うと、また行き止まりになるので、
   そのあいだはボタン自体を出しません。 */
function renderHomeReviewLink() {
  const link = $('#home-review-link');
  if (!link) return;
  const box = link.parentElement;
  if (SALON.reviews.length) {
    link.textContent = '口コミをすべて見る';
    link.href = 'reviews.html';
    box.hidden = false;
    return;
  }
  link.textContent = 'ご感想をお寄せください';
  link.href = 'reviews.html#write';
  box.hidden = !SALON.reservationEndpoint;
}

/* ---------- ページごとの初期化 ---------- */
function initHome() {
  const _wire = () => wireImageFallbacks();

  /* 管理ページの「お知らせ」。入力されているときだけ帯を出します。
     入れても出ないと、店側は入力欄を信用しなくなります。 */
  const noticeBox = $('#shop-notice');
  if (noticeBox) {
    const text = String(SALON.notice || '').trim();
    $('#shop-notice-text').textContent = text;
    noticeBox.hidden = !text;
  }

  /* 評価は実際に集まってから出す（rating が null のあいだは表示しない）。
     隠すだけでなく、出し直すところまで両方向でやります。
     口コミがシートから届くのは最初の描画より後なので、隠す片道だけにしていたころは、
     せっかく集まった評価がトップに一生出ませんでした。 */
  const ratingBox = $('.hero-rating');
  if (ratingBox) ratingBox.hidden = !SALON.rating;
  if (SALON.rating) {
    $('#hero-score').textContent = SALON.rating.toFixed(1);
    $('#hero-stars').textContent = stars(SALON.rating);
    $('#hero-count').textContent = `口コミ ${SALON.reviewCount.toLocaleString('ja-JP')}件`;
  }
  /* トップの大きい写真。
     has-photo は「写真が読めたとき」だけ付けます（wireImageFallbacks が付ける）。
     先に付けてしまうと、写真が無いときに暗い膜と白文字だけが残り、
     地の意匠より読みにくい画面になります。

     足す前に、前に足したものを外します。この関数はシートが届くともう一度走るので、
     外さないと写真が2枚重なります。しかも古いほうが後ろに残って上に見えるため、
     店が管理ページで「メイン写真」を差し替えても、画面は古い写真のままになります。 */
  const hero = $('.hero');
  if (hero) {
    $$('.hero-photo', hero).forEach(img => img.remove());
    if (SALON.heroImage) {
      hero.insertAdjacentHTML('afterbegin',
        `<img class="hero-photo ph-photo-opt" src="${esc(SALON.heroImage)}" alt="" />`);
    }
  }

  const heroBrand = $('#hero-brand');
  /* トップの大見出しは文字ロゴのままにします。
     ロゴ画像を大きく出すと、画面の1/3がロゴ1枚で埋まり、
     「イタリア発、東京経由。」の一文まで下に押し出されます。 */
  if (heroBrand) heroBrand.innerHTML = brandLockup({ size: 'lg', logo: false });
  const tagline = $('#hero-tagline');
  if (tagline) {
    /* 区切りは前の語にくっつけます。単独の span にすると、
       「｜」だけが行のあたまに残ることがあります。 */
    const parts = heroTaglineParts();
    tagline.innerHTML = parts
      .map((t, i) => `<span>${esc(t)}${i < parts.length - 1 ? '｜' : ''}</span>`).join('');
    tagline.hidden = !parts.length;
  }
  $('#hero-catch').textContent = SALON.catch;
  $('#hero-desc').textContent = SALON.description;
  $('#lead-hours').textContent = SALON.business.minLeadHours;

  $('#hero-meta').innerHTML = [
    SALON.access || SALON.address,
    `${SALON.business.openTime}〜${SALON.business.closeTime}`,
    /* トップの一行なので、定休日の注記は先頭の語（「不定休」）だけ出します。
       ここに注記を丸ごと入れると、3行の箇条書きが1つだけ長くなって読めません。
       全文は店舗情報の表に出ています。 */
    `定休日 ${SALON.business.closedWeekdays.map(d => WEEKDAY_JA[d]).join('・')
      || String(SALON.business.closedNote || '').split(/[\s　]/)[0] || 'なし'}`
  ].filter(Boolean).map(t => `<li>◍ ${esc(t)}</li>`).join('');

  $('#home-coupons').innerHTML = SALON.coupons.slice(0, 3).map(couponCard).join('');
  $('#home-styles').innerHTML = homeStyles().map(styleCard).join('');
  bindStyleBooking();
  $('#home-staff').innerHTML = SALON.staff.map(staffCard).join('');
  $('#home-reviews').innerHTML = SALON.reviews.length
    ? SALON.reviews.slice(0, 2).map(reviewCard).join('')
    : reviewEmptyHtml();
  renderHomeReviewLink();
  renderSalonInfo($('#salon-info'));
  renderFaq($('#faq-list'));
  _wire();
}

function initMenuPage() {
  initCouponFilter();

  const tabsHost = $('#menu-tabs');
  const listHost = $('#menu-list');
  tabsHost.innerHTML = [{ id: 'all', name: 'すべて' }, ...SALON.menuCategories]
    .map((c, i) => `<button class="tab" type="button" role="tab" data-cat="${esc(c.id)}" aria-selected="${i === 0}">${esc(c.name)}</button>`)
    .join('');

  /* 描くたびに SALON.menuCategories を読み直します。
     この関数はシートが届くともう一度走りますが、タブを押したときの処理は
     bindOnce で1回しか張り直しません（張り直すと1タップが2回分になるため）。
     ここで最初の配列を覚え込んでしまうと、押したときだけ古い一覧を見にいきます。
     シートのメニューは区分のIDが別物なので、絞り込むと1件も出ず一覧が真っ白になり、
     「すべて」に戻すと店が直す前の古い料金が並びました。 */
  const draw = catId => {
    const cats = SALON.menuCategories;
    const target = catId === 'all' ? cats : cats.filter(c => c.id === catId);
    listHost.innerHTML = target.map(menuGroupHtml).join('');
    wireImageFallbacks(listHost);
  };
  draw('all');

  bindOnce('menu-tabs', () => tabsHost.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab', tabsHost).forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    draw(tab.dataset.cat);
  }));
}

/* おすすめメニューの絞り込み。
   14件あります。390pxのスマホだと、上から順に読んで単品メニューにたどり着くまでに
   3画面ぶん送ることになり、カラーだけ見たい方もパーマだけ見たい方も
   全部を通り過ぎることになります。

   絞る材料は掲載のタグ（カット・カラー・縮毛矯正…）です。店の言葉で、
   couponCard がすでに画面に出しているものと同じです。こちらでは足していません。
   シートから読んだおすすめメニューにはタグ欄が無いので、
   絞れないときはタブごと出しません（押せない箱を残さないため）。 */
function initCouponFilter() {
  const host = $('#coupon-list');
  const tabsHost = $('#coupon-tabs');
  if (!host) return;

  /* menu-tabs と同じ理由で、描くたびに SALON.coupons を読み直します。
     ここで配列を覚え込むと、タブを押したときだけ古い一覧を見にいきます。 */
  const draw = tag => {
    const list = tag === 'すべて'
      ? SALON.coupons
      : SALON.coupons.filter(c => (c.tags || []).includes(tag));
    host.innerHTML = list.map(couponCard).join('');
    wireImageFallbacks(host);
  };

  const tags = [...new Set(SALON.coupons
    .flatMap(c => (Array.isArray(c.tags) ? c.tags : []))
    .map(t => String(t).trim()).filter(Boolean))];

  if (tabsHost) {
    // タグが1種類しかなければ絞る意味がないので、そのときも出しません
    tabsHost.hidden = tags.length < 2;
    tabsHost.innerHTML = tags.length < 2 ? '' : ['すべて', ...tags]
      .map((t, i) => `<button class="tab" type="button" role="tab" data-tag="${esc(t)}" aria-selected="${i === 0}">${esc(t)}</button>`)
      .join('');
  }
  draw('すべて');

  if (!tabsHost) return;
  bindOnce('coupon-tabs', () => tabsHost.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab', tabsHost).forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    draw(tab.dataset.tag);
  }));
}

function initStaffPage() {
  $('#staff-list').innerHTML = SALON.staff.map(staffCard).join('');
  const note = $('#staff-note');
  if (note) note.innerHTML = staffNoteHtml();
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
  bindStyleBooking();

  bindOnce('style-tabs', () => tabsHost.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab', tabsHost).forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    draw(tab.dataset.len);
  }));
}

/* ---------- 口コミの投稿 ---------- */
function initReviewForm() {
  const form = $('#review-form');
  if (!form) return;

  // 受信先が無いあいだは投稿できないので、その旨だけ出す
  if (!SALON.reservationEndpoint) {
    $('#review-gate').innerHTML =
      '<b>ご案内</b><span>ご感想の投稿は、オンライン受付の準備が整い次第ご利用いただけます。</span>';
    form.hidden = true;
    return;
  }

  // 予約確認ページから来た場合は予約番号を入れておく（電話番号は入れません）
  try {
    const code = sessionStorage.getItem('salon.reviewCode');
    if (code) {
      $('#rv-code').value = code;
      sessionStorage.removeItem('salon.reviewCode');
      $('#write').scrollIntoView({ behavior: 'smooth' });
    }
  } catch (e) { /* noop */ }

  const err = $('#rv-error');
  bindOnce('review-submit', () => $('#rv-submit').addEventListener('click', async () => {
    const btn = $('#rv-submit');
    const payload = {
      code: $('#rv-code').value.trim(),
      tel: $('#rv-tel').value.trim(),
      score: Number(($('input[name="score"]:checked') || {}).value || 5),
      nickname: $('#rv-nickname').value.trim(),
      age: $('#rv-age').value,
      title: $('#rv-title').value.trim(),
      body: $('#rv-body').value.trim()
    };
    err.style.display = 'none';

    if (!payload.code || !payload.tel) {
      err.textContent = 'ご予約番号とお電話番号をご入力ください。';
      err.style.display = 'block';
      return;
    }
    if (!payload.body) {
      err.textContent = 'ご感想をご入力ください。';
      err.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = '送信中…';
    const res = await sendReview(payload);
    btn.disabled = false;
    btn.textContent = 'ご感想を送る';

    if (!res.ok) {
      err.textContent = res.error || '送信できませんでした。';
      err.style.display = 'block';
      return;
    }
    form.hidden = true;
    $('#review-gate').hidden = true;
    $('#review-thanks').hidden = false;
    renderGoogleReviewLink();
    $('#review-thanks').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

/* ご感想をいただいた直後だけ、Googleにも書いていただけないかお願いします。
   このサイトの口コミは店が下げられるので、外から見た信用にはなりません。
   信用になるのはGoogle側です（DECISIONS.md）。
   店舗情報にURLを入れていないあいだは何も出しません。 */
function renderGoogleReviewLink() {
  const host = $('#google-review');
  if (!host || !SALON.googleReviewUrl) return;
  host.innerHTML = `
    <p style="font-size:13px;color:var(--text-2);line-height:1.8;margin:20px 0 14px;">
      よろしければ、Googleにも同じ内容をお寄せいただけると励みになります。
    </p>
    <a class="btn btn-outline" href="${esc(SALON.googleReviewUrl)}" target="_blank" rel="noopener">
      Googleにクチコミを書く
    </a>`;
  host.hidden = false;
}

function initReviewsPage() {
  initReviewForm();
  $('#review-summary').innerHTML = SALON.rating
    ? `<div style="text-align:center;">
         <div class="rating-score" style="font-size:44px;">${SALON.rating.toFixed(1)}</div>
         <div class="stars" style="font-size:20px;">${stars(SALON.rating)}</div>
         ${/* --muted は12.5pxだと地に対して3.49:1しかなく、屋外では読めません */ ''}
         <p style="font-size:12.5px;color:var(--text-2);margin-top:6px;">全 ${SALON.reviewCount.toLocaleString('ja-JP')}件の口コミ</p>
       </div>`
    : '';
  $('#review-list').innerHTML = SALON.reviews.length
    ? SALON.reviews.map(reviewCard).join('')
    : (SALON.reviewCount
        ? `<p class="empty-state">${SALON.reviewCount}件の評価をいただいています。<br />個別の口コミはただいま準備中です。</p>`
        : reviewEmptyHtml({ formHere: true }));
}

/* 起動。
   まず掲載中の内容（data.js）ですぐ描き、
   スプレッドシートが届いたら描き直します。

   取得を待ってから描いていたころは、Apps Script の応答が遅いあいだ
   （久しぶりの呼び出しでは数秒かかります）トップのキャッチコピーすら
   出ませんでした。LINEから来た方が最初に見る画面が空白になります。 */
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  const init = {
    home: initHome,
    menu: initMenuPage,
    staff: initStaffPage,
    gallery: initGalleryPage,
    reviews: initReviewsPage
  }[page] || (() => {});

  init();

  Catalog.load().then(source => {
    // シートに中身があったときだけ描き直す（同じ内容で2度描かない）
    if (source === 'sheet') init();
  });
});
