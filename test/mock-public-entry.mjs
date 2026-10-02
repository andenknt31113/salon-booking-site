import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

test('Google管理入口を画面試験で配信し、内部資料を静的配信しない', async () => {
  let handler;
  const server = http.createServer((request, response) => handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  handler = createMockHandler({ port });
  const base = `http://127.0.0.1:${port}`;
  try {
    const entry = await fetch(base + '/admin-google.html');
    assert.equal(entry.status, 200);
    assert.match(await entry.text(), /id="google-login"/);
    for (const path of ['/HANDOFF.md', '/gas/Code.gs', '/test/mock-gas.mjs', '/tools/demo-support.mjs']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
