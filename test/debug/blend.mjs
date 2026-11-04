import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chromium', headless: true });
const p = await b.newPage({ viewport: { width: 1400, height: 900 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36' });
await p.goto(process.argv[2], { waitUntil: 'load' });
await p.waitForTimeout(3000);
console.log(JSON.stringify(await p.evaluate(() => {
  const m = {};
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.mixBlendMode !== 'normal') { const k = `${el.tagName}:${cs.mixBlendMode}`; m[k] = (m[k] || 0) + 1; }
    if (cs.isolation === 'isolate') m.isolate = (m.isolate || 0) + 1;
  }
  return m;
})));
await b.close();
