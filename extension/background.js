const CALLBACK_PATH = "/auth/callback";
const PENDING_KEY = "pendingOAuth";

function validState(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function localhostCallback(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      url.port === "1455" &&
      url.pathname === CALLBACK_PATH
      ? url
      : null;
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    !sender.tab?.id ||
    !["oauth-start", "oauth-stop"].includes(message.type)
  ) {
    sendResponse({ ok: false, error: "invalid_message" });
    return;
  }
  if (!validState(message.state) || typeof message.origin !== "string") {
    sendResponse({ ok: false, error: "invalid_oauth_state" });
    return;
  }
  if (message.type === "oauth-start") {
    chrome.storage.session
      .set({
        [PENDING_KEY]: {
          state: message.state,
          origin: message.origin,
          tabId: sender.tab.id,
          expiresAt: Date.now() + 10 * 60 * 1000,
        },
      })
      .then(() => sendResponse({ ok: true }));
  } else {
    chrome.storage.session.get(PENDING_KEY).then((result) => {
      const pending = result[PENDING_KEY];
      if (pending?.state === message.state)
        chrome.storage.session.remove(PENDING_KEY);
      sendResponse({ ok: true });
    });
  }
  return true;
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const callback = localhostCallback(details.url);
  if (!callback) return;
  const result = await chrome.storage.session.get(PENDING_KEY);
  const pending = result[PENDING_KEY];
  if (
    !pending ||
    pending.expiresAt <= Date.now() ||
    pending.state !== callback.searchParams.get("state")
  ) {
    if (pending?.expiresAt <= Date.now())
      await chrome.storage.session.remove(PENDING_KEY);
    return;
  }
  await chrome.storage.session.remove(PENDING_KEY);
  const target = new URL(pending.origin);
  target.pathname = "/api/oauth/codex/callback";
  target.search = callback.search;
  target.hash = "";
  await chrome.tabs.update(details.tabId, { url: target.href });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const result = await chrome.storage.session.get(PENDING_KEY);
  if (result[PENDING_KEY]?.tabId === tabId)
    await chrome.storage.session.remove(PENDING_KEY);
});
