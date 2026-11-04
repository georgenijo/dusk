// Main-thread cost of Dusk on one site: load + scroll, without Dusk, with Dusk
// (first visit), and with Dusk again (cached profile). Also counts Jev calls.
// Usage: VERCEL_KEY_FILE=... node test/debug/perf.mjs URL
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const [url] = process.argv.slice(2);
const ext = path.resolve('extension');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const KEYS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize'];

async function measure(ctx, label, sw) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const snap = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.filter((m) => KEYS.includes(m.name)).map((m) => [m.name, m.value]));
  const before = sw ? await sw.evaluate(() => (globalThis.duskDebugLog || []).length) : 0;
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(8000);
  const loaded = await snap();
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(400); }
  await page.waitForTimeout(4000);
  const scrolled = await snap();
  const elements = await page.evaluate(() => document.getElementsByTagName('*').length);
  let jev = null, diagnostics = null;
  if (sw) {
    const calls = await sw.evaluate((n) => (globalThis.duskDebugLog || []).slice(n), before);
    diagnostics = await sw.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const d = await chrome.tabs.sendMessage(tab.id, { type: 'diagnostics' });
      return { mode: d.status.mode, jev: d.status.jev, engine: d.engine, walk: d.events.find((e) => e.kind === 'walk')?.ms };
    }, page.url());
    jev = { calls: calls.length, questions: calls.reduce((s, c) => s + Object.keys(c.body?.questions || c.questions || {}).length, 0), kb: Math.round(calls.reduce((s, c) => s + JSON.stringify({ state: c.state, questions: c.questions }).length, 0) / 1024) };
  }
  await page.close();
  const ms = (o, k) => Math.round(o[k] * 1000);
  return {
    label, elements,
    loadCpuMs: ms(loaded, 'TaskDuration'), loadScriptMs: ms(loaded, 'ScriptDuration'), loadStyleLayoutMs: ms(loaded, 'RecalcStyleDuration') + ms(loaded, 'LayoutDuration'),
    scrollCpuMs: ms(scrolled, 'TaskDuration') - ms(loaded, 'TaskDuration'), scrollScriptMs: ms(scrolled, 'ScriptDuration') - ms(loaded, 'ScriptDuration'),
    heapMB: +(scrolled.JSHeapUsedSize / 1048576).toFixed(1), jev, diagnostics,
  };
}

const launch = (withExt) => chromium.launchPersistentContext(fs.mkdtempSync('/tmp/dusk-perf-'), {
  channel: 'chromium', headless: true, viewport: { width: 1400, height: 900 }, colorScheme: 'light', userAgent: UA,
  args: withExt ? [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] : [],
});
const rows = [];
let ctx = await launch(false);
rows.push(await measure(ctx, 'no Dusk'));
await ctx.close();
ctx = await launch(true);
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent('serviceworker');
if (process.env.VERCEL_KEY_FILE) {
  const key = fs.readFileSync(process.env.VERCEL_KEY_FILE, 'utf8').trim();
  await sw.evaluate((k) => chrome.storage.local.set({ settings: { provider: 'vercel', vercelKey: k, jevEnabled: true, debug: true } }), key);
}
rows.push(await measure(ctx, 'Dusk, first visit', sw));
rows.push(await measure(ctx, 'Dusk, repeat visit', sw));
await ctx.close();
console.log(JSON.stringify(rows, null, 1));
