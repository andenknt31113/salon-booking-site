import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';

const execute = promisify(execFile);
const FILES = ['index.html', 'menu.html', 'staff.html', 'gallery.html', 'reviews.html',
  'assets/js/data.js', 'assets/js/published-menus.js', 'assets/js/common.js', 'assets/js/pages.js',
  'tools/public-content.mjs', 'tools/publish-menus.mjs', 'tools/publication-site.mjs'];
const HTML_FILES = ['index.html', 'menu.html', 'staff.html', 'gallery.html', 'reviews.html'];
const FAULT_MODULE = `
import fileSystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const originalWrite = fileSystem.writeFile;
const originalRename = fileSystem.rename;
const faults = JSON.parse(process.env.PUBLICATION_FAULTS);
let writeCount = 0;
let renameCount = 0;
fileSystem.writeFile = async (...args) => {
  writeCount += 1;
  if (faults.editAt === writeCount) {
    await originalWrite(new URL('./index.html', process.env.PUBLICATION_TEST_ROOT), '別の作業者による変更');
  }
  if (faults.writeAt === writeCount) throw Object.assign(new Error('模擬書込障害'), { code: 'ENOSPC' });
  return originalWrite(...args);
};
fileSystem.rename = async (...args) => {
  renameCount += 1;
  if (faults.editRenameAt === renameCount) {
    await originalWrite(new URL('./index.html', process.env.PUBLICATION_TEST_ROOT), '別の作業者による変更');
  }
  if ((faults.renameAt || []).includes(renameCount)) throw Object.assign(new Error('模擬置換障害'), { code: 'EACCES' });
  return originalRename(...args);
};
syncBuiltinESMExports();
`;

async function withPublication(run) {
  const root = await mkdtemp(join(tmpdir(), 'zer01-publication-write-'));
  try {
    for (const name of FILES) {
      const destination = join(root, name);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(new URL('../' + name, import.meta.url), destination);
    }
    const dataPath = join(root, 'assets/js/data.js');
    await writeFile(dataPath, (await readFile(dataPath, 'utf8'))
      + '\nSALON.description += " 更新の試験";\nSALON.staff[0].message += " 更新の試験";\nSALON.styles[0].title += " 更新の試験";\n');
    const publishedPath = join(root, 'assets/js/published-menus.js');
    const published = JSON.parse(vm.runInNewContext((await readFile(publishedPath, 'utf8')) + ';JSON.stringify(PUBLISHED_MENUS)'));
    published.coupons[0].price += 123;
    await writeFile(publishedPath, 'const PUBLISHED_MENUS = ' + JSON.stringify(published).replaceAll('<', '\\u003c') + ';\n');
    const preload = join(root, 'fault.mjs');
    await writeFile(preload, FAULT_MODULE);
    const command = (mode, faults = {}, endpoint = 'invalid:local-only-test') => execute(process.execPath,
      ['--import', preload, join(root, 'tools/publish-menus.mjs'), mode], {
        env: { ...process.env, RESERVATION_ENDPOINT: endpoint,
          PUBLICATION_FAULTS: JSON.stringify(faults), PUBLICATION_TEST_ROOT: pathToFileURL(root + '/').href }
      });
    const snapshot = () => Promise.all(FILES.map(name => readFile(join(root, name), 'utf8')));
    const temporaryDirectories = async () => (await readdir(root)).filter(name => name.startsWith('.publication-'));
    await run({ root, command, snapshot, temporaryDirectories });
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const writeAt of [2, 4, 8]) {
  test(`${writeAt}回目の書込が失敗しても、公開元の全ファイルを変更せず再実行できる`, async () => {
    await withPublication(async ({ command, snapshot, temporaryDirectories }) => {
      const before = await snapshot();
      await assert.rejects(command('--write-local', { writeAt }), /模擬書込障害/);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await temporaryDirectories(), []);
      await command('--write-local');
      await command('--check-local');
    });
  });
}

for (const renameAt of [2, 4]) {
  test(`${renameAt}回目の置換が失敗したら、先に置換したHTMLも元へ戻す`, async () => {
    await withPublication(async ({ command, snapshot, temporaryDirectories }) => {
      const before = await snapshot();
      await assert.rejects(command('--write-local', { renameAt: [renameAt] }), /模擬置換障害/);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await temporaryDirectories(), []);
      await command('--write-local');
      await command('--check-local');
    });
  });
}

test('別の作業者が置いた.tmpを上書き・削除せず、全ページを同じ公開データへ更新する', async () => {
  await withPublication(async ({ root, command, snapshot, temporaryDirectories }) => {
    const foreign = join(root, 'index.html.tmp');
    await writeFile(foreign, '別の作業者の一時ファイル');
    const before = await snapshot();
    await command('--write-local');
    await command('--check-local');
    const after = await snapshot();
    assert.ok(HTML_FILES.filter(name => before[FILES.indexOf(name)] !== after[FILES.indexOf(name)]).length >= 4);
    assert.equal(await readFile(foreign, 'utf8'), '別の作業者の一時ファイル');
    assert.deepEqual(await temporaryDirectories(), []);
  });
});

test('準備中に別の作業者が編集した内容を上書きせず、公開検査も失敗のままにする', async () => {
  await withPublication(async ({ root, command, snapshot, temporaryDirectories }) => {
    const before = await snapshot();
    await assert.rejects(command('--write-local', { editAt: 2 }), /変更/);
    assert.equal(await readFile(join(root, 'index.html'), 'utf8'), '別の作業者による変更');
    const after = await snapshot();
    assert.deepEqual(after.slice(1), before.slice(1));
    assert.deepEqual(await temporaryDirectories(), []);
    await assert.rejects(command('--check-local'));
  });
});

for (const renameAt of [[2, 3], [4, 5]]) {
  test(`${renameAt[0]}回目の置換と復旧が失敗しても、復旧用の元ファイルを全件残す`, async () => {
    await withPublication(async ({ root, command, snapshot, temporaryDirectories }) => {
      const before = await snapshot();
      await assert.rejects(command('--write-local', { renameAt }), /元に戻せません/);
      const directories = await temporaryDirectories();
      assert.equal(directories.length, 1);
      for (const name of HTML_FILES.filter(name => name !== 'reviews.html')) {
        assert.equal(await readFile(join(root, directories[0], 'previous', name), 'utf8'), before[FILES.indexOf(name)]);
      }
      await assert.rejects(command('--check-local'));
    });
  });
}

test('失敗後の復旧で別の作業者の編集を上書きせず、元ファイルを残す', async () => {
  await withPublication(async ({ root, command, snapshot, temporaryDirectories }) => {
    const before = await snapshot();
    await assert.rejects(command('--write-local', { renameAt: [2], editRenameAt: 2 }), /元に戻せません/);
    const after = await snapshot();
    assert.equal(after[0], '別の作業者による変更');
    assert.deepEqual(after.slice(1), before.slice(1));
    const directories = await temporaryDirectories();
    assert.equal(directories.length, 1);
    assert.equal(await readFile(join(root, directories[0], 'previous/index.html'), 'utf8'), before[0]);
  });
});

test('予約側の料金を取得しても、途中の置換失敗時は公開データとHTMLを両方戻せる', async () => {
  await withPublication(async ({ root, command, snapshot, temporaryDirectories }) => {
    const before = await snapshot();
    const published = JSON.parse(vm.runInNewContext(before[FILES.indexOf('assets/js/published-menus.js')] + ';JSON.stringify(PUBLISHED_MENUS)'));
    published.coupons[0].price += 123;
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, ...published }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = 'http://127.0.0.1:' + server.address().port;
      await assert.rejects(command('--write', { renameAt: [3] }, endpoint), /模擬置換障害/);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await temporaryDirectories(), []);
      await command('--write', {}, endpoint);
      await command('--check', {}, endpoint);
      await command('--check-local');
      const next = await readFile(join(root, 'assets/js/published-menus.js'), 'utf8');
      assert.notEqual(next, before[FILES.indexOf('assets/js/published-menus.js')]);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
