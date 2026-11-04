const $ = (s) => document.querySelector(s);
let tabId;

async function send(msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null;
  }
}

const MODE_TEXT = {
  themed: 'Dusk theme',
  native: "Site's own dark mode",
  'already-dark': 'Already dark',
  off: 'Off',
  starting: 'Starting…',
  error: 'Error',
};

async function refresh() {
  const s = await send({ type: 'status' });
  if (!s) {
    $('#state').innerHTML = '<span class="muted">Dusk can’t run on this page.</span>';
    return;
  }
  $('#host').textContent = s.host;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === (s.siteMode || 'auto'));
  const jev = s.jev;
  const noKey = /no API key/.test(jev.lastError || '');
  const counts = s.adjustments.reduce((m, a) => ((m[a] = (m[a] || 0) + 1), m), {});
  const adapted = Object.entries(counts).map(([a, n]) => a.replace(/_/g, ' ') + (n > 1 ? ` ×${n}` : '')).join(', ');
  const jevLine = !s.jevAllowed
    ? 'Jev off for this page (private site)'
    : jev.lastError
      ? `Jev unavailable: ${jev.lastError}`
      : jev.calls
        ? `Jev: ${jev.decisions} decisions · ${jev.calls} calls · ${jev.lastMs ?? '–'} ms`
        : 'Jev: waiting';
  const q = s.quality == null ? '–' : `${(s.quality + 1).toFixed(1)} / 4`;
  $('#state').innerHTML = `
    <div class="row"><span>Applied</span><b>${MODE_TEXT[s.mode] || s.mode}</b></div>
    ${s.native ? `<div class="row"><span>Native switch</span><b>${s.native.kind}${s.native.value ? '=' + s.native.value : ''}</b></div>` : ''}
    ${s.enabled ? `<div class="row"><span>Jev quality</span><b>${q}</b></div>
    <div class="row"><span>Palette</span><b>${s.theme.tone} · ${s.theme.accent} accents</b></div>
    <div class="row"><span>Images</span><b>${s.stats.images.invert} inverted · ${s.stats.images.backdrop} tiled · ${s.stats.images.dim} dimmed</b></div>
    ${adapted ? `<div class="row"><span>Adapted</span><b>${adapted}</b></div>` : ''}` : ''}
    ${noKey
      ? `<button id="setup" class="primary wide">Set up Jev — it tunes each site</button>`
      : `<div class="small ${jev.lastError ? 'warn' : 'muted'}">${jevLine}</div>`}`;
  $('#setup')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

document.querySelectorAll('#modes button').forEach((b) =>
  b.addEventListener('click', async () => {
    await send({ type: 'setMode', mode: b.dataset.mode });
    setTimeout(refresh, 600);
  }),
);

document.querySelectorAll('[data-fb]').forEach((b) =>
  b.addEventListener('click', async () => {
    $('#result').textContent = 'Asking Jev…';
    const r = await send({ type: 'feedback', kind: b.dataset.fb });
    $('#result').textContent = r?.adjustment ? `Applied: ${r.adjustment.replace(/_/g, ' ')}` : 'Already at the limit for that change';
    refresh();
  }),
);

$('#pick').addEventListener('click', async () => {
  // The picker runs in the page; closing the popup hands it the mouse.
  send({ type: 'pick' });
  window.close();
});

// Everything Dusk knows about this page, minus page text and URLs, for bug reports.
$('#diag').addEventListener('click', async () => {
  const [page, worker] = await Promise.all([send({ type: 'diagnostics' }), chrome.runtime.sendMessage({ type: 'workerLog' }).catch(() => null)]);
  const report = JSON.stringify({ at: new Date().toISOString(), page, worker }, null, 2);
  await navigator.clipboard.writeText(report);
  $('#result').textContent = `Diagnostics copied (${Math.round(report.length / 1024)} KB)`;
});

$('#reset').addEventListener('click', async () => {
  await send({ type: 'reset' });
  window.close();
});

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  tabId = tab.id;
  refresh();
  setInterval(refresh, 1500);
});
