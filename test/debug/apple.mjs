import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const ext = path.resolve('extension');
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/dusk-dbg-'), {
  channel: 'chromium', headless: true, viewport: { width: 1400, height: 900 }, colorScheme: 'light',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = await ctx.newPage();
await page.goto(process.argv[2] || 'https://www.apple.com/mac/', { waitUntil: 'load' });
await page.waitForTimeout(5000);
await page.screenshot({ path: 'test/debug/apple.png' });
const info = await page.evaluate(() => {
  const out = {};
  const find = (txt) => [...document.querySelectorAll('span,a,p,button,div')].find((e) => e.children.length === 0 && e.textContent.trim() === txt);
  for (const t of ['MacBook Air', 'Laptops', 'Explore the lineup.']) {
    const el = find(t);
    if (!el) { out[t] = 'not found'; continue; }
    const chain = [];
    for (let e = el; e && chain.length < 6; e = e.parentElement) {
      const cs = getComputedStyle(e);
      chain.push(`${e.tagName}.${[...e.classList].slice(0,2).join('.')} color=${cs.color} bg=${cs.backgroundColor} dusk=${e.hasAttribute('data-dusk')} op=${cs.opacity} fill=${cs.webkitTextFillColor}`);
    }
    out[t] = chain;
  }
  const imgs = document.querySelectorAll('img').length;
  const pics = document.querySelectorAll('picture').length;
  out.counts = { imgs, pics, all: document.querySelectorAll('*').length, themed: document.querySelectorAll('[data-dusk]').length };
  return out;
});
console.log(JSON.stringify(info, null, 1));
await ctx.close();
