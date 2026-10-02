import { copyFile, lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_FILES = ['index.html', 'gallery.html', 'menu.html', 'staff.html', 'reviews.html',
  'reserve.html', 'mypage.html', 'privacy.html', '404.html', 'admin.html', 'admin-google.html',
  'design-a.html', 'favicon.svg', 'robots.txt', 'sitemap.xml'];
const ASSET_EXTENSIONS = new Set(['.js', '.css', '.json', '.jpg', '.jpeg', '.png', '.gif', '.svg',
  '.webp', '.avif', '.woff', '.woff2', '.ttf', '.otf']);
const SECRET_PATTERNS = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|ya29\.[a-zA-Z0-9_-]{20,})\b/,
  /\b(?:ADMIN_PASSWORD|CLIENT_SECRET|REFRESH_TOKEN|LINE_TOKEN|PRIVATE_KEY|private_key)\b["']?\s*[:=]\s*["'][^"'\s][^"']*["']/i];

export async function prepareSite({ root, destination }) {
  const sourceRoot = await lstat(root);
  if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink()) throw new Error('公開元の通常ディレクトリが必要です。');
  root = resolve(root);
  destination = resolve(destination);
  if (root === destination || root.startsWith(destination + sep)) throw new Error('公開先に公開元やその親を指定できません。');
  try {
    const existing = await lstat(destination);
    if (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(destination)).length) {
      throw new Error('公開先は新しい空のディレクトリにしてください。既存の内容は変更しません。');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = [...PUBLIC_FILES];
  async function assets(directory) {
    const info = await lstat(join(root, directory));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`公開画像等の場所を確認してください: ${directory}`);
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) throw new Error(`配信できないファイル形式です: ${path}`);
      if (entry.isDirectory()) await assets(path);
      else if (entry.isFile() && ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
      else throw new Error(`配信できないファイル形式です: ${path}`);
    }
  }
  await assets('assets');
  const fileSet = new Set(files);
  for (const file of files) {
    const info = await lstat(join(root, file));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`通常ファイルではありません: ${file}`);
    if (!['.html', '.js', '.css', '.json', '.svg', '.xml', '.txt'].includes(extname(file))) continue;
    const content = await readFile(join(root, file), 'utf8');
    if (SECRET_PATTERNS.some(pattern => pattern.test(content))) throw new Error(`秘密情報の形式を検出しました: ${file}`);
    if (extname(file) !== '.html') continue;
    for (const match of content.matchAll(/<(?:a|script|link)\b[^>]*?\b(?:href|src)=["']([^"']+)["']/gi)) {
      const url = new URL(match[1].replaceAll('&amp;', '&'), `https://site.invalid/${file}`);
      if (url.origin !== 'https://site.invalid') continue;
      let path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!path || path.endsWith('/')) path += 'index.html';
      if (!fileSet.has(path)) throw new Error(`公開対象にない参照先です: ${file} → ${path}`);
    }
  }
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
  return { files: files.length, destination: relative(root, destination) || '.' };
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => '') : '';
if (fileURLToPath(import.meta.url) === invokedPath) {
  try {
    if (process.argv.length !== 3) throw new Error('使い方: node tools/prepare-site.mjs <新しい公開用ディレクトリ>');
    const result = await prepareSite({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      destination: process.argv[2] });
    console.log(`公開対象 ${result.files} ファイルをコピーしました。変換・台帳接続・公開操作は行っていません。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
