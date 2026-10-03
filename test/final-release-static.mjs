import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_ROOT = process.env.FINAL_RELEASE_ROOT
  ? resolve(process.env.FINAL_RELEASE_ROOT) : REPOSITORY_ROOT;
const LOCAL_ORIGIN = 'https://release.invalid';
const INTERNAL_PATH = /(?:^|\/)(?:test|tools|gas|node_modules|\.git|\.github)(?:\/|$)|\.md$/i;
const PRIVATE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.clasp(?:rc)?\.json(?:\..*)?|allowed-users\.json|runtime\.json)$/i;
const PUBLIC_TEXT = /(?:^assets\/.*\.(?:js|css|json)$|^[^/]+\.html$|^gas\/.*\.(?:gs|json)$)/i;
const SECRET_RULES = [
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/ },
  { name: 'OAuth token', pattern: /\bya29\.[a-zA-Z0-9_-]{20,}\b/ },
  { name: 'credential literal', pattern: /\b(?:ADMIN_PASSWORD|CLIENT_SECRET|REFRESH_TOKEN|LINE_TOKEN|PRIVATE_KEY|private_key)\b["']?\s*[:=]\s*["'][^"'\s][^"']*["']/i }
];

function directoryFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? directoryFiles(join(directory, entry.name), path) : [path];
  });
}

const releaseFiles = process.env.FINAL_RELEASE_ROOT
  ? directoryFiles(RELEASE_ROOT)
  : execFileSync('git', ['ls-files', '-z'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
const fileSet = new Set(releaseFiles);
const publicPages = releaseFiles.filter(path => /^[^/]+\.html$/i.test(path));
const source = path => readFileSync(join(RELEASE_ROOT, path), 'utf8');

function localReferences(path) {
  return [...source(path).matchAll(/<(?:a|script|link)\b[^>]*?\b(?:href|src)=["']([^"']+)["']/gi)]
    .map(match => match[1].replace(/&amp;/g, '&'));
}

function referenceUrl(path, reference) {
  return new URL(reference, `${LOCAL_ORIGIN}/${path}`);
}

function referencePath(url) {
  const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  return path.endsWith('/') || !path ? `${path}index.html` : path;
}

function scriptVersion(path, scriptPath) {
  const url = localReferences(path).map(reference => referenceUrl(path, reference))
    .find(reference => reference.origin === LOCAL_ORIGIN && referencePath(reference) === scriptPath);
  assert.ok(url, `${path}: ${scriptPath} の読込先が必要`);
  const version = url.searchParams.get('v');
  assert.ok(version, `${path}: ${scriptPath} の版番号が必要`);
  return version;
}

test('静的配信対象に内部資料・試験・GAS・端末設定を含めない', () => {
  const internalFiles = releaseFiles.filter(path => INTERNAL_PATH.test(path) || PRIVATE_PATH.test(path));
  assert.equal(internalFiles.length, 0,
    `非公開にすべき配信候補 ${internalFiles.length} 件: ${internalFiles.join(', ')}`);
});

test('公開画面・表示用データ・GASソースに既知形式の秘密を直接書かない', () => {
  const findings = [];
  for (const path of releaseFiles.filter(path => PUBLIC_TEXT.test(path))) {
    const content = source(path);
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(content)) findings.push(`${path}: ${rule.name}`);
    }
  }
  assert.equal(findings.length, 0, `秘密の形式を検出した場所: ${findings.join(', ')}`);
});

test('公開HTMLのページ・スクリプト・stylesheetのローカル参照が存在する', () => {
  assert.ok(publicPages.length > 0, '公開HTMLが必要');
  const missing = [];
  for (const path of publicPages) {
    for (const reference of localReferences(path)) {
      const url = referenceUrl(path, reference);
      if (url.origin !== LOCAL_ORIGIN) continue;
      const target = referencePath(url);
      if (!fileSet.has(target)) missing.push(`${path}: ${target}`);
    }
  }
  assert.equal(missing.length, 0, `参照先が配信対象にない: ${missing.join(', ')}`);
});

test('公開HTMLから内部資料・検証環境・placeholderへ案内しない', () => {
  const findings = [];
  for (const path of publicPages) {
    for (const reference of localReferences(path)) {
      const url = referenceUrl(path, reference);
      const target = referencePath(url);
      if (url.origin === LOCAL_ORIGIN && (INTERNAL_PATH.test(target) || PRIVATE_PATH.test(target))) {
        findings.push(`${path}: 非公開対象への参照`);
      } else if (/^(?:localhost|127\.0\.0\.1|\[::1\]|(?:.*\.)?example\.(?:com|org|net))$/i.test(url.hostname)) {
        findings.push(`${path}: 検証環境・placeholderへの参照`);
      }
    }
  }
  assert.equal(findings.length, 0, `公開導線の問題: ${findings.join(', ')}`);
});

test('Google管理入口・管理HTML・管理JSの読込版番号が一致する', () => {
  const portalVersion = scriptVersion('admin-google.html', 'assets/js/admin-portal.js');
  const adminVersion = scriptVersion('admin.html', 'assets/js/admin.js');
  const frameSource = source('assets/js/admin-portal.js')
    .match(/frame\.src\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(frameSource, '管理iframeの読込先が必要');
  const frameUrl = referenceUrl('admin-google.html', frameSource[1]);
  assert.equal(frameUrl.origin, LOCAL_ORIGIN, '管理iframeは同じ公開先を読む');
  assert.equal(referencePath(frameUrl), 'admin.html', '管理iframeは管理HTMLを読む');
  assert.equal(frameUrl.searchParams.get('google'), '1', '管理iframeはGoogle管理用の入口を使う');
  assert.equal(frameUrl.searchParams.get('v'), portalVersion, '入口JSと管理HTMLの版を揃える');
  assert.equal(adminVersion, portalVersion, '管理HTMLと管理JSの版を揃える');
  for (const file of ['admin.html', 'admin-google.html']) {
    assert.equal(scriptVersion(file, 'assets/js/admin-data.js'), adminVersion,
      '初回データの検査も両管理画面と同じ版を読む');
    assert.ok(source(file).indexOf('assets/js/admin-data.js') < source(file).indexOf(
      file === 'admin.html' ? 'assets/js/admin.js?' : 'assets/js/admin-portal.js?'),
    '初回データの検査を利用するscriptより先に読む');
  }
  assert.equal(scriptVersion('admin.html', 'assets/js/admin-publication.js'), adminVersion,
    '掲載確認も管理JSと同じ版を読む');
});
