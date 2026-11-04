import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const ext = path.resolve('extension');
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/dusk-dbg-'), {
  channel: 'chromium', headless: true, viewport: { width: 1400, height: 900 }, colorScheme: 'light',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage();
await page.goto('https://www.apple.com/mac/', { waitUntil: 'load' });
const st = async () => sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'https://www.apple.com/*' }); const s = await chrome.tabs.sendMessage(t.id, { type: 'status' }); return JSON.stringify(s.stats); });
for (const t of [2000, 5000]) { await page.waitForTimeout(t); console.log('stats', await st()); }
for (let y = 0; y < 6000; y += 600) { await page.mouse.wheel(0, 600); await page.waitForTimeout(400); }
await page.waitForTimeout(2000);
console.log('after scroll', await st());
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(1500);
await page.screenshot({ path: 'test/debug/apple-cards.png' });
const cards = await page.evaluate(() => {
  const res = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < 250 || r.height < 250 || r.top > 900 || r.bottom < 0) continue;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    if (bg !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none')
      res.push(`${el.tagName}.${[...el.classList].slice(0,2).join('.')} ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.top)} bg=${bg} img=${cs.backgroundImage.slice(0,60)} dusk=${el.getAttribute('data-dusk')}`);
  }
  return res;
});
console.log(cards.join('\n'));
// mutation rate
const rate = await page.evaluate(() => new Promise((r) => { let n = 0; const mo = new MutationObserver((m) => (n += m.length)); mo.observe(document, { subtree: true, attributes: true, childList: true }); setTimeout(() => { mo.disconnect(); r(n); }, 3000); }));
console.log('mutations in 3s idle:', rate);
await ctx.close();
