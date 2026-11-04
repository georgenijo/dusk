// UI smoke test against the real unpacked extension and a local CPA fixture.
// Run: PLAYWRIGHT_BROWSERS_PATH=/tmp/dusk-browsers node test/ui.mjs
// Most state checks open popup.html as a tab and pin only tabs.query to the
// target website; messaging, storage, testing and reload use real extension
// APIs. A separate CDP check opens Chromium's actual action popup to verify
// intrinsic sizing, active-tab selection, font size and absence of scrolling.
// Explicit fixtures cover transient states and stale-tab messaging failure.
// This does not verify toolbar placement or real-provider billing/authentication.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '../extension');
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });
const requests = [];
const { server, mode } = await start({ port: 8766, root: path.join(here, 'fixtures'), log: requests });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dusk-ui-'));
let context;
const results = [];
const check = (name, detail = '') => { results.push({ name, ok: true, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };
async function text(page, selector, expected) {
  await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent.includes(expected), { selector, expected });
}
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 900 }, colorScheme: 'dark',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const extensionUrl = (file) => `chrome-extension://${id}/ui/${file}`;
  const options = await context.newPage();
  await options.goto(extensionUrl('options.html'));
  await text(options, '#connection', 'Not configured');
  assert.equal(await options.locator('#provider').inputValue(), 'vercel');
  assert.equal(await options.locator('#vercelKey').getAttribute('type'), 'password');
  await options.locator('#test').click();
  await text(options, '#out', 'Enter a provider key');
  assert.equal(requests.length, 0);
  check('New setup defaults to Vercel; missing key blocks test before a request');
  await options.screenshot({ path: path.join(out, 'ui-settings-new-dark.png'), fullPage: true });

  const initial = {
    provider: 'cpa', baseUrl: 'http://127.0.0.1:8766/v1', apiKey: 'ui-only-test-key',
    vercelKey: 'retained-unused-vercel-key', jevEnabled: true, debug: false,
    futureSetting: { keep: 'untouched' },
  };
  await worker.evaluate((settings) => chrome.storage.local.set({ settings }), initial);
  await options.reload();
  await text(options, '#connection', 'Saved, not tested');
  assert.equal(await options.locator('#provider').inputValue(), 'cpa');
  await options.locator('#save').click();
  await text(options, '#out', 'Settings saved');
  assert.equal(await options.locator('#connection').textContent(), 'Saved, not tested');
  assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings), initial);
  assert.equal(requests.length, 0);
  check('Save preserves existing provider, both keys and unknown settings; save never connects');

  await options.locator('#test').click();
  await text(options, '#connection', 'Connected');
  assert.equal(requests.length, 1);
  check('A successful real worker test establishes Connected');
  await options.screenshot({ path: path.join(out, 'ui-settings-connected-dark.png'), fullPage: true });
  await options.locator('#provider').selectOption('vercel');
  assert.notEqual(await options.locator('#connection').textContent(), 'Connected');
  await options.locator('#test').click();
  await text(options, '#out', 'Save your changes');
  assert.equal(requests.length, 1);
  await options.locator('#save').click();
  await text(options, '#out', 'Settings saved');
  assert.notEqual(await options.locator('#connection').textContent(), 'Connected');
  const stored = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.equal(stored.apiKey, initial.apiKey);
  assert.equal(stored.vercelKey, initial.vercelKey);
  assert.equal(stored.provider, 'vercel');
  check('Provider changes immediately invalidate visible verification and preserve inactive keys');

  await options.locator('#provider').selectOption('cpa');
  await options.locator('#save').click();
  await text(options, '#out', 'Settings saved');
  mode.fail = true;
  await options.locator('#test').click();
  await text(options, '#connection', 'Failed');
  await text(options, '#out', 'Test failed');
  mode.fail = false;
  await options.locator('#test').click();
  await text(options, '#connection', 'Connected');
  check('Failed connection is distinct and retry recovers');
  await options.locator('#jevEnabled').uncheck();
  await options.locator('#save').click();
  await text(options, '#connection', 'Disabled');
  const beforeDisabled = requests.length;
  await options.locator('#test').click();
  await text(options, '#out', 'Enable Jev');
  assert.equal(requests.length, beforeDisabled);
  await options.locator('#jevEnabled').check();
  await options.locator('#save').click();
  await options.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await options.screenshot({ path: path.join(out, 'ui-settings-light.png'), fullPage: true });
  check('Disabled state prevents tests; settings support system light appearance');

  // Private fixture suppresses automatic evaluation so request counts remain
  // deterministic while exercising real content-script status and controls.
  const site = await context.newPage();
  await site.goto('http://127.0.0.1:8766/login.html');
  const target = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0], site.url());
  async function popup({ status, disconnected = false, targetOverride } = {}) {
    const page = await context.newPage();
    await page.addInitScript(({ target, status, disconnected }) => {
      const realSend = chrome.tabs.sendMessage.bind(chrome.tabs);
      const realReload = chrome.tabs.reload.bind(chrome.tabs);
      chrome.tabs.query = async () => [target];
      if (status || disconnected) chrome.tabs.sendMessage = async (tabId, message) => {
        if (message.type === 'status') {
          if (disconnected) throw new Error('Receiving end does not exist');
          return status;
        }
        return realSend(tabId, message);
      };
      window.__reloads = 0;
      chrome.tabs.reload = async (...args) => { window.__reloads++; return realReload(...args); };
    }, { target: targetOverride || target, status, disconnected });
    await page.goto(extensionUrl('popup.html'));
    await page.waitForFunction(() => document.querySelector('#connection').textContent !== 'Checking…');
    return page;
  }
  const p = await popup();
  await text(p, '#host', '127.0.0.1');
  await text(p, '#request-help', 'private page');
  await text(p, '#theme-state', 'Dusk theme applied');
  assert.equal(await p.locator('#attempts').textContent(), '0');
  check('Real private-page status explains zero automatic requests separately from global connection');
  await p.locator('body').screenshot({ path: path.join(out, 'ui-popup-private-dark.png'), fullPage: true });

  for (const selector of ['#settings', '#diag', '#reset']) {
    const box = await p.locator(selector).boundingBox();
    assert.ok(box.width >= 320 && box.height >= 36, `${selector} hit region ${JSON.stringify(box)}`);
    await p.locator(selector).focus();
    assert.ok(await p.locator(selector).evaluate((el) => el === document.activeElement));
    assert.notEqual(await p.locator(selector).evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
  }
  const layout = await p.evaluate(() => ({ width: document.body.offsetWidth, height: document.body.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }));
  assert.equal(layout.width, 360);
  assert.ok(layout.height <= 600 && !layout.overflow, JSON.stringify(layout));
  await p.locator('#settings').focus();
  await p.keyboard.press('Tab');
  assert.ok(await p.locator('#diag').evaluate((el) => el === document.activeElement));
  await p.locator('#feedback summary').click();
  const expanded = await p.evaluate(() => document.body.getBoundingClientRect().height);
  assert.ok(expanded <= 600);
  const footerBottom = await p.locator('.popup-footer').evaluate((el) => el.getBoundingClientRect().bottom);
  assert.ok(footerBottom <= 600, `Footer must stay visible: ${footerBottom}`);
  await p.locator('body').screenshot({ path: path.join(out, 'ui-popup-feedback-dark.png'), fullPage: true });
  const beforeFeedback = requests.length;
  await p.locator('[data-fb=too_bright]').click();
  await text(p, '#result', 'Applied:');
  assert.equal(requests.length, beforeFeedback);
  check('Private-page feedback applies a local adjustment without a Jev request');
  check('Three distinct full-width footer buttons, keyboard focus/order, 360px width and ≤600px popup');
  await p.close();

  const state = { mode: 'native', host: '<img src=x onerror=alert(1)>', enabled: false, siteMode: 'auto', jevAllowed: true, jev: { calls: 0 }, adjustments: [] };
  for (const [name, patch, title, reason] of [
    ['native', {}, 'Site’s own dark mode', 'site handles dark mode'],
    ['native-earlier-attempt', { jev: { calls: 1 } }, 'Site’s own dark mode', 'earlier attempts remain shown'],
    ['private-earlier-attempt', { mode: 'themed', enabled: true, jevAllowed: false, jev: { calls: 1 } }, 'Dusk theme applied', 'earlier attempts remain shown'],
    ['off-earlier-attempt', { mode: 'off', siteMode: 'off', jev: { calls: 1 } }, 'Dusk is off', 'earlier attempts remain shown'],
    ['already-dark', { mode: 'already-dark' }, 'Already dark', 'already dark'],
    ['off', { mode: 'off', siteMode: 'off' }, 'Dusk is off', 'site is off'],
    ['checking', { mode: 'checking' }, 'Checking appearance', null],
  ]) {
    const page = await popup({ status: { ...state, ...patch } });
    await text(page, '#theme-state', title);
    if (reason) await text(page, '#request-help', reason);
    assert.ok(await page.locator('body').evaluate(el => el.getBoundingClientRect().height <= 600));
    await page.locator('body').screenshot({ path: path.join(out, `ui-popup-${name}-dark.png`), fullPage: true });
    await page.locator('#feedback summary').click();
    assert.equal(await page.locator('[data-fb]:enabled').count(), patch.enabled ? 5 : 0);
    assert.equal(await page.locator('#pick').isDisabled(), !patch.enabled);
    if (patch.jev?.calls) {
      assert.equal(await page.locator('#attempts').textContent(), '1');
      assert.ok(!(await page.locator('#request-help').textContent()).includes('0 automatic requests'));
    }
    assert.equal(await page.locator('#modes [aria-pressed=true]').getAttribute('data-mode'), patch.siteMode || 'auto');
    assert.equal(await page.locator('img').count(), 0);
    await page.close();
  }
  check('Native, already-dark, off and checking states gate adjustments; earlier native/private/off attempts remain truthful');

  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, apiKey: '' } });
  });
  const noKey = await popup({ status: state });
  await text(noKey, '#connection', 'Not configured');
  assert.ok(await noKey.locator('#setup').isVisible());
  await noKey.locator('body').screenshot({ path: path.join(out, 'ui-popup-setup-native-dark.png'), fullPage: true });
  await noKey.close();
  const privateNoKey = await popup();
  assert.ok(await privateNoKey.locator('#setup').isVisible());
  await privateNoKey.close();
  check('Missing-key setup remains prominent on native and private pages');

  // Chrome action popups are CDP targets, but are not exposed as Playwright
  // context.pages(). Inspect the actual popup target instead of inferring its
  // natural size from an ordinary extension page's large viewport.
  const darkSite = await context.newPage();
  await darkSite.goto('http://already-dark.localhost:8766/already-dark.html');
  await darkSite.bringToFront();
  await worker.evaluate(() => chrome.action.openPopup());
  const cdp = await context.newCDPSession(darkSite);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const popupTarget = targetInfos.find((target) => target.type === 'page' && target.url === extensionUrl('popup.html'));
  assert.ok(popupTarget, 'Chrome action popup must be open');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: false });
  let commandId = 0;
  async function popupCommand(method, params = {}) {
    const id = ++commandId;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', handle); reject(new Error(`Popup CDP timeout: ${method}`)); }, 10000);
      const handle = ({ sessionId: receivedSession, message }) => {
        if (receivedSession !== sessionId) return;
        const data = JSON.parse(message);
        if (data.id !== id) return;
        clearTimeout(timeout);
        cdp.off('Target.receivedMessageFromTarget', handle);
        data.error ? reject(new Error(data.error.message)) : resolve(data.result);
      };
      cdp.on('Target.receivedMessageFromTarget', handle);
    });
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
    return response;
  }
  async function popupEvaluate(expression) {
    const response = await popupCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }
  assert.ok(await popupEvaluate(`new Promise(resolve => {
    let frames = 0;
    const check = () => {
      if (document.querySelector('#theme-state')?.textContent === 'Already dark' && document.querySelector('#connection')?.textContent === 'Not configured') return resolve(true);
      if (++frames > 300) return resolve(false);
      requestAnimationFrame(check);
    };
    check();
  })`), 'Actual popup must show the current website, already dark, with missing-key setup');
  // Chrome asynchronously resizes an action popup after DOM changes. Require
  // several stable animation frames with fitting content before measuring;
  // checking immediately after a status update measures the previous viewport.
  const geometry = () => popupEvaluate(`new Promise((resolve, reject) => {
    let previous = '', stable = 0, frames = 0;
    const measure = () => {
      const size = { width: innerWidth, height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        bodyHeight: document.body.offsetHeight, fontSize: getComputedStyle(document.body).fontSize,
        host: document.querySelector('#host').textContent,
        scrollContainers: [...document.querySelectorAll('*')].filter(el =>
          ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight).length
      };
      const current = JSON.stringify(size);
      const fits = size.width === 360 && size.height <= 600 && size.scrollWidth <= size.width && size.scrollHeight <= size.height && size.scrollContainers === 0;
      stable = fits && current === previous ? stable + 1 : 0;
      if (stable >= 3) return resolve(size);
      if (++frames > 300) return reject(new Error('Popup did not settle without scrolling: ' + current));
      previous = current;
      requestAnimationFrame(measure);
    };
    measure();
  })`);
  const actual = await geometry();
  assert.equal(actual.width, 360);
  assert.equal(actual.fontSize, '13px');
  assert.equal(actual.host, 'already-dark.localhost');
  assert.ok(actual.height <= 600 && actual.scrollWidth <= actual.width && actual.scrollHeight <= actual.height && actual.scrollContainers === 0, JSON.stringify(actual));
  let capture = await popupCommand('Page.captureScreenshot');
  fs.writeFileSync(path.join(out, 'ui-popup-real-already-dark.png'), Buffer.from(capture.data, 'base64'));
  await popupEvaluate(`document.querySelector('#feedback').open = true`);
  await popupEvaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  const actualFeedback = await geometry();
  assert.ok(actualFeedback.height <= 600 && actualFeedback.scrollWidth <= actualFeedback.width && actualFeedback.scrollHeight <= actualFeedback.height && actualFeedback.scrollContainers === 0, JSON.stringify(actualFeedback));
  capture = await popupCommand('Page.captureScreenshot');
  fs.writeFileSync(path.join(out, 'ui-popup-real-feedback.png'), Buffer.from(capture.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId: popupTarget.targetId });
  await cdp.detach();
  await darkSite.close();
  check('Actual Chrome popup is 360px wide, normal 13px text, ≤600px tall, with zero scrolling', JSON.stringify({ closed: actual.height, feedback: actualFeedback.height }));

  const disconnected = await popup({ disconnected: true });
  await text(disconnected, '#theme-state', 'Refresh this tab');
  assert.ok(await disconnected.locator('#reload').isVisible());
  assert.equal(await disconnected.locator('#modes button:enabled').count(), 0);
  await disconnected.locator('#reload').click();
  assert.equal(await disconnected.evaluate(() => window.__reloads), 1);
  await disconnected.locator('body').screenshot({ path: path.join(out, 'ui-popup-disconnected-dark.png'), fullPage: true });
  await disconnected.close();
  const internal = await popup({ targetOverride: { ...target, url: 'chrome://extensions/' } });
  await text(internal, '#theme-state', 'Unsupported page');
  assert.equal(await internal.locator('#reload').isVisible(), false);
  assert.equal(await internal.locator('#reset').isDisabled(), true);
  await internal.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await internal.locator('body').screenshot({ path: path.join(out, 'ui-popup-unsupported-light.png'), fullPage: true });
  await internal.close();
  check('Disconnected supported tab offers real reload; browser internal page is distinctly unsupported');

  // Verify copy through the actual handler without relying on a headless OS
  // clipboard permission. The replacement captures only writeText's argument.
  await worker.evaluate((settings) => chrome.storage.local.set({ settings }), initial);
  const diag = await popup();
  await diag.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value) => { window.__copied = value; } } }));
  await diag.locator('#diag').click();
  await text(diag, '#result', 'Diagnostics copied');
  const copied = await diag.evaluate(() => window.__copied);
  assert.deepEqual(Object.keys(JSON.parse(copied)).sort(), ['page', 'worker']);
  assert.ok(!copied.includes(initial.apiKey) && !copied.includes(initial.vercelKey));
  await diag.locator('[data-mode=off]').click();
  await text(diag, '#theme-state', 'Dusk is off');
  await text(diag, '#request-help', 'site is off');
  assert.equal(await diag.locator('[data-mode=off]').getAttribute('aria-pressed'), 'true');
  await diag.locator('#reset').click();
  await text(diag, '#result', 'Removes this site’s mode');
  assert.equal(await diag.locator('#reset-label').textContent(), 'Confirm reset site preferences');
  await diag.locator('#reset').click();
  await text(diag, '#theme-state', 'Dusk theme applied');
  assert.equal(await diag.locator('[data-mode=auto]').getAttribute('aria-pressed'), 'true');
  await diag.close();
  check('Diagnostics excludes keys; real mode switch and confirmed reset restore Auto');
  fs.writeFileSync(path.join(out, 'ui-results.json'), JSON.stringify({ ok: true, results, requests: requests.length }, null, 2));
} catch (error) {
  console.error(error);
  fs.writeFileSync(path.join(out, 'ui-results.json'), JSON.stringify({ ok: false, results, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}
