/*
 * Tool: Capture.
 *
 * Four modes, all built on chrome.tabs.captureVisibleTab (no debugger, no CDP):
 *   visible  one shot of the viewport
 *   full     scroll-and-stitch the whole document
 *   snip     drag a rectangle, then stitch + crop
 *   element  pick an element, then stitch + crop to its box
 *
 * Our own UI is hidden for every shot, otherwise the dock would appear in the
 * screenshot. A separate progress chip is appended outside the shadow host so
 * the user still sees that work is happening.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  const { h } = F.util;

  const MAX_TILES = 40;
  const MAX_HEIGHT = 32000;
  const SETTLE_MS = 120;

  let lastCapture = null;

  const sleep = F.util.sleep;

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function progressChip(text) {
    const el = document.createElement("div");
    el.setAttribute("data-fathom-helper", "");
    Object.assign(el.style, {
      position: "fixed",
      left: "50%",
      bottom: "20px",
      translate: "-50% 0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      gap: "9px",
      padding: "9px 15px",
      background: "#18151e",
      color: "#fff",
      border: "1px solid #a164ec",
      borderRadius: "12px",
      boxShadow: "0 12px 40px #000a",
      font: "12px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    });
    const spinner = document.createElement("span");
    Object.assign(spinner.style, {
      width: "12px",
      height: "12px",
      border: "2px solid #ffffff30",
      borderTopColor: "#fff",
      borderRadius: "50%",
      animation: "fathom-spin .7s linear infinite",
    });
    const style = document.createElement("style");
    style.textContent = "@keyframes fathom-spin{to{rotate:360deg}}";
    el.append(style, spinner, document.createTextNode(text));
    document.documentElement.append(el);
    return {
      set: (t) => {
        el.lastChild.textContent = t;
      },
      remove: () => el.remove(),
    };
  }

  /**
   * Hide every piece of our own UI before a shot. The dock lives in the shadow
   * host, but the progress chip and the measure outline are appended to the
   * page's documentElement, so hiding the host alone would bake them into the
   * screenshot.
   */
  function hideWorkspace() {
    const host = document.querySelector("fathom-workspace");
    const targets = [];
    if (host) targets.push(host);
    for (const el of document.querySelectorAll("[data-fathom-helper]")) {
      if (!host || !host.contains(el)) targets.push(el);
    }
    const previous = targets.map((el) => [el, el.style.visibility]);
    for (const el of targets) el.style.visibility = "hidden";
    return () => {
      for (const [el, value] of previous) el.style.visibility = value;
    };
  }

  /** Elements the page keeps pinned — they would smear across every tile. */
  function stickyAndFixed() {
    const out = [];
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      if (el.closest("fathom-workspace")) continue;
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") out.push(el);
      if (out.length > 40) break;
    }
    return out;
  }

  async function shot(token) {
    const res = await F.call({ operation: "capture-shot", token });
    return res.dataUrl;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("The screenshot could not be decoded."));
      img.src = src;
    });
  }

  /**
   * Scroll through the document, capture each viewport, paint the tiles onto one
   * canvas. Returns { canvas, scale } where canvas pixels are already DPR-scaled.
   * `opts` comes from the dashboard: maxScreens, longPage, scrollBefore.
   */
  async function stitch(token, chip, opts = {}) {
    const dpr = window.devicePixelRatio || 1;
    const viewport = window.innerHeight;
    const screenCap = Math.min(
      Math.max(1, opts.maxScreens || 10),
      opts.longPage ? MAX_TILES : 10,
    );
    const docHeight = Math.min(
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      MAX_HEIGHT,
    );
    const startY = window.scrollY;

    /* A quick pass to the bottom and back wakes lazy images and scroll
       animations before the first tile is taken. */
    if (opts.scrollBefore !== false) {
      const steps = Math.min(6, Math.max(1, Math.ceil(docHeight / viewport) - 1));
      for (let i = 1; i <= steps; i++) {
        window.scrollTo(0, Math.min(docHeight - viewport, (docHeight / (steps + 1)) * i));
        await nextPaint();
        await sleep(60);
      }
      window.scrollTo(0, startY);
      await nextPaint();
    }

    const tiles = Math.min(Math.ceil(docHeight / viewport), screenCap);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(Math.min(docHeight, tiles * viewport) * dpr);
    const ctx = canvas.getContext("2d");

    const pinned = stickyAndFixed();
    const restorePinned = pinned.map((el) => [el, el.style.visibility]);
    const first = await loadImage(await shot(token));
    ctx.drawImage(first, 0, 0, canvas.width, Math.min(first.height, canvas.height));

    for (const el of pinned) el.style.visibility = "hidden";

    for (let i = 1; i < tiles; i++) {
      const y = i * viewport;
      window.scrollTo(0, y);
      await nextPaint();
      await sleep(SETTLE_MS);
      chip?.set(`Capturing ${i + 1} of ${tiles}…`);
      try {
        const img = await loadImage(await shot(token));
        ctx.drawImage(img, 0, Math.round(y * dpr), canvas.width, img.height);
      } catch {
        break; // quota or rate limit — keep what we already have
      }
    }

    for (const [el, value] of restorePinned) el.style.visibility = value;
    window.scrollTo(0, startY);
    await nextPaint();

    return { canvas, scale: dpr };
  }

  function crop(canvas, rect, dpr) {
    const x = Math.max(0, Math.round(rect.left * dpr));
    const y = Math.max(0, Math.round(rect.top * dpr));
    const w = Math.min(canvas.width - x, Math.round(rect.width * dpr));
    const h = Math.min(canvas.height - y, Math.round(rect.height * dpr));
    if (w <= 0 || h <= 0) return canvas;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
    return out;
  }

  /** Drag-to-select rectangle, resolved in document coordinates. */
  function snip() {
    return new Promise((resolve) => {
      const host = document.querySelector("fathom-workspace");
      const root = host?.shadowRoot;
      const layer = document.createElement("div");
      Object.assign(layer.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483644",
        cursor: "crosshair",
        background: "#00000026",
      });
      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "absolute",
        border: "1px solid #bd91ff",
        background: "#b887ff26",
        display: "none",
      });
      layer.append(box);

      let start = null;
      const onDown = (event) => {
        event.preventDefault();
        start = { x: event.clientX, y: event.clientY };
        Object.assign(box.style, { display: "block", left: `${start.x}px`, top: `${start.y}px`, width: "0", height: "0" });
      };
      const onMove = (event) => {
        if (!start) return;
        const left = Math.min(start.x, event.clientX);
        const top = Math.min(start.y, event.clientY);
        Object.assign(box.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${Math.abs(event.clientX - start.x)}px`,
          height: `${Math.abs(event.clientY - start.y)}px`,
        });
      };
      const finish = (rect) => {
        layer.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(rect);
      };
      const onUp = (event) => {
        if (!start) return;
        const rect = {
          left: Math.min(start.x, event.clientX) + window.scrollX,
          top: Math.min(start.y, event.clientY) + window.scrollY,
          width: Math.abs(event.clientX - start.x),
          height: Math.abs(event.clientY - start.y),
        };
        finish(rect.width > 4 && rect.height > 4 ? rect : null);
      };
      const onKey = (event) => {
        if (event.key === "Escape") finish(null);
      };

      layer.addEventListener("pointerdown", onDown);
      layer.addEventListener("pointermove", onMove);
      layer.addEventListener("pointerup", onUp);
      document.addEventListener("keydown", onKey, true);

      (root || document.documentElement).append(layer);
    });
  }

  function showResult(api, panel) {
    const { dataUrl, width, height, mode } = lastCapture;
    const img = h("img", { class: "capture-preview", src: dataUrl, alt: "Captured screenshot" });
    panel.body.replaceChildren(
      img,
      h("p", {
        class: "meta",
        style: { marginTop: "8px" },
        text: `${mode} · ${width} × ${height}px`,
      }),
    );

    const save = async () => {
      const ext = EXT[lastCapture.format] || "png";
      await F.call({
        operation: "download-file",
        dataUrl,
        name: `fathom-${mode}-${location.hostname.replace(/[^a-z0-9.-]/gi, "") || "page"}-${Date.now()}.${ext}`,
      });
      api.toast("Screenshot saved", { tone: "success" });
    };

    const copy = async () => {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        api.toast("Copied image", { tone: "success", timeout: 1800 });
      } catch {
        api.toast("This browser refused clipboard access", { tone: "error" });
      }
    };

    const editor = async () => {
      try {
        await F.call({ operation: "capture-open-editor" });
        api.toast("Opened the editor");
      } catch (err) {
        api.toast(err.message || "The editor could not be opened.", { tone: "error" });
      }
    };

    panel.setActions([
      {
        label: `Save ${(lastCapture.format || "png").toUpperCase()}`,
        primary: true,
        icon: "M12 4v11m0 0l-4-4m4 4l4-4M5 20h14",
        onClick: save,
      },
      { label: "Copy", icon: "M8 8h10v12H8zM4 16V4h10", onClick: copy },
      { label: "Edit", icon: "M4 20h4L20 8l-4-4L4 16z", onClick: editor },
    ]);
  }

  const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
  const EXT = { png: "png", jpeg: "jpg", webp: "webp" };

  const FALLBACK_CAPTURE = {
    afterCapture: "editor",
    format: "png",
    quality: 0.92,
    scale: 1,
    historyLimit: 10,
    scrollBefore: true,
    longPage: false,
    maxScreens: 20,
  };

  async function captureSettings() {
    try {
      const all = await F.settings.load();
      return { ...FALLBACK_CAPTURE, ...(all.capture || {}) };
    } catch {
      return FALLBACK_CAPTURE;
    }
  }

  /** Export scale, applied after cropping so the crop maths stays in device pixels. */
  function scaleCanvas(canvas, factor) {
    if (!factor || factor === 1) return canvas;
    const out = document.createElement("canvas");
    out.width = Math.round(canvas.width * factor);
    out.height = Math.round(canvas.height * factor);
    const ctx = out.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }

  /** A small JPEG for the history list; the full image is stored separately. */
  function thumbnail(canvas, width = 320) {
    const out = document.createElement("canvas");
    out.width = Math.min(width, canvas.width);
    out.height = Math.max(1, Math.round((out.width / canvas.width) * canvas.height));
    out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
    return out.toDataURL("image/jpeg", 0.72);
  }

  /**
   * History is written by the service worker, not here: a content script's
   * IndexedDB is scoped to the visited page's origin, so the dashboard (an
   * extension page) would never see records created from this side.
   */
  async function rememberCapture(canvas, dataUrl, mode, settings) {
    if (!settings.historyLimit) return null;
    try {
      const res = await F.call({
        operation: "capture-save",
        capture: {
          dataUrl,
          thumb: thumbnail(canvas),
          width: canvas.width,
          height: canvas.height,
          url: location.href,
          mode,
          limit: settings.historyLimit,
        },
      });
      return res.id ?? null;
    } catch {
      return null; // history is a convenience, never a reason to fail a capture
    }
  }

  /** What the dashboard says should happen when a shot is ready. */
  async function afterCapture(settings, dataUrl, mode, api) {
    const ext = EXT[settings.format] || "png";
    try {
      if (settings.afterCapture === "download") {
        await F.call({
          operation: "download-file",
          dataUrl,
          name: `fathom-${mode}-${location.hostname.replace(/[^a-z0-9.-]/gi, "") || "page"}-${Date.now()}.${ext}`,
        });
        api.toast("Saved to your downloads", { tone: "success" });
      } else if (settings.afterCapture === "copy") {
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        api.toast("Copied to the clipboard", { tone: "success" });
      } else if (settings.afterCapture === "editor") {
        await F.call({ operation: "capture-open-editor" });
      }
    } catch (err) {
      api.toast(err.message || "The follow-up action failed.", { tone: "error" });
    }
  }

  async function run(mode, api, panel) {
    panel.busy("Preparing…");
    let token;
    try {
      token = (await F.call({ operation: "capture-start" })).token;
    } catch (err) {
      panel.busy(null);
      api.toast(err.message || "Capture is unavailable on this page.", { tone: "error" });
      return;
    }

    const chip = progressChip(mode === "full" ? "Preparing full-page capture…" : "Capturing…");
    const restore = () => {
      chip.remove();
      panel.busy(null);
    };

    const settings = await captureSettings();

    try {
      let canvas;

      if (mode === "visible") {
        const hide = hideWorkspace();
        await nextPaint();
        const dataUrl = await shot(token);
        hide();
        const img = await loadImage(dataUrl);
        canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
      } else if (mode === "snip") {
        restore();
        const rect = await snip();
        if (!rect) {
          await F.call({ operation: "capture-end", token });
          return;
        }
        panel.busy("Capturing the page…");
        const chip2 = progressChip("Capturing…");
        const hide = hideWorkspace();
        await nextPaint();
        const stitched = await stitch(token, chip2, settings);
        hide();
        chip2.remove();
        canvas = crop(stitched.canvas, rect, stitched.scale);
      } else if (mode === "element") {
        restore();
        const el = await new Promise((resolve) => F.workspace.pick(resolve, { hint: "Click an element to capture" }));
        if (!el) {
          await F.call({ operation: "capture-end", token });
          return;
        }
        el.scrollIntoView({ block: "center", behavior: "instant" });
        await nextPaint();
        await sleep(SETTLE_MS);
        panel.busy("Capturing the page…");
        const chip2 = progressChip("Capturing…");
        const hide = hideWorkspace();
        await nextPaint();
        const stitched = await stitch(token, chip2, settings);
        hide();
        chip2.remove();
        const r = el.getBoundingClientRect();
        canvas = crop(
          stitched.canvas,
          {
            left: r.left + window.scrollX,
            top: r.top + window.scrollY,
            width: r.width,
            height: r.height,
          },
          stitched.scale,
        );
      } else {
        const hide = hideWorkspace();
        await nextPaint();
        const stitched = await stitch(token, chip, settings);
        hide();
        canvas = stitched.canvas;
      }

      const scaled = scaleCanvas(canvas, settings.scale);
      const mime = MIME[settings.format] || "image/png";
      const dataUrl = scaled.toDataURL(mime, settings.quality);
      lastCapture = {
        dataUrl,
        width: scaled.width,
        height: scaled.height,
        mode,
        url: location.href,
        format: settings.format,
      };

      await F.call({ operation: "capture-end", token }).catch(() => {});
      panel.busy(null);
      showResult(api, panel);
      api.toast("Capture ready", { tone: "success", timeout: 2000 });
      await rememberCapture(scaled, dataUrl, mode, settings);
      await afterCapture(settings, dataUrl, mode, api);
    } catch (err) {
      await F.call({ operation: "capture-end", token }).catch(() => {});
      api.toast(err.message || "The capture failed.", { tone: "error" });
    } finally {
      restore();
    }
  }

  F.workspace.register("capture", async (api) => {
    const panel = api.panel({
      title: "Screenshot",
      subtitle: "Stay on this tab while Fathom captures",
      size: "auto",
      tool: "capture",
    });

    const options = [
      ["visible", "Visible area", "What's on screen"],
      ["full", "Full page", "The whole page"],
      ["snip", "Snip", "Drag to select an area"],
      ["element", "Element", "Click a component"],
    ];

    panel.body.replaceChildren(
      h(
        "div",
        { class: "capture-options" },
        options.map(([mode, label, hint]) =>
          h(
            "button",
            {
              class: "capture-option",
              type: "button",
              onclick: () => run(mode, api, panel),
            },
            h("strong", { text: label }),
            h("span", { text: hint }),
          ),
        ),
      ),
      h("p", { class: "meta", style: { marginTop: "10px" } }, "Esc cancels · the page must stay active"),
    );

    if (lastCapture) showResult(api, panel);
  });

  /* The capture editor page asks this tab for the frame it just produced. */
  F.workspace.ops["capture-fetch"] = () => {
    if (!lastCapture) throw new Error("There is no capture in this tab. Take a screenshot first.");
    return lastCapture;
  };
})();
