export const PUBLICATION_SETTING_KEYS = Object.freeze([
  '準備中の帯', '準備中の文言',
  '電話番号', '営業開始', '営業終了', '最終受付', '定休曜日',
  '変更・キャンセル期限（何日前）', '変更・キャンセル期限（何時）',
  'キャッチコピー', 'お知らせ', '店の紹介文', 'こだわり条件',
  '住所', '地図の検索文字列', 'アクセス', '道案内', '駐車場', '支払い方法', '席数',
  'スタッフの肩書き', 'スタッフの経験年数', 'スタッフの得意分野', 'スタッフの紹介文',
  'ロゴ画像', 'スタッフ写真', 'メイン写真', 'LINE友だち追加URL', 'Google口コミURL',
  '事業者名', '代表者名', '問い合わせ先メール', 'プライバシーポリシー制定日'
]);
const STYLE_FIELDS = ['id', 'title', 'length', 'staffId', 'tags', 'detail', 'image', 'hue'];
const IMAGE_SETTINGS = ['ロゴ画像', 'スタッフ写真', 'メイン写真'];
const LINK_SETTINGS = ['LINE友だち追加URL', 'Google口コミURL'];
const SECRET_PATTERNS = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|ya29\.[a-zA-Z0-9_-]{20,})\b/];

function safeUrl(value, image) {
  if (typeof value !== 'string') return false;
  if (!value) return true;
  try {
    const url = new URL(value, 'https://publication.invalid/');
    if (url.username || url.password || url.hash) return false;
    if (value.startsWith('https://')) return true;
    return image && value.startsWith('assets/') && url.origin === 'https://publication.invalid'
      && url.pathname.startsWith('/assets/') && !url.search;
  } catch { return false; }
}

export function publicationSite(data) {
  const error = () => new Error('店舗情報・スタイル写真の公開データを確認できません。公開ファイルは変更しません。');
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.styles)
      || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) throw error();
  const settings = {};
  for (const key of PUBLICATION_SETTING_KEYS) {
    if (!Object.hasOwn(data.settings, key)) throw error();
    const value = data.settings[key];
    if (!['string', 'number', 'boolean'].includes(typeof value)
        || typeof value === 'number' && !Number.isFinite(value)) throw error();
    if ((IMAGE_SETTINGS.includes(key) && !safeUrl(value, true))
        || (LINK_SETTINGS.includes(key) && !safeUrl(value, false))) throw error();
    settings[key] = value;
  }
  const seen = new Set();
  const styles = Array.from(data.styles, style => {
    if (!style || typeof style !== 'object' || Array.isArray(style)
        || typeof style.id !== 'string' || !style.id || seen.has(style.id)
        || typeof style.title !== 'string' || !style.title.trim()
        || !['length', 'detail', 'image'].every(key => typeof style[key] === 'string')
        || !(style.staffId === null || typeof style.staffId === 'string')
        || !Array.isArray(style.tags) || !Array.from(style.tags).every(tag => typeof tag === 'string')
        || !Number.isFinite(style.hue) || style.hue < 0 || style.hue >= 360
        || !safeUrl(style.image, true)) throw error();
    seen.add(style.id);
    return Object.fromEntries(STYLE_FIELDS.map(key => [key, style[key]]));
  });
  const result = { settings, styles };
  if (SECRET_PATTERNS.some(pattern => pattern.test(JSON.stringify(result)))) throw error();
  return result;
}

export function parsePublishedMenus(source) {
  const match = source.match(/^\s*const PUBLISHED_MENUS\s*=\s*([\s\S]+);\s*$/);
  if (!match) throw new Error('公開用データの形式を確認できません。');
  return JSON.parse(match[1]);
}

export function serializePublishedMenus(data) {
  return 'const PUBLISHED_MENUS = ' + JSON.stringify(data, null, 2).replaceAll('<', '\\u003c') + ';\n';
}
