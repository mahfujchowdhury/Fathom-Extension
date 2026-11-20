/*
 * Fathom — service worker (classic script, no imports).
 *
 * Responsibilities:
 *   1. Own the toolbar click: inject the workspace bundle, toggle the overlay.
 *   2. Keep per-tab overlay state so a reload restores what was open.
 *   3. Meter screenshots: short-lived tokens, per-tab quota, minimum spacing.
 *   4. Downloads, asset fetching for ZIP export, and the responsive viewer tab.
 *   5. Declarative Net Request: strip frame-blocking headers for the viewer tab.
 *
 * Everything privileged lives here; the page-side bundle never touches
 * chrome.downloads, chrome.tabs.captureVisibleTab or the DNR API directly.
 */

const CH = "fathom/v1";
const VERSION = "0.1.0";

/*
 * The capture history must live in the *extension's* origin: a content script's
 * IndexedDB belongs to the page, so the dashboard would never see it. The store
 * module is origin-agnostic, so the worker loads the same file.
 */
importScripts("../lib/capture-store.js");

/* Order matters — see docs/SPEC-interfaces.md. */
const CONTENT_FILES = [
  "lib/core.js",
  "lib/settings.js",
  "lib/capture-store.js",
  "lib/analyze.js",
  "lib/inspect.js",
  "lib/zip.js",
  "lib/export.js",
  "lib/designmd.js",
  "content/workspace.js",
  "content/tool-export.js",
  "content/tool-brief.js",
  "content/tool-images.js",
  "content/tool-palette.js",
  "content/tool-type.js",
  "content/tool-measure.js",
  "content/tool-designmd.js",
  "content/tool-text.js",
  "content/tool-capture.js",
  "content/tool-responsive.js",
  "content/tool-fonts.js",
  "content/tool-arrange.js",
];

const stateKey = (tabId) => `fathomOpenTabV1_${tabId}`;
const GRANTS_KEY = "fathomCaptureGrantsV1";
const CAPTURE_TTL_MS = 120_000;
const CAPTURE_QUOTA = 80;
const CAPTURE_SPACING_MS = 600;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;

const pendingInjections = new Map();

/* ------------------------------------------------------------- injection --- */

function messageTarget(documentId) {
  return documentId ? { documentId } : { frameId: 0 };
}

async function currentDocument(tabId, expected = {}) {
  let frame;
  try {
    frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  } catch {
    return null;
  }
  if (!frame || !/^https?:\/\//i.test(frame.url || "")) return null;
  if (frame.documentLifecycle && frame.documentLifecycle !== "active") return null;
  if (expected.documentId && frame.documentId && frame.documentId !== expected.documentId) return null;
  return frame;
}

async function ensureInjected(tabId, documentId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { channel: CH, operation: "ping" }, messageTarget(documentId));
    if (res && res.ok) return;
  } catch {
    /* not injected yet, or the frame moved on */
  }

  const key = `${tabId}:${documentId || "current"}`;
  if (!pendingInjections.has(key)) {
    const task = chrome.scripting
      .executeScript({
        target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] },
        files: CONTENT_FILES,
      })
      .finally(() => pendingInjections.delete(key));
    pendingInjections.set(key, task);
  }
  await pendingInjections.get(key);
}

/* ---------------------------------------------------------------- settings --- */

const dashboardUrl = (route) =>
  chrome.runtime.getURL("ui/dashboard.html") + (route ? `#${route}` : "");

function openDashboard(route) {
  return chrome.tabs.create({ url: dashboardUrl(route) });
}

/** Right-clicking the toolbar icon is the discoverable, permanent way in. */
function installContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "fathom-dashboard",
      title: "Fathom dashboard",
      contexts: ["action"],
    });
    chrome.contextMenus.create({
      id: "fathom-history",
      title: "Capture history",
      contexts: ["action"],
      parentId: "fathom-dashboard",
    });
  });
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "fathom-dashboard") openDashboard().catch(() => {});
  else if (info.menuItemId === "fathom-history") openDashboard("history").catch(() => {});
});

/* --------------------------------------------------------- workspace state --- */

async function remember(tabId, state) {
  const key = stateKey(tabId);
  if (state.open) {
    await chrome.storage.session.set({ [key]: { open: true, collapsed: state.collapsed === true } });
  } else {
    await chrome.storage.session.remove(key);
  }
}

/* ------------------------------------------------------------------ click --- */

chrome.action.onClicked.addListener((tab) => {
  toggleWorkspace(tab).catch((err) => {
    console.warn("[Fathom]", err.message);
    if (Number.isInteger(tab?.id)) {
      chrome.action.setBadgeText({ tabId: tab.id, text: "!" }).catch(() => {});
      chrome.action.setTitle({
        tabId: tab.id,
        title: `Fathom — ${err.message}`,
      }).catch(() => {});
    }
  });
});

async function toggleWorkspace(tab) {
  if (!Number.isInteger(tab?.id)) return;
  const doc = await currentDocument(tab.id);
  if (!doc) throw new Error("open an http or https page to use Fathom");

  await ensureInjected(tab.id, doc.documentId);
  const res = await chrome.tabs.sendMessage(
    tab.id,
    { channel: CH, operation: "toggle" },
    messageTarget(doc.documentId),
  );
  if (!res || res.ok === false) throw new Error(res?.error || "the toolbox could not open");

  await remember(tab.id, { open: res.open });
  await chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
  await chrome.action.setTitle({ tabId: tab.id, title: "Fathom — click to open or close" }).catch(() => {});
}

/* -------------------------------------------------------------- restoring --- */

async function restore(tabId, frame) {
  const stored = (await chrome.storage.session.get(stateKey(tabId)))[stateKey(tabId)];
  if (!stored || !stored.open) return;
  const doc = await currentDocument(tabId, frame);
  if (!doc) return;
  await ensureInjected(tabId, doc.documentId);
  await chrome.tabs.sendMessage(
    tabId,
    { channel: CH, operation: "restore-workspace", collapsed: stored.collapsed === true },
    messageTarget(doc.documentId),
  );
}

chrome.webNavigation.onDOMContentLoaded.addListener((frame) => {
  if (frame.frameId !== 0 || !/^https?:\/\//i.test(frame.url || "")) return;
  restore(frame.tabId, frame).catch(() => {});
});

chrome.webNavigation.onCommitted.addListener((frame) => {
  if (frame.frameId !== 0) return;
  if (!frame.transitionQualifiers?.includes("forward_back")) return;
  if (!/^https?:\/\//i.test(frame.url || "")) return;
  restore(frame.tabId, frame).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(stateKey(tabId)).catch(() => {});
  captureSessions.delete(tabId);
  persistGrants().catch(() => {});
  clearFrameRules(tabId).catch(() => {});
});

/* --------------------------------------------------------------- captures --- */

const captureSessions = new Map();
let captureQueue = Promise.resolve();
let lastCaptureAt = 0;

const grantsReady = (async () => {
  try {
    const stored = (await chrome.storage.session.get(GRANTS_KEY))[GRANTS_KEY] || [];
    for (const [tabId, grant] of stored) {
      if (Number.isInteger(tabId) && grant && grant.expires > Date.now()) captureSessions.set(tabId, grant);
    }
  } catch {
    /* session storage is a cache, not a source of truth */
  }
})();

function persistGrants() {
  return chrome.storage.session.set({ [GRANTS_KEY]: [...captureSessions] });
}

/** Screenshots are serialised globally: captureVisibleTab is rate limited. */
function captureTask(task) {
  const next = captureQueue.catch(() => {}).then(() => grantsReady).then(task);
  captureQueue = next.catch(() => {});
  return next;
}

async function captureTab(tab) {
  const wait = Math.max(0, CAPTURE_SPACING_MS - (Date.now() - lastCaptureAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));

  /* captureVisibleTab only reads the foreground tab. Another tab may have
     taken focus since the user started the capture, so bring this one back
     rather than failing with a confusing error. */
  let live = await chrome.tabs.get(tab.id);
  if (!live.active) {
    await chrome.windows.update(live.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
    live = await chrome.tabs.get(tab.id);
  }
  if (!live.active || live.windowId !== tab.windowId) {
    throw new Error("Keep this tab active while capturing.");
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  lastCaptureAt = Date.now();
  return { dataUrl };
}

function requireGrant(tabId, token, sender) {
  const grant = captureSessions.get(tabId);
  const document = sender.documentId || sender.url;
  if (!grant || grant.token !== token) throw new Error("Start a new capture first.");
  if (grant.document !== document) throw new Error("The page changed while capturing.");
  if (grant.expires < Date.now()) throw new Error("This capture expired. Start again.");
  return grant;
}

/* ---------------------------------------------------------------- assets --- */

function base64FromBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchAsset(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid asset URL.");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Only http(s) assets can be fetched.");
  if (url.username || url.password) throw new Error("Asset URLs must not contain credentials.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url.href, { credentials: "omit", redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`Asset returned HTTP ${res.status}.`);

    const declared = Number(res.headers.get("content-length"));
    if (declared > MAX_ASSET_BYTES) throw new Error("That asset is too large to bundle.");

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel();
        throw new Error("That asset is too large to bundle.");
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      base64: base64FromBytes(bytes),
      mime: res.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------- downloads --- */

const DATA_URL = /^data:(?:image\/(?:png|jpeg|webp|gif|svg\+xml)|text\/(?:html|css|plain|markdown)|application\/(?:json|zip|pdf|octet-stream));base64,[a-z0-9+/=]+$/i;

function safeName(name) {
  if (typeof name !== "string" || !name) throw new Error("Invalid filename.");
  if (name.length > 180) throw new Error("Invalid filename.");
  if (/[\\/<>:"|?*\u0000-\u001f]/.test(name) || name.startsWith(".")) throw new Error("Invalid filename.");
  return name;
}

async function saveDataUrl(dataUrl, name) {
  if (typeof dataUrl !== "string" || !DATA_URL.test(dataUrl)) throw new Error("That file cannot be downloaded.");
  if (dataUrl.length > 64 * 1024 * 1024) throw new Error("That file is too large to download.");
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: safeName(name),
    conflictAction: "uniquify",
    saveAs: false,
  });
  return { downloadId };
}

/* ------------------------------------------------- frame headers (viewer) --- */

const RULE_BASE = 800000;

function ruleIdFor(tabId) {
  return RULE_BASE + (tabId % 99_999);
}

async function enableFrameRules(tabId, url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error("The viewer needs a valid http(s) URL.");
  }
  if (!/^https?:/.test(origin)) throw new Error("The viewer only works with http(s) pages.");

  const rule = {
    id: ruleIdFor(tabId),
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" },
      ],
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: ["sub_frame"],
      requestDomains: [new URL(origin).hostname],
    },
  };

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleIdFor(tabId)],
    addRules: [rule],
  });
  return { ruleId: rule.id };
}

async function clearFrameRules(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleIdFor(tabId)] });
}

/* ---------------------------------------------------------------- router --- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== CH) return;

  const tab = sender.tab;
  const reply = (promise) => {
    promise.then(
      (value) => sendResponse({ ok: true, ...(value || {}) }),
      (err) => sendResponse({ ok: false, error: err.message || String(err) }),
    );
    return true;
  };

  switch (message.operation) {
    case "workspace-state":
      if (!tab) return;
      remember(tab.id, { open: message.open === true, collapsed: message.collapsed === true });
      sendResponse({ ok: true });
      return;

    case "workspace-state-read": {
      const tabId = Number.isInteger(message.tabId) ? message.tabId : tab?.id;
      if (!Number.isInteger(tabId)) {
        sendResponse({ ok: false, error: "Unknown tab." });
        return;
      }
      return reply(
        chrome.storage.session.get(stateKey(tabId)).then((stored) => ({
          open: stored[stateKey(tabId)]?.open === true,
        })),
      );
    }

    case "capture-start":
      if (!tab) {
        sendResponse({ ok: false, error: "Captures must start from a page." });
        return;
      }
      return reply(
        captureTask(async () => {
          for (const [tabId, grant] of captureSessions) {
            if (grant.expires < Date.now()) captureSessions.delete(tabId);
          }
          const token = crypto.randomUUID();
          captureSessions.set(tab.id, {
            token,
            document: sender.documentId || sender.url,
            expires: Date.now() + CAPTURE_TTL_MS,
            remaining: CAPTURE_QUOTA,
          });
          await persistGrants();
          return { token };
        }),
      );

    case "capture-shot":
      if (!tab) {
        sendResponse({ ok: false, error: "Captures must run in a page." });
        return;
      }
      return reply(
        captureTask(async () => {
          const grant = requireGrant(tab.id, message.token, sender);
          if (grant.remaining <= 0) throw new Error("This capture used its screen budget. Start again.");
          grant.remaining -= 1;
          await persistGrants();
          return captureTab(tab);
        }),
      );

    case "capture-end":
      if (!tab) {
        sendResponse({ ok: true });
        return;
      }
      return reply(
        captureTask(async () => {
          if (captureSessions.get(tab.id)?.token === message.token) captureSessions.delete(tab.id);
          await persistGrants();
          return {};
        }),
      );

    case "capture-fetch": {
      const tabId = Number.isInteger(message.tabId) ? message.tabId : null;
      if (!tabId) {
        sendResponse({ ok: false, error: "Which tab?" });
        return;
      }
      return reply(
        chrome.tabs
          .sendMessage(tabId, { channel: CH, operation: "capture-fetch" }, { frameId: 0 })
          .then((res) => {
            if (!res || res.ok === false) throw new Error(res?.error || "That tab has no capture.");
            return res;
          }),
      );
    }

    case "capture-open-editor": {
      const tabId = Number.isInteger(message.tabId) ? message.tabId : tab?.id;
      if (!Number.isInteger(tabId)) {
        sendResponse({ ok: false, error: "Which tab?" });
        return;
      }
      return reply(
        chrome.tabs.create({ url: chrome.runtime.getURL(`ui/capture.html?tab=${tabId}`) }).then((created) => ({
          tabId: created.id,
        })),
      );
    }

    case "download-file":
      return reply(saveDataUrl(message.dataUrl, message.name));

    case "fetch-asset":
      return reply(fetchAsset(message.url));

    case "responsive-open": {
      const target = typeof message.url === "string" ? message.url : tab?.url;
      if (!target || !/^https?:\/\//i.test(target)) {
        sendResponse({ ok: false, error: "Open an http(s) page first." });
        return;
      }
      return reply(
        chrome.tabs
          .create({ url: chrome.runtime.getURL(`ui/responsive.html?url=${encodeURIComponent(target)}`) })
          .then((created) => ({ tabId: created.id })),
      );
    }

    case "responsive-enable":
      if (!tab) {
        sendResponse({ ok: false, error: "The viewer must run in a tab." });
        return;
      }
      return reply(enableFrameRules(tab.id, message.url || tab.url));

    case "responsive-disable":
      if (!tab) {
        sendResponse({ ok: true });
        return;
      }
      return reply(clearFrameRules(tab.id).then(() => ({})));

    case "open-dashboard":
      return reply(openDashboard(message.route).then((created) => ({ tabId: created.id })));

    case "capture-save": {
      const capture = message.capture || {};
      if (typeof capture.dataUrl !== "string" || !capture.dataUrl.startsWith("data:image/")) {
        sendResponse({ ok: false, error: "That capture could not be stored." });
        return;
      }
      const limit = Math.max(0, Math.min(100, Number(capture.limit) || 10));
      return reply(
        globalThis.Fathom.captureStore
          .add(
            {
              dataUrl: capture.dataUrl,
              thumb: typeof capture.thumb === "string" ? capture.thumb : capture.dataUrl,
              width: Number(capture.width) || 0,
              height: Number(capture.height) || 0,
              url: typeof capture.url === "string" ? capture.url : "",
              mode: typeof capture.mode === "string" ? capture.mode : "capture",
            },
            limit,
          )
          .then((id) => ({ id })),
      );
    }

    default:
      return;
  }
});

/* ------------------------------------------------------------- lifecycle --- */

chrome.runtime.onInstalled.addListener((details) => {
  installContextMenu();
  /* First run lands on the "pin me to the toolbar" page, like the original. */
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("ui/pin.html") }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(installContextMenu);

chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
