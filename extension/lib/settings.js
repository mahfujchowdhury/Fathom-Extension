/*
 * Fathom — shared settings.
 *
 * One key, one shape, used by the dashboard (writes) and the injected bundle
 * (reads). Loaded both as an injected classic script and as a page script, so it
 * must not touch the DOM at evaluation time.
 */
(() => {
  const F = (globalThis.Fathom = globalThis.Fathom || {});

  const KEY = "fathomPrefsV1";

  const TOOL_IDS = [
    "element",
    "page",
    "brief",
    "designmd",
    "images",
    "palette",
    "type",
    "inspect",
    "text",
    "capture",
    "responsive",
    "fonts",
    "arrange",
  ];

  const DEFAULTS = {
    order: TOOL_IDS.slice(),
    enabled: TOOL_IDS.slice(),
    capture: {
      afterCapture: "editor", // "editor" | "download" | "copy"
      format: "png", // "png" | "jpeg" | "webp"
      quality: 0.92, // jpeg/webp only
      scale: 1, // 1 | 1.5 | 2
      historyLimit: 10, // 0 disables the history
      scrollBefore: true, // scroll the page once before a full capture
      longPage: false, // lift the 10-screen cap
      maxScreens: 20, // 1..40
    },
    dock: {
      layout: "bottom", // "bottom" | "sidebar"
      side: "right", // "left" | "right", used by sidebar + minimized
      minimized: false,
    },
    responsive: {
      fit: true,
      percent: 60,
      widths: [375, 768, 1440],
    },
  };

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

  /** Fill in anything missing and drop anything nonsensical. */
  function merge(stored) {
    const src = stored && typeof stored === "object" ? stored : {};
    const capture = src.capture && typeof src.capture === "object" ? src.capture : {};
    const dock = src.dock && typeof src.dock === "object" ? src.dock : {};
    const responsive = src.responsive && typeof src.responsive === "object" ? src.responsive : {};

    const enabled = Array.isArray(src.enabled)
      ? src.enabled.filter((id) => TOOL_IDS.includes(id))
      : DEFAULTS.enabled.slice();

    const order = [];
    for (const id of Array.isArray(src.order) ? src.order : []) {
      if (TOOL_IDS.includes(id) && !order.includes(id)) order.push(id);
    }
    for (const id of TOOL_IDS) if (!order.includes(id)) order.push(id);

    const widths = Array.isArray(responsive.widths)
      ? responsive.widths.map((w) => clamp(w, 240, 2560, 0)).filter(Boolean).slice(0, 6)
      : DEFAULTS.responsive.widths.slice();

    return {
      order,
      enabled: enabled.length ? enabled : DEFAULTS.enabled.slice(),
      capture: {
        afterCapture: oneOf(capture.afterCapture, ["editor", "download", "copy"], DEFAULTS.capture.afterCapture),
        format: oneOf(capture.format, ["png", "jpeg", "webp"], DEFAULTS.capture.format),
        quality: clamp(capture.quality, 0.3, 1, DEFAULTS.capture.quality),
        scale: oneOf(capture.scale, [1, 1.5, 2], DEFAULTS.capture.scale),
        historyLimit: Math.round(clamp(capture.historyLimit, 0, 100, DEFAULTS.capture.historyLimit)),
        scrollBefore: capture.scrollBefore !== false,
        longPage: capture.longPage === true,
        maxScreens: Math.round(clamp(capture.maxScreens, 1, 40, DEFAULTS.capture.maxScreens)),
      },
      dock: {
        layout: oneOf(dock.layout, ["bottom", "sidebar"], DEFAULTS.dock.layout),
        side: oneOf(dock.side, ["left", "right"], DEFAULTS.dock.side),
        minimized: dock.minimized === true,
      },
      responsive: {
        fit: responsive.fit !== false,
        percent: Math.round(clamp(responsive.percent, 20, 100, DEFAULTS.responsive.percent)),
        widths: widths.length ? widths : DEFAULTS.responsive.widths.slice(),
      },
    };
  }

  async function load() {
    try {
      const stored = (await chrome.storage.local.get(KEY))[KEY];
      return merge(stored);
    } catch {
      return merge(null);
    }
  }

  /** Shallow-merge a patch into the stored settings and persist the result. */
  async function save(patch) {
    const current = await load();
    const next = merge({
      ...current,
      ...patch,
      capture: { ...current.capture, ...(patch?.capture || {}) },
      dock: { ...current.dock, ...(patch?.dock || {}) },
      responsive: { ...current.responsive, ...(patch?.responsive || {}) },
    });
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  async function reset() {
    await chrome.storage.local.set({ [KEY]: merge(null) });
    return merge(null);
  }

  F.settings = { KEY, TOOL_IDS, DEFAULTS, merge, load, save, reset, clamp };
})();
