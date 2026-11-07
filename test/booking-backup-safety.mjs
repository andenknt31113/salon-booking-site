import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const SOURCE_ID = 'fixture-source-spreadsheet';
const OLD_ID = 'fixture-old-backup';
const NEW_ID = 'fixture-new-backup';
const SLOT = 'BACKUP_' + SOURCE_ID + '_日';

class FixedDate extends Date {
  constructor(...values) { super(...(values.length ? values : ['2030-01-06T12:00:00+09:00'])); }
  getDay() { return 0; }
}

function fixture(options = {}) {
  const { oldId = OLD_ID, fault = '', busy = false, onCopy, ledger = 'ready', queue = 'absent', enabled = false } = options;
  const copyId = Object.hasOwn(options, 'copyId') ? options.copyId : NEW_ID;
  const effects = [];
  const properties = new Map(oldId == null ? [] : [[SLOT, oldId]]);
  if (enabled) properties.set('BOOKING_EMAIL_QUEUE_ENABLED', 'true');
  const files = new Map([[SOURCE_ID, { trashed: false }], [OLD_ID, { trashed: false }]]);
  const sheets = new Map();
  let held = false;
  let releases = 0;
  let copies = 0;
  let propertyWrites = 0;
  const context = vm.createContext({ Date: FixedDate, console: { log() {}, warn() {}, error() {} },
    LockService: { getScriptLock: () => ({
      tryLock(timeout) {
        assert.equal(timeout, 0);
        effects.push('lock');
        if (fault === 'lock') throw new Error('架空のロック障害');
        if (busy || held) return false;
        held = true;
        return true;
      },
      releaseLock() { assert.equal(held, true); releases++; held = false; effects.push('release'); }
    }) },
    SpreadsheetApp: { getActiveSpreadsheet() {
      assert.equal(held, true);
      if (fault === 'spreadsheet') throw new Error('架空の台帳取得障害');
      return { getId: () => SOURCE_ID, getName: () => '架空予約台帳', getSheetByName: name => sheets.get(name) || null };
    } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) {
        assert.equal(held, true);
        effects.push('read:' + key);
        if (fault === 'read-before' || fault === 'read-after' && propertyWrites) throw new Error('架空の記録読込障害');
        return properties.get(key) ?? null;
      },
      setProperty(key, value) {
        assert.equal(held, true);
        effects.push('write:' + key);
        propertyWrites++;
        if (fault === 'write-before') throw new Error('架空の記録保存障害');
        if (fault !== 'discard') properties.set(key, fault === 'mismatch' ? 'fixture-wrong-pointer' : value);
        if (fault === 'write-after') throw new Error('架空の記録保存後の障害');
      }
    }) },
    DriveApp: {
      getFilesByName() { assert.fail('名前検索で別のファイルを削除対象にしない'); },
      getFileById(fileId) {
        assert.equal(held, true);
        effects.push('file:' + fileId);
        if (fault === 'source-file' && fileId === SOURCE_ID || fault === 'old-file' && fileId === oldId) {
          throw new Error('架空のファイル取得障害');
        }
        if (fileId === SOURCE_ID) return {
          makeCopy(name) {
            assert.equal(name, '架空予約台帳 バックアップ（日）');
            effects.push('copy');
            if (fault === 'copy') throw new Error('架空のコピー作成障害');
            copies++;
            if (onCopy) onCopy(context);
            if (!files.has(copyId)) files.set(copyId, { trashed: false });
            return { getId() { if (fault === 'copy-id') throw new Error('架空のコピー番号読込障害'); return copyId; } };
          }
        };
        assert.ok(files.has(fileId), '指定された控えだけを整理する');
        return { setTrashed(value) {
          assert.equal(value, true);
          effects.push('trash:' + fileId);
          if (fault === 'trash') throw new Error('架空の控え整理障害');
          files.get(fileId).trashed = true;
        } };
      }
    }
  });
  vm.runInContext(SOURCE, context);
  const headers = Array.from(vm.runInContext('HEADERS', context));
  const makeSheet = cells => ({
    getLastRow: () => cells.length,
    getLastColumn: () => Math.max(0, ...cells.map(row => row.length)),
    getRange(row, column, height = 1, width = 1) {
      return { getValues() {
        assert.equal(held, true);
        if (fault === 'ledger-read') throw new Error('架空の台帳読込障害');
        return Array.from({ length: height }, (_, offset) => Array.from({ length: width }, (_value, index) =>
          cells[row - 1 + offset]?.[column - 1 + index] ?? ''));
      } };
    }
  });
  if (ledger !== 'missing') {
    const head = ledger === 'blank' ? [''] : ledger === 'duplicate' ? [...headers, '開始']
      : ledger === 'missing-date' ? headers.filter(header => header !== '来店日') : headers;
    sheets.set('予約一覧', makeSheet(ledger === 'empty' ? [] : [head]));
  }
  if (queue !== 'absent') {
    const head = queue === 'wrong-header' ? ['通知ID', '予約照合', '不明な列'] : ['通知ID', '予約照合', '配送内容'];
    sheets.set('予約メール配送', makeSheet(queue === 'empty' ? [] : queue === 'broken-job'
      ? [head, ['fixture-broken-notification', '[]', '{broken']] : [head]));
  }
  return { context, properties, files, effects, copies: () => copies, held: () => held, releases: () => releases };
}

function assertRetained(app) {
  assert.equal(app.files.get(SOURCE_ID).trashed, false, '本体の台帳を削除しない');
  assert.equal(app.files.get(OLD_ID).trashed, false, '古い有効な控えを残す');
  assert.equal(app.effects.some(effect => effect.startsWith('trash:')), false);
  assert.equal(app.held(), false);
  assert.equal(app.releases(), 1);
}

test('新しい控えの記録を読み返して確認した後だけ、元の曜日の古い控えを整理する', () => {
  const app = fixture();
  app.properties.set('BACKUP_' + SOURCE_ID + '_月', 'fixture-monday-backup');
  app.properties.set('BACKUP_fixture-other-spreadsheet_日', 'fixture-other-backup');
  app.context.dailyBackup();
  assert.equal(app.properties.get(SLOT), NEW_ID);
  assert.equal(app.copies(), 1);
  const write = app.effects.indexOf('write:' + SLOT);
  const confirmation = app.effects.indexOf('read:' + SLOT, write + 1);
  const trash = app.effects.indexOf('trash:' + OLD_ID);
  assert.ok(write > app.effects.indexOf('copy'));
  assert.ok(confirmation > write && confirmation < trash, '保存結果を確認する前に古い控えを削除しない');
  assert.equal(app.properties.get('BACKUP_' + SOURCE_ID + '_月'), 'fixture-monday-backup');
  assert.equal(app.properties.get('BACKUP_fixture-other-spreadsheet_日'), 'fixture-other-backup');
  assert.equal(app.files.get(OLD_ID).trashed, true);
  assert.equal(app.files.get(NEW_ID).trashed, false);
  assert.equal(app.files.get(SOURCE_ID).trashed, false);
  assert.equal(app.held(), false);
  assert.equal(app.releases(), 1);
});

for (const fault of ['discard', 'mismatch', 'read-after']) {
  test(`新しい控えの記録が${fault}なら成功で終わらず、古い控えを削除しない`, () => {
    const app = fixture({ fault });
    assert.throws(() => app.context.dailyBackup(), /記録.*確認できません|記録読込障害/);
    assert.equal(app.copies(), 1);
    assert.equal(app.files.get(NEW_ID).trashed, false, '確認できない新しい控えも勝手に削除しない');
    assertRetained(app);
  });
}

for (const copyId of ['', ' ', null, undefined, 0, {}, SOURCE_ID]) {
  test(`コピー番号が${JSON.stringify(copyId)}なら誤った復元先を記録せず、古い控えを残す`, () => {
    const app = fixture({ copyId });
    assert.throws(() => app.context.dailyBackup(), /バックアップ.*確認できません/);
    assert.equal(app.properties.get(SLOT), OLD_ID);
    assert.equal(app.effects.some(effect => effect.startsWith('write:')), false);
    assertRetained(app);
  });
}

for (const fault of ['spreadsheet', 'read-before', 'source-file', 'copy', 'copy-id', 'write-before', 'write-after']) {
  test(`${fault}の障害は握りつぶさず、古い控えと本体を残してロックを解放する`, () => {
    const app = fixture({ fault });
    assert.throws(() => app.context.dailyBackup(), /架空の/);
    if (fault !== 'write-after') assert.equal(app.properties.get(SLOT), OLD_ID);
    else assert.equal(app.properties.get(SLOT), NEW_ID);
    assertRetained(app);
  });
}

for (const oldId of [null, SOURCE_ID, NEW_ID]) {
  test(`以前の番号が${oldId}でも本体や新しい控えをゴミ箱へ送らない`, () => {
    const app = fixture({ oldId });
    app.context.dailyBackup();
    assert.equal(app.properties.get(SLOT), NEW_ID);
    assert.equal(app.copies(), 1);
    assertRetained(app);
  });
}

for (const fault of ['old-file', 'trash']) {
  test(`古い控えの${fault}で失敗しても、確認済みの新しい控えの記録を巻き戻さない`, () => {
    const app = fixture({ fault });
    assert.throws(() => app.context.dailyBackup(), /架空の/);
    assert.equal(app.properties.get(SLOT), NEW_ID);
    assert.equal(app.files.get(NEW_ID).trashed, false);
    assert.equal(app.files.get(SOURCE_ID).trashed, false);
    assert.equal(app.held(), false);
    assert.equal(app.releases(), 1);
  });
}

for (const options of [{ busy: true }, { fault: 'lock' }]) {
  test(`ロックを取れない${JSON.stringify(options)}ではコピー・記録・削除も解放も行わない`, () => {
    const app = fixture(options);
    assert.throws(() => app.context.dailyBackup());
    assert.deepEqual(app.effects, ['lock']);
    assert.equal(app.properties.get(SLOT), OLD_ID);
    assert.equal(app.held(), false);
    assert.equal(app.releases(), 0);
  });
}

test('コピー処理中の別のバックアップは同じロックへ入れず、一部だけを二重に整理しない', () => {
  const app = fixture({ onCopy: context => assert.throws(() => context.dailyBackup(), /処理中/) });
  app.context.dailyBackup();
  assert.equal(app.copies(), 1);
  assert.equal(app.effects.filter(effect => effect.startsWith('trash:')).length, 1);
  assert.equal(app.properties.get(SLOT), NEW_ID);
  assert.equal(app.files.get(SOURCE_ID).trashed, false);
  assert.equal(app.held(), false);
  assert.equal(app.releases(), 1);
});

for (const ledger of ['missing', 'empty', 'blank', 'duplicate', 'missing-date']) {
  test(`予約台帳が${ledger}なら壊れた写しで有効な控えを置き換えない`, () => {
    const app = fixture({ ledger });
    assert.throws(() => app.context.dailyBackup(), /台帳|バックアップ/);
    assert.equal(app.properties.get(SLOT), OLD_ID);
    assert.equal(app.copies(), 0);
    assertRetained(app);
  });
}

for (const queue of ['absent', 'empty', 'wrong-header', 'broken-job']) {
  test(`配送が有効で記録が${queue}なら復旧に必要な控えを捨てない`, () => {
    const app = fixture({ enabled: true, queue });
    assert.throws(() => app.context.dailyBackup(), /配送|バックアップ/);
    assert.equal(app.properties.get(SLOT), OLD_ID);
    assert.equal(app.copies(), 0);
    assertRetained(app);
  });
}

test('配送を止めていても壊れた配送記録を正常なバックアップへ繰り上げない', () => {
  const app = fixture({ queue: 'broken-job' });
  assert.throws(() => app.context.dailyBackup(), /配送|バックアップ/);
  assert.equal(app.copies(), 0);
  assertRetained(app);
});

test('台帳読込の失敗は古い控えを保持し、台帳を初期化せずに終わる', () => {
  const app = fixture({ fault: 'ledger-read' });
  assert.throws(() => app.context.dailyBackup(), /台帳読込障害/);
  assert.equal(app.copies(), 0);
  assertRetained(app);
});

for (const enabled of [false, true]) {
  test(`見出しだけの正常な空台帳と配送記録はenabled=${enabled}でも控えを更新できる`, () => {
    const app = fixture({ enabled, queue: 'ready' });
    app.context.dailyBackup();
    assert.equal(app.copies(), 1);
    assert.equal(app.files.get(OLD_ID).trashed, true);
    assert.equal(app.properties.get(SLOT), NEW_ID);
    assert.equal(app.held(), false);
  });
}
