import './pixels.js';

// Service worker: the only place that talks to Jev, and the only place that
// fetches cross-origin image bytes for local analysis.

const JEV_MODEL = 'typesafe-ai/jev';
const MAX_QUESTIONS = 64;
// Two routes to the same model: CPA's /v1/evaluations relay (client key), or
// Vercel AI Gateway's decision-model endpoint directly (vck_ key).
const VERCEL_URL = 'https://ai-gateway.vercel.sh/v4/ai/decision-model';
const DEFAULTS = { provider: 'vercel', baseUrl: 'https://cpa-georgenijo.georgenijo.com/v1', apiKey: '', vercelKey: '', jevEnabled: true };

async function settings() {
  const { settings: s } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(s || {}) };
}

async function recordStatus(patch) {
  const { jevStatus = {} } = await chrome.storage.local.get('jevStatus');
  await chrome.storage.local.set({ jevStatus: { ...jevStatus, ...patch, at: Date.now() } });
}

async function configurationId(cfg) {
  const key = cfg.provider === 'vercel' ? cfg.vercelKey : cfg.apiKey;
  const route = cfg.provider === 'vercel' ? VERCEL_URL : cfg.baseUrl.replace(/\/+$/, '') + '/evaluations';
  const bytes = new TextEncoder().encode(JSON.stringify([cfg.provider, route, key]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function connectionStatus() {
  const cfg = await settings();
  const hasKey = !!(cfg.provider === 'vercel' ? cfg.vercelKey : cfg.apiKey);
  const { jevStatus = {} } = await chrome.storage.local.get('jevStatus');
  const matching = hasKey && jevStatus.configurationId === await configurationId(cfg);
  return {
    provider: cfg.provider, hasKey, jevEnabled: cfg.jevEnabled,
    verified: !!(cfg.jevEnabled && matching && jevStatus.ok),
    lastError: matching ? jevStatus.error || null : null,
    lastVerifiedAt: matching ? jevStatus.lastVerifiedAt || null : null,
  };
}

async function evaluateChunk(cfg, state, questions) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  const started = performance.now();
  try {
    const direct = cfg.provider === 'vercel';
    const res = await fetch(direct ? VERCEL_URL : cfg.baseUrl.replace(/\/+$/, '') + '/evaluations', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${direct ? cfg.vercelKey : cfg.apiKey}`,
        ...(direct && {
          'ai-gateway-protocol-version': '0.0.1',
          'ai-gateway-auth-method': 'api-key',
          'ai-decision-model-specification-version': '4',
          'ai-model-id': JEV_MODEL,
        }),
      },
      body: JSON.stringify(
        direct ? { stateParts: [{ type: 'json', value: state }], questions } : { model: JEV_MODEL, state, questions },
      ),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch {}
      throw new Error(`HTTP ${res.status}${detail ? ': ' + detail.slice(0, 160) : ''}`);
    }
    const body = await res.json();
    if (!body || typeof body.answers !== 'object') throw new Error('bad response shape');
    return { answers: body.answers, ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

// Jev allows 64 questions per request; larger batches run as parallel chunks
// over the same state.
// Recent Jev calls (metadata only: route, question count, latency, outcome),
// shown in the popup's diagnostics. Lives until the worker is recycled.
const callLog = [];
function logCall(entry) {
  callLog.push({ t: new Date().toISOString(), ...entry });
  if (callLog.length > 100) callLog.shift();
  if (entry.error) console.warn('[Dusk] Jev call failed', entry);
  else console.debug('[Dusk] Jev call', entry);
}

// With settings.debug on, also keep full exchanges in memory for the test harness.
const debugLog = [];
function remember(cfg, entry) {
  if (!cfg.debug) return;
  debugLog.push({ ...entry, raw: JSON.stringify({ state: entry.state, questions: entry.questions }) });
  if (debugLog.length > 200) debugLog.shift();
}
globalThis.duskDebugLog = debugLog;

async function evaluate(state, questions, sender = {}) {
  const cfg = await settings();
  if (!cfg.jevEnabled) return { ok: false, error: 'disabled' };
  if (!(cfg.provider === 'vercel' ? cfg.vercelKey : cfg.apiKey)) return { ok: false, error: 'no API key (open Dusk options)' };
  const id = await configurationId(cfg);
  let host = null;
  try { if (sender.tab?.url) host = new URL(sender.tab.url).hostname; } catch {}
  const source = { source: sender.tab ? 'page' : 'settings', host, tabId: sender.tab?.id ?? null };
  const names = Object.keys(questions);
  const chunks = [];
  for (let i = 0; i < names.length; i += MAX_QUESTIONS) {
    chunks.push(Object.fromEntries(names.slice(i, i + MAX_QUESTIONS).map((n) => [n, questions[n]])));
  }
  try {
    const results = await Promise.all(chunks.map((q) => evaluateChunk(cfg, state, q)));
    const answers = Object.assign({}, ...results.map((r) => r.answers));
    const ms = Math.max(...results.map((r) => r.ms));
    remember(cfg, { state, questions, answers });
    logCall({ ...source, provider: cfg.provider, questions: names.length, chunks: chunks.length, ms });
    await recordStatus({ ok: true, error: null, lastMs: ms, questions: names.length, configurationId: id, lastVerifiedAt: Date.now() });
    return { ok: true, answers, ms };
  } catch (err) {
    let error = err.name === 'AbortError' ? 'timeout' : String(err.message || err);
    for (const key of [cfg.apiKey, cfg.vercelKey]) if (key) error = error.split(key).join('[redacted]');
    remember(cfg, { state, questions, error });
    logCall({ ...source, provider: cfg.provider, questions: names.length, chunks: chunks.length, error });
    await recordStatus({ ok: false, error, configurationId: id });
    return { ok: false, error };
  }
}

// Pixel statistics for an image, computed locally. Only these numbers (never
// the pixels or URL) are shared with Jev.
async function analyzeImage(url) {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > 8 * 1024 * 1024) return null;
    if (blob.type.includes('svg')) return blob.size < 512 * 1024 ? { svg: await blob.text() } : null;
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 64 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    return { width: bitmap.width, height: bitmap.height, mime: blob.type || 'unknown', ...pixelStats(ctx.getImageData(0, 0, w, h).data, w * h, w) };
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'jev') {
    evaluate(msg.state, msg.questions, sender).then(reply);
    return true;
  }
  if (msg.type === 'connectionStatus' || msg.type === 'workerLog') {
    connectionStatus().then((connection) => reply(msg.type === 'workerLog' ? { ...connection, calls: callLog } : connection)).catch(() => reply(null));
    return true;
  }
  if (msg.type === 'analyzeImages') {
    Promise.all(msg.urls.map(analyzeImage)).then(reply);
    return true;
  }
  return false;
});
