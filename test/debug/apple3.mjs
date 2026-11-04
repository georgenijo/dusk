import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const ext = path.resolve('extension');
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/dusk-dbg-'), {
  channel: 'chromium', headless: true, viewport: { width: 1400, height: 900 }, colorScheme: process.argv[2] || 'light',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 400000, uploadThroughput: 200000 });
await page.goto('https://www.apple.com/mac/', { waitUntil: 'commit' });
const probe = () => page.evaluate(() => {
  const els = [...document.querySelectorAll('span,a,p,div')].filter((e) => e.children.length === 0 && ['MacBook Neo','Laptops','Compare'].includes(e.textContent.trim()) && e.getBoundingClientRect().width > 0 && !e.closest('.globalnav'));
  return els.map((e) => `${e.textContent.trim()}:${getComputedStyle(e).color}:${e.getAttribute('data-dusk')}:${e.style.cssText.slice(0,60)}`).join(' | ');
}).catch((e) => 'err ' + e.message.slice(0, 50));
for (let i = 0; i < 12; i++) { await page.waitForTimeout(1500); console.log(i, await probe()); }
await page.screenshot({ path: 'test/debug/apple-slow.png' });
await ctx.close();
