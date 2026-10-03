import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const FILES = ['index.html', 'menu.html', 'staff.html', 'gallery.html', 'reviews.html',
  'assets/js/data.js', 'assets/js/published-menus.js', 'assets/js/common.js', 'assets/js/pages.js',
  'tools/public-content.mjs', 'tools/publish-menus.mjs'];
const GENERATED_FILES = ['assets/js/published-menus.js', 'index.html', 'menu.html', 'staff.html', 'gallery.html', 'reviews.html'];

async function withPublication(run) {
  const root = await mkdtemp(join(tmpdir(), 'zer01-publication-gate-'));
  try {
    for (const name of FILES) {
      const destination = join(root, name);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(new URL('../' + name, import.meta.url), destination);
    }
    const command = mode => execute(process.execPath, [join(root, 'tools/publish-menus.mjs'), mode], {
      env: { ...process.env, RESERVATION_ENDPOINT: 'invalid:local-only-test' }
    });
    const snapshot = () => Promise.all(GENERATED_FILES.map(name => readFile(join(root, name), 'utf8')));
    await run({ root, command, snapshot });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('揃った公開データと初期HTMLはAPI接続なしで検査でき、見出しや予約先を変更しない', async () => {
  await withPublication(async ({ root, command, snapshot }) => {
    const before = await snapshot();
    await command('--check-local');
    await command('--write-local');
    assert.deepEqual(await snapshot(), before);
    const home = await readFile(join(root, 'index.html'), 'utf8');
    assert.ok(home.includes('<h2 class="section-title">口コミ</h2>'));
    assert.ok(home.includes('href="reviews.html"'));
    assert.ok(home.includes('href="reserve.html'));
  });
});

for (const [name, region] of [['index.html', 'hero-desc'], ['menu.html', 'coupon-list'],
  ['staff.html', 'staff-note'], ['gallery.html', 'style-list'], ['reviews.html', 'google-review']]) {
  test(`${name}の初期表示だけが古ければ公開検査を止め、ローカル修復後だけ通す`, async () => {
    await withPublication(async ({ root, command, snapshot }) => {
      const path = join(root, name);
      const original = await readFile(path, 'utf8');
      const pattern = new RegExp('(id="' + region + '"[^>]*>)');
      assert.ok(pattern.test(original));
      await writeFile(path, original.replace(pattern, '$1同期試験の古い内容'), 'utf8');
      const stale = await snapshot();
      await assert.rejects(command('--check-local'), error => {
        assert.equal(error.code, 1);
        assert.ok(error.stderr.includes(name));
        return true;
      });
      assert.deepEqual(await snapshot(), stale, '検査は古いファイルも勝手に変更しない');
      await command('--write-local');
      assert.equal(await readFile(path, 'utf8'), original);
      await command('--check-local');
      assert.deepEqual(await snapshot(), stale.map((value, index) => GENERATED_FILES[index] === name ? original : value));
    });
  });
}

for (const duplicate of [false, true]) {
  test(`更新する領域が${duplicate ? '重複' : '欠落'}している場合は、他のHTMLやデータも変更しない`, async () => {
    await withPublication(async ({ root, command, snapshot }) => {
      const path = join(root, 'menu.html');
      const html = await readFile(path, 'utf8');
      const invalid = duplicate ? html.replace('</main>', '<section id="menu-list"></section></main>')
        : html.replace('id="menu-list"', 'id="missing-list"');
      assert.notEqual(invalid, html);
      await writeFile(path, invalid, 'utf8');
      const homePath = join(root, 'index.html');
      await writeFile(homePath, (await readFile(homePath, 'utf8')).replace('id="hero-desc">', 'id="hero-desc">古い紹介'), 'utf8');
      const before = await snapshot();
      await assert.rejects(command('--write-local'), /初期表示欄/);
      assert.deepEqual(await snapshot(), before);
    });
  });
}
