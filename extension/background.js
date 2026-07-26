// Receives scrobble messages from content scripts and forwards them to the
// Endless Watch server. Debounces duplicates so a re-watched last-few-minutes
// doesn't double-fire.

const recent = new Map(); // key -> timestamp
const DEDUPE_MS = 6 * 60 * 60 * 1000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'scrobble') return;
  handle(msg.data).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
  return true; // async response
});

async function handle(data) {
  const { server, token } = await chrome.storage.local.get(['server', 'token']);
  if (!server || !token) return { ok: false, error: 'not signed in' };

  const key = `${data.title}|${data.season}|${data.episode || data.epName}`;
  const now = Date.now();
  if (recent.get(key) && now - recent.get(key) < DEDUPE_MS) return { ok: false, error: 'duplicate' };

  const res = await fetch(server.replace(/\/$/, '') + '/api/scrobble', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...data }),
  });
  const out = await res.json().catch(() => ({}));
  if (out.ok) {
    recent.set(key, now);
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#3ddc84' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  }
  return out;
}
