const A_STYLE_COUNT = 3;
const A_MENU_COUNT = 4;

function aText(selector, value) {
  document.querySelector(selector).textContent = value || '';
}

function aPrice(menu) {
  return menu.price == null ? 'お見積り' : `¥${Number(menu.price).toLocaleString('ja-JP')}${menu.priceFrom ? '〜' : ''}`;
}

function aImagePath(value) {
  return typeof value === 'string' && /^assets\/[\w./-]+$/.test(value) && !value.includes('..') ? value : '';
}

function aMenu(menu) {
  const row = document.createElement('article');
  row.className = 'menu-item';
  const title = document.createElement('h3');
  title.textContent = menu.title || menu.name;
  const price = document.createElement('p');
  price.className = 'menu-price';
  price.textContent = aPrice(menu);
  const note = document.createElement('p');
  note.className = 'menu-note';
  note.textContent = [menu.target, menu.condition, menu.description].filter(Boolean).join(' ／ ');
  row.append(title, price, note);
  return row;
}

aText('#catch', SALON.catch);
aText('#description', SALON.description);
aText('#address', SALON.address);
aText('#access-text', SALON.access);
aText('#directions', SALON.directions);
const aStaff = SALON.staff[0];
if (aStaff) {
  aText('#owner-name', aStaff.name);
  aText('#owner-role', aStaff.role);
  aText('#owner-message', aStaff.message);
  document.querySelector('#owner-image').src = aImagePath(aStaff.image) || 'assets/staff-matteo.jpg';
  document.querySelector('#owner-image').alt = aStaff.name;
}
const aHero = aImagePath(SALON.heroImage);
if (aHero) document.querySelector('#hero-image').src = aHero;
const aDialog = document.querySelector('#photo-dialog');
SALON.styles.forEach((style, index) => {
  const source = aImagePath(style.image);
  if (!source) return;
  const figure = document.createElement('figure');
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', `${style.title}を大きく見る`);
  const photo = document.createElement('img');
  photo.src = source;
  photo.alt = style.title;
  photo.loading = 'lazy';
  photo.width = 600;
  photo.height = 800;
  const caption = document.createElement('figcaption');
  caption.textContent = style.title;
  button.append(photo);
  figure.append(button, caption);
  button.addEventListener('click', () => {
    document.querySelector('#photo-full').src = source;
    document.querySelector('#photo-full').alt = style.title;
    aText('#photo-caption', style.title);
    aDialog.showModal();
  });
  document.querySelector(index < A_STYLE_COUNT ? '#style-grid' : '#more-styles').append(figure);
});
document.querySelector('.more-styles').hidden = !document.querySelector('#more-styles').children.length;
document.querySelector('#photo-close').addEventListener('click', () => aDialog.close());
const aMenus = typeof PUBLISHED_MENUS !== 'undefined' && PUBLISHED_MENUS
  ? PUBLISHED_MENUS : { coupons: SALON.coupons, categories: SALON.menuCategories };
aMenus.coupons.forEach((menu, index) => document.querySelector(index < A_MENU_COUNT ? '#menu-list' : '#more-menus').append(aMenu(menu)));
document.querySelector('.menu-more').hidden = aMenus.coupons.length <= A_MENU_COUNT;
if (!aMenus.coupons.length) aText('#menu-list', '掲載メニューを確認中です。');
aMenus.categories.forEach(category => {
  const heading = document.createElement('h3');
  heading.className = 'menu-category';
  heading.textContent = category.name;
  document.querySelector('#single-menus').append(heading, ...category.items.map(aMenu));
});
[
  ['営業時間', SALON.business.note], ['定休日', SALON.business.closedNote],
  ['駐車場', SALON.parking], ['お支払い', SALON.payment], ['電話', SALON.tel]
].filter(([, value]) => value).forEach(([label, value]) => {
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  document.querySelector('#facts').append(term, detail);
});
