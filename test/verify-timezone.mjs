import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { BACKEND_TIME_ZONE, verifyLocalChecks } from '../tools/verify-local.mjs';

const JST_OFFSET_MINUTES = -540;

test('検査の時刻帯は受け口の設定と同じにする', async () => {
  const manifest = JSON.parse(await readFile(new URL('../gas/appsscript.json', import.meta.url), 'utf8'));
  assert.equal(BACKEND_TIME_ZONE, manifest.timeZone);
});

for (const parentZone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
  test(`実行する機械が${parentZone}でも、子の検査は受け口と同じ時刻帯で動く`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'zer01-verify-timezone-'));
    const previous = process.env.TZ;
    t.after(async () => {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(root, 'test'));
    await writeFile(join(root, 'test/zone.mjs'), `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('zone', () => {
  assert.equal(process.env.TZ, ${JSON.stringify(BACKEND_TIME_ZONE)});
  assert.equal(new Date(2026, 10, 12, 0, 30).getTimezoneOffset(), ${JST_OFFSET_MINUTES});
  // 日本時間の深夜（UTCでは前日）でも、当日の0時は現在より前になる。
  assert.ok(new Date(2026, 10, 12).getTime() < Date.UTC(2026, 10, 11, 15, 30));
});
`);
    process.env.TZ = parentZone;
    const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const result = await verifyLocalChecks({ root, checks: ['test/zone.mjs'], output });
    assert.equal(result.exitCode, 0);
    assert.equal(result.fail, 0);
    assert.equal(result.pass, 1);
  });
}
