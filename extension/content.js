const PAGE_SOURCE = "quota-pilot-page";
const EXTENSION_SOURCE = "quota-pilot-oauth-extension";

function reply(event, type, payload = {}) {
  window.postMessage(
    {
      source: EXTENSION_SOURCE,
      type,
      nonce: event.data.nonce,
      ...payload,
    },
    event.origin,
  );
}

window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.origin !== window.location.origin ||
    event.data?.source !== PAGE_SOURCE
  )
    return;

  if (event.data.type === "extension-ping") {
    reply(event, "extension-pong", { installed: true });
    return;
  }

  if (!["oauth-start", "oauth-stop"].includes(event.data.type)) return;
  chrome.runtime.sendMessage(
    {
      type: event.data.type,
      state: event.data.state,
      origin: window.location.origin,
    },
    (response) => {
      const error = chrome.runtime.lastError;
      reply(event, `${event.data.type}-result`, {
        ok: !error && response?.ok === true,
        error: error?.message || response?.error,
      });
    },
  );
});
