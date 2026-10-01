import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const SOURCE = readFileSync(process.env.GAS_SOURCE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
const IMAGE = { mimeType: 'image/png', slot: 'salon-main', dataBase64: 'aW1hZ2U=' };

function fixture({ denied = false, unavailable = false, missingFolder = false, failure = '', legacy = false,
  duringUpload = null } = {}) {
  const events = [];
  const password = randomUUID();
  let held = false;
  let files = 0;
  let responseDuringUpload;
  const properties = { ADMIN_GOOGLE_ONLY: legacy ? 'false' : 'true', ADMIN_PASSWORD: password };
  const file = {
    setSharing(access, permission) {
      assert.equal(held, legacy, '画像共有中はGoogle管理の予約ロックを占有しない');
      events.push('sharing');
      assert.equal(access, 'link');
      assert.equal(permission, 'view');
      if (failure === 'sharing') throw new Error('試験用の共有失敗');
    },
    getId: () => 'upload-test-file'
  };
  const folder = { createFile(blob) {
    assert.equal(held, legacy, '画像の保存中はGoogle管理の予約ロックを占有しない');
    assert.equal(blob.mime, IMAGE.mimeType);
    assert.equal(blob.bytes.toString(), 'image');
    events.push('create-file');
    if (duringUpload) responseDuringUpload = duringUpload(send);
    if (failure === 'file') throw new Error('試験用の画像保存失敗');
    files += 1;
    return file;
  } };
  const context = vm.createContext({ Date, console: { error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] ?? null,
      deleteProperty: key => { delete properties[key]; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => body }) },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(held, false); held = true; events.push('lock'); },
      releaseLock() { assert.equal(held, true); held = false; events.push('release'); }
    }) },
    SpreadsheetApp: new Proxy({}, { get() { throw new Error('画像の受付で台帳へ書き込まない'); } }),
    Utilities: {
      formatDate: () => '20300101-090000',
      base64Decode: value => Buffer.from(value, 'base64'),
      newBlob(bytes, mime, name) {
        assert.equal(held, legacy, '大きな画像の変換もGoogle管理の予約ロック外で行う');
        return { bytes, mime, name };
      }
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'link' }, Permission: { VIEW: 'view' },
      getFoldersByName() {
        assert.equal(held, true, '保存先の取得と初回作成は短いロックで直列化する');
        events.push('find-folder');
        if (failure === 'folder') throw new Error('試験用の保存先取得失敗');
        return { hasNext: () => !missingFolder, next: () => folder };
      },
      createFolder() { assert.equal(held, true); events.push('create-folder'); return folder; }
    }
  });
  vm.runInContext(SOURCE, context);
  context.verifyGoogleAdmin_ = () => {
    assert.equal(held, false);
    events.push('authorize');
    if (unavailable) throw Object.assign(new Error('試験用のGoogle通信失敗'), { authUnavailable: true });
    if (denied) throw new Error('試験用の許可なし');
  };
  context.recoverBookingChange_ = () => { assert.equal(held, true); events.push('recovery'); };
  context.getSheet_ = () => { assert.equal(held, true); return {}; };
  context.doAvailability_ = () => { assert.equal(held, true); events.push('availability'); return { ok: true, booked: [] }; };
  context.doReserve_ = () => { assert.equal(held, true); events.push('verify-and-save'); return { ok: true }; };
  const send = request => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(request) } }));
  return { events, held: () => held, files: () => files, responseDuringUpload: () => responseDuringUpload,
    upload: changes => send({ type: 'googleAdmin', action: 'adminUpload', payload: { ...IMAGE, ...changes } }),
    legacyUpload: changes => send({ type: 'adminUpload', ...IMAGE, password, ...changes }), send };
}

test('Google画像保存は認証と保存先の直列化後に予約ロックを解放する', () => {
  const app = fixture();
  const result = app.upload();
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://lh3.googleusercontent.com/d/upload-test-file=w1200');
  assert.equal(result.name, 'salon-main-20300101-090000.png');
  assert.deepEqual(app.events, ['authorize', 'lock', 'recovery', 'find-folder', 'release', 'create-file', 'sharing']);
  assert.equal(app.files(), 1);
  assert.equal(app.held(), false);
});

test('初回保存先の作成も直列化するが、画像本体と共有はロック外に置く', () => {
  const app = fixture({ missingFolder: true });
  assert.equal(app.upload().ok, true);
  assert.deepEqual(app.events, ['authorize', 'lock', 'recovery', 'find-folder', 'create-folder', 'release', 'create-file', 'sharing']);
});

test('画像を保存する間に別の空席照会が台帳ロックを取得できる', () => {
  const app = fixture({ duringUpload: send => send({ type: 'availability' }) });
  assert.equal(app.upload().ok, true);
  assert.equal(app.responseDuringUpload().ok, true);
  assert.deepEqual(app.events, ['authorize', 'lock', 'recovery', 'find-folder', 'release', 'create-file',
    'lock', 'recovery', 'availability', 'release', 'sharing']);
});

test('画像の保存中も予約の最終照合と保存は自分の台帳ロック内で行う', () => {
  const app = fixture({ duringUpload: send => send({ type: 'reserve' }) });
  assert.equal(app.upload().ok, true);
  assert.equal(app.responseDuringUpload().ok, true);
  assert.deepEqual(app.events, ['authorize', 'lock', 'recovery', 'find-folder', 'release', 'create-file',
    'lock', 'recovery', 'verify-and-save', 'release', 'sharing']);
  assert.equal(app.held(), false);
});

for (const options of [{ denied: true }, { unavailable: true }]) {
  test(`Googleの確認に失敗した画像要求は保存先にも予約ロックにも触れない：${JSON.stringify(options)}`, () => {
    const app = fixture(options);
    const result = app.upload();
    assert.equal(result.ok, false);
    assert.equal(options.denied ? result.authDenied : result.transportError, true);
    assert.deepEqual(app.events, ['authorize']);
    assert.equal(app.files(), 0);
  });
}

for (const payload of [{ dataBase64: '' }, { mimeType: 'image/svg+xml' },
  { dataBase64: 'a'.repeat(6 * 1024 * 1024 * 4 / 3 + 4) }]) {
  test(`空・非対応・上限超過の画像は予約ロックを取らず拒否する：${Object.keys(payload).join(',')}`, () => {
    const app = fixture();
    assert.equal(app.upload(payload).ok, false);
    assert.deepEqual(app.events, ['authorize']);
    assert.equal(app.files(), 0);
  });
}

for (const failure of ['folder', 'file', 'sharing']) {
  test(`画像の${failure}失敗を成功と表示せず、予約ロックを残さない`, () => {
    const app = fixture({ failure });
    assert.equal(app.upload().ok, false);
    assert.equal(app.held(), false);
    assert.equal(app.send({ type: 'availability' }).ok, true);
    assert.equal(app.events.filter(event => event === 'lock').length, 2);
    assert.equal(app.events.filter(event => event === 'release').length, 2);
  });
}

test('外からGoogle管理の認証済み印を偽造しても旧画像入口から保存できない', () => {
  const app = fixture();
  const result = app.legacyUpload({ googleAdminContext: {} });
  assert.equal(result.ok, false);
  assert.equal(app.events.includes('find-folder'), false);
  assert.equal(app.files(), 0);
  assert.equal(app.held(), false);
});

test('旧方式を許可した設置先の画像保存も、認証と元のロック範囲を維持する', () => {
  const app = fixture({ legacy: true });
  assert.equal(app.legacyUpload().ok, true);
  assert.deepEqual(app.events, ['lock', 'recovery', 'find-folder', 'create-file', 'sharing', 'release']);
  assert.equal(app.files(), 1);
  assert.equal(app.held(), false);
});
