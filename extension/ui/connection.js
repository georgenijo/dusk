// Presentation only. Verification belongs to the service worker, which ties it
// to the selected provider, endpoint and key fingerprint.
export function describeConnection(status, { untested = false } = {}) {
  if (!status) return { label: 'Unavailable', state: 'failed', help: 'Could not read the connection. Reopen Dusk to try again.' };
  const route = status.provider === 'cpa' ? 'CPA gateway' : 'Vercel AI Gateway';
  if (!status.hasKey) return { label: 'Not configured', state: 'missing', help: 'Add a provider key in Jev settings.' };
  if (status.jevEnabled === false) return { label: 'Disabled', state: 'disabled', help: 'Jev is turned off. Your saved key is kept.' };
  if (status.unavailable) return { label: 'Not verified', state: 'untested', help: 'Open Jev settings to test this saved connection.' };
  if (untested) return { label: 'Saved, not tested', state: 'untested', help: 'Test the saved settings to verify the connection.' };
  if (status.lastError) return { label: 'Failed', state: 'failed', help: `Connection failed: ${status.lastError}` };
  if (status.verified === true) return { label: 'Connected', state: 'connected', help: `Verified through ${route}.` };
  return { label: 'Saved, not tested', state: 'untested', help: `Key saved for ${route}. Test the connection in settings.` };
}

export function renderConnection(badge, help, status, options) {
  const description = describeConnection(status, options);
  badge.textContent = description.label;
  badge.dataset.state = description.state;
  help.textContent = description.help;
}

export async function connectionStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'connectionStatus' }).catch(() => null);
  if (status) return status;
  // A newly updated popup can briefly outlive its old service worker. Key
  // presence is still known locally; do not hide setup behind a runtime error.
  try {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const provider = settings.provider || 'vercel';
    return { provider, hasKey: !!(provider === 'cpa' ? settings.apiKey : settings.vercelKey), jevEnabled: settings.jevEnabled !== false, verified: false, unavailable: true };
  } catch { return null; }
}
