/* Fathom — workspace dashboard.
 *
 * Hash-routed options page. Every read and write goes through
 * `Fathom.settings` / `Fathom.captureStore`; this file never touches
 * chrome.storage directly and degrades quietly when the extension APIs
 * (runtime manifest) are unavailable.
 */
(() => {
  "use strict";

  const Settings = globalThis.Fathom && globalThis.Fathom.settings;
  const Store = globalThis.Fathom && globalThis.Fathom.captureStore;

  /* The canonical thirteen, matching Settings.TOOL_IDS. `line` is the one-line
     description the About page shows. */
  const TOOLS = [
    { id: "element", label: "Pick element", caption: "Pick", line: "Outline any element and export its HTML, CSS and assets." },
    { id: "page", label: "Clone page", caption: "Clone page", line: "Save the page as one self-contained HTML file." },
    { id: "brief", label: "Design prompt", caption: "Prompt", line: "Turn the page's layout, colour and type into a reusable prompt." },
    { id: "designmd", label: "Design MD", caption: "Design MD", line: "Export colours, type, spacing and radii as markdown." },
    { id: "images", label: "Extract assets", caption: "Assets", line: "List every image and video with its format and size." },
    { id: "palette", label: "Extract colors", caption: "Colors", line: "Collect the page palette by role, with usage counts." },
    { id: "type", label: "Detect fonts", caption: "Fonts", line: "Identify every family in use with weights and sizes." },
    { id: "inspect", label: "Inspect & measure", caption: "Measure", line: "Read the box model and computed styles of any element." },
    { id: "text", label: "Edit text", caption: "Edit text", line: "Edit the copy in place, undo it, and copy it back out." },
    { id: "capture", label: "Screenshot", caption: "Capture", line: "Snip the viewport or a region and open it in the editor." },
    { id: "responsive", label: "Responsive viewer", caption: "Responsive", line: "Compare this URL at several device widths." },
    { id: "fonts", label: "Swap fonts", caption: "Swap font", line: "Preview another font family on the live page." },
    { id: "arrange", label: "Move & delete", caption: "Arrange", line: "Nudge or delete elements to test a layout." },
  ];
  const TOOL_BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]));
  const TOOL_COUNT = TOOLS.length;

  const ROUTES = ["overview", "capture", "history", "dock", "responsive", "about"];
  const META = {
    overview: { title: "Overview", desc: "Your tools, your setup. Everything in one place." },
    capture: { title: "Capture", desc: "Choose how screenshots are captured, opened and saved." },
    history: { title: "Capture history", desc: "Saved in this browser only. Open a capture to edit or export it." },
    dock: { title: "Dock & sidebar", desc: "Keep the tools you use close, in a layout that fits your workflow." },
    responsive: { title: "Responsive viewer", desc: "Set the widths and zoom the viewer opens with." },
    about: { title: "About", desc: "What Fathom includes, what it deliberately leaves out, and the keys it listens for." },
  };

  const WIDTHS = [320, 375, 390, 414, 768, 834, 1024, 1280, 1440, 1920];
  const MAX_WIDTHS = 6;

  const ICON_CAPTURE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h3l1.4-2h7.2l1.4 2H20a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.1"/></svg>`;
  const ICON_DOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 15.4h17"/><path d="M9.5 18.2h5"/></svg>`;
  const ICON_SCREENS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/></svg>`;
  const ICON_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/></svg>`;
  const ICON_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m6.5 13.5 5.5 5.5 5.5-5.5"/></svg>`;
  const GRIP = `<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.6" cy="2.6" r="1.15"/><circle cx="7.4" cy="2.6" r="1.15"/><circle cx="2.6" cy="8" r="1.15"/><circle cx="7.4" cy="8" r="1.15"/><circle cx="2.6" cy="13.4" r="1.15"/><circle cx="7.4" cy="13.4" r="1.15"/></svg>`;

  /* --------------------------------------------------------------- state --- */

  let state = Settings ? Settings.merge(null) : null;
  let captures = [];
  let captureCount = 0;
  let selected = new Set();
  let previewMinimized = false;
  let version = "";
  let currentRoute = "overview";
  let routeRun = 0;
  let toastTimer = 0;
  let savedTimer = 0;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const esc = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  const option = (value, label, current) =>
    `<option value="${esc(value)}"${String(value) === String(current) ? " selected" : ""}>${esc(label)}</option>`;

  const clamp = (value, min, max, fallback) => (Settings ? Settings.clamp(value, min, max, fallback) : value);

  /* --------------------------------------------------------------- shell --- */

  function readVersion() {
    try {
      const manifest = globalThis.chrome && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest();
      return manifest && manifest.version ? String(manifest.version) : "";
    } catch {
      return "";
    }
  }

  function toast(message) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2800);
  }

  function flashSaved() {
    const note = $("#save-state");
    if (!note) return;
    note.textContent = "Saved";
    note.classList.add("is-flash");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      note.textContent = "Settings save automatically";
      note.classList.remove("is-flash");
    }, 1600);
  }

  function openWindow(url) {
    try {
      window.open(url, "_blank", "noopener");
    } catch {
      toast("Could not open a new tab.");
    }
  }

  /** Open a page that lives beside this one (capture.html, responsive.html…). */
  function openPage(page) {
    let url = page;
    try {
      if (globalThis.chrome && chrome.runtime && chrome.runtime.id && typeof chrome.runtime.getURL === "function") {
        url = chrome.runtime.getURL(`ui/${page}`);
      }
    } catch {
      url = page;
    }
    try {
      if (globalThis.chrome && chrome.tabs && typeof chrome.tabs.create === "function") {
        const pending = chrome.tabs.create({ url });
        if (pending && typeof pending.catch === "function") pending.catch(() => openWindow(url));
        return;
      }
    } catch {
      /* fall through to a plain window */
    }
    openWindow(url);
  }

  /* ------------------------------------------------------------ settings --- */

  function mergeLocal(patch) {
    state = Settings.merge({
      ...state,
      ...patch,
      capture: { ...state.capture, ...(patch.capture || {}) },
      dock: { ...state.dock, ...(patch.dock || {}) },
      responsive: { ...state.responsive, ...(patch.responsive || {}) },
    });
  }

  async function loadSettings() {
    try {
      return await Settings.load();
    } catch {
      return Settings.merge(null);
    }
  }

  /** Merge locally for an immediate repaint, then persist through the API. */
  async function persist(patch) {
    mergeLocal(patch);
    try {
      state = await Settings.save(patch);
      flashSaved();
      return true;
    } catch {
      toast("Could not save — extension storage is unavailable.");
      return false;
    }
  }

  function numberField(input, apply, { min = -Infinity, max = Infinity, integer = false } = {}) {
    if (!input) return;
    let timer = 0;
    let last = Number(input.value);
    const complete = (raw) => /^-?\d+(?:\.\d+)?$/.test(raw);
    const commit = (rewrite) => {
      const raw = String(input.value).trim();
      if (!raw) return;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      let value = Math.min(max, Math.max(min, parsed));
      if (integer) value = Math.round(value);
      if (rewrite) input.value = String(value);
      if (value === last) return;
      last = value;
      void apply(value);
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      /* Save a finished number on the spot; give half-typed values ("0.")
         a moment to settle so the clamp doesn't jump under the caret. */
      if (complete(String(input.value).trim())) commit(false);
      else timer = setTimeout(() => commit(false), 300);
    });
    input.addEventListener("change", () => {
      clearTimeout(timer);
      commit(true);
    });
  }

  function row(id, label, help, control, { labelFor = id } = {}) {
    const tag = labelFor ? "label" : "span";
    return `<div class="setting">
      <div class="setting-main">
        <${tag} class="setting-label"${labelFor ? ` for="${labelFor}"` : ""}>${label}</${tag}>
        ${help ? `<p class="setting-help" id="${id}-help">${help}</p>` : ""}
      </div>
      <div class="setting-control">${control}</div>
    </div>`;
  }

  /* ------------------------------------------------------------- templates --- */

  function countText() {
    return `${state.enabled.length} of ${TOOL_COUNT} shown in the dock`;
  }

  function historyCountText() {
    const limit = state.capture.historyLimit;
    return limit > 0 ? `${captures.length} of ${limit} saved` : `${captures.length} saved`;
  }

  function templateOverview() {
    const enabled = state.enabled.length;
    return `<section class="route" aria-labelledby="page-title">
      <div class="card stat-card">
        <div class="stat">
          <p class="stat-value">${enabled} ${enabled === 1 ? "tool" : "tools"}</p>
          <p class="stat-label">Enabled in your dock</p>
        </div>
        <div class="stat">
          <p class="stat-value">${captureCount} ${captureCount === 1 ? "capture" : "captures"}</p>
          <p class="stat-label">Stored locally in this browser</p>
        </div>
        <div class="stat">
          <button class="btn btn-primary" type="button" id="open-editor">Open editor</button>
          <p class="stat-label">Your default capture destination</p>
        </div>
      </div>

      <div class="action-grid">
        <button class="action-card" type="button" data-route="capture">
          <span class="action-icon" aria-hidden="true">${ICON_CAPTURE}</span>
          <span class="action-title">Make captures yours</span>
          <span class="action-text">Choose what happens after a capture, the export format and how much history to keep.</span>
        </button>
        <button class="action-card" type="button" data-route="dock">
          <span class="action-icon" aria-hidden="true">${ICON_DOCK}</span>
          <span class="action-title">A workspace that fits</span>
          <span class="action-text">Move the dock, pick its edge and order the tools you reach for first.</span>
        </button>
        <button class="action-card" type="button" data-route="responsive">
          <span class="action-icon" aria-hidden="true">${ICON_SCREENS}</span>
          <span class="action-title">Check every screen</span>
          <span class="action-text">Open the viewer with the widths and zoom you use most.</span>
        </button>
      </div>

      <div class="card local-card">
        <h2 class="card-title">Local by default</h2>
        <p class="local-text">Captures and edits stay in this browser. Design MD and the design prompt are generated locally. There is no account, no AI service and no telemetry.</p>
        <a class="text-link" href="#history">Open capture history →</a>
      </div>
    </section>`;
  }

  function templateCapture() {
    const c = state.capture;
    const qualityOff = !(c.format === "jpeg" || c.format === "webp");
    return `<section class="route" aria-labelledby="page-title">
      <div class="card">
        <div class="card-head"><h2 class="card-title">After a capture</h2></div>
        <div class="card-body">
          <div class="setting-list">
            ${row("cap-after", "Open or download", "What Fathom does the moment a capture finishes.",
              `<select id="cap-after" aria-describedby="cap-after-help">${option("editor", "Open capture editor", c.afterCapture)}${option("download", "Download file", c.afterCapture)}${option("copy", "Copy to clipboard", c.afterCapture)}</select>`)}
            ${row("cap-format", "Export format", "PNG keeps every pixel; JPEG and WebP trade detail for size.",
              `<select id="cap-format" aria-describedby="cap-format-help">${option("png", "PNG · lossless", c.format)}${option("jpeg", "JPEG · smaller", c.format)}${option("webp", "WebP · smallest", c.format)}</select>`)}
            ${row("cap-quality", "Image quality", "Applies to JPEG and WebP only.",
              `<input id="cap-quality" type="number" min="0.3" max="1" step="0.01" inputmode="decimal" value="${c.quality}" aria-describedby="cap-quality-help"${qualityOff ? " disabled" : ""}>`)}
            ${row("cap-scale", "Export scale", "Multiplies the captured pixels before export.",
              `<select id="cap-scale" aria-describedby="cap-scale-help">${option(1, "100%", c.scale)}${option(1.5, "150%", c.scale)}${option(2, "200%", c.scale)}</select>`)}
            ${row("cap-history", "Capture history", "Editor captures retained locally. Direct downloads are not added.",
              `<input id="cap-history" type="number" min="0" max="100" step="1" inputmode="numeric" value="${c.historyLimit}" aria-describedby="cap-history-help">`)}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2 class="card-title">Advanced settings</h2></div>
        <div class="card-body">
          <div class="setting-list">
            ${row("cap-scroll", "Scroll before capture", "Scroll first to load lazy images and reveal animated sections, then capture.",
              `<input id="cap-scroll" type="checkbox" aria-describedby="cap-scroll-help"${c.scrollBefore ? " checked" : ""}>`)}
            ${row("cap-long", "Long page capture", "Go beyond the default 10-screen limit.",
              `<input id="cap-long" type="checkbox" aria-describedby="cap-long-help"${c.longPage ? " checked" : ""}>`)}
            ${row("cap-screens", "Capture up to", "Maximum viewport screens the capture may stitch together.",
              `<input id="cap-screens" type="number" min="1" max="40" step="1" inputmode="numeric" value="${c.maxScreens}" aria-describedby="cap-screens-help">`)}
          </div>
        </div>
      </div>
    </section>`;
  }

  function mockMarkup() {
    return `<div class="mock" id="mock" data-layout="${esc(state.dock.layout)}" data-side="${esc(state.dock.side)}" data-minimized="${previewMinimized}" aria-hidden="true">
      <div class="mock-chrome">
        <span class="mock-light mock-light--red"></span>
        <span class="mock-light mock-light--amber"></span>
        <span class="mock-light mock-light--green"></span>
        <span class="mock-url">example.com</span>
      </div>
      <div class="mock-body">
        <div class="mock-page">
          <span class="mock-block mock-block--hero"></span>
          <span class="mock-block"></span>
          <span class="mock-block mock-block--wide"></span>
          <span class="mock-block mock-block--short"></span>
        </div>
        <div class="mock-dock" id="mock-dock"></div>
        <div class="mock-handle"><span class="mock-grip"></span></div>
      </div>
    </div>`;
  }

  function toolRows() {
    const order = state.order.length ? state.order : TOOLS.map((tool) => tool.id);
    return order
      .map((id, index) => {
        const tool = TOOL_BY_ID.get(id);
        if (!tool) return "";
        const checked = state.enabled.includes(id) ? " checked" : "";
        return `<li class="tool-row" data-id="${id}">
          <span class="grip" aria-hidden="true">${GRIP}</span>
          <input class="tool-check" type="checkbox" id="tool-${id}" data-tool="${id}"${checked}>
          <label class="tool-name" for="tool-${id}">${esc(tool.label)}</label>
          <span class="tool-actions">
            <button class="icon-btn" type="button" data-move="${id}" data-dir="-1" aria-label="Move ${esc(tool.label)} up" title="Move up"${index === 0 ? " disabled" : ""}>${ICON_UP}</button>
            <button class="icon-btn" type="button" data-move="${id}" data-dir="1" aria-label="Move ${esc(tool.label)} down" title="Move down"${index === order.length - 1 ? " disabled" : ""}>${ICON_DOWN}</button>
          </span>
        </li>`;
      })
      .join("");
  }

  function templateDock() {
    const d = state.dock;
    return `<section class="route" aria-labelledby="page-title">
      <div class="card">
        <div class="card-head"><h2 class="card-title">Make room for your work</h2></div>
        <div class="card-body">
          <div class="dock-grid">
            <div class="setting-list dock-list">
              ${row("dock-layout", "Layout", "Where the tools sit while you browse.",
                `<select id="dock-layout" aria-describedby="dock-layout-help">${option("bottom", "Bottom dock", d.layout)}${option("sidebar", "Sidebar", d.layout)}</select>`)}
              ${row("dock-side", "Side edge", "Which edge the sidebar hugs.",
                `<select id="dock-side" aria-describedby="dock-side-help">${option("left", "Left", d.side)}${option("right", "Right", d.side)}</select>`)}
              ${row("dock-minimized", "Minimize the dock", "Minimize your tools to a small edge handle. Click it to bring them back.",
                `<input id="dock-minimized" type="checkbox" aria-describedby="dock-minimized-help"${d.minimized ? " checked" : ""}>`)}
            </div>
            <div class="preview-pane">
              <h3 class="preview-title">Layout preview</h3>
              ${mockMarkup()}
              <p class="preview-caption" id="preview-caption" role="status" aria-live="polite">${previewCaption()}</p>
              <button class="btn btn-sm" type="button" id="preview-min-toggle" aria-pressed="${previewMinimized}">${previewMinimized ? "Show expanded" : "Show minimized"}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head card-head--row">
          <div>
            <h2 class="card-title">Tool order &amp; visibility</h2>
            <p class="card-sub" id="tools-count" role="status" aria-live="polite">${countText()}</p>
          </div>
          <button class="btn btn-sm" type="button" id="reset-order">Reset order</button>
        </div>
        <div class="card-body">
          <ol class="tool-list" id="tool-list">${toolRows()}</ol>
        </div>
      </div>
    </section>`;
  }

  function templateResponsive() {
    const r = state.responsive;
    const chips = WIDTHS.map(
      (width) =>
        `<button class="chip" type="button" data-width="${width}" aria-pressed="${r.widths.includes(width)}" aria-label="${width} pixels">${width}</button>`,
    ).join("");
    return `<section class="route" aria-labelledby="page-title">
      <div class="card">
        <div class="card-head"><h2 class="card-title">Viewer defaults</h2></div>
        <div class="card-body">
          <div class="setting-list">
            ${row("resp-fit", "Fit to window", "Scale the whole stage to the width of the tab.",
              `<input id="resp-fit" type="checkbox" aria-describedby="resp-fit-help"${r.fit ? " checked" : ""}>`)}
            ${row("resp-zoom", "Zoom", "Starting zoom for every frame.",
              `<div class="range-wrap"><input id="resp-zoom" type="range" min="20" max="100" step="1" value="${r.percent}" aria-describedby="resp-zoom-help"><output id="resp-zoom-value" for="resp-zoom">${r.percent}%</output></div>`)}
            ${row("resp-widths", "Default widths", "Up to six widths open each time. Toggle to add or remove.",
              `<div class="chips" id="resp-widths" role="group" aria-label="Default widths" aria-describedby="resp-widths-help">${chips}</div>`,
              { labelFor: false })}
          </div>
          <div class="card-foot">
            <button class="btn btn-primary" type="button" id="open-viewer">Open viewer</button>
          </div>
        </div>
      </div>
    </section>`;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname || "Page";
    } catch {
      return "Page";
    }
  }

  function isoDate(ts) {
    try {
      return new Date(Number(ts) || Date.now()).toISOString();
    } catch {
      return "";
    }
  }

  function absoluteTime(ts) {
    try {
      return new Date(Number(ts) || Date.now()).toLocaleString();
    } catch {
      return "";
    }
  }

  function relativeTime(ts) {
    const then = Number(ts);
    if (!Number.isFinite(then) || !then) return "";
    const diff = Date.now() - then;
    const abs = Math.abs(diff);
    if (abs < 45e3) return "just now";
    const minutes = Math.round(abs / 60e3);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(abs / 36e5);
    if (hours < 24) return `${hours} ${hours === 1 ? "hr" : "hrs"} ago`;
    const days = Math.round(abs / 864e5);
    if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
    const weeks = Math.round(days / 7);
    if (weeks < 5) return `${weeks} ${weeks === 1 ? "wk" : "wks"} ago`;
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(then));
  }

  function captureHref(id) {
    return `capture.html?id=${encodeURIComponent(id)}`;
  }

  function captureCard(record) {
    const id = Number(record.id);
    const host = hostOf(record.url);
    const mode = String(record.mode || "capture");
    const size = `${Math.round(Number(record.width) || 0)} × ${Math.round(Number(record.height) || 0)}`;
    const href = captureHref(id);
    return `<article class="capture-card" data-id="${id}">
      <label class="capture-select" title="Select this capture">
        <input type="checkbox" data-select value="${id}" aria-label="Select capture of ${esc(host)}">
      </label>
      <a class="capture-thumb" href="${href}" target="_blank" rel="noopener" aria-label="Open the capture of ${esc(host)} in the editor">
        <img src="${esc(record.thumb || "")}" alt="" loading="lazy" decoding="async">
      </a>
      <div class="capture-body">
        <p class="capture-title" title="${esc(record.url || host)}">${esc(host)}</p>
        <p class="capture-meta">
          <span class="capture-mode">${esc(mode)}</span>
          <span>${size}</span>
          <time datetime="${esc(isoDate(record.createdAt))}" title="${esc(absoluteTime(record.createdAt))}">${esc(relativeTime(record.createdAt))}</time>
        </p>
        <div class="capture-actions">
          <a class="btn btn-sm" href="${href}" target="_blank" rel="noopener">Open</a>
          <button class="btn btn-sm" type="button" data-download="${id}">Download</button>
          <button class="btn btn-sm btn-danger" type="button" data-delete="${id}" aria-label="Delete capture of ${esc(host)}">Delete</button>
        </div>
      </div>
    </article>`;
  }

  function templateHistory() {
    const grid = captures.length
      ? `<div class="history-grid" id="history-grid">${captures.map(captureCard).join("")}</div>`
      : `<div class="card empty-card">
          <div class="empty-state">
            <strong>No captures yet</strong>
            <p>Open Fathom on a website and choose Capture to get started.</p>
          </div>
        </div>`;
    return `<section class="route" aria-labelledby="page-title">
      <div class="history-panel">
        <div class="history-toolbar">
          <button class="btn btn-sm" type="button" id="select-all" aria-pressed="false">Select all</button>
          <button class="btn btn-sm" type="button" id="download-selected" disabled>Download selected</button>
          <button class="btn btn-sm btn-danger" type="button" id="delete-selected" disabled>Delete selected</button>
          <p class="history-count" id="history-count">${historyCountText()}</p>
        </div>
        ${grid}
      </div>
    </section>`;
  }

  function templateAbout() {
    const versionLine = version ? `Version ${version} · Chrome extension` : "Version unavailable outside the extension";
    const included = TOOLS.map(
      (tool) => `<div class="included-row"><dt>${esc(tool.label)}</dt><dd>${esc(tool.line)}</dd></div>`,
    ).join("");
    return `<section class="route" aria-labelledby="page-title">
      <p class="about-version" id="about-version">${esc(versionLine)}</p>

      <div class="card">
        <div class="card-head"><h2 class="card-title">What is included</h2></div>
        <div class="card-body">
          <dl class="included">${included}</dl>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2 class="card-title">Deliberately not included</h2></div>
        <div class="card-body">
          <ul class="excluded">
            <li>No account, sign-in, licence or trial — nothing to activate.</li>
            <li>No AI settings, providers or hosted generation; prompts and Design MD are built on your machine.</li>
            <li>No telemetry, analytics or crash reporting.</li>
            <li>No network requests — pages are read in place and captures stay in this browser.</li>
          </ul>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2 class="card-title">Shortcuts</h2></div>
        <div class="card-body">
          <table class="shortcuts">
            <caption class="sr-only">Keyboard shortcuts</caption>
            <thead><tr><th scope="col">Keys</th><th scope="col">Action</th><th scope="col">Where</th></tr></thead>
            <tbody>
              <tr><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd></td><td>Open or close the panel</td><td>Any page</td></tr>
              <tr><td><kbd>Esc</kbd></td><td>Leave picking, then close the panel, then the dock</td><td>Any tool</td></tr>
              <tr><td><kbd>Enter</kbd></td><td>Apply the edited property</td><td>Measure</td></tr>
              <tr><td><kbd>Esc</kbd></td><td>Cancel a snip</td><td>Capture</td></tr>
              <tr><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd></td><td>Undo the last change</td><td>Edit text, Arrange</td></tr>
              <tr><td><kbd>↑</kbd>/<kbd>↓</kbd></td><td>Step through the font options</td><td>Swap font</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card reset-card">
        <div class="reset-copy">
          <h2 class="card-title">Start over</h2>
          <p class="setting-help">Restore the default order, visibility, capture, dock and viewer settings. Saved captures are not deleted.</p>
        </div>
        <button class="btn btn-danger" type="button" id="reset-settings">Reset all settings</button>
      </div>
    </section>`;
  }

  function templateFor(route) {
    if (route === "capture") return templateCapture();
    if (route === "history") return templateHistory();
    if (route === "dock") return templateDock();
    if (route === "responsive") return templateResponsive();
    if (route === "about") return templateAbout();
    return templateOverview();
  }

  /* -------------------------------------------------------------- preview --- */

  function previewCaption() {
    const side = state.dock.side === "left" ? "left" : "right";
    if (previewMinimized) return `Minimized — A slim handle on the ${side} edge.`;
    if (state.dock.layout === "sidebar") {
      return `${side === "right" ? "Right" : "Left"} side — Your tools sit beside the page.`;
    }
    return "Bottom center — Your tools sit below the page, within reach.";
  }

  function syncPreviewToggle() {
    const button = $("#preview-min-toggle");
    if (!button) return;
    button.setAttribute("aria-pressed", String(previewMinimized));
    button.textContent = previewMinimized ? "Show expanded" : "Show minimized";
  }

  function syncDockPreview() {
    const mock = $("#mock");
    if (!mock) return;
    mock.dataset.layout = state.dock.layout;
    mock.dataset.side = state.dock.side;
    mock.dataset.minimized = String(previewMinimized);

    const dock = $("#mock-dock");
    if (dock) {
      const shown = state.order.filter((id) => state.enabled.includes(id));
      const visible = shown.slice(0, 6);
      dock.replaceChildren();
      for (const id of visible) {
        const tool = TOOL_BY_ID.get(id);
        if (!tool) continue;
        const item = document.createElement("span");
        item.className = "mock-tool";
        const dot = document.createElement("span");
        dot.className = "mock-dot";
        const label = document.createElement("span");
        label.className = "mock-label";
        label.textContent = tool.caption;
        item.append(dot, label);
        dock.append(item);
      }
      if (shown.length > visible.length) {
        const more = document.createElement("span");
        more.className = "mock-more";
        more.textContent = `+${shown.length - visible.length}`;
        dock.append(more);
      }
    }

    const caption = $("#preview-caption");
    if (caption) caption.textContent = previewCaption();
  }

  /* --------------------------------------------------------------- wiring --- */

  function wireOverview() {
    const open = $("#open-editor");
    if (open) open.addEventListener("click", () => openPage("capture.html"));
    for (const card of $$("#content [data-route]")) {
      card.addEventListener("click", () => navigate(card.dataset.route));
    }
  }

  function wireCapture() {
    const quality = $("#cap-quality");
    const format = $("#cap-format");
    const syncQuality = () => {
      if (!quality || !format) return;
      quality.disabled = !(format.value === "jpeg" || format.value === "webp");
    };
    syncQuality();

    const after = $("#cap-after");
    if (after) after.addEventListener("change", () => void persist({ capture: { afterCapture: after.value } }));

    if (format) {
      format.addEventListener("change", () => {
        void persist({ capture: { format: format.value } });
        syncQuality();
      });
    }
    numberField(quality, (value) => persist({ capture: { quality: value } }), { min: 0.3, max: 1 });
    numberField($("#cap-history"), (value) => persist({ capture: { historyLimit: value } }), { min: 0, max: 100, integer: true });

    const scale = $("#cap-scale");
    if (scale) scale.addEventListener("change", () => void persist({ capture: { scale: Number(scale.value) } }));

    const scroll = $("#cap-scroll");
    if (scroll) scroll.addEventListener("change", () => void persist({ capture: { scrollBefore: scroll.checked } }));

    const longPage = $("#cap-long");
    if (longPage) longPage.addEventListener("change", () => void persist({ capture: { longPage: longPage.checked } }));

    numberField($("#cap-screens"), (value) => persist({ capture: { maxScreens: value } }), { min: 1, max: 40, integer: true });
  }

  function syncToolState() {
    const count = $("#tools-count");
    if (count) count.textContent = countText();
    for (const toolRow of $$("#tool-list .tool-row")) {
      const id = toolRow.dataset.id;
      const index = state.order.indexOf(id);
      const box = toolRow.querySelector("input[data-tool]");
      if (box) box.checked = state.enabled.includes(id);
      const up = toolRow.querySelector('[data-dir="-1"]');
      const down = toolRow.querySelector('[data-dir="1"]');
      if (up) up.disabled = index <= 0;
      if (down) down.disabled = index < 0 || index >= state.order.length - 1;
    }
    syncDockPreview();
  }

  function reorderToolRows() {
    const list = $("#tool-list");
    if (!list) return;
    for (const id of state.order) {
      const toolRow = list.querySelector(`.tool-row[data-id="${id}"]`);
      if (toolRow) list.append(toolRow);
    }
  }

  async function moveTool(id, direction) {
    const from = state.order.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= state.order.length) return;
    const order = state.order.slice();
    order.splice(from, 1);
    order.splice(to, 0, id);
    await persist({ order, enabled: state.enabled.slice() });
    reorderToolRows();
    syncToolState();

    const toolRow = document.querySelector(`.tool-row[data-id="${id}"]`);
    if (!toolRow) return;
    const preferred = toolRow.querySelector(`[data-dir="${direction}"]`);
    if (preferred && !preferred.disabled) preferred.focus();
    else {
      const other = toolRow.querySelector(`[data-dir="${-direction}"]`);
      if (other) other.focus();
    }
  }

  function wireDock() {
    syncDockPreview();
    syncPreviewToggle();

    const layout = $("#dock-layout");
    if (layout) {
      layout.addEventListener("change", () => {
        void persist({ dock: { layout: layout.value } });
        syncDockPreview();
      });
    }
    const side = $("#dock-side");
    if (side) {
      side.addEventListener("change", () => {
        void persist({ dock: { side: side.value } });
        syncDockPreview();
      });
    }
    const minimized = $("#dock-minimized");
    if (minimized) {
      minimized.addEventListener("change", () => {
        previewMinimized = minimized.checked;
        syncPreviewToggle();
        syncDockPreview();
        void persist({ dock: { minimized: minimized.checked } });
      });
    }
    const previewToggle = $("#preview-min-toggle");
    if (previewToggle) {
      previewToggle.addEventListener("click", () => {
        previewMinimized = !previewMinimized;
        syncPreviewToggle();
        syncDockPreview();
      });
    }

    const list = $("#tool-list");
    if (list) {
      list.addEventListener("change", (event) => {
        const box = event.target.closest("input[data-tool]");
        if (!box) return;
        const id = box.dataset.tool;
        const wantEnabled = box.checked;
        if (!wantEnabled && state.enabled.length <= 1) {
          box.checked = true;
          toast("Keep at least one tool in the dock.");
          return;
        }
        const enabled = state.order.filter((toolId) => (toolId === id ? wantEnabled : state.enabled.includes(toolId)));
        void persist({ order: state.order.slice(), enabled });
        syncToolState();
      });

      list.addEventListener("click", (event) => {
        const button = event.target.closest("[data-move]");
        if (!button) return;
        void moveTool(button.dataset.move, Number(button.dataset.dir));
      });
    }

    const reset = $("#reset-order");
    if (reset) {
      reset.addEventListener("click", async () => {
        await persist({ order: Settings.TOOL_IDS.slice(), enabled: state.enabled.slice() });
        if (list) list.innerHTML = toolRows();
        syncToolState();
        toast("Tool order reset");
      });
    }
  }

  async function downloadCapture(record) {
    if (!record || !record.dataUrl) return;
    const type = (/^data:image\/([a-z]+)/i.exec(record.dataUrl) || [])[1] || "png";
    const extension = type === "jpeg" ? "jpg" : type;
    const host = hostOf(record.url).replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "") || "capture";
    const stamp = new Date(Number(record.createdAt) || Date.now()).toISOString().replace(/[:.]/g, "-");
    const filename = `fathom-${host}-${stamp}.${extension}`;
    try {
      if (globalThis.chrome && chrome.downloads && typeof chrome.downloads.download === "function") {
        await chrome.downloads.download({ url: record.dataUrl, filename, saveAs: false });
        return;
      }
    } catch {
      /* fall back to an anchor download */
    }
    const link = document.createElement("a");
    link.href = record.dataUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function downloadOne(id) {
    try {
      const record = await Store.get(id);
      if (!record) {
        toast("That capture is no longer available.");
        return;
      }
      await downloadCapture(record);
    } catch {
      toast("Could not download that capture.");
    }
  }

  async function downloadSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    const button = $("#download-selected");
    const label = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Preparing…";
    }
    let done = 0;
    for (const id of ids) {
      try {
        const record = await Store.get(id);
        if (!record) continue;
        await downloadCapture(record);
        done += 1;
      } catch {
        /* try the rest */
      }
    }
    if (button) {
      button.textContent = label || "Download selected";
      button.disabled = selected.size === 0;
    }
    toast(done ? `${done} capture${done === 1 ? "" : "s"} downloading` : "Could not download the selected captures.");
  }

  async function deleteOne(id) {
    try {
      await Store.remove(id);
    } catch {
      toast("Could not delete that capture.");
      return;
    }
    selected.delete(id);
    captures = captures.filter((record) => Number(record.id) !== id);
    captureCount = Math.max(0, captureCount - 1);
    if (currentRoute === "history") rerenderCurrent();
    toast("Capture deleted");
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      await Store.removeMany(ids);
    } catch {
      toast("Could not delete the selected captures.");
      return;
    }
    const removed = new Set(ids);
    captures = captures.filter((record) => !removed.has(Number(record.id)));
    captureCount = Math.max(0, captureCount - ids.length);
    selected.clear();
    if (currentRoute === "history") rerenderCurrent();
    toast(ids.length === 1 ? "Capture deleted" : `${ids.length} captures deleted`);
  }

  function wireHistory() {
    const selectAll = $("#select-all");
    if (!selectAll) return;
    const grid = $("#history-grid");

    const sync = () => {
      const total = captures.length;
      const all = total > 0 && selected.size === total;
      selectAll.textContent = all ? "Clear selection" : "Select all";
      selectAll.setAttribute("aria-pressed", all ? "true" : "false");
      const has = selected.size > 0;
      const download = $("#download-selected");
      const remove = $("#delete-selected");
      if (download) download.disabled = !has;
      if (remove) remove.disabled = !has;
      const count = $("#history-count");
      if (count) count.textContent = historyCountText();
    };
    sync();

    selectAll.addEventListener("click", () => {
      if (captures.length && selected.size === captures.length) selected.clear();
      else for (const record of captures) selected.add(Number(record.id));
      if (grid) for (const box of $$("input[data-select]", grid)) box.checked = selected.has(Number(box.value));
      sync();
    });

    if (grid) {
      grid.addEventListener("change", (event) => {
        const box = event.target.closest("input[data-select]");
        if (!box) return;
        const id = Number(box.value);
        if (box.checked) selected.add(id);
        else selected.delete(id);
        sync();
      });

      grid.addEventListener("click", (event) => {
        const download = event.target.closest("[data-download]");
        if (download) {
          void downloadOne(Number(download.dataset.download));
          return;
        }
        const remove = event.target.closest("[data-delete]");
        if (remove) {
          void deleteOne(Number(remove.dataset.delete));
          return;
        }
        if (event.target.closest("a, button, input, label")) return;
        const card = event.target.closest(".capture-card");
        if (card) openPage(`capture.html?id=${encodeURIComponent(card.dataset.id)}`);
      });
    }

    const download = $("#download-selected");
    if (download) download.addEventListener("click", () => void downloadSelected());
    const remove = $("#delete-selected");
    if (remove) remove.addEventListener("click", () => void deleteSelected());
  }

  function wireResponsive() {
    const fit = $("#resp-fit");
    if (fit) fit.addEventListener("change", () => void persist({ responsive: { fit: fit.checked } }));

    const zoom = $("#resp-zoom");
    const output = $("#resp-zoom-value");
    if (zoom) {
      const syncZoom = () => {
        if (output) output.textContent = `${zoom.value}%`;
      };
      let zoomTimer = 0;
      let lastZoom = Number(zoom.value);
      const saveZoom = () => {
        const value = Number(zoom.value);
        if (!Number.isFinite(value) || value === lastZoom) return;
        lastZoom = value;
        void persist({ responsive: { percent: value } });
      };
      zoom.addEventListener("input", () => {
        syncZoom();
        clearTimeout(zoomTimer);
        zoomTimer = setTimeout(saveZoom, 180);
      });
      zoom.addEventListener("change", () => {
        clearTimeout(zoomTimer);
        syncZoom();
        saveZoom();
      });
    }

    const chips = $("#resp-widths");
    if (chips) {
      chips.addEventListener("click", (event) => {
        const chip = event.target.closest("[data-width]");
        if (!chip) return;
        const width = Number(chip.dataset.width);
        const widths = state.responsive.widths.slice();
        const index = widths.indexOf(width);
        if (index >= 0) {
          if (widths.length <= 1) {
            toast("Keep at least one width.");
            return;
          }
          widths.splice(index, 1);
        } else {
          if (widths.length >= MAX_WIDTHS) {
            toast("Six widths is the maximum — remove one first.");
            return;
          }
          widths.push(width);
        }
        widths.sort((a, b) => a - b);
        void persist({ responsive: { widths } });
        syncWidthChips();
      });
    }

    const open = $("#open-viewer");
    if (open) open.addEventListener("click", () => openPage("responsive.html"));
  }

  function syncWidthChips() {
    for (const chip of $$("#resp-widths [data-width]")) {
      const width = Number(chip.dataset.width);
      chip.setAttribute("aria-pressed", state.responsive.widths.includes(width) ? "true" : "false");
    }
  }

  async function resetAllSettings() {
    try {
      state = await Settings.reset();
    } catch {
      toast("Could not reset settings.");
      return;
    }
    previewMinimized = state.dock.minimized;
    flashSaved();
    rerenderCurrent();
    toast("All settings reset to defaults");
  }

  function wireAbout() {
    const reset = $("#reset-settings");
    if (reset) reset.addEventListener("click", () => void resetAllSettings());
  }

  function wireRoute(route) {
    if (route === "overview") wireOverview();
    else if (route === "capture") wireCapture();
    else if (route === "history") wireHistory();
    else if (route === "dock") wireDock();
    else if (route === "responsive") wireResponsive();
    else if (route === "about") wireAbout();
  }

  function rerenderCurrent() {
    const content = $("#content");
    if (!content) return;
    content.innerHTML = templateFor(currentRoute);
    wireRoute(currentRoute);
  }

  /* -------------------------------------------------------------- routing --- */

  function routeFromHash() {
    const raw = (location.hash || "").replace(/^#/, "").trim().toLowerCase();
    return ROUTES.includes(raw) ? raw : "overview";
  }

  function navigate(route) {
    if (!ROUTES.includes(route)) return;
    if (location.hash === `#${route}`) {
      void showRoute(route, { focus: true });
      return;
    }
    location.hash = route;
  }

  async function refreshCaptureCount() {
    if (!Store) {
      captureCount = 0;
      return;
    }
    try {
      captureCount = await Store.count();
    } catch {
      captureCount = 0;
    }
  }

  async function loadCaptures() {
    if (!Store) return [];
    try {
      return await Store.list();
    } catch {
      toast("Could not read the capture history.");
      return [];
    }
  }

  async function showRoute(name, { focus = false } = {}) {
    const route = ROUTES.includes(name) ? name : "overview";
    const run = ++routeRun;
    currentRoute = route;
    const meta = META[route];

    document.title = `${meta.title} — Fathom${version ? ` ${version}` : ""}`;
    const title = $("#page-title");
    if (title) title.textContent = meta.title;
    const desc = $("#page-desc");
    if (desc) desc.textContent = meta.desc;

    for (const button of $$(".nav-item")) {
      if (button.dataset.route === route) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }

    if (route === "overview") await refreshCaptureCount();
    if (route === "history") {
      selected = new Set();
      captures = await loadCaptures();
    }
    if (run !== routeRun) return;

    const content = $("#content");
    if (content) content.innerHTML = templateFor(route);
    wireRoute(route);
    window.scrollTo(0, 0);
    if (focus && title) title.focus({ preventScroll: true });
  }

  function onNavKeydown(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const buttons = $$(".nav-item");
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    let next = index;
    if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else next = buttons.length - 1;
    buttons[next].focus();
  }

  function wireShell() {
    const nav = $("#nav");
    if (nav) {
      nav.addEventListener("click", (event) => {
        const button = event.target.closest(".nav-item");
        if (button && button.dataset.route) navigate(button.dataset.route);
      });
      nav.addEventListener("keydown", onNavKeydown);
    }
    window.addEventListener("hashchange", () => void showRoute(routeFromHash(), { focus: true }));
  }

  function renderUnavailable() {
    const content = $("#content");
    if (!content) return;
    content.innerHTML = `<section class="route" aria-label="Settings unavailable">
      <div class="card empty-card">
        <div class="empty-state">
          <strong>Settings are unavailable</strong>
          <p>The dashboard needs the Fathom extension context. Open it from chrome://extensions.</p>
        </div>
      </div>
    </section>`;
    document.title = "Fathom — dashboard";
  }

  /* ----------------------------------------------------------------- boot --- */

  async function boot() {
    version = readVersion();
    const sidebarVersion = $("#sidebar-version");
    if (sidebarVersion) sidebarVersion.textContent = version ? `Fathom ${version}` : "Fathom";

    if (!Settings) {
      renderUnavailable();
      return;
    }

    state = await loadSettings();
    previewMinimized = state.dock.minimized;
    wireShell();

    const start = routeFromHash();
    if (location.hash !== `#${start}`) {
      try {
        history.replaceState(null, "", `#${start}`);
      } catch {
        /* leave the hash alone */
      }
    }
    await showRoute(start, { focus: false });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
  } else {
    void boot();
  }
})();
