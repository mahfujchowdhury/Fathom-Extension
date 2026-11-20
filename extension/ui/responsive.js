/*
 * Fathom — responsive viewer page (ui/responsive.html?url=<encoded>).
 *
 * One URL, several real iframes. Each frame is laid out at its device's true
 * CSS width, so media queries, 100vw and 100vh behave as on the device; the
 * finished card is then displayed with `transform: scale()`. The viewport is
 * never faked by resizing the page after load.
 */

(() => {
  "use strict";

  const CHANNEL = "fathom/v1";
  const DEVICES_KEY = "fathomResponsiveDevicesV1";
  const ZOOM_KEY = "fathomResponsiveZoomV1";
  const MAX_DEVICES = 6;
  const DEFAULT_WIDTHS = [375, 768, 1440];
  const DEFAULT_HEIGHT = 780;
  const HEADER_HEIGHT = 38; // keep in sync with .device-header in responsive.css
  const GUTTERS = 24; // breathing room at both ends of the row, CSS px
  const FALLBACK_GAP = 18; // fallback for #stage { gap }
  const MIN_SCALE = 0.2;
  const WORKER_TIMEOUT = 800;

  // [category label, device widths in CSS px]
  const PRESETS = [
    ["Mobile", [320, 360, 375, 390, 414, 430]],
    ["Tablet", [768, 834, 1024]],
    ["Laptop", [1280, 1440]],
    ["Desktop", [1680, 1920]],
  ];
  const HEIGHTS = [600, 780, 900, 1080, "full"];

  /* ------------------------------------------------------------------- dom --- */

  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  const emptyState = $("empty-state");
  const sidebar = $("sidebar");
  const sidebarToggle = $("sidebar-toggle");
  const presetHost = $("preset-groups");
  const countNote = $("device-count");
  const clearButton = $("clear-devices");
  const urlForm = $("url-form");
  const urlInput = $("url-input");
  const urlError = $("url-error");
  const reloadButton = $("reload-all");
  const fitToggle = $("fit-toggle");
  const zoomInput = $("zoom");
  const zoomOutput = $("zoom-output");
  const openLink = $("open-link");
  const statusEl = $("status");

  const state = {
    url: "",
    widths: DEFAULT_WIDTHS.slice(),
    cards: new Map(), // width -> { el, inner, viewport, frame, select, height, placeholder }
    fit: true,
    zoom: 100,
    scale: 1,
  };

  /* --------------------------------------------------------------- helpers --- */

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

  function setStatus(message) {
    statusEl.textContent = message;
  }

  function showError(message) {
    urlError.textContent = message || "";
    urlError.hidden = !message;
    if (message) urlInput.setAttribute("aria-invalid", "true");
    else urlInput.removeAttribute("aria-invalid");
  }

  function describeUrl(value) {
    try {
      return new URL(value).host || "the page";
    } catch (_) {
      return "the page";
    }
  }

  /* --------------------------------------------------------------- storage --- */

  function hasStorage() {
    try {
      return typeof chrome !== "undefined" && Boolean(chrome.storage && chrome.storage.local);
    } catch (_) {
      return false;
    }
  }

  async function storeSet(items) {
    if (!hasStorage()) return;
    try {
      await chrome.storage.local.set(items);
    } catch (_) {
      /* storage is a convenience; the viewer works without it */
    }
  }

  let zoomTimer = 0;

  function persistDevices() {
    void storeSet({ [DEVICES_KEY]: state.widths.slice() });
  }

  function persistZoom() {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      void storeSet({ [ZOOM_KEY]: { fit: state.fit, percent: state.zoom } });
    }, 180);
  }

  function sanitizeWidths(raw) {
    const seen = new Set();
    const widths = [];
    if (!Array.isArray(raw)) return widths;
    for (const entry of raw) {
      const width = Math.round(Number(entry));
      if (!Number.isFinite(width) || width < 240 || width > 3840 || seen.has(width)) continue;
      seen.add(width);
      widths.push(width);
      if (widths.length >= MAX_DEVICES) break;
    }
    return widths;
  }

  async function restoreState() {
    if (!hasStorage()) return;
    try {
      const stored = await chrome.storage.local.get([DEVICES_KEY, ZOOM_KEY]);
      if (Array.isArray(stored[DEVICES_KEY])) state.widths = sanitizeWidths(stored[DEVICES_KEY]);
      const zoom = stored[ZOOM_KEY];
      if (typeof zoom === "number") {
        state.fit = false;
        state.zoom = clamp(Math.round(zoom), 20, 100);
      } else if (zoom && typeof zoom === "object") {
        state.fit = zoom.fit !== false;
        state.zoom = clamp(Math.round(Number(zoom.percent)) || 100, 20, 100);
      }
    } catch (_) {
      state.widths = DEFAULT_WIDTHS.slice();
    }
  }

  /* ------------------------------------------------------ worker messages --- */

  function sendToWorker(payload) {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
        return Promise.resolve(null);
      }
      const reply = chrome.runtime.sendMessage({ channel: CHANNEL, ...payload });
      if (reply && typeof reply.then === "function") return reply.catch(() => null);
      return Promise.resolve(reply || null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  /** Best effort: the page must work even when the worker never answers. */
  function enableFraming(url) {
    if (!url) return Promise.resolve(null);
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), WORKER_TIMEOUT));
    return Promise.race([sendToWorker({ operation: "responsive-enable", url }), timeout]);
  }

  function disableFraming() {
    void sendToWorker({ operation: "responsive-disable" });
  }

  /* ------------------------------------------------------------------ urls --- */

  function parseUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) return { error: "Enter a page URL to preview." };
    const schemed =
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
      /^(mailto|javascript|data|file|about|chrome|ftp):/i.test(value);
    let parsed;
    try {
      parsed = new URL(schemed ? value : `https://${value}`);
    } catch (_) {
      return { error: "That does not look like a valid URL." };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "Only http:// and https:// pages can be previewed." };
    }
    return { url: parsed.href };
  }

  function updateOpenLink() {
    if (state.url) {
      openLink.href = state.url;
      openLink.removeAttribute("aria-disabled");
      openLink.removeAttribute("tabindex");
    } else {
      openLink.removeAttribute("href");
      openLink.setAttribute("aria-disabled", "true");
      openLink.setAttribute("tabindex", "-1");
    }
  }

  function frameTitle(width) {
    return `${width} px preview of ${describeUrl(state.url)}`;
  }

  async function commitUrl(raw, { fromUser = true } = {}) {
    const parsed = parseUrl(raw);
    if (parsed.error) {
      showError(parsed.error);
      setStatus(parsed.error);
      urlInput.focus();
      return false;
    }

    showError("");
    const changed = parsed.url !== state.url;
    state.url = parsed.url;
    urlInput.value = state.url;
    updateOpenLink();

    // Let the worker install the frame-ancestors rule before frames navigate.
    await enableFraming(state.url);

    for (const card of state.cards.values()) {
      if (card.placeholder) {
        card.placeholder.remove();
        card.placeholder = null;
      }
      card.frame.src = state.url;
      card.frame.title = frameTitle(card.width);
    }

    if (fromUser) {
      const host = describeUrl(state.url);
      if (!state.cards.size) setStatus(`Loaded ${host}. Pick a width in the sidebar to preview it.`);
      else if (changed) setStatus(`Loaded ${host} in ${plural(state.cards.size, "width")}.`);
      else setStatus(`Reloaded ${plural(state.cards.size, "preview")}.`);
    }
    return true;
  }

  function reloadAll() {
    if (!state.url) {
      setStatus("Load a page first — there is nothing to preview.");
      urlInput.focus();
      return;
    }
    if (!state.cards.size) {
      setStatus("Pick a width in the sidebar, then reload.");
      return;
    }
    for (const card of state.cards.values()) {
      if (card.placeholder) continue;
      card.frame.src = state.url;
    }
    void enableFraming(state.url);
    setStatus(`Reloaded ${plural(state.cards.size, "preview")}.`);
  }

  /* ----------------------------------------------------------------- cards --- */

  function heightLabel(value) {
    return value === "full" ? "Full" : `${value} px`;
  }

  function addCard(width) {
    const inner = el("div", { class: "device-inner" });
    const title = el("span", { class: "device-title", text: `${width} px` });

    const select = el("select", {
      class: "device-height",
      "aria-label": `Viewport height for the ${width} px preview`,
    });
    for (const option of HEIGHTS) {
      select.append(el("option", { value: String(option), text: heightLabel(option) }));
    }
    select.value = String(DEFAULT_HEIGHT);

    const close = el(
      "button",
      { type: "button", class: "device-close", title: "Remove", "aria-label": `Remove the ${width} px preview` },
      el("span", { "aria-hidden": "true", text: "×" })
    );
    const header = el("header", { class: "device-header" }, title, select, close);
    const frame = el("iframe", {
      title: `${width} px preview`,
      loading: "lazy",
      referrerpolicy: "no-referrer",
    });
    const viewport = el("div", { class: "device-viewport" }, frame);
    const card = { width, height: DEFAULT_HEIGHT, el: null, inner, viewport, frame, select, placeholder: null };

    if (state.url) {
      frame.src = state.url;
      frame.title = frameTitle(width);
    } else {
      card.placeholder = el(
        "div",
        { class: "device-placeholder" },
        el("strong", { text: "No page loaded" }),
        el("span", { text: "Enter a URL above and press Load." })
      );
      viewport.append(card.placeholder);
    }

    inner.append(header, viewport);
    card.el = el(
      "article",
      { class: "device", dataset: { width: String(width) }, "aria-label": `${width} px preview` },
      inner
    );

    select.addEventListener("change", () => {
      card.height = select.value === "full" ? "full" : Number(select.value) || DEFAULT_HEIGHT;
      layout();
      setStatus(`${width} px preview height: ${heightLabel(card.height)}.`);
    });
    close.addEventListener("click", () => removeDevice(width));

    state.cards.set(width, card);
    stage.append(card.el);
  }

  function renderCards() {
    for (const width of state.widths) {
      if (!state.cards.has(width)) addCard(width);
    }
  }

  function removeDevice(width) {
    const card = state.cards.get(width);
    if (!card) return;
    const hadFocus = card.el.contains(document.activeElement);
    card.el.remove();
    state.cards.delete(width);
    state.widths = state.widths.filter((value) => value !== width);
    afterDevicesChange(`Removed the ${width} px preview.`);
    if (hadFocus) stage.focus();
  }

  function toggleDevice(width) {
    if (!Number.isInteger(width)) return;
    if (state.widths.includes(width)) {
      removeDevice(width);
      return;
    }
    if (state.widths.length >= MAX_DEVICES) {
      setStatus(`Up to ${MAX_DEVICES} widths at once — remove one first.`);
      return;
    }
    state.widths.push(width);
    addCard(width);
    afterDevicesChange(`Added the ${width} px preview.`);
  }

  function clearDevices() {
    if (!state.cards.size) {
      setStatus("No widths to clear.");
      return;
    }
    for (const card of state.cards.values()) card.el.remove();
    state.cards.clear();
    state.widths = [];
    afterDevicesChange("Cleared all widths.");
    clearButton.focus();
  }

  function afterDevicesChange(message) {
    persistDevices();
    syncSidebar();
    layout();
    setStatus(message);
  }

  /* ---------------------------------------------------------------- layout --- */

  function stageMetrics() {
    const styles = getComputedStyle(stage);
    const padX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
    const padY = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
    return {
      available: Math.max(160, stage.clientWidth - padX),
      gap: parseFloat(styles.columnGap) || FALLBACK_GAP,
      fullHeight: Math.max(600, Math.round(stage.clientHeight - padY)),
    };
  }

  /**
   * Fit: z = (availableWidth - gutters) / (sum of widths + gaps), clamped to
   * 0.2–1. Manual zoom uses the range value directly. Each wrapper is sized to
   * width*z by (height + header)*z so scaled cards never overlap.
   */
  function layout() {
    const metrics = stageMetrics();
    const widths = [...state.cards.keys()];
    let scale = state.zoom / 100;

    if (widths.length && state.fit) {
      const total = widths.reduce((sum, width) => sum + width, 0);
      const gaps = Math.max(0, widths.length - 1) * metrics.gap;
      scale = (metrics.available - GUTTERS) / (total + gaps);
    }
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    state.scale = clamp(scale, MIN_SCALE, 1);

    for (const [width, card] of state.cards) {
      const height = card.height === "full" ? metrics.fullHeight : card.height;
      card.inner.style.width = `${width}px`;
      card.inner.style.transform = `scale(${state.scale})`;
      card.viewport.style.width = `${width}px`;
      card.viewport.style.height = `${height}px`;
      card.el.style.width = `${width * state.scale}px`;
      card.el.style.height = `${(height + HEADER_HEIGHT) * state.scale}px`;
    }

    const isEmpty = state.cards.size === 0;
    emptyState.hidden = !isEmpty;
    stage.classList.toggle("is-empty", isEmpty);

    const percent = Math.round(state.scale * 100);
    zoomInput.value = String(percent);
    fitToggle.setAttribute("aria-pressed", String(state.fit));
    zoomOutput.textContent = state.fit ? `Fit · ${percent}%` : `${percent}%`;
    zoomInput.setAttribute("aria-valuetext", state.fit ? `Fit, ${percent} percent` : `${percent} percent`);
  }

  let layoutFrame = 0;

  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      layout();
    });
  }

  /* --------------------------------------------------------------- sidebar --- */

  function buildPresets() {
    const fragment = document.createDocumentFragment();
    PRESETS.forEach(([label, widths], index) => {
      const headingId = `preset-group-${index}`;
      const chips = el("div", { class: "chips" });
      for (const width of widths) {
        chips.append(
          el("button", {
            type: "button",
            class: "chip",
            dataset: { width: String(width) },
            "aria-pressed": "false",
            "aria-label": `${width} pixels`,
            text: String(width),
          })
        );
      }
      fragment.append(
        el(
          "section",
          { class: "preset-group", "aria-labelledby": headingId },
          el("h3", { class: "preset-label", id: headingId, text: label }),
          chips
        )
      );
    });
    presetHost.append(fragment);
    presetHost.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (chip) toggleDevice(Number(chip.dataset.width));
    });
  }

  function syncSidebar() {
    for (const chip of presetHost.querySelectorAll(".chip")) {
      const width = Number(chip.dataset.width);
      chip.setAttribute("aria-pressed", state.widths.includes(width) ? "true" : "false");
    }
    countNote.textContent = `${state.widths.length} of ${MAX_DEVICES} widths shown`;
  }

  /* ---------------------------------------------------------------- events --- */

  function onFitToggle() {
    state.fit = !state.fit;
    if (!state.fit) state.zoom = clamp(Math.round(state.scale * 100), 20, 100);
    persistZoom();
    layout();
    setStatus(state.fit ? "Zoom: fit to screen." : `Zoom: ${Math.round(state.scale * 100)}%.`);
  }

  function onZoomInput() {
    state.fit = false;
    state.zoom = clamp(Math.round(Number(zoomInput.value)) || 100, 20, 100);
    persistZoom();
    layout();
  }

  function onSidebarToggle() {
    const collapsed = !sidebar.hidden;
    sidebar.hidden = collapsed;
    sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    layout();
    setStatus(collapsed ? "Width list hidden." : "Width list shown.");
  }

  function bindEvents() {
    urlForm.addEventListener("submit", (event) => {
      event.preventDefault();
      commitUrl(urlInput.value).catch(() => setStatus("Could not load that page."));
    });
    urlInput.addEventListener("input", () => {
      if (!urlError.hidden) showError("");
    });
    reloadButton.addEventListener("click", reloadAll);
    clearButton.addEventListener("click", clearDevices);
    fitToggle.addEventListener("click", onFitToggle);
    zoomInput.addEventListener("input", onZoomInput);
    zoomInput.addEventListener("change", () => setStatus(`Zoom: ${Math.round(state.scale * 100)}%.`));
    sidebarToggle.addEventListener("click", onSidebarToggle);
    openLink.addEventListener("click", (event) => {
      if (!state.url) {
        event.preventDefault();
        urlInput.focus();
      }
    });

    if (typeof ResizeObserver === "function") new ResizeObserver(scheduleLayout).observe(stage);
    addEventListener("resize", scheduleLayout);
    addEventListener("pagehide", () => {
      disableFraming();
      void storeSet({ [ZOOM_KEY]: { fit: state.fit, percent: state.zoom } });
    });
  }

  /* ------------------------------------------------------------------ boot --- */

  async function init() {
    buildPresets();
    bindEvents();

    const requested = new URLSearchParams(location.search).get("url") || "";
    let startError = "";
    if (requested.trim()) {
      const parsed = parseUrl(requested);
      if (parsed.error) {
        startError = parsed.error;
        urlInput.value = requested;
        showError(parsed.error);
      } else {
        state.url = parsed.url;
        urlInput.value = parsed.url;
      }
    }

    await restoreState();
    updateOpenLink();
    if (state.url) await enableFraming(state.url);

    renderCards();
    syncSidebar();
    layout();

    if (state.url) setStatus(`Showing ${describeUrl(state.url)} at ${plural(state.widths.length, "width")}.`);
    else if (startError) setStatus(startError);
    else setStatus("Paste a page URL to start comparing widths.");
  }

  init().catch(() => setStatus("The viewer could not start. Reload the page."));
})();
