import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { commitPublication, PUBLICATION_FILES, verifyPublicationRevision } from '../tools/commit-publication.mjs';
import { parsePublishedMenus, serializePublishedMenus } from '../tools/publication-site.mjs';
import { publicHtml } from '../tools/public-content.mjs';

const execute = promisify(execFile);
const IDENTITY = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test'];
const EXPECTED_FILES = ['assets/js/published-menus.js', 'index.html', 'reviews.html', 'menu.html',
  'staff.html', 'gallery.html', 'privacy.html', 'reserve.html', 'mypage.html', 'design-a.html'];

async function fixture(run, { realContent = false } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'zer01-publication-git-'));
  const root = join(temporary, 'checkout');
  const remote = join(temporary, 'origin.git');
  const preparedRoot = join(temporary, 'verified');
  const git = async argumentsList => (await execute('git', argumentsList, { cwd: root })).stdout.trimEnd();
  try {
    await mkdir(root);
    await execute('git', ['init', '--bare', '--initial-branch=main', remote]);
    await git(['init', '--initial-branch=main']);
    await git(['remote', 'add', 'origin', remote]);
    for (const file of [...EXPECTED_FILES, 'README.md']) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      if (realContent && file !== 'README.md') await copyFile(new URL('../' + file, import.meta.url), join(root, file));
      else await writeFile(join(root, file), 'fixture\n');
    }
    await mkdir(join(root, 'tools'));
    for (const file of ['tools/commit-publication.mjs', 'tools/public-content.mjs',
      'tools/publication-site.mjs', 'tools/publish-menus.mjs', 'assets/js/data.js', 'assets/js/common.js', 'assets/js/pages.js']) {
      await copyFile(new URL('../' + file, import.meta.url), join(root, file));
    }
    await git(['add', '.']);
    await git([...IDENTITY, 'commit', '-m', 'fixture baseline']);
    await git(['push', '-u', 'origin', 'main']);
    const base = await git(['rev-parse', 'HEAD']);
    const state = async () => ({ head: await git(['rev-parse', 'HEAD']),
      remote: await git(['ls-remote', '--heads', 'origin', 'refs/heads/main']) });
    const prepare = async () => {
      for (const file of EXPECTED_FILES) {
        await mkdir(dirname(join(preparedRoot, file)), { recursive: true });
        await copyFile(join(root, file), join(preparedRoot, file));
      }
    };
    await prepare();
    const commit = expectedBase => commitPublication({ root, expectedBase, preparedRoot });
    await run({ root, remote, temporary, git, base, state, prepare, preparedRoot, commit });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test('検証済みの公開10ファイルだけをcommitし、隔離したorigin/mainへ反映する', async () => {
  await fixture(async ({ root, git, base, state, prepare, commit }) => {
    for (const file of EXPECTED_FILES) await writeFile(join(root, file), 'updated fixture\n');
    await prepare();
    const result = await commit(base);
    assert.equal(result.changed, true);
    assert.match(result.revision, /^[a-f0-9]{40}$/);
    assert.notEqual(result.revision, base);
    assert.deepEqual((await git(['diff', '--name-only', base, 'HEAD'])).split('\n').sort(), [...EXPECTED_FILES].sort());
    assert.equal(await git(['status', '--porcelain']), '');
    assert.deepEqual(await state(), { head: result.revision, remote: result.revision + '\trefs/heads/main' });
    assert.equal(await git(['config', '--get', 'user.name']).catch(() => ''), '', '端末のGit設定を変更しない');
  });
});

test('公開対象は生成する九HTMLとデータの10件だけで、実行途中に変更できない', async () => {
  const source = await readFile(new URL('../assets/js/published-menus.js', import.meta.url), 'utf8');
  const generated = ['assets/js/published-menus.js', ...(await publicHtml(source)).map(file => file.name)];
  assert.deepEqual([...PUBLICATION_FILES].sort(), [...EXPECTED_FILES].sort());
  assert.deepEqual([...PUBLICATION_FILES].sort(), generated.sort());
  assert.equal(Object.isFrozen(PUBLICATION_FILES), true);
  assert.throws(() => PUBLICATION_FILES.push('README.md'), TypeError);
});

test('実際の公開データと九HTMLを二度同期し、cache版を含む検証済みのbyteだけを隔離originへ送る', async () => {
  await fixture(async ({ root, git, base, state, prepare, commit }) => {
    let expectedBase = base;
    const versions = new Set();
    const source = await readFile(join(root, 'assets/js/published-menus.js'), 'utf8');
    const published = parsePublishedMenus(source);
    for (const increase of [1, 2]) {
      const updated = structuredClone(published);
      updated.categories[0].items[0].price += increase;
      await writeFile(join(root, 'assets/js/published-menus.js'), serializePublishedMenus(updated));
      await execute(process.execPath, [join(root, 'tools/publish-menus.mjs'), '--write-local']);
      await execute(process.execPath, [join(root, 'tools/publish-menus.mjs'), '--check-local']);
      const content = await readFile(join(root, 'assets/js/published-menus.js'), 'utf8');
      const generated = await publicHtml(content);
      for (const file of generated) assert.equal(await readFile(join(root, file.name), 'utf8'), file.next);
      const version = generated[0].next.match(/published-menus\.js\?v=([a-f0-9]{64})/)?.[1];
      assert.ok(version);
      for (const file of generated) assert.ok(file.next.includes('published-menus.js?v=' + version));
      assert.equal(versions.has(version), false);
      versions.add(version);
      const status = (await git(['diff', '--name-only'])).split('\n').sort();
      assert.deepEqual(status, [...EXPECTED_FILES].sort());
      await prepare();
      const result = await commit(expectedBase);
      assert.equal(result.changed, true);
      assert.deepEqual((await git(['diff', '--name-only', expectedBase, result.revision])).split('\n').sort(), status);
      for (const file of EXPECTED_FILES) {
        const saved = await execute('git', ['show', result.revision + ':' + file], { cwd: root });
        assert.equal(saved.stdout, await readFile(join(root, file), 'utf8'));
      }
      assert.equal((await state()).remote, result.revision + '\trefs/heads/main');
      assert.equal(await git(['status', '--porcelain']), '');
      expectedBase = result.revision;
    }
    assert.deepEqual(await commit(expectedBase), { changed: false, revision: expectedBase });
    assert.equal(versions.size, 2);
  }, { realContent: true });
});

for (const file of ['privacy.html', 'reserve.html', 'mypage.html', 'design-a.html']) {
  test(`${file}だけのcache版更新も検査して公開し、検査後の変更はstage前に拒否する`, async () => {
    await fixture(async ({ root, git, base, state, prepare, commit }) => {
      await writeFile(join(root, file), '検査済みのcache版\n');
      await prepare();
      await writeFile(join(root, file), '検査後のcache版\n');
      const before = await state();
      await assert.rejects(commit(base), /検査した公開ファイル/);
      assert.deepEqual(await state(), before);
      assert.equal(await git(['diff', '--cached', '--name-only']), '');
      await writeFile(join(root, file), '検査済みのcache版\n');
      const result = await commit(base);
      assert.equal(result.changed, true);
      assert.equal(await git(['diff', '--name-only', base, result.revision]), file);
      assert.equal((await state()).remote, result.revision + '\trefs/heads/main');
    });
  });
}

test('同じ内容なら新しいcommitもpushも不要で元の版を返す', async () => {
  await fixture(async ({ base, state, commit }) => {
    const before = await state();
    assert.deepEqual(await commit(base), { changed: false, revision: base });
    assert.deepEqual(await state(), before);
  });
});

for (const mode of ['未追跡の資料', '別件の変更', '別件をstage', '削除', '改名', 'symlink']) {
  test(`${mode}を公開更新へ混ぜず、commit・push前に停止する`, async () => {
    await fixture(async ({ root, git, base, state, commit }) => {
      const before = await state();
      await writeFile(join(root, 'menu.html'), 'updated fixture\n');
      if (mode === '未追跡の資料') await writeFile(join(root, 'private.txt'), '残す資料\n');
      if (mode.startsWith('別件')) {
        await writeFile(join(root, 'README.md'), '別件の内容\n');
        if (mode === '別件をstage') await git(['add', 'README.md']);
      }
      if (mode === '削除') await rm(join(root, 'gallery.html'));
      if (mode === '改名') await git(['mv', 'gallery.html', 'old-gallery.html']);
      if (mode === 'symlink') {
        await rm(join(root, 'gallery.html'));
        await symlink('README.md', join(root, 'gallery.html'));
      }
      await assert.rejects(commit(base), /差分|通常ファイル/);
      assert.deepEqual(await state(), before);
      assert.ok((await git(['status', '--porcelain'])).includes('menu.html'), '修復やリセットで既存差分を消さない');
    });
  });
}

test('無効な版番号・手元の版変更・main以外のブランチを許可しない', async () => {
  await fixture(async ({ git, base, state, commit }) => {
    const before = await state();
    for (const expectedBase of [undefined, '', 'main', 'HEAD', base.slice(0, 7), '-'.repeat(40)]) {
      await assert.rejects(commit(expectedBase), /完全なcommit/);
    }
    await assert.rejects(commit('0'.repeat(40)), /手元の版/);
    await git(['checkout', '-b', 'fixture-review']);
    await assert.rejects(commit(base), /mainでだけ/);
    assert.deepEqual(await state(), before);
  });
});

test('先にorigin/mainが進んでいたら他人の変更を上書きしない', async () => {
  await fixture(async ({ root, remote, temporary, git, base, state, commit }) => {
    const other = join(temporary, 'other');
    await execute('git', ['clone', remote, other]);
    await writeFile(join(other, 'menu.html'), '先に更新した人の内容\n');
    await execute('git', ['add', 'menu.html'], { cwd: other });
    await execute('git', [...IDENTITY, 'commit', '-m', 'other writer'], { cwd: other });
    await execute('git', ['push', 'origin', 'main'], { cwd: other });
    await writeFile(join(root, 'menu.html'), '後から準備した内容\n');
    const before = await state();
    await assert.rejects(commit(base), /上書きせず/);
    assert.deepEqual(await state(), before);
    assert.equal(await git(['diff', '--cached', '--name-only']), '', '競合した差分はstageしない');
  });
});

test('push拒否を成功にせず、originの版を保持する', async () => {
  await fixture(async ({ root, remote, git, base, state, prepare, commit }) => {
    await writeFile(join(root, 'menu.html'), 'updated fixture\n');
    await prepare();
    await writeFile(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    await assert.rejects(commit(base), /Git処理に失敗/);
    const after = await state();
    assert.equal(after.remote, base + '\trefs/heads/main');
    assert.notEqual(after.head, base, '未公開のcommitができても公開完了とは扱わない');
    assert.equal(await git(['show', base + ':menu.html']), 'fixture');
  });
});

test('直下でだけ版を照合し、読取検査は差分やbranchを変更しない', async () => {
  await fixture(async ({ root, git, base, state }) => {
    await writeFile(join(root, 'menu.html'), 'updated fixture\n');
    await git(['checkout', '--detach']);
    const before = await state();
    const status = await git(['status', '--porcelain']);
    assert.equal(await verifyPublicationRevision({ root, expectedBase: base }), base);
    await assert.rejects(verifyPublicationRevision({ root: join(root, 'assets'), expectedBase: base }), /直下/);
    assert.deepEqual(await state(), before);
    assert.equal(await git(['status', '--porcelain']), status);
  });
});

test('検査後の内容変更を未検証のままstage・commit・pushしない', async () => {
  await fixture(async ({ root, git, base, state, prepare, commit }) => {
    await writeFile(join(root, 'menu.html'), '検査した内容\n');
    await prepare();
    await writeFile(join(root, 'menu.html'), '検査の後の変更\n');
    const before = await state();
    await assert.rejects(commit(base), /検査した公開ファイル/);
    assert.deepEqual(await state(), before);
    assert.equal(await git(['diff', '--cached', '--name-only']), '');
  });
});

test('検査用のファイルがsymlinkなら元の版を維持する', async () => {
  await fixture(async ({ root, base, state, preparedRoot, commit }) => {
    await writeFile(join(root, 'menu.html'), 'updated fixture\n');
    await rm(join(preparedRoot, 'menu.html'));
    await symlink(join(root, 'menu.html'), join(preparedRoot, 'menu.html'));
    const before = await state();
    await assert.rejects(commit(base), /検査済みの通常ファイル/);
    assert.deepEqual(await state(), before);
  });
});

test('ローカルのcommit hookが別件を追加してもpushしない', async () => {
  await fixture(async ({ root, base, state, prepare, commit }) => {
    await writeFile(join(root, 'menu.html'), 'updated fixture\n');
    await prepare();
    await writeFile(join(root, '.git/hooks/pre-commit'),
      '#!/bin/sh\nprintf "hookの別件\\n" > README.md\ngit add README.md\n', { mode: 0o700 });
    await assert.rejects(commit(base), /公開対象以外/);
    assert.equal((await state()).remote, base + '\trefs/heads/main');
  });
});

test('commit hookが同じ公開ファイルを変えた場合も未検証の内容をpushしない', async () => {
  await fixture(async ({ root, base, state, prepare, commit }) => {
    await writeFile(join(root, 'menu.html'), 'updated fixture\n');
    await prepare();
    await writeFile(join(root, '.git/hooks/pre-commit'),
      '#!/bin/sh\nprintf "hookの未検証変更\\n" > menu.html\ngit add menu.html\n', { mode: 0o700 });
    await assert.rejects(commit(base), /検査した内容とcommit/);
    assert.equal((await state()).remote, base + '\trefs/heads/main');
  });
});

test('最後の照合後にremoteが進んでもforce pushせず他人の版を保持する', async () => {
  await fixture(async ({ root, remote, temporary, base, state, prepare, commit }) => {
    const other = join(temporary, 'other');
    await execute('git', ['clone', remote, other]);
    await writeFile(join(other, 'README.md'), '先に反映する別件\n');
    await execute('git', ['add', 'README.md'], { cwd: other });
    await execute('git', [...IDENTITY, 'commit', '-m', 'other writer'], { cwd: other });
    const next = (await execute('git', ['rev-parse', 'HEAD'], { cwd: other })).stdout.trim();
    await writeFile(join(root, 'menu.html'), 'updated fixture\n');
    await prepare();
    await writeFile(join(root, '.git/hooks/pre-push'),
      `#!/bin/sh\ngit -C '${other}' push origin main\n`, { mode: 0o700 });
    await assert.rejects(commit(base), /Git処理に失敗/);
    assert.equal((await state()).remote, next + '\trefs/heads/main');
  });
});

test('改行なしや日本語も検査したbyteをそのままcommitする', async () => {
  await fixture(async ({ root, git, base, prepare, commit }) => {
    await writeFile(join(root, 'menu.html'), '改行なし');
    await writeFile(join(root, 'index.html'), '日本語の一行目\n二行目\n');
    await prepare();
    const result = await commit(base);
    assert.equal(result.changed, true);
    assert.equal((await execute('git', ['show', 'HEAD:menu.html'], { cwd: root })).stdout, '改行なし');
    assert.equal((await execute('git', ['show', 'HEAD:index.html'], { cwd: root })).stdout, '日本語の一行目\n二行目\n');
    assert.equal(await git(['status', '--porcelain']), '');
  });
});

test('差分検査に通らない末尾空白や余分な空行は公開を止める', async () => {
  for (const content of ['末尾空白 \n', '余分な空行\n\n']) {
    await fixture(async ({ root, base, state, prepare, commit }) => {
      await writeFile(join(root, 'menu.html'), content);
      await prepare();
      const before = await state();
      await assert.rejects(commit(base), /Git処理に失敗/);
      assert.deepEqual(await state(), before);
    });
  }
});

test('workflow外からCLIの自動commitを呼んでもGitを変更しない', async () => {
  await fixture(async ({ root, preparedRoot, base, state }) => {
    await writeFile(join(root, 'menu.html'), 'updated fixture\n');
    const before = await state();
    await assert.rejects(execute(process.execPath,
      [join(root, 'tools/commit-publication.mjs'), '--commit', base, preparedRoot], {
        env: { ...process.env, GITHUB_ACTIONS: 'false' }
      }), error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /GitHub workflow内だけ/);
        return true;
      });
    assert.deepEqual(await state(), before);
  });
});

test('CLIは検証済みの版を反映し、配信へ渡すrevisionを出力する', async () => {
  await fixture(async ({ root, temporary, preparedRoot, base, state, prepare }) => {
    await writeFile(join(root, 'menu.html'), 'updated fixture\n');
    await prepare();
    const output = join(temporary, 'step-output.txt');
    const result = await execute(process.execPath,
      [join(root, 'tools/commit-publication.mjs'), '--commit', base, preparedRoot], {
        env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output }
      });
    const after = await state();
    assert.notEqual(after.head, base);
    assert.equal(after.remote, after.head + '\trefs/heads/main');
    assert.equal(await readFile(output, 'utf8'), `changed=true\nrevision=${after.head}\n`);
    assert.match(result.stdout, /配信結果は次の処理で確認/);
  });
});
