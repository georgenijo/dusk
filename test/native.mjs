// Regression coverage for native appearance and zero unnecessary Jev requests.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '../extension');
const profile = fs.mkdtempSync('/tmp/dusk-native-');
const requests = [];
const { server, mode } = await start({ port: 8767, root: path.join(here, 'fixtures'), log: requests });
const settings = { provider:'cpa', apiKey:'native-test-key', baseUrl:'http://127.0.0.1:8767/v1', jevEnabled:true };
let context;
let checks = 0;
const pass = (name) => { checks++; console.log(`PASS ${name}`); };
try {
  context = await chromium.launchPersistentContext(profile, {
    channel:'chromium', headless:true, viewport:{width:1200,height:800}, colorScheme:'light',
    args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  await worker.evaluate((settings) => chrome.storage.local.set({settings}), settings);
  const page = await context.newPage();
  const send = (message) => worker.evaluate(async ({url,message}) => {
    const [tab] = await chrome.tabs.query({url});
    return chrome.tabs.sendMessage(tab.id,message);
  }, {url:page.url(),message});
  const diagnostic = () => send({type:'diagnostics'});
  async function waitMode(mode) {
    await page.waitForFunction(() => !document.getElementById('dusk-preflight'));
    for (let i=0;i<100;i++) {
      if ((await diagnostic()).status.mode === mode) return;
      await page.waitForTimeout(100);
    }
    assert.equal((await diagnostic()).status.mode,mode);
  }
  // Route the fixture under Gmail's actual hostname without using an account
  // or sending network traffic to Gmail. Exercises its longer startup window.
  const fixture = fs.readFileSync(path.join(here,'fixtures/native-app.html'),'utf8');
  await page.route('http://mail.google.com:8767/**', route => route.fulfill({contentType:'text/html',body:fixture}));
  let before = requests.length;
  await page.goto('http://mail.google.com:8767/native-app.html?delay=2600');
  await waitMode('already-dark');
  let d = await diagnostic();
  assert.equal(d.engine.writes,0); assert.equal(d.status.jev.calls,0); assert.equal(requests.length,before);
  assert.equal(d.jevAllowed,false);
  assert.equal(await page.$eval('#app',e=>getComputedStyle(e).backgroundColor),'rgb(32, 33, 36)');
  pass('Delayed Gmail-like app: transparent roots, native dark app, zero theme writes and requests');
  for (const type of ['feedback','pick','reverify']) await send({type,kind:'hard_to_read'});
  assert.equal(requests.length,before); assert.equal((await diagnostic()).engine.writes,0);
  pass('Native page ignores feedback, picker and verification without model work');
  await page.goto('http://delayed.localhost:8767/native-app.html');
  await waitMode('already-dark');
  assert.equal((await diagnostic()).engine.writes,0); assert.equal(requests.length,before);
  pass('Public delayed native app also makes zero model requests');

  for (const inline of [false,true]) {
    const origin = `http://${inline ? 'inline-' : ''}wrapper.localhost:8767/`;
    const wrapper = inline
      ? '<div class="shell" style="background:#202124;color:#e8eaed"><h1>Native wrapper</h1></div>'
      : '<div class="shell night"><h1>Native wrapper</h1></div>';
    await page.route(origin,route=>route.fulfill({contentType:'text/html',body:`<!doctype html><style>html,body{margin:0}.shell{min-height:100vh;background:white;color:#222}.shell.night{background:#202124;color:#e8eaed}</style><body>${wrapper}</body>`}));
    await page.goto(origin);
    await waitMode('already-dark');
    assert.equal((await diagnostic()).engine.writes,0);
    await page.locator('.shell').evaluate((el,inline)=>{
      if (inline) { el.style.background='#fff'; el.style.color='#222'; }
      else el.classList.remove('night');
    },inline);
    await waitMode('themed');
    assert.ok((await diagnostic()).engine.writes>0);
    pass(`Ordinary wrapper ${inline ? 'inline style' : 'class'} toggle resumes Dusk when native dark becomes light`);
  }

  // A marker without a rendered dark palette must not make a light site skip.
  await page.route('http://marker.localhost:8767/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html dark><style>body{background:white;color:#222;min-height:100vh}</style><body><h1>Still light</h1></body></html>'}));
  await page.goto('http://marker.localhost:8767/');
  await waitMode('themed');
  assert.ok((await diagnostic()).engine.writes>0);
  pass('Unstyled dark marker does not suppress the local theme');

  // Start light, become native dark with transitions, then return to light.
  await page.route('http://switch.localhost:8767/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><style>html,body{margin:0}body{background:white;color:#222;min-height:100vh;transition:background-color 2s,color 2s}</style><body><h1>Switch theme</h1></body>'}));
  await page.goto('http://switch.localhost:8767/');
  await waitMode('themed');
  await page.waitForFunction(()=>document.documentElement.hasAttribute('data-dusk-adapted'));
  await page.waitForTimeout(600);
  assert.equal((await diagnostic()).status.mode,'themed');
  pass('Transitioning light page stays themed after source probes');
  await page.evaluate(()=>{ const style=document.createElement('style'); style.textContent='body.night{background:#181818;color:#eee}'; document.head.append(style); document.body.classList.add('night'); });
  await waitMode('already-dark');
  await page.waitForTimeout(2200);
  d = await diagnostic(); before = requests.length;
  assert.equal(await page.locator('[data-dusk]').count(),0);
  assert.equal(await page.$eval('body',e=>getComputedStyle(e).backgroundColor),'rgb(24, 24, 24)');
  await page.waitForTimeout(1800);
  assert.equal(requests.length,before);
  pass('Later native theme restores source styles and stops follow-up requests');
  await page.evaluate(()=>document.body.classList.remove('night'));
  await waitMode('themed');
  assert.ok(await page.locator('[data-dusk]').count());
  pass('Native to light switch resumes local theming');

  // A request already in flight may finish after a native theme appears.
  // Its result must never repaint or trigger quality/follow-up requests.
  mode.delay = 1200;
  await page.route('http://inflight.localhost:8767/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><style>body{background:white;color:#222;min-height:100vh}</style><body><h1>Late native appearance</h1></body>'}));
  before = requests.length;
  await page.goto('http://inflight.localhost:8767/');
  await waitMode('themed');
  for (let i=0; requests.length === before && i<100; i++) await page.waitForTimeout(20);
  assert.equal(requests.length,before+1);
  await page.evaluate(()=>{ const style=document.createElement('style'); style.textContent='body{background:#181818;color:#eee}'; document.head.append(style); });
  await waitMode('already-dark');
  await page.waitForTimeout(1500);
  d = await diagnostic();
  assert.equal(d.status.mode,'already-dark'); assert.equal(d.status.quality,null);
  assert.equal(requests.length,before+1); assert.equal(await page.locator('[data-dusk]').count(),0);
  mode.delay = 120;
  pass('Late model answer is discarded after native handoff, without a quality request');

  await page.route('http://sheet.localhost:8767/**',async route=>{
    if (route.request().url().endsWith('/dark.css')) {
      await new Promise(resolve=>setTimeout(resolve,900));
      return route.fulfill({contentType:'text/css',body:'body{background:#181818;color:#eee}'});
    }
    return route.fulfill({contentType:'text/html',body:'<!doctype html><style>body{background:white;color:#222;min-height:100vh}</style><body><h1>Late stylesheet</h1></body>'});
  });
  await page.goto('http://sheet.localhost:8767/');
  await waitMode('themed');
  await page.waitForFunction(()=>document.documentElement.hasAttribute('data-dusk-adapted'));
  await page.evaluate(()=>{ const link=document.createElement('link'); link.rel='stylesheet'; link.href='/dark.css'; document.head.append(link); });
  await waitMode('already-dark');
  assert.equal(await page.$eval('body',e=>getComputedStyle(e).backgroundColor),'rgb(24, 24, 24)');
  pass('Late stylesheet load rechecks native colors even while Dusk owns inline colors');

  // Always explicitly overrides native appearance, while Off leaves it alone.
  await worker.evaluate(()=>chrome.storage.local.set({'site:delayed.localhost':{mode:'on',roles:{},images:{},overrides:{},history:[]}}));
  await page.goto('http://delayed.localhost:8767/native-app.html?delay=1');
  await waitMode('themed');
  await page.waitForTimeout(700);
  assert.equal((await diagnostic()).status.mode,'themed');
  pass('Always mode intentionally overrides a native theme');

  await worker.evaluate((settings)=>chrome.storage.local.set({settings:{...settings,apiKey:''}}),settings);
  before = requests.length;
  await page.goto('http://no-key.localhost:8767/blog.html');
  await waitMode('themed');
  await page.waitForFunction(()=>document.documentElement.hasAttribute('data-dusk-adapted'));
  d = await diagnostic();
  assert.equal(d.status.jev.calls,0); assert.equal(requests.length,before);
  assert.match(d.status.jev.lastError,/no API key/);
  pass('Missing key: local theme works with zero request attempts and a clear setup error');
  console.log(`${checks}/${checks} native regressions passed`);
} finally {
  await context?.close(); server.close(); fs.rmSync(profile,{recursive:true,force:true});
}
