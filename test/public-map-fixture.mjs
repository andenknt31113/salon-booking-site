import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/data.js', import.meta.url), 'utf8');
export const mapEmbedUrl = vm.runInNewContext(source + ';SALON.mapEmbedUrl');

export function isPublicMapFrame(request) {
  return request.method() === 'GET' && request.url() === mapEmbedUrl
    && request.resourceType() === 'document' && request.frame().parentFrame() !== null;
}

export const mapFixture = {
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: '<!doctype html><html lang="ja"><title>地図の試験用応答</title><body>試験用の地図</body></html>'
};
