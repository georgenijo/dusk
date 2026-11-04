// End-to-end check: load the unpacked extension in Chromium, theme each
// fixture, and assert on the rendered result and on what was sent to Jev.
//
//   node test/run.mjs            # mock Jev (default)
//   JEV=vercel VERCEL_KEY_FILE=… node test/run.mjs   # real Jev, direct
//   JEV=cpa node test/run.mjs    # real Jev through CPA (key from fleet config)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '../extension');
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = 8765;
const url = (name) => `http://${name}.localhost:${PORT}/${name}.html`;

const log = [];
const { server, mode: mock } = await start({ port: PORT, root: path.join(here, 'fixtures'), log });

let settings = { provider: 'cpa', baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: 'test-key', jevEnabled: true };
if (process.env.JEV === 'vercel') {
  settings = { provider: 'vercel', vercelKey: fs.readFileSync(process.env.VERCEL_KEY_FILE, 'utf8').trim(), jevEnabled: true };
} else if (process.env.JEV === 'cpa') {
  const key = execFileSync('python3', ['-I', '-c', 'import os,sys;sys.path.insert(0,os.path.expanduser("~/.fleet"));from fleet import ai;print(ai._credential(ai.load_config()))']).toString().trim();
  settings = { provider: 'cpa', baseUrl: 'https://cpa-georgenijo.georgenijo.com/v1', apiKey: key, jevEnabled: true };
}
const real = !!process.env.JEV;
settings.debug = true;

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/dusk-profile-'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1200, height: 800 },
  colorScheme: 'light',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);

const results = [];
async function syncLog() {
  if (!real) return;
  const entries = await sw.evaluate(() => globalThis.duskDebugLog.splice(0));
  for (const e of entries) log.push({ body: { state: e.state, questions: e.questions }, answers: e.answers, error: e.error, raw: e.raw });
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function status(page) {
  await syncLog();
  return sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u + '*' });
    return chrome.tabs.sendMessage(tab.id, { type: 'status' });
  }, page.url().split('#')[0]);
}

async function settle(page, { adapted = true } = {}) {
  await page.waitForFunction(
    (a) => document.documentElement.hasAttribute(a ? 'data-dusk-adapted' : 'data-dusk-ready') || !document.getElementById('dusk-preflight'),
    adapted,
    { timeout: real ? 60000 : 15000 },
  );
  await page.waitForTimeout(400);
}

const L = (rgb) => {
  const [r, g, b] = rgb.match(/[\d.]+/g).map(Number).map((v) => v / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => (Math.max(L(a), L(b)) + 0.05) / (Math.min(L(a), L(b)) + 0.05);
const style = (page, sel, prop) => page.$eval(sel, (el, p) => getComputedStyle(el)[p], prop);
async function effectiveBg(page, sel) {
  return page.$eval(sel, (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
    }
    return 'rgb(255, 255, 255)';
  });
}

// "Before" shots without the extension, for the side-by-side report.
const plain = await chromium.launch({ channel: 'chromium', headless: true });
const plainPage = await plain.newPage({ viewport: { width: 1200, height: 800 } });
for (const f of ['blog', 'brand', 'native-media', 'native-class', 'dynamic']) {
  await plainPage.goto(url(f));
  await plainPage.waitForTimeout(f === 'dynamic' ? 1800 : 200);
  await plainPage.screenshot({ path: path.join(out, `${f}-before.png`) });
}
await plain.close();

const page = await ctx.newPage();

// ---- blog: text, links, code, images
{
  const t0 = Date.now();
  await page.goto(url('blog'));
  await settle(page, { adapted: false });
  const firstPaintMs = Date.now() - t0;
  await settle(page);
  await page.screenshot({ path: path.join(out, 'blog-after.png') });
  const s = await status(page);
  check('blog: themed by Dusk', s.mode === 'themed', s.mode);
  check('blog: body is dark', L(await style(page, 'body', 'backgroundColor')) < 0.04, await style(page, 'body', 'backgroundColor'));
  for (const sel of ['#para', '#code', '.meta', 'blockquote', '#note', 'td', '#para a', 'nav a']) {
    const c = contrast(await style(page, sel, 'color'), await effectiveBg(page, sel));
    check(`blog: ${sel} contrast ≥ 4.5`, c >= 4.5, c.toFixed(2));
  }
  const link = (await style(page, '#para a', 'color')).match(/\d+/g).map(Number);
  check('blog: link keeps its blue hue', link[2] > link[0] + 40 && link[2] > 150, `rgb(${link})`);
  check('blog: dark logo inverted', (await style(page, '#logo', 'filter')).includes('invert'), await style(page, '#logo', 'filter'));
  check('blog: line diagram inverted', (await style(page, '#diagram', 'filter')).includes('invert'), await style(page, '#diagram', 'filter'));
  check('blog: photo not inverted', !(await style(page, '#photo', 'filter')).includes('invert'), await style(page, '#photo', 'filter'));
  check('blog: Jev consulted', s.jev.calls >= 1 && !s.jev.lastError, `${s.jev.calls} calls, ${s.jev.decisions} decisions, error=${s.jev.lastError}`);
  check('blog: dark styles before Jev answers', firstPaintMs < 3000, `${firstPaintMs} ms to ready`);
  const sent = log.map((l) => l.raw).join('\n');
  check('privacy: page text never sent to Jev', !sent.includes('SECRET-SENTENCE') && !sent.includes('durable software'));
  check('privacy: URLs and hostname never sent', !sent.includes('localhost') && !sent.includes('logo.svg') && !sent.includes('http'));
  console.log('      Jev answers on blog:', s.theme.tone, s.theme.accent, 'surfaceL', s.theme.surfaceL, 'quality', s.quality);
}

// ---- brand: hero, CTA, badges, swatches, gradient, footer
{
  const before = log.length;
  await page.goto(url('brand'));
  await settle(page);
  await page.screenshot({ path: path.join(out, 'brand-after.png') });
  const s = await status(page);
  const sentHere = log.slice(before);
  const roleQs = sentHere.flatMap((l) => Object.keys(l.body.questions).filter((q) => q.startsWith('role_')));
  check('brand: Jev asked about colored elements', roleQs.length >= 3, `${roleQs.length} role questions`);
  check('brand: page palette asked', sentHere.some((l) => l.body.questions.surface_tone && l.body.questions.depth?.criteria?.length === 3));
  const hero = await style(page, '#hero', 'backgroundColor');
  check('brand: hero darkened (surface)', L(hero) < 0.05, hero);
  const cta = await style(page, '#cta', 'backgroundColor');
  const [r, g, b] = cta.match(/\d+/g).map(Number);
  check('brand: CTA stays orange', r > g && g > b && r > 150, cta);
  check('brand: color swatch untouched', (await style(page, '#sw1', 'backgroundColor')) === 'rgb(225, 29, 72)', await style(page, '#sw1', 'backgroundColor'));
  check('brand: gradient band rewritten', !(await style(page, '#band', 'backgroundImage')).includes('224, 231, 255'), (await style(page, '#band', 'backgroundImage')).slice(0, 80));
  check('brand: card text readable', contrast(await style(page, '#card1 p', 'color'), await effectiveBg(page, '#card1 p')) >= 4.5);
  check('brand: verification ran', s.quality != null, `quality ${s.quality}`);
}

// ---- native dark modes
for (const [f, kind] of [['native-media', 'media'], ['native-class', 'class']]) {
  const before = log.length;
  await page.goto(url(f));
  await settle(page);
  await page.screenshot({ path: path.join(out, `${f}-after.png`) });
  const s = await status(page);
  check(`${f}: uses site's own dark mode`, s.mode === 'native' && s.native?.kind === kind, JSON.stringify(s.native));
  check(`${f}: body dark`, L(await style(page, 'body', 'backgroundColor')) < 0.03, await style(page, 'body', 'backgroundColor'));
  check(`${f}: no Jev call needed`, log.length === before);
}

// ---- already dark / private
{
  await page.goto(url('already-dark'));
  await settle(page);
  const s = await status(page);
  check('already-dark: left alone', s.mode === 'already-dark' && (await style(page, 'body', 'backgroundColor')) === 'rgb(18, 18, 18)', s.mode);

  const before = log.length;
  await page.goto(url('login'));
  await settle(page);
  const p = await status(page);
  check('login: themed locally', p.mode === 'themed' && L(await style(page, 'body', 'backgroundColor')) < 0.04);
  check('login: password page never sent to Jev', log.length === before && p.jevAllowed === false);
}

// ---- dynamic content
{
  await page.goto(url('dynamic'));
  await settle(page);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(out, 'dynamic-after.png') });
  const bgs = await page.$$eval('.item', (els) => els.map((e) => getComputedStyle(e).backgroundColor));
  check('dynamic: all 5 late items themed', bgs.length === 5 && bgs.every((c) => L(c) < 0.05), bgs.join(' '));
  check('dynamic: class change re-themed (.hot)', L(await style(page, '#item0', 'backgroundColor')) < 0.06 && (await style(page, '#item0', 'backgroundColor')) !== bgs[1], await style(page, '#item0', 'backgroundColor'));
}

// ---- feedback loop: user says "hard to read" -> Jev picks a correction -> persisted
{
  await page.goto(url('blog'));
  await settle(page);
  const before = await status(page);
  const r = await sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u + '*' });
    return chrome.tabs.sendMessage(tab.id, { type: 'feedback', kind: 'hard_to_read' });
  }, url('blog'));
  const after = await status(page);
  if (real) fs.writeFileSync(path.join(out, 'jev-real-log.json'), JSON.stringify(log, null, 1));
  const fbReq = log.at(-1).body;
  check('feedback: sent to Jev with user complaint', fbReq.state.userFeedback === 'Text is hard to read.' && !('none' in fbReq.questions.adjust.criteria));
  check('feedback: adjustment applied', r.adjustment === 'raise_contrast' && after.theme.minContrast > before.theme.minContrast, `${r.adjustment}, minContrast ${before.theme.minContrast}→${after.theme.minContrast}`);
  await page.reload();
  await settle(page);
  const reloaded = await status(page);
  check('feedback: remembered after reload', reloaded.theme.minContrast === after.theme.minContrast);
  check('cache: reload reuses saved decisions', reloaded.jev.calls === 0, `${reloaded.jev.calls} calls on reload`);
}

// ---- Jev outage: theme still works, error surfaced
if (!real) {
  mock.fail = true;
  await sw.evaluate(() => chrome.storage.local.remove('site:brand.localhost'));
  await page.goto(url('brand'));
  await settle(page);
  const s = await status(page);
  check('outage: still themed from priors', s.mode === 'themed' && L(await style(page, '#hero', 'backgroundColor')) < 0.2);
  check('outage: error surfaced', /502/.test(s.jev.lastError || ''), s.jev.lastError);
  mock.fail = false;
}

// ---- real sites (Jev still mocked unless JEV is set)
for (const site of ['https://news.ycombinator.com/', 'https://example.com/', 'https://en.wikipedia.org/wiki/Color_theory']) {
  const name = new URL(site).hostname;
  try {
    await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await settle(page);
    const s = await status(page);
    await page.screenshot({ path: path.join(out, `real-${name}.png`) });
    check(`real ${name}: dark`, L(await style(page, 'body', 'backgroundColor')) < 0.05 || s.mode === 'native', `${s.mode} ${s.native ? JSON.stringify(s.native) : ''}`);
  } catch (e) {
    check(`real ${name}: loaded`, false, String(e).slice(0, 120));
  }
}

fs.writeFileSync(path.join(out, 'jev-requests.json'), JSON.stringify(log.map((l) => ({ ...l.body, answers: l.answers, error: l.error })), null, 2));
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
await ctx.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${real ? ' (real Jev)' : ' (mock Jev)'}`);
process.exit(failed.length ? 1 : 0);
