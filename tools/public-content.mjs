import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, ROOT), 'utf8');

export async function publicHtml(catalogSource) {
  const context = vm.createContext({ URL, document: { addEventListener() {} } });
  for (const source of [await read('assets/js/data.js'), catalogSource,
    await read('assets/js/common.js'), await read('assets/js/pages.js')]) {
    vm.runInContext(source, context);
  }
  const fragments = vm.runInContext(`(() => {
    const info = { innerHTML: '', closest() { return null; } };
    renderSalonInfo(info);
    return {
      'hero-catch': homeCatchHtml(),
      'hero-desc': esc(SALON.description),
      'home-photo': homePhotoHtml(),
      'home-styles': homeStyles().map(styleCard).join(''),
      'home-access': homeAccessHtml(),
      'home-reviews': reviewEmptyHtml(),
      'google-review': googleReviewGuideHtml(),
      'hero-tagline': heroTaglineParts().map((text, index, parts) =>
        '<span>' + esc(text) + (index < parts.length - 1 ? '｜' : '') + '</span>').join(''),
      'salon-info': info.innerHTML,
      'home-coupons': SALON.coupons.slice(0, 3).map(couponCard).join(''),
      'home-staff': SALON.staff.map(staffCard).join(''),
      'coupon-list': SALON.coupons.map(couponCard).join(''),
      'menu-list': SALON.menuCategories.map(menuGroupHtml).join(''),
      'staff-list': SALON.staff.map(staffCard).join(''),
      'style-list': SALON.styles.map(styleCard).join(''),
      'staff-note': staffNoteHtml()
    };
  })()`, context);
  const targets = {
    'index.html': { 'hero-catch': 'h1', 'hero-desc': 'p', 'home-photo': 'figure', 'home-styles': 'section', 'home-access': 'section', 'home-reviews': 'div', 'hero-tagline': 'p', 'salon-info': 'tbody', 'home-coupons': 'section', 'home-staff': 'section' },
    'reviews.html': { 'google-review': 'article' },
    'menu.html': { 'coupon-list': 'section', 'menu-list': 'section' },
    'staff.html': { 'staff-list': 'section', 'staff-note': 'aside' },
    'gallery.html': { 'style-list': 'section' }
  };
  const files = [];
  for (const [name, regions] of Object.entries(targets)) {
    const previous = await read(name);
    let next = previous;
    for (const [id, tag] of Object.entries(regions)) {
      const pattern = new RegExp('(<'+ tag +'\\b[^>]*\\bid="'+ id +'"[^>]*>)[\\s\\S]*?(</'+ tag +'>)', 'g');
      if ([...next.matchAll(pattern)].length !== 1) throw new Error(`${name} の初期表示欄 ${id} を確認できません。ファイルは更新しません。`);
      if (new RegExp('</?' + tag + '\\b', 'i').test(fragments[id])) throw new Error(`${name} の初期表示欄 ${id} の構造を確認してください。ファイルは更新しません。`);
      next = next.replace(pattern, (_match, start, end) => start + fragments[id].replace(/[\t ]+$/gm, '') + end);
    }
    files.push({ name, previous, next });
  }
  return files;
}
