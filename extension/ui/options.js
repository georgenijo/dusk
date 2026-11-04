import { connectionStatus, renderConnection } from './connection.js';

const $ = (s) => document.querySelector(s);
const DEFAULTS = { provider: 'vercel', baseUrl: 'https://cpa-georgenijo.georgenijo.com/v1', apiKey: '', vercelKey: '', jevEnabled: true, debug: false };
let dirty = false;
let busy = false;
let forceUntested = false;
let revision = 0;
let loaded = false;

function notice(message, error = false) {
  $('#out').textContent = message;
  $('#out').hidden = !message;
  $('#out').dataset.error = String(error);
}

function formValues() {
  return {
    provider: $('#provider').value,
    baseUrl: $('#baseUrl').value.trim(),
    apiKey: $('#apiKey').value.trim(),
    vercelKey: $('#vercelKey').value.trim(),
    jevEnabled: $('#jevEnabled').checked,
    debug: $('#debug').checked,
  };
}

function localStatus() {
  const values = formValues();
  return { ...values, hasKey: !!(values.provider === 'vercel' ? values.vercelKey : values.apiKey) };
}

function showProvider() {
  const provider = $('#provider').value;
  $('#cpa').hidden = provider !== 'cpa';
  $('#vercel').hidden = provider !== 'vercel';
  $('#provider-help').textContent = provider === 'vercel'
    ? 'Connect directly with a Vercel AI Gateway key. Recommended for new setups.'
    : 'Use an existing CPA gateway and its client key.';
}

function showLocalStatus() {
  renderConnection($('#connection'), $('#connection-help'), localStatus(), { untested: true });
  if (dirty) {
    if (localStatus().hasKey) $('#connection').textContent = 'Unsaved changes';
    $('#connection-help').textContent = 'Changes are not saved. Save settings before testing.';
  }
}

async function refreshConnection() {
  const token = revision;
  const status = await connectionStatus();
  if (token !== revision || dirty || busy) return;
  renderConnection($('#connection'), $('#connection-help'), status, { untested: forceUntested });
}

async function load() {
  const token = revision;
  try {
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (token !== revision || dirty || busy) return;
    const s = { ...DEFAULTS, ...settings };
    $('#provider').value = s.provider === 'cpa' ? 'cpa' : 'vercel';
    for (const key of ['baseUrl', 'apiKey', 'vercelKey']) $('#' + key).value = s[key] || '';
    for (const key of ['jevEnabled', 'debug']) $('#' + key).checked = !!s[key];
    loaded = true;
    showProvider();
    await refreshConnection();
  } catch {
    notice('Could not load settings. Reopen this page to try again.', true);
  }
}

function setBusy(value) {
  busy = value;
  $('#settings-form').setAttribute('aria-busy', String(value));
  for (const control of document.querySelectorAll('input, select, button')) control.disabled = value;
}

function validate({ test = false } = {}) {
  for (const field of document.querySelectorAll('[aria-invalid]')) field.removeAttribute('aria-invalid');
  const s = formValues();
  if (test && !s.jevEnabled) {
    notice('Enable Jev and save settings before testing the connection.', true);
    $('#jevEnabled').focus();
    return false;
  }
  const key = $(s.provider === 'vercel' ? '#vercelKey' : '#apiKey');
  if (test && !key.value.trim()) {
    notice('Enter a provider key before testing the connection.', true);
    key.setAttribute('aria-invalid', 'true');
    key.focus();
    return false;
  }
  if (s.provider === 'cpa') {
    let valid = false;
    try {
      const url = new URL(s.baseUrl);
      valid = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {}
    if (!valid) {
      notice('Enter a valid HTTP or HTTPS CPA base URL without credentials.', true);
      $('#baseUrl').setAttribute('aria-invalid', 'true');
      $('#baseUrl').focus();
      return false;
    }
  }
  return true;
}

$('#settings-form').addEventListener('input', () => {
  if (!loaded) return;
  dirty = true;
  forceUntested = true;
  revision++;
  showProvider();
  showLocalStatus();
  notice('Unsaved changes.');
});
// Selects and checkboxes also emit change; input covers typing and immediate
// invalidation, while change covers browsers' select keyboard behavior.
$('#settings-form').addEventListener('change', () => {
  if (!loaded) return;
  dirty = true;
  forceUntested = true;
  revision++;
  showProvider();
  showLocalStatus();
  notice('Unsaved changes.');
});

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !loaded || !validate()) return;
  const values = formValues();
  revision++;
  setBusy(true);
  notice('Saving settings…');
  try {
    // Merge at save time, retaining settings fields introduced by other builds.
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...values } });
    dirty = false;
    forceUntested = true;
    showLocalStatus();
    notice('Settings saved. Use Test connection to verify them.');
  } catch {
    notice('Could not save settings. Your changes are still here; try saving again.', true);
  } finally {
    setBusy(false);
  }
});

$('#test').addEventListener('click', async () => {
  if (busy || !loaded || !validate({ test: true })) return;
  if (dirty) {
    notice('Save your changes before testing the connection.', true);
    $('#save').focus();
    return;
  }
  revision++;
  setBusy(true);
  $('#connection').textContent = 'Testing…';
  $('#connection').dataset.state = 'checking';
  $('#connection-help').textContent = 'Sending a small test request to the saved provider.';
  notice('Testing connection…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'jev',
      state: { image: { ext: 'svg', filenameHints: ['logo'], pixels: { transparentFraction: 0.7, meanLightness: 0.08, meanSaturation: 0.02 } } },
      questions: {
        treatment: {
          type: 'choice',
          instructions: 'How should this image be treated on a dark page?',
          criteria: { keep: 'Leave as is', invert: 'Invert lightness', dim: 'Dim slightly' },
        },
      },
    });
    forceUntested = false;
    const status = await connectionStatus();
    if (!result?.ok) {
      const error = result?.error || 'The extension did not return a response.';
      renderConnection($('#connection'), $('#connection-help'), { ...localStatus(), lastError: error });
      notice('Test failed. Check the key, endpoint and provider, then try again.', true);
    } else {
      // Only the worker can confirm that this success matches saved settings.
      renderConnection($('#connection'), $('#connection-help'), status);
      notice(status?.verified ? `Connection verified${Number.isFinite(result.ms) ? ` in ${result.ms} ms` : ''}.` : 'Jev responded, but the saved connection could not be verified. Try testing again.', !status?.verified);
    }
  } catch {
    forceUntested = true;
    renderConnection($('#connection'), $('#connection-help'), { ...localStatus(), lastError: 'No response from the extension.' });
    notice('Test could not finish. Reopen settings and try again.', true);
  } finally {
    setBusy(false);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || busy) return;
  if (changes.settings) {
    revision++;
    forceUntested = true;
    if (!dirty) load();
    else notice('Settings changed in another window. Save your form to keep these changes.');
  } else if (!dirty) refreshConnection();
});
load();
