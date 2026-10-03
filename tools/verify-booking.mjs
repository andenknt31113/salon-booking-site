import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_KEYS = ['MOCK_ADMIN_PASSWORD', 'MOCK_ADMIN_TOKEN'];
export const BOOKING_CHECKS = Object.freeze([
  'final-backend-boundaries', 'booking-change-recovery', 'booking-ledger-schema',
  'booking-overlap-reads', 'booking-reserve-reads', 'booking-reserve-ack',
  'booking-cancel-ack', 'booking-cancel-conflict', 'admin-auth-boundary',
  'admin-legacy-preflight', 'phone-request-identity', 'phone-booking-ack',
  'booking-write-settings', 'booking-operation-settings', 'admin-note-ack',
  'admin-upload-lock', 'closed-save-validation'
].map(name => `test/${name}.mjs`));

export async function verifyBooking({ root = ROOT, output = process.stdout } = {}) {
  const testDirectory = await lstat(join(root, 'test')).catch(() => null);
  if (!testDirectory?.isDirectory() || testDirectory.isSymbolicLink()) throw new Error('検証対象の通常ディレクトリがありません: test');
  for (const file of BOOKING_CHECKS) {
    const entry = await lstat(join(root, file)).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error(`検証対象の通常ファイルがありません: ${file}`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'zer01-booking-check-'));
  const secrets = MOCK_KEYS.map(() => randomBytes(32).toString('hex'));
  const environment = { ...process.env };
  for (const key of [...MOCK_KEYS, 'GAS_SOURCE', 'GAS_BASELINE_SOURCE', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete environment[key];
  const counts = {};
  try {
    const envFile = join(directory, '.env');
    await writeFile(envFile, MOCK_KEYS.map((key, index) => `${key}=${secrets[index]}`).join('\n') + '\n', { mode: 0o600 });
    const task = spawn(process.execPath, [`--env-file=${envFile}`, '--test', '--test-reporter=tap', ...BOOKING_CHECKS], {
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

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => '') : '';
if (fileURLToPath(import.meta.url) === invoked) {
  try {
    if (process.argv.length !== 2) throw new Error('使い方: node tools/verify-booking.mjs');
    const result = await verifyBooking();
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
