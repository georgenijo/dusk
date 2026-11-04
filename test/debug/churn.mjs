import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const ext = path.resolve('extension');
for (const withExt of [false, true]) {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/dusk-dbg-'), {
    channel: 'chromium', headless: true, viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    args: withExt ? [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] : [],
  });
  const page = await ctx.newPage();
  await page.goto(process.argv[2], { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => new Promise((res) => {
    const seen = {};
    const mo = new MutationObserver((ms) => { for (const m of ms) { const t = m.target; const k = `${m.type}:${m.attributeName || ''}:${t.tagName}.${[...(t.classList || [])].slice(0, 2).join('.')}`; seen[k] = (seen[k] || 0) + 1; } });
    mo.observe(document, { subtree: true, attributes: true, childList: true, attributeFilter: ['class', 'style', 'src', 'srcset'] });
    setTimeout(() => { mo.disconnect(); res(Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 8)); }, 2000);
  }));
  console.log(withExt ? 'WITH Dusk' : 'without', JSON.stringify(r));
  await ctx.close();
}
