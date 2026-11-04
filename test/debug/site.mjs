// Load one real site with Dusk and dump a screenshot plus the diagnostics
// report the popup would copy. Usage: node test/debug/site.mjs URL [name]
// Set VERCEL_KEY_FILE to let Jev take part.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const [url, name = new URL(url).hostname] = process.argv.slice(2);
const ext = path.resolve('extension');
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/dusk-dbg-'), {
  channel: 'chromium', headless: true, viewport: { width: 1400, height: 900 }, colorScheme: process.env.SCHEME || "light",
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent('serviceworker');
if (process.env.VERCEL_KEY_FILE) {
  const key = fs.readFileSync(process.env.VERCEL_KEY_FILE, 'utf8').trim();
  await sw.evaluate((k) => chrome.storage.local.set({ settings: { provider: 'vercel', vercelKey: k, jevEnabled: true, debug: true } }), key);
}
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => document.documentElement.hasAttribute('data-dusk-adapted') || document.documentElement.hasAttribute('data-dusk-ready'), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(6000);
fs.mkdirSync('test/debug/out', { recursive: true });
await page.screenshot({ path: `test/debug/out/${name}.png` });
if (process.env.SCROLL) {
  await page.evaluate((y) => window.scrollTo(0, y), +process.env.SCROLL);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `test/debug/out/${name}-scrolled.png` });
}
const diag = await sw.evaluate(async (u) => {
  const [tab] = await chrome.tabs.query({ url: u + '*' });
  return chrome.tabs.sendMessage(tab.id, { type: 'diagnostics' });
}, new URL(url).origin + '/');
fs.writeFileSync(`test/debug/out/${name}-jev.json`, JSON.stringify(await sw.evaluate(() => globalThis.duskDebugLog), null, 1));
fs.writeFileSync(`test/debug/out/${name}.json`, JSON.stringify(diag, null, 1));
console.log(JSON.stringify({ stats: diag.stats, mode: diag.status.mode, jev: diag.status.jev, quality: diag.status.quality, adjustments: diag.status.adjustments, profile: diag.profile }, null, 1));
console.log(diag.events.map((e) => `${e.t}ms ${e.kind} ${JSON.stringify({ ...e, t: undefined, kind: undefined }).slice(0, 220)}`).join('\n'));
await ctx.close();
