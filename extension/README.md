# Quota Pilot OAuth extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `extension/` folder.
5. Reload the dashboard tab.

The extension only watches the active OAuth callback at `localhost:1455`. It stores one short-lived `state` in `chrome.storage.session`, redirects the matching callback to the dashboard origin, then clears the state. It does not proxy quota requests or store tokens.
