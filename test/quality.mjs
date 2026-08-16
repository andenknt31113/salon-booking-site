/* 品質の確認
   - 構造化データ（検索結果への出方）
   - OGP（LINEやSNSに貼ったときのカード）
   - アクセシビリティ（入力欄のラベル、ボタンの名前、押しやすさ、文字の拡大）

   使い方は ユースケース.md を参照。 */
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const B = process.env.BASE || 'http://127.0.0.1:8820';
const PAGES = ['index.html', 'menu.html', 'staff.html', 'gallery.html',
               'reviews.html', 'reserve.html', 'mypage.html', 'privacy.html'];

const br = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const results = [];
function check(group, label, actual, expected) {
  const ok = String(actual) === String(expected);
  results.push({ group, label, ok, actual, expected });
  console.log(`   ${ok ? '✅' : '❌'} ${label}` + (ok ? '' : `  期待=${expected} 実際=${actual}`));
}

try {
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    /* お客様のスマホは日本時間です。この機械の時間帯のままだと、
       当日の締め切りのような「いま何時か」で変わる判定がずれます。 */
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  const p = await ctx.newPage();

  /* ---------- 構造化データ ---------- */
  console.log('\n【構造化データ】検索結果に店舗として出るための情報');
  await p.goto(B + '/index.html'); await p.waitForTimeout(1500);
  const ld = await p.evaluate(() => {
    const tag = document.querySelector('script[type="application/ld+json"]');
    if (!tag) return null;
    try { return JSON.parse(tag.textContent); } catch (e) { return 'こわれている'; }
  });
  check('LD', 'トップに入っている', !!ld && ld !== 'こわれている', true);
  check('LD', 'JSONとして読める', ld !== 'こわれている', true);
  if (ld && ld !== 'こわれている') {
    console.log('   ' + JSON.stringify(ld, null, 1).split('\n').join('\n   '));
    check('LD', '種類が美容室', ld['@type'], 'HairSalon');
    check('LD', '店名が入っている', !!ld.name, true);
    check('LD', '住所が入っている', !!(ld.address && ld.address.streetAddress), true);
    check('LD', '営業時間が入っている', /^Mo-Su \d{2}:\d{2}-\d{2}:\d{2}$/.test(ld.openingHours || ''), true);
    check('LD', 'URLが絶対パス', /^https?:\/\//.test(ld.url || ''), true);
    check('LD', '評価は口コミが無いあいだ出さない', 'aggregateRating' in ld, false);
    check('LD', '価格帯が壊れていない', /^¥[\d,]+〜¥[\d,]+$/.test(ld.priceRange || ''), true);
    /* 電話番号は「設定してあれば出す・無ければ出さない」。
       持っていない番号を書くと検索結果に嘘が載り、
       持っている番号を書かないとマップから電話できません。 */
    const telSet = await p.evaluate(() => !!SALON.tel);
    check('LD', telSet ? '電話番号を出している' : '未設定の電話番号を出していない',
      'telephone' in ld, telSet);
  }

  /* ---------- OGP ---------- */
  console.log('\n【OGP】LINEに貼ったときのカード');
  for (const page of ['index.html', 'menu.html', 'reserve.html']) {
    await p.goto(B + '/' + page); await p.waitForTimeout(900);
    const og = await p.evaluate(() => {
      const get = k => (document.querySelector(`meta[property="${k}"], meta[name="${k}"]`) || {}).content || '';
      return { title: get('og:title'), desc: get('og:description'), image: get('og:image'),
               type: get('og:type'), card: get('twitter:card'), viewport: get('viewport') };
    });
    check('OGP', `${page}: 見出しがある`, !!og.title, true);
    check('OGP', `${page}: 説明がある`, !!og.desc, true);
    check('OGP', `${page}: 画像が絶対URL`, /^https?:\/\//.test(og.image), true);
    check('OGP', `${page}: 画面幅の指定がある`, og.viewport.includes('width=device-width'), true);
  }

  /* ---------- アクセシビリティ ---------- */
  console.log('\n【操作しやすさ】');
  for (const page of PAGES) {
    await p.goto(B + '/' + page); await p.waitForTimeout(1200);
    const a11y = await p.evaluate(() => {
      const nameOf = el => (
        el.getAttribute('aria-label') ||
        (el.labels && el.labels.length ? [...el.labels].map(l => l.textContent).join('') : '') ||
        (el.closest('label') ? el.closest('label').textContent : '') ||
        el.textContent || el.value || el.title || ''
      ).trim();

      const visible = el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };

      const inputs = [...document.querySelectorAll('input, select, textarea')]
        .filter(el => el.type !== 'hidden' && visible(el));
      const buttons = [...document.querySelectorAll('button, a[href]')].filter(visible);
      const images = [...document.querySelectorAll('img')].filter(visible);

      return {
        lang: document.documentElement.lang,
        h1: document.querySelectorAll('h1').length,
        ラベルの無い入力欄: inputs.filter(el => !nameOf(el)).map(el => el.id || el.name || el.type),
        名前の無いボタン: buttons.filter(el => !nameOf(el)).map(el => el.id || el.className || el.tagName),
        altの無い画像: images.filter(el => !el.hasAttribute('alt')).map(el => el.src.split('/').pop()),
        小さすぎる操作: buttons.concat(inputs).filter(el => {
          const r = el.getBoundingClientRect();
          // カレンダーの枠は表なので別扱い
          if (el.hasAttribute('data-date')) return false;
          // ラジオ・チェックボックスの本体は隠してあり、押す対象は外側のチップ
          if (el.closest('.radio-chip, .checkbox-line')) return false;
          /* 文章の途中に置いたリンクは対象外。
             行の高さを広げると文章の行間が崩れるうえ、
             読んでいる流れの中で押すものなので押し間違えにくい。
             （WCAG 2.5.8 も文中のリンクを例外にしている） */
          if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') {
            const parentText = (el.parentElement.textContent || '').trim();
            const linkText = (el.textContent || '').trim();
            if (parentText !== linkText) return false;   // まわりに文章がある＝文中のリンク
          }
          return r.height > 0 && r.height < 32;
        }).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}(${Math.round(el.getBoundingClientRect().height)}px)`)
      };
    });
    check('A11Y', `${page}: 日本語ページと宣言している`, a11y.lang, 'ja');
    check('A11Y', `${page}: 見出しが1つ`, a11y.h1, 1);
    check('A11Y', `${page}: ラベルの無い入力欄が無い`, a11y.ラベルの無い入力欄.join(',') || 'なし', 'なし');
    check('A11Y', `${page}: 名前の無いボタンが無い`, a11y.名前の無いボタン.join(',') || 'なし', 'なし');
    check('A11Y', `${page}: altの無い画像が無い`, a11y.altの無い画像.join(',') || 'なし', 'なし');
    check('A11Y', `${page}: 小さすぎる操作が無い`,
      [...new Set(a11y.小さすぎる操作)].join(',') || 'なし', 'なし');
  }

  /* ---------- 文字を大きくしても読めるか ---------- */
  console.log('\n【文字の拡大】設定で文字を大きくしている人向け');
  const big = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2,
    timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  const bp = await big.newPage();
  for (const page of ['index.html', 'menu.html', 'reserve.html']) {
    await bp.goto(B + '/' + page); await bp.waitForTimeout(900);
    await bp.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    await bp.waitForTimeout(500);
    const w = await bp.evaluate(() => document.documentElement.scrollWidth);
    check('拡大', `${page}: 横にはみ出さない`, w <= 391, true);
  }
  await big.close();

  const ng = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(52));
  console.log(`確認 ${results.length} 項目 / 失敗 ${ng.length} 件`);
  ng.forEach(r => console.log(`  ❌ [${r.group}] ${r.label}（期待=${r.expected} 実際=${r.actual}）`));
} finally {
  await br.close();
}

if (results.some(r => !r.ok)) process.exitCode = 1;
