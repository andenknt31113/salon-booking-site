// 公開サイトの外形監視。読取だけを行い、予約・取消・管理保存・メール送信はしない。
// 使い方と止め方は tools/monitor-site.md を参照。
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);

// 1回の取得を待つ上限。GitHub Pages の通常応答は1秒未満なので、遅延の検出も兼ねる。
export const PAGE_TIMEOUT_MS = 15000;
// GAS は起動直後に30秒前後かかった記録があるため、ページより長く待つ。
export const BACKEND_TIMEOUT_MS = 45000;
// 一時的な通信失敗で通知を出さないための再試行回数（初回を含む）。
export const MAX_ATTEMPTS = 2;
export const RETRY_INTERVAL_MS = 3000;
// これより小さいHTMLは、エラーページや空ページとして扱う。
export const MIN_PAGE_BYTES = 500;
// 公開してはいけない内部ファイル。配信の境界が崩れたら検出する。
export const PRIVATE_PATHS = Object.freeze(['HANDOFF.md', 'README.md', 'gas/Code.gs', 'test/backend.mjs',
  'tools/prepare-site.mjs', '.clasp.json']);
// サイトマップに載せない公開ページ。予約確認と管理の入口が開けることも確認する。
export const EXTRA_PAGES = Object.freeze(['mypage.html', 'admin-google.html']);
const ENDPOINT_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/;

export function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(match => match[1]);
}

export function assetUrls(html, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const urls = new Set();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/gi)) {
    const url = new URL(match[1].replaceAll('&amp;', '&'), pageUrl);
    if (url.origin === origin && /\.(?:js|css)$/.test(url.pathname)) urls.add(url.href);
  }
  return [...urls];
}

async function attempt(fetchImpl, url, options, timeoutMs, wait) {
  let last = { status: 0, body: '', error: 'no-attempt' };
  for (let count = 1; count <= MAX_ATTEMPTS; count++) {
    try {
      const response = await fetchImpl(url, { ...options, cache: 'no-store', redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs) });
      last = { status: response.status, body: await response.text(), error: '' };
      // 404 は配信の境界確認で期待する結果なので、再試行せず返す。
      if (response.status < 500) return last;
    } catch (error) {
      last = { status: 0, body: '', error: error.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
    if (count < MAX_ATTEMPTS) await wait(RETRY_INTERVAL_MS);
  }
  return last;
}

export async function runMonitor({ fetchImpl = fetch, sitemapXml, checkBackend = false,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const failures = [];
  const fail = (target, reason) => failures.push({ target, reason });
  const pages = sitemapUrls(sitemapXml);
  if (!pages.length) {
    fail('sitemap.xml', 'no-pages');
    return { ok: false, pages: 0, assets: 0, privatePaths: 0, backend: 'skipped', failures };
  }
  const base = pages.find(url => url.endsWith('/')) || new URL('./', pages[0]).href;
  for (const name of EXTRA_PAGES) pages.push(new URL(name, base).href);

  const assets = new Set();
  let dataSource = '';
  for (const url of pages) {
    const result = await attempt(fetchImpl, url, {}, PAGE_TIMEOUT_MS, wait);
    if (result.status !== 200) { fail(url, result.error || 'http-' + result.status); continue; }
    if (result.body.length < MIN_PAGE_BYTES || !/<\/html>\s*$/i.test(result.body)) { fail(url, 'incomplete-html'); continue; }
    for (const asset of assetUrls(result.body, url)) assets.add(asset);
  }
  for (const url of assets) {
    const result = await attempt(fetchImpl, url, {}, PAGE_TIMEOUT_MS, wait);
    if (result.status !== 200) fail(url, result.error || 'http-' + result.status);
    else if (!result.body.length) fail(url, 'empty-asset');
    else if (new URL(url).pathname.endsWith('/assets/js/data.js')) dataSource = result.body;
  }
  for (const path of PRIVATE_PATHS) {
    const url = new URL(path, base).href;
    const result = await attempt(fetchImpl, url, {}, PAGE_TIMEOUT_MS, wait);
    if (result.status === 200) fail(url, 'private-file-exposed');
    else if (result.status !== 404) fail(url, result.error || 'http-' + result.status);
  }

  let backend = 'skipped';
  if (checkBackend) {
    backend = 'failed';
    const endpoint = dataSource.match(/reservationEndpoint:\s*'([^']+)'/)?.[1] || '';
    if (!ENDPOINT_PATTERN.test(endpoint)) fail('booking-backend', 'endpoint-not-found');
    else {
      // 予約画面が最初に送るのと同じ読取。接続先のURLと応答本文は出力しない。
      const result = await attempt(fetchImpl, endpoint, { method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ type: 'menu', booking: true, initialAvailability: false }) }, BACKEND_TIMEOUT_MS, wait);
      let ok = false;
      try { ok = result.status === 200 && JSON.parse(result.body).ok === true; } catch {}
      if (ok) backend = 'ok';
      else fail('booking-backend', result.error || (result.status === 200 ? 'invalid-response' : 'http-' + result.status));
    }
  }
  return { ok: failures.length === 0, pages: pages.length, assets: assets.size,
    privatePaths: PRIVATE_PATHS.length, backend, failures };
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => '') : '';
if (fileURLToPath(import.meta.url) === invokedPath) {
  const summary = await runMonitor({ sitemapXml: await readFile(new URL('sitemap.xml', ROOT), 'utf8'),
    checkBackend: process.env.MONITOR_BACKEND_READ === 'true' });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}
