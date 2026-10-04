import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const MOCK_KEYS = ['MOCK_ADMIN_PASSWORD', 'MOCK_ADMIN_TOKEN'];
const EXCLUDED_ENV = [...MOCK_KEYS, 'GAS_SOURCE', 'GAS_BASELINE_SOURCE', 'ADMIN_SOURCE',
  'ADMIN_BASELINE_SOURCE', 'BASE', 'ADMIN_PW', 'TEST_BROWSER', 'TEST_SCREENSHOT_DIR',
  'SCREENSHOT_DIR', 'TEST_ARTIFACT_DIR', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS'];

export async function verifyLocalChecks({ root, checks, output = process.stdout, serial = false }) {
  if (!Array.isArray(checks) || !checks.length || new Set(checks).size !== checks.length
      || checks.some(file => typeof file !== 'string' || !/^test\/[a-z0-9-]+\.mjs$/.test(file))) {
    throw new Error('検証対象には重複のない test/*.mjs の通常ファイルを指定してください');
  }
  const testDirectory = await lstat(join(root, 'test')).catch(() => null);
  if (!testDirectory?.isDirectory() || testDirectory.isSymbolicLink()) throw new Error('検証対象の通常ディレクトリがありません: test');
  for (const file of checks) {
    const entry = await lstat(join(root, file)).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error(`検証対象の通常ファイルがありません: ${file}`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'zer01-booking-check-'));
  const secrets = MOCK_KEYS.map(() => randomBytes(32).toString('hex'));
  const environment = { ...process.env };
  for (const key of EXCLUDED_ENV) delete environment[key];
  const counts = {};
  try {
    const envFile = join(directory, '.env');
    await writeFile(envFile, MOCK_KEYS.map((key, index) => `${key}=${secrets[index]}`).join('\n') + '\n', { mode: 0o600 });
    const task = spawn(process.execPath, [`--env-file=${envFile}`, '--test', '--test-reporter=tap',
      ...(serial ? ['--test-concurrency=1'] : []), ...checks], {
      cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe']
    });
    const completed = new Promise((resolveResult, reject) => {
      task.once('error', reject);
      task.once('close', code => resolveResult(code ?? 1));
    });
    const copy = async (input, summary) => {
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        const safe = secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), line);
        output.write(safe + '\n');
        const match = summary && safe.match(/^# (tests|pass|fail) (\d+)$/);
        if (match) counts[match[1]] = Number(match[2]);
      }
    };
    const [exitCode] = await Promise.all([completed, copy(task.stdout, true), copy(task.stderr, false)]);
    const succeeded = exitCode === 0 && counts.tests > 0 && counts.pass === counts.tests && counts.fail === 0;
    return { exitCode: succeeded ? 0 : exitCode || 1, ...counts };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
