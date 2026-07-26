// ViddyPod Cookie Bridge — background service worker
//
// Listens for YouTube-domain cookie changes and pushes the full set to the
// local ViddyPod Desktop Agent over an authenticated localhost endpoint.

const AGENT_URL = 'http://127.0.0.1:17421';
const DOMAINS = ['.youtube.com', '.google.com', '.googlevideo.com'];
const DEBOUNCE_MS = 3000;
// Chrome clamps alarm periods to >= 1 min for packed extensions. The desktop
// app marks us disconnected after 3 min of silence, so 1 min survives a couple
// of missed wakeups.
const HEARTBEAT_MINUTES = 1;
// Cookies rarely change; a full re-push every 10 min is enough on top of the
// change-triggered pushes.
const COOKIE_REPUSH_MS = 10 * 60 * 1000;

let debounceHandle = null;

// --- Cookie push ----------------------------------------------------------

async function getPairToken() {
  const data = await chrome.storage.local.get(['pairToken']);
  return data.pairToken || null;
}

async function collectCookies() {
  const all = [];
  for (const domain of DOMAINS) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      all.push(...cookies);
    } catch (e) {
      console.warn('[ViddyPod] cookies.getAll failed for', domain, e);
    }
  }
  return all;
}

async function pushCookies() {
  const pairToken = await getPairToken();
  if (!pairToken) {
    return { ok: false, reason: 'not-paired' };
  }
  const cookies = await collectCookies();
  try {
    const res = await fetch(`${AGENT_URL}/cookies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pairToken}`,
      },
      body: JSON.stringify({ cookies }),
    });
    const result = {
      ok: res.ok,
      count: cookies.length,
      status: res.status,
    };
    await chrome.storage.local.set({
      lastSync: {
        at: new Date().toISOString(),
        ...result,
      },
    });
    if (!res.ok) console.warn('[ViddyPod] push failed:', res.status);
    return result;
  } catch (e) {
    console.warn('[ViddyPod] push error:', e);
    await chrome.storage.local.set({
      lastSync: { at: new Date().toISOString(), ok: false, error: String(e) },
    });
    return { ok: false, error: String(e) };
  }
}

async function ping() {
  const pairToken = await getPairToken();
  try {
    const res = await fetch(`${AGENT_URL}/ping`, {
      headers: pairToken ? { 'Authorization': `Bearer ${pairToken}` } : {},
    });
    return { reachable: true, authed: res.ok, status: res.status };
  } catch (e) {
    return { reachable: false, error: String(e) };
  }
}

// --- Event listeners (must be registered at top level in MV3 SWs) ---------

chrome.cookies.onChanged.addListener((info) => {
  if (!info.cookie) return;
  const domain = info.cookie.domain || '';
  if (!DOMAINS.some((d) => domain === d || domain.endsWith(d))) return;
  if (debounceHandle) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    pushCookies();
  }, DEBOUNCE_MS);
});

// Alarms survive service-worker teardown, so this only needs to cover the
// cases where one is genuinely absent: first install, browser restart, or an
// extension reload. It must be a get-then-create — calling create() outright
// REPLACES an existing alarm and restarts its countdown, and this file's top
// level re-runs on every worker wake-up (cookies.onChanged fires constantly
// while browsing YouTube). An unconditional create() there would push the
// heartbeat out by a minute on every cookie change and starve it entirely.
chrome.alarms.get('heartbeat', (existing) => {
  if (!existing) chrome.alarms.create('heartbeat', { periodInMinutes: HEARTBEAT_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'heartbeat') return;
  (async () => {
    // The ping is what keeps the desktop app's "connected" light on; it is
    // cheap enough to run every minute.
    await ping();
    const { lastSync } = await chrome.storage.local.get(['lastSync']);
    const staleSince = lastSync && lastSync.ok ? Date.parse(lastSync.at) : 0;
    if (Date.now() - staleSince >= COOKIE_REPUSH_MS) await pushCookies();
  })();
});

// --- Messaging API (for popup) --------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'setPairToken') {
        await chrome.storage.local.set({ pairToken: msg.token });
        sendResponse({ ok: true });
        // Do an immediate push so the user sees it work
        pushCookies();
      } else if (msg.type === 'clearPairToken') {
        await chrome.storage.local.remove('pairToken');
        sendResponse({ ok: true });
      } else if (msg.type === 'syncNow') {
        const result = await pushCookies();
        sendResponse(result);
      } else if (msg.type === 'getStatus') {
        const pairToken = await getPairToken();
        const pingResult = await ping();
        const stored = await chrome.storage.local.get(['lastSync']);
        sendResponse({
          paired: !!pairToken,
          ping: pingResult,
          lastSync: stored.lastSync || null,
        });
      } else {
        sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async response
});
