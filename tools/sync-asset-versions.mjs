// お客様向けHTMLのJS・CSS読込URLへ、ファイル内容から作った版を付ける。外部へ接続しない。
//   node tools/sync-asset-versions.mjs --check   ずれがあれば一覧を出して終了コード1
//   node tools/sync-asset-versions.mjs --write   ずれているHTMLだけを書き換える
// メニュー・店舗情報の初期表示は変えない。それは tools/publish-menus.mjs の担当。
import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { syncAssetVersions } from './public-content.mjs';

const ROOT = new URL('../', import.meta.url);
// 管理画面は、入口・管理HTML・管理JSを一つの版で揃えて読む設計（iframeのURLにも同じ版を書く）。
// 内容hashでは揃えられないため対象外。版の一致は test/final-release-static.mjs が検査する。
export const MANUAL_VERSION_PAGES = Object.freeze(['admin.html', 'admin-google.html']);

export async function staleAssetVersions(root = ROOT) {
  const readAsset = name => readFile(new URL(name, root), 'utf8');
  const stale = [];
  for (const name of (await readdir(root)).filter(file => file.endsWith('.html')
      && !MANUAL_VERSION_PAGES.includes(file)).sort()) {
    const previous = await readAsset(name);
    const next = await syncAssetVersions(previous, readAsset);
    if (next !== previous) stale.push({ name, next });
  }
  return stale;
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => '') : '';
if (fileURLToPath(import.meta.url) === invokedPath) {
  const mode = process.argv[2];
  if (!['--check', '--write'].includes(mode) || process.argv.length !== 3) {
    console.error('--check または --write を指定してください。');
    process.exitCode = 1;
  } else {
    const stale = await staleAssetVersions();
    if (!stale.length) console.log('お客様向けHTMLの読込URLは、JS・CSSの現在の内容と一致しています。');
    else if (mode === '--check') {
      console.error('JS・CSSの内容と読込URLの版がずれています：' + stale.map(file => file.name).join('、')
        + '。node tools/sync-asset-versions.mjs --write で揃えてください。');
      process.exitCode = 1;
    } else {
      for (const file of stale) await writeFile(new URL(file.name, ROOT), file.next, 'utf8');
      console.log('読込URLの版を揃えました：' + stale.map(file => file.name).join('、') + '。公開・commitは行っていません。');
    }
  }
}
