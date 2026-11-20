/*
 * Fathom — capture editor.
 * Composes the pending screenshot (background + padding + radius + shadow)
 * and exports PNG/JPEG. Classic script: no imports, chrome.* only.
 */
(() => {
  "use strict";

  const CHANNEL = "fathom/v1";
  const PREVIEW_BUDGET = 12_000_000; // preview canvas pixels (device px)
  const MAX_DIM = 16_384; // max export dimension per side
  const MAX_AREA = 40_000_000; // max export area in px
  const DEFAULT_CUSTOM = "#141217";
  const SHADOWS = {
    none: { blur: 0, offsetY: 0, alpha: 0 }, soft: { blur: 18, offsetY: 6, alpha: 0.35 },
    medium: { blur: 40, offsetY: 14, alpha: 0.45 }, hard: { blur: 72, offsetY: 24, alpha: 0.55 },
  };
  const SOLIDS = [
    { id: "ink", label: "Ink", color: "#0c0b0e" },
    { id: "charcoal", label: "Charcoal", color: "#1c1822" },
    { id: "plum", label: "Plum", color: "#2b2037" },
    { id: "lilac", label: "Lilac", color: "#c29aef" },
    { id: "paper", label: "Paper", color: "#f3eef9" },
    { id: "white", label: "White", color: "#ffffff" },
    { id: "pine", label: "Pine", color: "#14342f" },
    { id: "clay", label: "Clay", color: "#3a2a24" },
  ];
  const GRADIENTS = [
    { id: "dusk", label: "Dusk", stops: [["#35254c", 0], ["#0b0910", 1]] },
    { id: "lagoon", label: "Lagoon", stops: [["#123b47", 0], ["#0c0b0e", 1]] },
    { id: "ember", label: "Ember", stops: [["#4a2433", 0], ["#150e14", 1]] },
    { id: "mist", label: "Mist", stops: [["#efe9f6", 0], ["#b7a6cd", 1]] },
  ];

  const $ = (id) => document.getElementById(id);
  const ui = {
    stage: $("stage"), empty: $("empty-state"), emptyTitle: $("empty-title"),
    emptyText: $("empty-text"), retry: $("retry"), wrap: $("canvas-wrap"),
    canvas: $("canvas"), status: $("status"), outputInfo: $("output-info"),
    sourceUrl: $("source-url"), sourceSize: $("source-size"), swatches: $("swatches"),
    customColor: $("custom-color"), customField: $("custom-field"),
    padding: $("padding"), paddingOut: $("padding-out"), radius: $("radius"),
    radiusOut: $("radius-out"), shadow: $("shadow"), scale: $("scale"),
    scaleOut: $("scale-out"), quality: $("quality"), qualityOut: $("quality-out"),
    qualityField: $("quality-field"), copy: $("copy"), downloadPng: $("download-png"),
    downloadJpeg: $("download-jpeg"), reset: $("reset"),
    formatRadios: Array.from(document.querySelectorAll('input[name="format"]')),
  };
  const defaultState = () => ({
    padding: 48, radius: 12, shadow: "soft", scale: 100, format: "png", quality: 90,
    background: { type: "none", id: "none" },
  });
  let state = defaultState();
  let source = null; // { image, width, height, url }
  let tabId = null;
  let renderTimer = 0;
  let toastTimer = 0;
  let fallbackIndex = 0;

  /* ------------------------------------------------------------ feedback --- */
  const announce = (message) => { ui.status.textContent = message; };
  function toast(message, tone) {
    for (const node of document.querySelectorAll(".toast")) node.remove();
    const node = document.createElement("div");
    node.className = tone === "danger" ? "toast toast-danger" : "toast";
    node.setAttribute("role", "status"); node.textContent = message;
    document.body.append(node);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => node.remove(), 2800);
  }
  function fail(error, fallback) {
    const message = (error && error.message) || fallback;
    announce(message);
    toast(message, "danger");
  }

  /* -------------------------------------------------------------- canvas --- */
  const compositionSize = () => ({
    width: source.width + state.padding * 2,
    height: source.height + state.padding * 2,
  });
  function roundRectPath(ctx, x, y, width, height, radius) {
    if (!(radius > 0)) return ctx.rect(x, y, width, height);
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }
  function paintBackground(ctx, width, height, flatten) {
    const { type, color, preset } = state.background;
    if (type === "solid" && color) ctx.fillStyle = color;
    else if (type === "gradient" && preset) {
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      for (const [stop, at] of preset.stops) gradient.addColorStop(at, stop);
      ctx.fillStyle = gradient;
    } else if (flatten) ctx.fillStyle = "#ffffff"; // JPEG has no alpha
    else return;
    ctx.fillRect(0, 0, width, height);
  }
  function drawScene(target, scale, { flatten = false } = {}) {
    if (!source) return;
    const comp = compositionSize();
    const width = Math.max(1, Math.round(comp.width * scale));
    const height = Math.max(1, Math.round(comp.height * scale));
    const ctx = target.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable in this browser.");
    target.width = width;
    target.height = height;
    ctx.clearRect(0, 0, width, height);
    paintBackground(ctx, width, height, flatten);

    const x = Math.round(state.padding * scale);
    const w = Math.max(1, Math.round((state.padding + source.width) * scale) - x);
    const h = Math.max(1, Math.round((state.padding + source.height) * scale) - x);
    const radius = Math.max(0, Math.min(state.radius * scale, w / 2, h / 2));
    const shadow = SHADOWS[state.shadow] || SHADOWS.none;

    if (shadow.blur > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(0, 0, 0, ${shadow.alpha})`;
      ctx.shadowBlur = shadow.blur * scale;
      ctx.shadowOffsetY = shadow.offsetY * scale;
      ctx.fillStyle = "#000"; ctx.beginPath();
      roundRectPath(ctx, x, x, w, h, radius);
      ctx.fill(); ctx.restore();
    }

    ctx.save(); ctx.beginPath();
    roundRectPath(ctx, x, x, w, h, radius);
    ctx.clip();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source.image, x, x, w, h);
    ctx.restore();
  }
  function fitScale(comp) {
    const styles = getComputedStyle(ui.stage);
    const inset = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0) + 18;
    return Math.min(1, Math.max(160, ui.stage.clientWidth - inset) / comp.width);
  }
  function renderPreview() {
    if (!source) return;
    const comp = compositionSize();
    const fit = fitScale(comp);
    let scale = fit * Math.min(2, window.devicePixelRatio || 1);
    const area = comp.width * comp.height;
    if (area * scale * scale > PREVIEW_BUDGET) scale = Math.sqrt(PREVIEW_BUDGET / area);
    scale = Math.min(scale, 16384 / comp.width, 16384 / comp.height);
    drawScene(ui.canvas, Math.max(0.01, scale), { flatten: false });
    ui.canvas.style.width = `${Math.round(comp.width * fit)}px`;
    updateOutputInfo();
  }
  function scheduleRender(delay = 60) {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => { renderTimer = 0; renderPreview(); }, delay);
  }

  /* ------------------------------------------------------------ controls --- */
  function gradientCss(preset) {
    const stops = preset.stops.map(([color, at]) => `${color} ${Math.round(at * 100)}%`);
    return `linear-gradient(135deg, ${stops.join(", ")})`;
  }
  function makeSwatch({ id, label, style }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = id === "none" ? "swatch swatch-transparent" : "swatch";
    button.dataset.background = id;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", "false");
    if (style) button.style.background = style;
    button.addEventListener("click", () => selectBackground(id));
    return button;
  }
  function buildSwatches() {
    ui.swatches.replaceChildren(makeSwatch({ id: "none", label: "Transparent background" }));
    for (const solid of SOLIDS) {
      ui.swatches.append(makeSwatch({ id: solid.id, label: `${solid.label} background`, style: solid.color }));
    }
    for (const preset of GRADIENTS) {
      const label = `${preset.label} gradient`;
      ui.swatches.append(makeSwatch({ id: preset.id, label, style: gradientCss(preset) }));
    }
  }
  function selectBackground(id) {
    const solid = SOLIDS.find((entry) => entry.id === id);
    const preset = GRADIENTS.find((entry) => entry.id === id);
    if (solid) state.background = { type: "solid", id, color: solid.color };
    else if (preset) state.background = { type: "gradient", id, preset };
    else state.background = { type: "none", id: "none" };
    syncBackgroundUI();
    scheduleRender();
  }
  function syncBackgroundUI() {
    for (const button of ui.swatches.querySelectorAll(".swatch")) {
      button.setAttribute("aria-pressed", String(button.dataset.background === state.background.id));
    }
    ui.customField.classList.toggle("is-active", state.background.id === "custom");
  }
  function syncFormatUI() {
    const jpeg = state.format === "jpeg";
    ui.quality.disabled = !jpeg;
    ui.qualityField.classList.toggle("is-disabled", !jpeg);
    ui.downloadPng.classList.toggle("btn-primary", !jpeg);
    ui.downloadJpeg.classList.toggle("btn-primary", jpeg);
  }
  function setFormat(format) {
    state.format = format;
    for (const radio of ui.formatRadios) radio.checked = radio.value === format;
    syncFormatUI();
    updateOutputInfo();
  }
  function updateOutputs() {
    ui.paddingOut.textContent = `${state.padding} px`;
    ui.radiusOut.textContent = `${state.radius} px`;
    ui.scaleOut.textContent = `${state.scale} %`;
    ui.qualityOut.textContent = String(state.quality);
  }
  function updateOutputInfo() {
    if (!source) { ui.outputInfo.textContent = ""; return; }
    const comp = compositionSize();
    const width = Math.round(comp.width * (state.scale / 100));
    const height = Math.round(comp.height * (state.scale / 100));
    ui.outputInfo.textContent = `${state.format === "jpeg" ? "JPEG" : "PNG"} · ${width} × ${height} px · ${state.scale}%`;
  }
  function applyFormState() {
    const values = [[ui.padding, state.padding], [ui.radius, state.radius], [ui.scale, state.scale], [ui.quality, state.quality]];
    for (const [input, value] of values) input.value = String(value);
    ui.shadow.value = state.shadow;
    for (const radio of ui.formatRadios) radio.checked = radio.value === state.format;
    updateOutputs();
    syncBackgroundUI();
    syncFormatUI();
    updateOutputInfo();
  }
  function resetAll() {
    state = defaultState();
    ui.customColor.value = DEFAULT_CUSTOM;
    applyFormState();
    renderPreview();
    announce("Reset to the default composition.");
    toast("Reset to defaults");
  }

  /* ------------------------------------------------------------- capture --- */
  async function send(operation, fields) {
    if (!globalThis.chrome || typeof chrome.runtime?.sendMessage !== "function") {
      throw new Error("The Fathom extension isn't available on this page.");
    }
    return chrome.runtime.sendMessage({ channel: CHANNEL, operation, ...fields });
  }
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("The capture data could not be decoded."));
      image.src = dataUrl;
    });
  }
  function parseTabId() {
    const raw = new URLSearchParams(location.search).get("tab");
    return raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  }

  /** `?id=<n>` opens a capture from the local history instead of a live tab. */
  function parseHistoryId() {
    const raw = new URLSearchParams(location.search).get("id");
    return raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  }

  async function loadFromHistory(id) {
    showEmpty("Loading capture…", "Reading it from your local history.");
    announce("Loading capture…");
    try {
      const store = globalThis.Fathom && globalThis.Fathom.captureStore;
      if (!store) throw new Error("The capture store is unavailable.");
      const record = await store.get(id);
      if (!record) throw new Error("That capture is no longer saved.");
      const image = await loadImage(record.dataUrl);
      const width = Math.max(0, Math.round(Number(record.width))) || image.naturalWidth;
      const height = Math.max(0, Math.round(Number(record.height))) || image.naturalHeight;
      if (!width || !height) throw new Error("That capture has no usable dimensions.");
      source = { image, width, height, url: typeof record.url === "string" ? record.url : "" };
      applySourceMeta();
      setControlsEnabled(true);
      ui.empty.hidden = true;
      ui.wrap.hidden = false;
      renderPreview();
      announce(`Capture ready — ${width} × ${height} px.`);
    } catch (error) {
      source = null;
      setControlsEnabled(false);
      showEmpty("Couldn't load the capture", (error && error.message) || "The capture could not be loaded.");
      announce("The capture could not be loaded.");
    }
  }
  function safeHost(url) {
    try {
      return new URL(url).hostname || "page";
    } catch {
      return "page";
    }
  }
  function showEmpty(title, text, { retry = false, error = false } = {}) {
    ui.emptyTitle.textContent = title; ui.emptyText.textContent = text;
    ui.retry.hidden = !retry;
    ui.empty.classList.toggle("is-error", error);
    ui.empty.hidden = false;
    ui.wrap.hidden = true;
  }
  function setControlsEnabled(enabled) {
    for (const button of [ui.copy, ui.downloadPng, ui.downloadJpeg, ui.reset]) button.disabled = !enabled;
  }
  function applySourceMeta() {
    const { width, height, url } = source;
    if (url) {
      ui.sourceUrl.textContent = url; ui.sourceUrl.title = url;
      document.title = `Fathom — ${safeHost(url)}`;
      ui.canvas.setAttribute("aria-label", `Screenshot of ${safeHost(url)}, ${width} × ${height} px`);
    } else {
      ui.sourceUrl.textContent = "Source URL unavailable";
      ui.sourceUrl.title = "";
      ui.canvas.setAttribute("aria-label", `Screenshot, ${width} × ${height} px`);
    }
    ui.sourceSize.textContent = `${width} × ${height} px`;
  }

  async function loadCapture() {
    showEmpty("Loading capture…", "Fetching the screenshot from the page.");
    announce("Loading capture…");
    try {
      const response = await send("capture-fetch", { tabId });
      if (!response) throw new Error("The extension worker did not answer.");
      if (response.ok === false) throw new Error(response.error || "The capture could not be loaded.");
      if (typeof response.dataUrl !== "string" || !response.dataUrl.startsWith("data:image/")) {
        throw new Error("No screenshot data came back.");
      }
      const image = await loadImage(response.dataUrl);
      const width = Math.max(0, Math.round(Number(response.width))) || image.naturalWidth;
      const height = Math.max(0, Math.round(Number(response.height))) || image.naturalHeight;
      if (!width || !height) throw new Error("The screenshot has no usable dimensions.");

      source = { image, width, height, url: typeof response.url === "string" ? response.url : "" };
      applySourceMeta();
      setControlsEnabled(true);
      ui.empty.hidden = true;
      ui.wrap.hidden = false;
      renderPreview();
      announce(`Capture ready — ${width} × ${height} px.`);
    } catch (error) {
      source = null;
      setControlsEnabled(false);
      ui.sourceUrl.textContent = "No source loaded"; ui.sourceUrl.title = "";
      ui.sourceSize.textContent = "";
      showEmpty("Couldn't load the capture", (error && error.message) || "The capture could not be loaded.", { retry: true, error: true });
      announce("The capture could not be loaded.");
    }
  }

  /* -------------------------------------------------------------- export --- */
  function sourceSlug() {
    return safeHost(source.url).replace(/^www\./i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "page";
  }
  function nextFileName(extension) {
    let index;
    try {
      index = Number(window.sessionStorage.getItem("fathomCaptureIndex") || "0") + 1;
      window.sessionStorage.setItem("fathomCaptureIndex", String(index));
    } catch { index = ++fallbackIndex; }
    return `fathom-capture-${sourceSlug()}-${index}.${extension}`;
  }
  function composeCanvas(format) {
    const comp = compositionSize();
    const scale = state.scale / 100;
    const width = Math.round(comp.width * scale);
    const height = Math.round(comp.height * scale);
    if (width > MAX_DIM || height > MAX_DIM || width * height > MAX_AREA) {
      throw new Error(`That export would be ${width} × ${height} px — too large. Lower the scale.`);
    }
    const canvas = document.createElement("canvas");
    try { drawScene(canvas, scale, { flatten: format === "jpeg" }); }
    catch { throw new Error("The browser ran out of canvas memory at that scale."); }
    return canvas;
  }

  const canvasToBlob = (canvas) =>
    new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode that image."));
      }, "image/png");
    });

  async function downloadImage(format) {
    if (!source) return;
    try {
      setFormat(format);
      const canvas = composeCanvas(format);
      const mime = format === "jpeg" ? "image/jpeg" : "image/png";
      const dataUrl = canvas.toDataURL(mime, format === "jpeg" ? state.quality / 100 : undefined);
      if (!dataUrl || !dataUrl.startsWith("data:image/")) {
        throw new Error("The browser could not encode that image. Try a lower scale.");
      }
      const name = nextFileName(format === "jpeg" ? "jpg" : "png");
      const response = await send("download-file", { dataUrl, name });
      if (!response || response.ok === false) {
        throw new Error((response && response.error) || "The download was not confirmed.");
      }
      announce(`Saved ${name}`);
      toast(`Saved ${name}`);
    } catch (error) { fail(error, "The download failed."); }
  }

  async function copyImage() {
    if (!source) return;
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        throw new Error("This browser can't copy images — use Download PNG instead.");
      }
      const blob = await canvasToBlob(composeCanvas("png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      announce("Copied the image to the clipboard.");
      toast("Copied to clipboard");
    } catch (error) { fail(error, "Copying failed — use Download PNG instead."); }
  }

  /* -------------------------------------------------------------- wiring --- */
  function bindEvents() {
    const ranges = [
      [ui.padding, 0, 160, (value) => { state.padding = value; scheduleRender(); }],
      [ui.radius, 0, 48, (value) => { state.radius = value; scheduleRender(); }],
      [ui.scale, 25, 200, (value) => { state.scale = value; updateOutputInfo(); }],
      [ui.quality, 60, 100, (value) => { state.quality = value; updateOutputInfo(); }],
    ];
    for (const [input, min, max, apply] of ranges) {
      input.addEventListener("input", () => {
        apply(Math.min(max, Math.max(min, Number(input.value) || min)));
        updateOutputs();
      });
    }

    ui.shadow.addEventListener("change", () => {
      state.shadow = ui.shadow.value in SHADOWS ? ui.shadow.value : "none";
      scheduleRender();
    });

    ui.customColor.addEventListener("input", () => {
      state.background = { type: "solid", id: "custom", color: ui.customColor.value };
      syncBackgroundUI();
      scheduleRender();
    });

    for (const radio of ui.formatRadios) {
      radio.addEventListener("change", () => radio.checked && setFormat(radio.value));
    }

    ui.copy.addEventListener("click", copyImage);
    ui.downloadPng.addEventListener("click", () => downloadImage("png"));
    ui.downloadJpeg.addEventListener("click", () => downloadImage("jpeg"));
    ui.reset.addEventListener("click", resetAll);
    ui.retry.addEventListener("click", () => tabId !== null && loadCapture());
    window.addEventListener("resize", () => source && scheduleRender(90));

    if ("ResizeObserver" in window) {
      new ResizeObserver(() => source && scheduleRender(90)).observe(ui.stage);
    }
  }
  function init() {
    buildSwatches(); bindEvents(); applyFormState(); setControlsEnabled(false);
    tabId = parseTabId();
    const historyId = parseHistoryId();
    if (tabId === null && historyId !== null) {
      loadFromHistory(historyId);
      return;
    }
    if (tabId === null) {
      showEmpty("No capture to compose", "Open this editor from a page you captured with Fathom.");
      announce("No capture selected.");
      return;
    }
    loadCapture();
  }

  init();
})();
