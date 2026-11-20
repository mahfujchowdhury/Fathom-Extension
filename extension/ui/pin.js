/* Fathom — first-run page.
 *
 * Opened once from background/service-worker.js when the extension is first
 * installed. There is nothing to configure here: it explains how to pin the
 * action, then sends the reader to a page where the dock can be tried.
 */

(() => {
  "use strict";

  const TRY_URL = "https://example.com";
  const CLOSE_DELAY = 900;

  const $ = (selector) => document.querySelector(selector);

  function setStatus(message) {
    const status = $("#status");
    if (status) status.textContent = message;
  }

  function closeThisTab() {
    /* window.close() only works on script-opened tabs, so fall back to the
       tabs API (neither create nor remove needs the "tabs" permission). */
    try {
      window.close();
    } catch {
      /* ignore — the tabs fallback below handles it */
    }
    try {
      if (!chrome || !chrome.tabs || typeof chrome.tabs.getCurrent !== "function") return;
      chrome.tabs.getCurrent((tab) => {
        if (!tab || typeof tab.id !== "number") return;
        try {
          const pending = chrome.tabs.remove(tab.id);
          if (pending && typeof pending.catch === "function") pending.catch(() => {});
        } catch {
          /* tab already gone */
        }
      });
    } catch {
      /* not an extension context — nothing else to do */
    }
  }

  async function openTryPage() {
    const button = $("#try-it");
    if (button) button.disabled = true;
    setStatus("Opening example.com in a new tab…");

    let opened = false;
    try {
      if (chrome && chrome.tabs && typeof chrome.tabs.create === "function") {
        await chrome.tabs.create({ url: TRY_URL, active: true });
        opened = true;
      }
    } catch {
      opened = false;
    }

    if (!opened) {
      try {
        const openedWindow = window.open(TRY_URL, "_blank");
        if (openedWindow) {
          try {
            openedWindow.opener = null;
          } catch {
            /* cross-origin — already detached */
          }
          opened = true;
        }
      } catch {
        opened = false;
      }
    }

    if (!opened) {
      if (button) button.disabled = false;
      setStatus("Could not open a tab. Visit example.com yourself, then open the dock with Ctrl/Cmd+Shift+Y.");
      return;
    }

    setStatus("Opened example.com. Closing this tab…");
    setTimeout(closeThisTab, CLOSE_DELAY);
  }

  function boot() {
    try {
      const manifest = chrome.runtime.getManifest();
      if (manifest && manifest.version) {
        const footer = $("#pin-version");
        if (footer) footer.textContent = `Fathom ${manifest.version}`;
      }
    } catch {
      /* version is decoration only */
    }

    const button = $("#try-it");
    if (button) button.addEventListener("click", openTryPage);

    const heading = $("#pin-title");
    if (heading) heading.focus({ preventScroll: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
