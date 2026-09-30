import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { createMockHandler } from './mock-gas.mjs';

const WIDTHS = [320, 390, 768, 1280];
const PAGES = ['index', 'gallery', 'menu', 'staff', 'reviews', 'reserve', 'mypage', 'privacy', '404'];
const MIN_FOCUS_CONTRAST = 3;
const MIN_FOCUS_WIDTH = 2;
const MIN_TOUCH_SIZE = 44;
const MAX_NARROW_TITLE_LINES = 3;
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let handler;
const server = http.createServer((request, response) => handler(request, response));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
handler = createMockHandler({ port: server.address().port });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function openPage(name, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base
    ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${base}/${name}.html`, { waitUntil: 'load' });
  return { context, page };
}

function contrast(foreground, background) {
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('狭いスマホのトップ写真一覧を読みやすくし、通常幅の構成と写真4点を保つ', async () => {
  for (const width of WIDTHS) {
    const { context, page } = await openPage('index', width);
    try {
      const layout = await page.locator('#home-styles').evaluate(grid => {
        const cards = [...grid.querySelectorAll('.style-card')];
        return {
          columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
          cards: cards.map(card => {
            const photo = card.querySelector('img');
            const title = card.querySelector('.style-title');
            const button = card.querySelector('.style-book');
            return {
              photo: photo.getAttribute('src'),
              title: title.textContent.trim(),
              titleLines: title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight),
              buttonHeight: button.getBoundingClientRect().height,
              buttonWidth: button.getBoundingClientRect().width,
              buttonRight: button.getBoundingClientRect().right,
              cardRight: card.getBoundingClientRect().right
            };
          }),
          overflow: document.documentElement.scrollWidth > innerWidth
        };
      });
      assert.equal(layout.columns, width < 360 ? 1 : width <= 700 ? 2 : 4, `幅${width}で写真の列数を保つ`);
      assert.equal(layout.cards.length, 4, '承認済みの写真4点を残す');
      assert.equal(new Set(layout.cards.map(card => card.photo)).size, 4);
      assert.ok(layout.cards.every(card => card.photo.startsWith('assets/') && card.title));
      assert.equal(layout.overflow, false, `幅${width}で横にはみ出さない`);
      for (const card of layout.cards) {
        assert.ok(card.buttonHeight >= MIN_TOUCH_SIZE && card.buttonWidth >= MIN_TOUCH_SIZE, '予約リンクの操作領域を保つ');
        assert.ok(card.buttonRight <= card.cardRight + 1, '予約リンクを写真一覧の幅に収める');
        if (width < 360) assert.ok(card.titleLines <= MAX_NARROW_TITLE_LINES, '長いタイトルを細切れにしない');
      }
    } finally { await context.close(); }
  }
});

test('公開9ページの暗いフッターでTab移動先が十分なコントラストで見える', async () => {
  for (const name of PAGES) {
    const { context, page } = await openPage(name);
    try {
      const links = page.locator('.footer-grid li a');
      await links.first().focus();
      await page.keyboard.press('Tab');
      const focus = await links.nth(1).evaluate(link => {
        const style = getComputedStyle(link);
        return {
          active: document.activeElement === link,
          visible: link.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: parseFloat(style.outlineWidth),
          outlineColor: style.outlineColor,
          background: getComputedStyle(link.closest('.site-footer')).backgroundColor
        };
      });
      assert.ok(focus.active && focus.visible, `${name}でTabの移動先を表示する`);
      assert.equal(focus.outlineStyle, 'solid');
      assert.ok(focus.outlineWidth >= MIN_FOCUS_WIDTH);
      assert.ok(contrast(focus.outlineColor, focus.background) >= MIN_FOCUS_CONTRAST, `${name}で暗い背景にfocusを埋もれさせない`);
    } finally { await context.close(); }
  }
});

test('予約照会の入力欄をキーボードで移動したときに明確なfocusを表示する', async () => {
  for (const width of [320, 1280]) {
    const { context, page } = await openPage('mypage', width);
    try {
      await page.locator('#lookup-code').focus();
      await page.keyboard.press('Tab');
      const focus = await page.locator('#lookup-tel').evaluate(input => {
        const style = getComputedStyle(input);
        return {
          active: document.activeElement === input,
          visible: input.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: parseFloat(style.outlineWidth),
          outlineColor: style.outlineColor,
          background: getComputedStyle(input.closest('#lookup-box')).backgroundColor
        };
      });
      assert.ok(focus.active && focus.visible);
      assert.equal(focus.outlineStyle, 'solid', '入力欄にもリンクと同じ見えるfocusを付ける');
      assert.ok(focus.outlineWidth >= MIN_FOCUS_WIDTH);
      assert.ok(contrast(focus.outlineColor, focus.background) >= MIN_FOCUS_CONTRAST);
      assert.equal(await page.locator('#lookup-result .booking-card').count(), 0, 'focus移動だけで照会しない');
    } finally { await context.close(); }
  }
});
