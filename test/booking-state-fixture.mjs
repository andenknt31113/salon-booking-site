import assert from 'node:assert/strict';

export function withBookingState(source, { approved = true, draft = false } = {}) {
  for (const [key, value] of [['bookingLaunchApproved', approved], ['draft', draft]]) {
    assert.equal(typeof value, 'boolean', `${key}の試験設定は真偽値`);
    const pattern = new RegExp(`(\\b${key}:\\s*)(true|false)(,)`, 'g');
    assert.equal([...source.matchAll(pattern)].length, 1, `${key}の設定箇所は1つ`);
    source = source.replace(pattern, (_match, prefix, _previous, suffix) => `${prefix}${value}${suffix}`);
  }
  return source;
}

export async function mockBookingState(context, state) {
  await context.route(/\/assets\/js\/data\.js(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: withBookingState(await response.text(), state) });
  });
}
