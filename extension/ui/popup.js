import { connectionStatus, renderConnection } from './connection.js';

const $ = (s) => document.querySelector(s);
let tabId;
let tabUrl = '';
let pageStatus = null;
let connection = null;
let busy = false;
let refreshing = false;
let awaitingReload = false;
let resetConfirm = false;

function notice(message, error = false) {
  $('#result').textContent = message;
  $('#result').hidden = !message;
  $('#result').dataset.error = String(error);
}

async function send(message) {
  if (tabId == null) return null;
  try { return await chrome.tabs.sendMessage(tabId, message); } catch { return null; }
}

function supported() {
  try { return ['http:', 'https:'].includes(new URL(tabUrl).protocol); } catch { return false; }
}

function updateControls() {
  const available = !!pageStatus && supported();
  for (const b of document.querySelectorAll('#modes button')) {
    b.disabled = busy || !available;
    b.setAttribute('aria-pressed', String(available && b.dataset.mode === (pageStatus?.siteMode || 'auto')));
  }
  const canAdjust = available && pageStatus.enabled === true && pageStatus.mode === 'themed';
  for (const b of document.querySelectorAll('[data-fb], #pick')) b.disabled = busy || !canAdjust;
  $('#reverify').disabled = busy || !canAdjust || pageStatus.jevAllowed !== true || !connection?.hasKey || connection?.jevEnabled === false;
  $('#reset').disabled = busy || !available;
  $('#reload').disabled = busy;
  $('#feedback-help').textContent = canAdjust
    ? 'Apply an adjustment to this page. Jev may refine it when available.'
    : 'Adjustments are available only while Dusk is applying a theme.';
}

const MODE_HELP = {
  auto: 'Prefer the site’s dark mode; otherwise use Dusk.',
  on: 'Always apply Dusk’s theme on this site.',
  off: 'Leave this site unchanged. No automatic Jev requests.',
};
const THEME = {
  checking: ['Checking appearance…', 'Checking for the site’s own dark mode.'],
  starting: ['Checking appearance…', 'Preparing this page.'],
  themed: ['Dusk theme applied', 'Dusk is adapting this page’s colors.'],
  native: ['Site’s own dark mode', 'This site handles dark mode.'],
  'already-dark': ['Already dark', 'No theme needed. This page is already dark.'],
  off: ['Dusk is off for this site', 'Choose Auto or Always to use Dusk here.'],
  error: ['Could not apply a theme', 'Refresh this tab to try again.'],
};

function renderPage() {
  const s = pageStatus;
  $('#appearance').hidden = !s || !supported();
  $('#feedback').hidden = !s || !supported();
  $('#reload').hidden = !!s && s.mode !== 'error';
  const attempts = Number.isFinite(s?.jev?.calls) ? s.jev.calls : 0;
  $('#attempts').textContent = String(attempts);
  if (!supported()) {
    $('#theme-state').textContent = 'Unsupported page';
    $('#theme-help').textContent = 'Browser and extension pages can’t be themed.';
    $('#reload').hidden = true;
    $('#mode-help').textContent = 'Open a website to use these controls.';
  } else if (!s) {
    $('#theme-state').textContent = awaitingReload ? 'Reconnecting to this tab…' : 'Refresh this tab';
    $('#theme-help').textContent = 'Refresh this tab to connect Dusk.';
    $('#mode-help').textContent = 'Site controls become available after Dusk connects.';
  } else {
    const [title, help] = THEME[s.mode] || ['Checking appearance…', 'Waiting for the page’s theme status.'];
    $('#theme-state').textContent = title;
    $('#theme-help').textContent = help;
    $('#mode-help').textContent = MODE_HELP[s.siteMode] || MODE_HELP.auto;
  }
  let requestHelp = 'Attempts on this page, not billed tokens.';
  if (!supported() || !s) requestHelp = '0 automatic requests while this page is unavailable.';
  else if (s.siteMode === 'off' || s.mode === 'off') requestHelp = attempts
    ? 'Automatic requests paused while this site is off; earlier attempts remain shown.'
    : '0 automatic requests while this site is off.';
  else if (s.jevAllowed === false) requestHelp = attempts
    ? 'Automatic requests paused on this private page; earlier attempts remain shown.'
    : '0 automatic requests on this private page.';
  else if (s.mode === 'native') requestHelp = attempts
    ? 'Automatic requests paused for native dark mode; earlier attempts remain shown.'
    : '0 automatic requests: the site handles dark mode.';
  else if (s.mode === 'already-dark') requestHelp = attempts
    ? 'Automatic requests paused: the page is already dark. Earlier attempts remain shown.'
    : '0 automatic requests: the page is already dark.';
  else if (connection?.jevEnabled === false) requestHelp = attempts
    ? 'Automatic requests paused while Jev is disabled; earlier attempts remain shown.'
    : '0 automatic requests while Jev is disabled.';
  else if (connection?.hasKey === false) requestHelp = 'Add a key to allow Jev requests. Counts are attempts, not tokens.';
  else if (s.jev?.lastError) requestHelp = `Latest page attempt failed: ${s.jev.lastError}`;
  $('#request-help').textContent = requestHelp;
  updateControls();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [status, currentConnection] = await Promise.all([supported() ? send({ type: 'status' }) : null, connectionStatus()]);
    pageStatus = status;
    connection = currentConnection;
    if (status) awaitingReload = false;
    renderConnection($('#connection'), $('#connection-help'), connection);
    $('#setup').hidden = connection?.hasKey !== false;
    $('#connection-help').hidden = connection?.hasKey === false;
    renderPage();
  } finally { refreshing = false; }
}

async function act(message, pending, success) {
  if (busy) return;
  busy = true;
  document.body.setAttribute('aria-busy', 'true');
  updateControls();
  notice(pending);
  try {
    const result = await send(message);
    if (result == null) throw new Error('No page response');
    if (result.error) throw new Error(String(result.error));
    notice(typeof success === 'function' ? success(result) : success);
  } catch {
    notice('The page did not complete that action. Refresh this tab and try again.', true);
  } finally {
    busy = false;
    document.body.setAttribute('aria-busy', 'false');
    await refresh();
  }
}

document.querySelectorAll('#modes button').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.mode === (pageStatus?.siteMode || 'auto')) return;
  awaitingReload = true;
  act({ type: 'setMode', mode: button.dataset.mode }, 'Changing site appearance…', 'Site preference saved. Refreshing the page…');
}));

document.querySelectorAll('[data-fb]').forEach((button) => button.addEventListener('click', () => {
  act({ type: 'feedback', kind: button.dataset.fb }, 'Applying page feedback…', (result) => result.adjustment
    ? `Applied: ${String(result.adjustment).replaceAll('_', ' ')}.`
    : 'No further adjustment was applied. Try a different change.');
}));
$('#reverify').addEventListener('click', () => {
  act({ type: 'reverify' }, 'Rechecking the page with Jev…', (result) => result.adjustment
    ? `Applied: ${String(result.adjustment).replaceAll('_', ' ')}.`
    : 'Recheck finished. No additional adjustment was applied.');
});
$('#pick').addEventListener('click', () => {
  // The picker waits for page interaction; keep the request alive while handing
  // the pointer back to the page.
  send({ type: 'pick' });
  window.close();
});

for (const id of ['settings', 'setup']) $('#' + id).addEventListener('click', async () => {
  try { await chrome.runtime.openOptionsPage(); } catch { notice('Could not open Jev settings. Try again.', true); }
});

$('#reload').addEventListener('click', async () => {
  if (tabId == null) return;
  awaitingReload = true;
  notice('Refreshing this tab…');
  try {
    await chrome.tabs.reload(tabId);
    await refresh();
  } catch { notice('Could not refresh this tab. Use the browser’s refresh button.', true); }
});

// Diagnostics include the page report and worker metadata, never settings.
// Redact known keys even if an upstream error accidentally echoes one.
$('#diag').addEventListener('click', async () => {
  $('#diag').disabled = true;
  try {
    const [page, worker, { settings = {} }] = await Promise.all([
      send({ type: 'diagnostics' }),
      chrome.runtime.sendMessage({ type: 'workerLog' }),
      chrome.storage.local.get('settings'),
    ]);
    const secrets = [settings.apiKey, settings.vercelKey].filter((key) => typeof key === 'string' && key.length);
    const report = JSON.stringify({ page, worker }, (key, value) => {
      if (/^(settings|apiKey|vercelKey|authorization|accessToken|secret)$/i.test(key)) return undefined;
      if (typeof value === 'string') for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
      return value;
    }, 2);
    await navigator.clipboard.writeText(report);
    notice('Diagnostics copied. Provider keys are excluded.');
  } catch { notice('Could not copy diagnostics. Try again with this popup focused.', true); }
  finally { $('#diag').disabled = false; }
});

$('#reset').addEventListener('click', () => {
  if (!resetConfirm) {
    resetConfirm = true;
    $('#reset-label').textContent = 'Confirm reset site preferences';
    notice('Removes this site’s mode and saved adjustments. Click again to reset.');
    return;
  }
  resetConfirm = false;
  $('#reset-label').textContent = 'Reset site preferences';
  awaitingReload = true;
  act({ type: 'reset' }, 'Resetting site preferences…', 'Site preferences removed. Refreshing the page…');
});

chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') refresh(); });
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  tabId = tab?.id;
  tabUrl = tab?.url || '';
  try { $('#host').textContent = supported() ? new URL(tabUrl).hostname : 'Browser page'; } catch { $('#host').textContent = 'No active website'; }
  refresh();
  setInterval(refresh, 1500);
}).catch(() => {
  renderPage();
  notice('Could not find the active tab. Reopen Dusk on a website.', true);
});
