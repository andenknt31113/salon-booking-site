import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PUBLICATION_PAGES } from './public-content.mjs';

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAIN_BRANCH = 'main';
export const PUBLICATION_FILES = Object.freeze(['assets/js/published-menus.js', ...PUBLICATION_PAGES]);

async function git(root, argumentsList) {
  try {
    const result = await execute('git', argumentsList, { cwd: root });
    return result.stdout.trimEnd();
  } catch (error) {
    throw new Error('公開メニューのGit処理に失敗しました。公開せず、実行記録を確認してください。', { cause: error });
  }
}

export async function verifyPublicationRevision({ root, expectedBase }) {
  if (typeof expectedBase !== 'string' || !/^[a-f0-9]{40}$/.test(expectedBase)) {
    throw new Error('開始時の完全なcommit IDが必要です。');
  }
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (await realpath(root) !== await realpath(top)) throw new Error('リポジトリ直下で実行してください。');
  if (await git(root, ['rev-parse', 'HEAD']) !== expectedBase) {
    throw new Error('開始時から手元の版が変わりました。公開を中止します。');
  }
  const remote = await git(root, ['ls-remote', '--heads', 'origin', 'refs/heads/' + MAIN_BRANCH]);
  if (remote !== expectedBase + '\trefs/heads/' + MAIN_BRANCH) {
    throw new Error('開始時からmainの公開元が変わりました。上書きせず、最新の版から再実行してください。');
  }
  return expectedBase;
}

export async function commitPublication({ root, expectedBase, preparedRoot }) {
  await verifyPublicationRevision({ root, expectedBase });
  if (await git(root, ['symbolic-ref', '--short', 'HEAD']) !== MAIN_BRANCH) {
    throw new Error('メニュー更新はmainでだけ実行できます。');
  }
  const entries = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    .split('\0').filter(Boolean);
  for (const entry of entries) {
    const file = entry.slice(3);
    if (!PUBLICATION_FILES.includes(file) || !/^[ M]{2}$/.test(entry.slice(0, 2))
        || !entry.slice(0, 2).includes('M')) {
      throw new Error('メニュー公開以外の差分があります。commit・pushせず停止します。');
    }
    const info = await lstat(join(root, file));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('通常ファイル以外は公開できません。');
  }
  if (!entries.length) return { changed: false, revision: expectedBase };
  if (!preparedRoot || await realpath(root) === await realpath(preparedRoot)) {
    throw new Error('独立した検査済みの公開ファイルが必要です。');
  }
  const fingerprint = content => createHash('sha256').update(content).digest('hex');
  const verified = new Map();
  for (const file of PUBLICATION_FILES) {
    const path = join(preparedRoot, file);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('検査済みの通常ファイルが必要です。');
    const content = await readFile(path);
    verified.set(file, fingerprint(content));
    if (fingerprint(await readFile(join(root, file))) !== verified.get(file)) {
      throw new Error('検査した公開ファイルから内容が変わりました。commit・pushせず停止します。');
    }
  }
  await git(root, ['add', '--', ...PUBLICATION_FILES]);
  const staged = (await git(root, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
  if (staged.length !== entries.length || staged.some(file => !PUBLICATION_FILES.includes(file))) {
    throw new Error('公開差分を確認できません。commit・pushせず停止します。');
  }
  await git(root, ['diff', '--cached', '--check']);
  for (const file of staged) {
    const content = await execute('git', ['show', ':' + file], { cwd: root, encoding: 'buffer' });
    if (fingerprint(content.stdout) !== verified.get(file)) throw new Error('検査した内容とstageが一致しません。');
  }
  await verifyPublicationRevision({ root, expectedBase });
  await git(root, ['-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', '予約用メニューを公開ページへ反映']);
  const revision = await git(root, ['rev-parse', 'HEAD']);
  const committed = (await git(root, ['diff', '--name-only', '-z', expectedBase, revision])).split('\0').filter(Boolean);
  if (committed.length !== staged.length || committed.some(file => !PUBLICATION_FILES.includes(file))) {
    throw new Error('commitに公開対象以外の差分があります。pushせず停止します。');
  }
  for (const file of committed) {
    const content = await execute('git', ['show', revision + ':' + file], { cwd: root, encoding: 'buffer' });
    if (fingerprint(content.stdout) !== verified.get(file)) throw new Error('検査した内容とcommitが一致しません。pushせず停止します。');
  }
  await git(root, ['push', 'origin', 'HEAD:refs/heads/' + MAIN_BRANCH]);
  await verifyPublicationRevision({ root, expectedBase: revision });
  return { changed: true, revision };
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => '') : '';
if (fileURLToPath(import.meta.url) === invoked) {
  try {
    const [mode, expectedBase, preparedRoot, ...extra] = process.argv.slice(2);
    if (extra.length || !['--check', '--commit'].includes(mode) || mode === '--check' && preparedRoot) {
      throw new Error('使い方: --check <開始時のcommit ID> / --commit <開始時のcommit ID> <検査済み公開ディレクトリ>');
    }
    if (mode === '--commit' && process.env.GITHUB_ACTIONS !== 'true') {
      throw new Error('自動commit・pushは承認済みのGitHub workflow内だけで実行してください。');
    }
    if (mode === '--check') await verifyPublicationRevision({ root: ROOT, expectedBase });
    else {
      const result = await commitPublication({ root: ROOT, expectedBase, preparedRoot });
      if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT, `changed=${result.changed}\nrevision=${result.revision}\n`);
      }
      console.log(result.changed ? '検証したメニューの版を更新しました。配信結果は次の処理で確認します。'
        : '公開用メニューは一致しています。commit・pushは行っていません。');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
