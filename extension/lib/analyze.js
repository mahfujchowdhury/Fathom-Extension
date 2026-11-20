/*
 * Fathom — page analysis shared by the extraction tools (assets, colours, fonts,
 * prompt). Everything here reads the live document; nothing mutates it.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F) return;

  const analyze = (F.analyze = {});

  const MAX_ELEMENTS = 4000;

  function eachElement(doc, fn) {
    const all = doc.querySelectorAll("*");
    const limit = Math.min(all.length, MAX_ELEMENTS);
    for (let i = 0; i < limit; i++) fn(all[i], i);
    return limit;
  }

  /* ----------------------------------------------------------- colours --- */

  const TRANSPARENT = /^(transparent|rgba?\([^)]*,\s*0\s*\)|rgba?\(0,\s*0,\s*0,\s*0\))$/i;

  analyze.parseColor = function parseColor(input) {
    const value = String(input).trim();
    if (!value || TRANSPARENT.test(value)) return null;
    const hex = value.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h.split("").map((c) => c + c).join("");
      if (h.length !== 6) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      };
    }
    const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/i);
    if (!rgb) return null;
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    if (alpha === 0) return null;
    return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: alpha };
  };

  analyze.toHex = function toHex(color) {
    const part = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
  };

  analyze.luminance = function luminance(color) {
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };

  /** WCAG 2.1 contrast ratio, 1–21. */
  analyze.contrast = function contrast(a, b) {
    const l1 = analyze.luminance(a);
    const l2 = analyze.luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  /**
   * Every painted colour on the page with its role and occurrence count.
   * Returns [{ value: "#rrggbb", count, roles: ["background"|"text"|"border"] }]
   */
  analyze.colors = function colors(doc = document) {
    const seen = new Map();

    const add = (raw, role) => {
      const parsed = analyze.parseColor(raw);
      if (!parsed) return;
      const value = analyze.toHex(parsed);
      let entry = seen.get(value);
      if (!entry) {
        entry = { value, count: 0, roles: new Set(), parsed };
        seen.set(value, entry);
      }
      entry.count += 1;
      entry.roles.add(role);
    };

    eachElement(doc, (el) => {
      const cs = getComputedStyle(el);
      add(cs.backgroundColor, "background");
      add(cs.color, "text");
      add(cs.borderTopColor, "border");
      add(cs.borderLeftColor, "border");
      if (cs.outlineStyle !== "none") add(cs.outlineColor, "border");
    });

    /* The page canvas itself is a background even if body is transparent. */
    add(getComputedStyle(doc.documentElement).backgroundColor, "background");

    return [...seen.values()]
      .map((e) => ({ value: e.value, count: e.count, roles: [...e.roles] }))
      .sort((a, b) => b.count - a.count);
  };

  /** Split colours into the roles the palette tool filters by. */
  analyze.roles = function roles(list) {
    const has = (entry, role) => entry.roles.includes(role);
    return {
      All: list,
      Background: list.filter((c) => has(c, "background")),
      Text: list.filter((c) => has(c, "text")),
      Border: list.filter((c) => has(c, "border")),
      Accent: list.filter((c) => c.count <= Math.max(2, list[0]?.count / 12)).slice(0, 24),
    };
  };

  /* ------------------------------------------------------------ assets --- */

  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|#|$)/i;
  const VIDEO_EXT = /\.(mp4|webm|ogg|mov|m3u8|mpd)(\?|#|$)/i;

  analyze.assets = function assets(doc = document) {
    const out = new Map();

    const push = (raw, kind, extra = {}) => {
      if (!raw) return;
      let url;
      try {
        url = new URL(raw, doc.baseURI);
      } catch {
        return;
      }
      if (!["http:", "https:", "data:"].includes(url.protocol)) return;
      const key = url.href;
      if (out.has(key)) return;
      out.set(key, {
        url: key,
        kind,
        format: (key.match(IMAGE_EXT) || key.match(VIDEO_EXT) || [null, kind === "video" ? "video" : "img"])[1],
        ...extra,
      });
    };

    for (const el of doc.querySelectorAll("img")) {
      const w = el.naturalWidth || el.width;
      const h = el.naturalHeight || el.height;
      push(el.currentSrc || el.src, "image", { width: w, height: h, alt: el.alt || "" });
    }

    for (const el of doc.querySelectorAll("video")) {
      push(el.currentSrc || el.src || el.poster, "video", { width: el.videoWidth, height: el.videoHeight });
    }

    for (const el of doc.querySelectorAll("source")) {
      push(el.src || el.getAttribute("srcset")?.split(" ")[0], el.type?.startsWith("video") ? "video" : "image");
    }

    eachElement(doc, (el) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === "none") return;
      for (const match of bg.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) push(match[2], "image");
    });

    for (const el of doc.querySelectorAll('link[rel~="icon"], meta[property="og:image"]')) {
      push(el.getAttribute("href") || el.getAttribute("content"), "image");
    }

    return [...out.values()];
  };

  analyze.formatSize = function formatSize(asset) {
    if (asset.width && asset.height) return `${asset.width} × ${asset.height}`;
    const ext = (asset.url.match(IMAGE_EXT) || asset.url.match(VIDEO_EXT) || [])[1];
    return ext ? ext.toUpperCase() : asset.kind;
  };

  /* ------------------------------------------------------------- fonts --- */

  const GENERIC = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "inherit",
    "initial",
  ]);

  analyze.fonts = function fonts(doc = document) {
    const seen = new Map();

    eachElement(doc, (el) => {
      const text = (el.textContent || "").trim();
      if (!text) return;
      /* Only leaf-ish elements: an ancestor's family is not a distinct usage. */
      if (el.children.length > 3) return;

      const cs = getComputedStyle(el);
      const family = cs.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
      if (!family || GENERIC.has(family.toLowerCase())) return;

      let entry = seen.get(family);
      if (!entry) {
        entry = { family, count: 0, sizes: new Set(), weights: new Set(), lineHeights: new Set(), sample: "" };
        seen.set(family, entry);
      }
      entry.count += 1;
      entry.sizes.add(Math.round(parseFloat(cs.fontSize)));
      entry.weights.add(Number(cs.fontWeight) || 400);
      entry.lineHeights.add(cs.lineHeight);
      if (!entry.sample && text.length > 12) entry.sample = text.slice(0, 80);
    });

    return [...seen.values()]
      .map((e) => ({
        family: e.family,
        count: e.count,
        sizes: [...e.sizes].sort((a, b) => b - a),
        weights: [...e.weights].sort((a, b) => a - b),
        lineHeights: [...e.lineHeights].slice(0, 4),
        sample: e.sample,
      }))
      .sort((a, b) => b.count - a.count);
  };

  /* ------------------------------------------------------------ layout --- */

  /** Coarse page outline for the design-prompt tool. */
  analyze.outline = function outline(doc = document) {
    const sections = [];
    const candidates = doc.querySelectorAll("header, nav, main, section, article, aside, footer, form");
    for (const el of candidates) {
      const heading = el.querySelector("h1, h2, h3");
      const rect = el.getBoundingClientRect();
      if (rect.height < 24) continue;
      sections.push({
        tag: el.tagName.toLowerCase(),
        heading: (heading?.textContent || "").trim().slice(0, 90),
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180),
        height: Math.round(rect.height),
      });
      if (sections.length >= 12) break;
    }
    return sections;
  };

  analyze.meta = function meta(doc = document) {
    const cs = getComputedStyle(doc.body);
    return {
      title: doc.title || doc.location?.hostname || "",
      url: doc.location?.href || "",
      description: doc.querySelector('meta[name="description"]')?.content || "",
      background: analyze.parseColor(cs.backgroundColor) ? analyze.toHex(analyze.parseColor(cs.backgroundColor)) : "#ffffff",
      color: analyze.toHex(analyze.parseColor(cs.color) || { r: 17, g: 17, b: 17 }),
      fontFamily: cs.fontFamily,
      baseSize: cs.fontSize,
      width: doc.documentElement.scrollWidth,
      height: doc.documentElement.scrollHeight,
    };
  };
})();
