import { copyFile, mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { publicHtml } from './public-content.mjs';
import { publicationSite, parsePublishedMenus, serializePublishedMenus } from './publication-site.mjs';

const OUTPUT = new URL('../assets/js/published-menus.js', import.meta.url);
const TIMEOUT_MS = 15000;
const argumentsList = process.argv.slice(2);
const mode = argumentsList[0];
if (!['--check', '--write', '--check-local', '--write-local', '--check-site', '--write-site'].includes(mode) || argumentsList.length !== 1) {
  throw new Error('--check / --write、店舗情報・写真も含む場合は --check-site / --write-site、外部へ接続しない場合は --check-local / --write-local を指定してください。');
}
async function loadCatalog(publication = false) {
  const endpoint = process.env.RESERVATION_ENDPOINT || (await readFile(new URL('../assets/js/data.js', import.meta.url), 'utf8'))
    .match(/reservationEndpoint:\s*'([^']*)'/)?.[1];
  if (!endpoint) throw new Error('店舗設定またはRESERVATION_ENDPOINTに接続先を指定してください。');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('接続先はHTTPSで指定してください。');
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(publication ? { type: 'menu', publication: true } : { type: 'menu', booking: true }), redirect: 'manual',
    credentials: 'omit', cache: 'no-store', signal
  });
  if ([302, 303].includes(response.status)) {
    let destination;
    try {
      const location = response.headers.get('location');
      if (!location) throw new Error();
      destination = new URL(location, url);
      const local = ['127.0.0.1', 'localhost'].includes(url.hostname) && destination.origin === url.origin;
      const google = url.hostname === 'script.google.com' && destination.protocol === 'https:'
        && destination.hostname === 'script.googleusercontent.com' && destination.pathname === '/macros/echo'
        && !destination.port;
      if ((!local && !google) || destination.username || destination.password || destination.hash) throw new Error();
    } catch {
      throw new Error('メニュー応答の転送先を確認できません。公開ファイルは変更しません。');
    }
    response = await fetch(destination, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal });
  }
  if (!response.ok) throw new Error('メニューを取得できませんでした。公開ファイルは変更しません。');
  const data = await response.json();
  if (!data || data.ok !== true || !Object.hasOwn(data, 'categories') || !Object.hasOwn(data, 'coupons')) {
    throw new Error('メニュー応答が不正です。公開ファイルは変更しません。');
  }
  if (publication && (data.publicationReady !== true || !Array.isArray(data.categories)
      || !Array.isArray(data.coupons) || data.error || data.unknown || data.rejected)) {
    throw new Error('店舗情報・写真の公開用応答を確認できません。');
  }
  const list = value => {
    if (value === null) return [];
    if (!Array.isArray(value)) throw new Error('メニュー一覧の形式が不正です。');
    return value;
  };
  const seen = new Set();
  const item = (value, coupon) => {
    if (!value || typeof value.id !== 'string' || !value.id || seen.has(value.id)
        || typeof value[coupon ? 'title' : 'name'] !== 'string'
        || !value[coupon ? 'title' : 'name'].trim()
        || !Number.isFinite(Number(value.minutes)) || Number(value.minutes) <= 0
        || !Number.isFinite(Number(value.price)) || Number(value.price) < 0) {
      throw new Error('メニューのID・名前・価格・所要時間が不正です。');
    }
    seen.add(value.id);
    const keys = coupon
      ? ['id', 'title', 'badge', 'tags', 'detail', 'price', 'priceFrom', 'listPrice', 'minutes', 'terms', 'image']
      : ['id', 'name', 'price', 'priceFrom', 'minutes', 'note', 'image'];
    return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  };
  const published = {
    categories: list(data.categories).map(category => {
      if (!category || typeof category.id !== 'string' || typeof category.name !== 'string') throw new Error('メニュー分類が不正です。');
      return { id: category.id, name: category.name, items: list(category.items).map(value => item(value, false)) };
    }),
    coupons: list(data.coupons).map(value => item(value, true))
  };
  if (publication) {
    published.site = publicationSite(data);
  }
  return serializePublishedMenus(published);
}
const previous = await readFile(OUTPUT, 'utf8');
let next = mode.endsWith('-local') ? previous : await loadCatalog(mode.endsWith('-site'));
const previousData = parsePublishedMenus(previous);
if (!mode.endsWith('-site') && !mode.endsWith('-local') && previousData && Object.hasOwn(previousData, 'site')) {
  const updated = parsePublishedMenus(next);
  updated.site = publicationSite(previousData.site);
  next = serializePublishedMenus(updated);
}
const files = [{ name: 'assets/js/published-menus.js', previous, next }, ...await publicHtml(next)];
const changes = files.filter(file => file.previous !== file.next);
if (!changes.length) {
  console.log(mode.endsWith('-local') ? '初期HTMLと公開用データは一致しています。予約側への接続は行っていません。' : '公開用メニュー・初期HTMLは予約側と一致しています。');
} else if (mode.startsWith('--check')) {
  console.error('公開用データまたは初期HTMLに差分があります：' + changes.map(file => file.name).join('、'));
  process.exitCode = 1;
} else {
  const temporary = await mkdtemp(new URL('../.publication-', import.meta.url));
  const replaced = [];
  let keepBackup = false;
  try {
    for (const file of changes) {
      for (const version of ['previous', 'next']) {
        const path = join(temporary, version, file.name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file[version], 'utf8');
      }
    }
    for (const file of files) {
      if (await readFile(new URL('../' + file.name, import.meta.url), 'utf8') !== file.previous) {
        throw new Error('準備中に変更されました：' + file.name + '。更新を中止します。');
      }
    }
    for (const file of changes) {
      const destination = new URL('../' + file.name, import.meta.url);
      if (await readFile(destination, 'utf8') !== file.previous) {
        throw new Error('更新中に変更されました：' + file.name + '。更新を中止します。');
      }
      await rename(join(temporary, 'next', file.name), destination);
      replaced.push(file);
    }
  } catch (error) {
    const failed = [];
    for (const file of replaced.reverse()) {
      try {
        const destination = new URL('../' + file.name, import.meta.url);
        if (await readFile(destination, 'utf8') !== file.next) throw new Error();
        const restore = join(temporary, 'next', file.name);
        await copyFile(join(temporary, 'previous', file.name), restore);
        await rename(restore, destination);
      } catch {
        failed.push(file.name);
      }
    }
    if (failed.length) {
      keepBackup = true;
      throw new Error('元に戻せません：' + failed.join('、') + '。公開しないでください。復旧用の元ファイルは '
        + basename(temporary) + '/previous に残しています。', { cause: error });
    }
    throw error;
  } finally {
    if (!keepBackup) await rm(temporary, { recursive: true, force: true });
  }
  console.log('公開用データと初期HTMLを書き出しました。本番への公開・予約側の変更は行っていません。');
}
