const $ = (s) => document.querySelector(s);
const DEFAULTS = { provider: 'cpa', baseUrl: 'https://cpa-georgenijo.georgenijo.com/v1', apiKey: '', vercelKey: '', jevEnabled: true, debug: false };
let provider = 'cpa';

function showProvider() {
  for (const b of document.querySelectorAll('#provider button')) b.classList.toggle('on', b.dataset.p === provider);
  $('#cpa').hidden = provider !== 'cpa';
  $('#vercel').hidden = provider !== 'vercel';
}

async function load() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  provider = s.provider;
  $('#baseUrl').value = s.baseUrl;
  $('#apiKey').value = s.apiKey;
  $('#vercelKey').value = s.vercelKey;
  $('#jevEnabled').checked = s.jevEnabled;
  $('#debug').checked = s.debug;
  showProvider();
}

async function save() {
  await chrome.storage.local.set({
    settings: {
      provider,
      baseUrl: $('#baseUrl').value.trim(),
      apiKey: $('#apiKey').value.trim(),
      vercelKey: $('#vercelKey').value.trim(),
      jevEnabled: $('#jevEnabled').checked,
      debug: $('#debug').checked,
    },
  });
}

document.querySelectorAll('#provider button').forEach((b) =>
  b.addEventListener('click', () => {
    provider = b.dataset.p;
    showProvider();
  }),
);

$('#save').addEventListener('click', async () => {
  await save();
  $('#out').textContent = 'Saved';
});

$('#test').addEventListener('click', async () => {
  await save();
  $('#out').textContent = 'Calling Jev…';
  const r = await chrome.runtime.sendMessage({
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
  $('#out').textContent = r.ok ? `Jev answered "${r.answers.treatment?.choice}" in ${r.ms} ms` : `Failed: ${r.error}`;
  $('#out').className = 'small ' + (r.ok ? 'ok' : 'warn');
});

load();
