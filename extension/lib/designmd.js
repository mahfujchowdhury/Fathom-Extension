/*
 * Fathom — Design MD: deterministic, offline design-system extraction.
 *
 *   collect(doc = document) -> Model    one computed-style walk, ≤ 2500 elements
 *   render(model, meta)     -> string   GitHub-flavoured markdown
 *   validate(markdown)      -> { ok, problems }
 *
 * Every value is read from `getComputedStyle`; nothing is inferred, so the same
 * model always renders byte-identical markdown. The only timestamp is the
 * `generatedAt` the caller passes. No imports, no build step, no DOM access while
 * the file evaluates.
 *
 * Model keys: url, title, theme, viewport{width,height},
 *   colors[{value,count,roles,contrastWith?}],
 *   typography[{family,sizes,weights,lineHeights,count,sample}],
 *   spacing[{value,count}], gaps[], radii[], shadows[], breakpoints[string],
 *   motion[{value,kind:"duration"|"easing",count}],
 *   components[{signature,count,example{tag,text,background,color,radius,padding,
 *   border,shadow}}], layout[{label,width,display,columns,gap,padding}],
 *   keyframes[string], variables[{name,value}],
 *   stats{elements,headings,links,images,forms,cssVariables,…extras}.
 */
(() => {
  "use strict";

  const F = (globalThis.Fathom = globalThis.Fathom || {});

  /* ------------------------------------------------------------- limits --- */

  const CAP = {
    elements: 2500, colors: 40, fonts: 24, sizes: 20, lineHeights: 8, spacing: 30,
    gaps: 12, radii: 12, shadows: 12, breakpoints: 12, motion: 8, components: 12,
    layout: 8, keyframes: 8, variables: 60, rules: 12000,
  };

  // The nine-part outline, in render order. `validate` asserts these verbatim.
  const SECTIONS = [
    "Color palette", "Typography", "Spacing, shape & motion", "Keyframes", "Component recipes",
    "Layout measurements", "Responsive conditions", "CSS custom properties", "Capture coverage",
  ];

  const SKIP_TAGS = new Set(["script", "style", "link", "meta", "noscript", "template", "head", "base", "title"]);
  const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
  const FORM_TAGS = new Set(["form", "input", "select", "textarea"]);
  const CONTAINER_TAGS = new Set(["header", "nav", "main", "footer", "section", "article", "aside"]);
  const CONTAINER_HINT = /(container|wrapper|shell|layout|grid|row|hero|content|page)/i;
  const OWN_SELECTOR = "fathom-workspace,[data-fathom-ui],[data-fathom-helper]";
  const SIDES = ["Top", "Right", "Bottom", "Left"];
  const BOX_PROPS = ["marginTop", "marginRight", "marginBottom", "marginLeft", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];

  /* --------------------------------------------------------- primitives --- */

  // Locale-independent compare: `localeCompare` would break determinism.
  const cmp = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const count = (n) => (Number.isFinite(Number(n)) ? String(Math.round(Number(n))) : "0");
  const plain = (v) => String(v === null || v === undefined ? "" : v).replace(/\s+/g, " ").trim();
  const clip = (v, max) => (plain(v).length > max ? `${plain(v).slice(0, Math.max(0, max - 1))}…` : plain(v));

  /** "8px" -> 8; "auto", "normal", percentages and calc() -> null. */
  function px(value) {
    const m = /^(-?\d*\.?\d+)(px)?$/.exec(plain(value));
    const n = m ? parseFloat(m[1]) : NaN;
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }

  // Quantise a length to a 4px bucket so near-identical paddings group together.
  const bucket = (value) => Math.round((Number(value) || 0) / 4) * 4;

  /** Split a comma list without breaking `cubic-bezier(a, b, c, d)`. */
  function splitTop(value) {
    const out = [];
    let depth = 0;
    let buf = "";
    for (const ch of plain(value)) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) {
        if (buf.trim()) out.push(buf.trim());
        buf = "";
      } else buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const sortByUse = (a, b) => b.count - a.count || cmp(a.value, b.value);
  const listText = (items) => (items.length ? items.join(", ") : "—");
  const plural = (n, one, many) => `${count(n)} ${Number(n) === 1 ? one : many}`;

  function table(head, rows) {
    const out = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
    for (const row of rows) out.push(`| ${row.join(" | ")} |`);
    return out;
  }

  // Escape `|` so a value cannot split a row, and `& < >` so page copy can never
  // inject HTML into the rendered document.
  const cell = (v) => plain(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|");
  const code = (v) => {
    const s = plain(v).replace(/`/g, "'").replace(/\|/g, "\\|");
    return s ? `\`${s}\`` : "—";
  };

  /* ------------------------------------------------------------- colour --- */

  const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : NaN);
  const channelOf = (p) => (!p || p === "none" ? 0 : p.endsWith("%") ? Math.round((parseFloat(p) / 100) * 255) : Math.round(parseFloat(p)));
  const alphaOf = (p) => (!p ? 1 : p.endsWith("%") ? clamp01(parseFloat(p) / 100) : clamp01(parseFloat(p)));

  /**
   * Parse a computed colour into `{ value, r, g, b, a }`; `value` is `#rrggbb`
   * when opaque and `rgba(r, g, b, a)` otherwise. Fully transparent, `none`,
   * `currentcolor` and unparsable colour spaces (oklch, lab, …) return null.
   */
  function parseColor(raw) {
    const s = plain(raw).toLowerCase();
    if (!s || s === "transparent" || s === "none" || s === "currentcolor") return null;
    const rgb = /^rgba?\(([^)]*)\)$/.exec(s);
    const srgb = rgb ? null : /^color\(srgb\s+([^)]*)\)$/.exec(s);
    const hex = rgb || srgb ? null : /^#([0-9a-f]{3,8})$/.exec(s);
    let r, g, b, a = 1;
    if (rgb || srgb) {
      const parts = (rgb || srgb)[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      if (rgb) {
        [r, g, b] = [channelOf(parts[0]), channelOf(parts[1]), channelOf(parts[2])];
        if (parts.length > 3) a = alphaOf(parts[3]);
      } else {
        const unit = (v) => Math.round(clamp01(parseFloat(v)) * 255);
        [r, g, b] = [unit(parts[0]), unit(parts[1]), unit(parts[2])];
        if (parts.length > 3) a = clamp01(parseFloat(parts[3]));
      }
    } else if (hex) {
      let h = hex[1];
      if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
      if (h.length !== 6 && h.length !== 8) return null;
      const at = (i) => parseInt(h.slice(i, i + 2), 16);
      [r, g, b] = [at(0), at(2), at(4)];
      if (h.length === 8) a = at(6) / 255;
    } else return null;
    if (![r, g, b, a].every(Number.isFinite) || a <= 0) return null;
    const hx = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    const value = a >= 1 ? `#${hx(r)}${hx(g)}${hx(b)}` : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 1000) / 1000})`;
    return { value, r, g, b, a };
  }

  function bumpColor(map, color, role) {
    if (!color) return;
    let rec = map.get(color.value);
    if (!rec) {
      rec = { value: color.value, count: 0, roles: new Set() };
      Object.assign(rec, { r: color.r, g: color.g, b: color.b, a: color.a });
      map.set(color.value, rec);
    }
    rec.count += 1;
    rec.roles.add(role);
  }

  function relativeLuminance(color) {
    const lin = (c) => {
      const v = Math.max(0, Math.min(255, Number(c) || 0)) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b);
  }

  const contrastRatio = (a, b) => {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  // The most-used background is the reference surface for contrast ratios.
  function pageBackground(map) {
    let best = null;
    for (const rec of map.values()) {
      if (rec.roles.has("background") && (!best || rec.count > best.count)) best = rec;
    }
    return best || { value: "#ffffff", r: 255, g: 255, b: 255, a: 1 };
  }

  /* --------------------------------------------------------- box helpers --- */

  function borderWidth(cs, side) {
    const style = cs[`border${side}Style`];
    if (!style || style === "none" || style === "hidden") return 0;
    return Math.max(0, parseFloat(cs[`border${side}Width`]) || 0);
  }

  // Distinct visible border and outline colours of one element, counted once each.
  function borderColors(cs) {
    const seen = new Set();
    const out = [];
    for (const side of SIDES) {
      if (borderWidth(cs, side) <= 0) continue;
      const color = parseColor(cs[`border${side}Color`]);
      if (color && !seen.has(color.value)) {
        seen.add(color.value);
        out.push(color);
      }
    }
    if ((parseFloat(cs.outlineWidth) || 0) > 0 && cs.outlineStyle && cs.outlineStyle !== "none") {
      const outline = parseColor(cs.outlineColor);
      if (outline && !seen.has(outline.value)) out.push(outline);
    }
    return out;
  }

  const pad = (cs) => SIDES.map((side) => plain(cs[`padding${side}`]) || "0px").join(" ");
  const borderOf = (cs, w) => (w ? `${Math.round(w)}px ${plain(cs.borderTopStyle) || "solid"} ${plain(cs.borderTopColor)}` : "none");
  const gapOf = (cs) => ["columnGap", "rowGap"].map((p) => plain(cs[p])).find((v) => v && v !== "normal" && v !== "0px") || "";
  const visible = (cs, rect) => Boolean(rect) && (rect.width > 0 || rect.height > 0) && cs.display !== "none" &&
    cs.visibility !== "hidden" && cs.visibility !== "collapse" && cs.opacity !== "0";
  const isContainer = (el, tag, rect) => rect.width >= 240 && rect.height >= 80 &&
    (CONTAINER_TAGS.has(tag) || CONTAINER_HINT.test(`${el.id || ""} ${(el.getAttribute && el.getAttribute("class")) || ""}`));
  const isOwn = (el) => {
    try {
      return Boolean(el.closest && el.closest(OWN_SELECTOR));
    } catch {
      return false;
    }
  };

  function describe(el) {
    const cls = (el.getAttribute && el.getAttribute("class")) || "";
    const suffix = cls ? `.${cls.split(/\s+/).filter(Boolean).slice(0, 2).join(".")}` : "";
    return clip(String(el.tagName || "").toLowerCase() + (el.id ? `#${el.id}` : "") + suffix, 70);
  }

  /* ------------------------------------------------------- text sampling --- */

  /**
   * One TreeWalker pass instead of `textContent` per element (which would be
   * quadratic). `has` marks every ancestor of real text — used for the `text`
   * colour role — while `sample` holds the first text an element renders itself.
   */
  function collectText(d, root) {
    const has = new WeakSet();
    const sample = new WeakMap();
    let walker = null;
    try {
      walker = root && typeof d.createTreeWalker === "function" ? d.createTreeWalker(root, 4) : null;
    } catch {
      walker = null;
    }
    if (!walker) return { has, sample };
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      if (!sample.has(parent)) sample.set(parent, clip(node.nodeValue, 80));
      let ancestor = parent;
      for (let depth = 0; ancestor && depth < 12; depth += 1) {
        has.add(ancestor);
        ancestor = ancestor.parentElement;
      }
    }
    return { has, sample };
  }

  /* ---------------------------------------------------- stylesheet crawl --- */

  function widthConditions(condition) {
    const out = [];
    const re = /\((min|max)-width\s*:\s*([\d.]+)(px|em|rem)\)/gi;
    for (let m = re.exec(condition); m; m = re.exec(condition)) {
      out.push(`(${m[1].toLowerCase()}-width: ${m[2]}${m[3].toLowerCase()})`);
    }
    return out;
  }

  function byCondition(a, b) {
    const width = (s) => {
      const m = /([\d.]+)(px|em|rem)/.exec(s);
      return m ? parseFloat(m[1]) * (m[2] === "px" ? 1 : 16) : 0;
    };
    const delta = width(a) - width(b);
    if (delta) return delta;
    const minA = a.indexOf("(min") === 0;
    return minA !== b.indexOf("(min") === 0 ? (minA ? -1 : 1) : cmp(a, b);
  }

  /**
   * Crawl every readable stylesheet once for `@media` width conditions,
   * `@keyframes` names and `:root` custom properties. Cross-origin sheets throw
   * on `cssRules`; they are counted for the coverage section and skipped.
   */
  function scanStyleSheets(d) {
    const breakpoints = new Set();
    const variables = new Map();
    const keyframes = new Set();
    const sheets = [];
    let unreadable = 0;
    let rules = 0;
    try { for (const sheet of d.styleSheets || []) sheets.push(sheet); } catch { /* none */ }
    try { for (const sheet of d.adoptedStyleSheets || []) sheets.push(sheet); } catch { /* none */ }
    const KEYFRAMES = (typeof CSSRule !== "undefined" && CSSRule.KEYFRAMES_RULE) || 7;
    const stack = [];
    for (const sheet of sheets) {
      let list = null;
      try { list = sheet.cssRules; } catch { list = null; }
      if (list) stack.push(list);
      else unreadable += 1;
    }
    while (stack.length) {
      const list = stack.pop();
      const children = [];
      for (let i = 0; i < list.length; i += 1) {
        const rule = list[i];
        rules += 1;
        if (rules > CAP.rules) return finish();
        if (rule.type === KEYFRAMES || (rule.name && rule.cssRules && !rule.selectorText)) {
          if (rule.name) keyframes.add(String(rule.name));
          continue;
        }
        if (typeof rule.conditionText === "string" && rule.conditionText) {
          for (const condition of widthConditions(rule.conditionText)) breakpoints.add(condition);
        }
        if (rule.cssRules) {
          children.push(rule.cssRules);
          continue;
        }
        if (!rule.selectorText || !rule.style || !/(^|,)\s*(:root|html)(?![\w-])/i.test(rule.selectorText)) continue;
        for (let k = 0; k < rule.style.length && variables.size < CAP.variables; k += 1) {
          const name = String(rule.style[k]);
          if (name.slice(0, 2) === "--") variables.set(name, clip(rule.style.getPropertyValue(name), 120));
        }
      }
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
    return finish();

    function finish() {
      return {
        breakpoints: [...breakpoints].sort(byCondition).slice(0, CAP.breakpoints),
        variables: [...variables].map(([name, value]) => ({ name, value })),
        keyframes: [...keyframes].slice(0, CAP.keyframes),
        sheets: sheets.length, unreadable, rules,
      };
    }
  }

  /* ------------------------------------------------------------ collect --- */

  function emptyModel() {
    return {
      url: "", title: "", theme: "light", viewport: { width: 0, height: 0 },
      colors: [], typography: [], spacing: [], gaps: [], radii: [], shadows: [],
      breakpoints: [], motion: [], components: [], layout: [], keyframes: [], variables: [],
      stats: { elements: 0, headings: 0, links: 0, images: 0, forms: 0, cssVariables: 0,
        canvases: 0, svgs: 0, stylesheets: 0, unreadableSheets: 0, cssRules: 0,
        documentElements: 0, capped: false },
    };
  }

  function collect(doc = typeof document !== "undefined" ? document : null) {
    const model = emptyModel();
    const d = doc;
    if (!d || typeof d.querySelectorAll !== "function" || !d.documentElement) return model;
    try { model.title = d.title || ""; } catch { /* detached */ }
    try { model.url = (d.location && d.location.href) || ""; } catch { /* detached */ }
    const sheets = scanStyleSheets(d);
    model.breakpoints = sheets.breakpoints;
    model.variables = sheets.variables;
    model.keyframes = sheets.keyframes;
    const view = d.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return model;

    const gcs = view.getComputedStyle.bind(view);
    const root = d.body || d.documentElement;
    const text = collectText(d, root);
    const stats = model.stats;
    stats.stylesheets = sheets.sheets;
    stats.unreadableSheets = sheets.unreadable;
    stats.cssRules = sheets.rules;
    stats.cssVariables = sheets.variables.length;

    const colors = new Map(), fonts = new Map(), spaces = new Map(), gaps = new Map();
    const radii = new Map(), shadows = new Map(), motion = new Map(), recipes = new Map();
    const layout = [], seenLayout = new Set();
    const all = root.querySelectorAll("*");
    const budget = Math.min(all.length + 1, CAP.elements);
    stats.documentElements = all.length + 1;
    stats.capped = all.length + 1 > CAP.elements;

    for (let i = 0; i < budget; i += 1) {
      const el = i === 0 ? root : all[i - 1];
      if (!el || el.nodeType !== 1) continue;
      const tag = String(el.tagName || "").toLowerCase();
      if (SKIP_TAGS.has(tag) || isOwn(el)) continue;
      let cs = null, rect = null;
      try { cs = gcs(el); rect = el.getBoundingClientRect(); } catch { cs = null; }
      if (!cs || !visible(cs, rect)) continue;

      stats.elements += 1;
      if (HEADING_TAGS.has(tag)) stats.headings += 1;
      if (tag === "a" && el.hasAttribute("href")) stats.links += 1;
      if (tag === "img") stats.images += 1;
      if (FORM_TAGS.has(tag)) stats.forms += 1;
      if (tag === "canvas") stats.canvases += 1;
      if (tag === "svg") stats.svgs += 1;

      // Colours: background always, text only where text renders, borders and
      // outlines only where they are actually drawn.
      bumpColor(colors, parseColor(cs.backgroundColor), "background");
      if (text.has.has(el)) bumpColor(colors, parseColor(cs.color), "text");
      for (const color of borderColors(cs)) bumpColor(colors, color, "border");

      // Typography: only elements that render their own text.
      const own = text.sample.get(el) || "";
      if (own && plain(cs.fontFamily)) {
        const family = plain(cs.fontFamily);
        let rec = fonts.get(family);
        if (!rec) {
          rec = { family, sizes: new Set(), weights: new Set(), lineHeights: new Set(), count: 0, sample: "" };
          fonts.set(family, rec);
        }
        rec.count += 1;
        const size = parseFloat(cs.fontSize);
        if (Number.isFinite(size)) rec.sizes.add(Math.round(size * 10) / 10);
        const weight = plain(cs.fontWeight).toLowerCase();
        rec.weights.add(weight === "normal" ? 400 : weight === "bold" ? 700 : Math.round(parseFloat(weight) || 400));
        if (plain(cs.lineHeight)) rec.lineHeights.add(plain(cs.lineHeight));
        if (!rec.sample) rec.sample = clip(own, 80);
      }

      // Spacing scale: margin, padding and flex/grid gaps. Zero is not a token.
      for (const prop of BOX_PROPS) {
        const value = px(cs[prop]);
        if (value) bump(spaces, value);
      }
      for (const prop of ["rowGap", "columnGap"]) {
        const value = px(cs[prop]);
        if (value) { bump(gaps, value); bump(spaces, value); }
      }

      const radius = plain(cs.borderRadius || cs.borderTopLeftRadius);
      if (radius && radius !== "0px") bump(radii, radius);
      const shadow = plain(cs.boxShadow) === "none" ? "" : plain(cs.boxShadow);
      if (shadow) bump(shadows, shadow);
      for (const value of splitTop(cs.transitionDuration)) addMotion(motion, value, "duration");
      for (const value of splitTop(cs.animationDuration)) addMotion(motion, value, "duration");
      for (const value of splitTop(cs.transitionTimingFunction)) addMotion(motion, value, "easing");

      // Component recipe: background + radius + border width + shadow + padding.
      const background = parseColor(cs.backgroundColor);
      const stroke = Math.max(...SIDES.map((side) => borderWidth(cs, side)));
      if ((background || stroke > 0 || shadow) && rect.width >= 24 && rect.height >= 16) {
        const signature = `bg=${background ? background.value : "none"}|r=${radius || "0"}|bw=${Math.round(stroke)}px|` +
          `sh=${shadow || "none"}|pad=${bucket(px(cs.paddingTop) || 0)}/${bucket(px(cs.paddingLeft) || 0)}`;
        let recipe = recipes.get(signature);
        if (!recipe) {
          recipe = {
            signature, count: 0,
            example: { tag, text: clip(own, 60), background: background ? background.value : "transparent",
              color: (parseColor(cs.color) || {}).value || plain(cs.color), radius: radius || "0",
              padding: pad(cs), border: borderOf(cs, stroke), shadow: shadow || "none" },
          };
          recipes.set(signature, recipe);
        }
        recipe.count += 1;
        if (!recipe.example.text && own) recipe.example.text = clip(own, 60);
      }

      // Layout containers, de-duplicated by label + width.
      if (layout.length < CAP.layout && isContainer(el, tag, rect)) {
        const item = { label: describe(el), width: Math.round(rect.width), display: plain(cs.display),
          columns: cs.display === "grid" ? splitTop(cs.gridTemplateColumns).filter((t) => t !== "none").length : 0,
          gap: gapOf(cs), padding: pad(cs) };
        const key = `${item.label}|${item.width}`;
        if (!seenLayout.has(key)) { seenLayout.add(key); layout.push(item); }
      }
    }

    const page = pageBackground(colors);
    const entries = (map, cap) => [...map.entries()].map(([value, n]) => ({ value, count: n })).sort(sortByUse).slice(0, cap);

    model.colors = [...colors.values()].sort(sortByUse).slice(0, CAP.colors).map((rec) => {
      const roles = ["background", "text", "border"].filter((role) => rec.roles.has(role));
      const entry = { value: rec.value, count: rec.count, roles };
      // Contrast is measured against the dominant surface, not every surface.
      if (rec.roles.has("text")) entry.contrastWith = { value: page.value, ratio: Math.round(contrastRatio(rec, page) * 100) / 100 };
      return entry;
    });
    model.typography = [...fonts.values()].sort((a, b) => b.count - a.count || cmp(a.family, b.family)).slice(0, CAP.fonts)
      .map((rec) => ({ family: rec.family, sizes: [...rec.sizes].sort((a, b) => a - b).slice(0, CAP.sizes),
        weights: [...rec.weights].sort((a, b) => a - b), lineHeights: [...rec.lineHeights].slice(0, CAP.lineHeights),
        count: rec.count, sample: rec.sample }));
    model.spacing = entries(spaces, CAP.spacing);
    model.gaps = entries(gaps, CAP.gaps);
    model.radii = entries(radii, CAP.radii);
    model.shadows = entries(shadows, CAP.shadows);
    model.motion = [
      ...[...motion.values()].filter((m) => m.kind === "duration").sort(sortByUse).slice(0, CAP.motion),
      ...[...motion.values()].filter((m) => m.kind === "easing").sort(sortByUse).slice(0, CAP.motion),
    ];
    model.components = [...recipes.values()].filter((recipe) => recipe.count >= 2)
      .sort((a, b) => b.count - a.count || cmp(a.signature, b.signature)).slice(0, CAP.components);
    model.layout = layout;
    model.theme = relativeLuminance(page) < 0.4 ? "dark" : "light";
    model.viewport = { width: Math.round(view.innerWidth || 0), height: Math.round(view.innerHeight || 0) };
    return model;
  }

  function addMotion(map, raw, kind) {
    const value = plain(raw).toLowerCase();
    if (!value || value === "0s" || value === "0ms" || value === "initial") return;
    const key = `${kind}:${value}`;
    const rec = map.get(key) || { value, kind, count: 0 };
    rec.count += 1;
    map.set(key, rec);
  }

  /* ------------------------------------------------------------- tokens --- */

  // Name every measured entry; the paste block later slices the highest-use ones.
  function tokenize(model) {
    const list = (v) => (Array.isArray(v) ? v : []);
    const tk = { colors: [], fonts: [], spaces: [], gaps: [], radii: [], shadows: [], durations: [], easings: [] };
    list(model.colors).forEach((c, i) => tk.colors.push({ token: `--color-${i + 1}`, value: c.value, count: c.count,
      roles: list(c.roles), contrastWith: c.contrastWith || null }));
    list(model.typography).forEach((f, i) => tk.fonts.push({ token: `--font-${i + 1}`, value: f.family, family: f.family,
      sizes: list(f.sizes), weights: list(f.weights), lineHeights: list(f.lineHeights), count: f.count, sample: f.sample || "" }));
    list(model.spacing).forEach((s, i) => tk.spaces.push({ token: `--space-${i + 1}`, value: `${s.value}px`, count: s.count }));
    list(model.gaps).forEach((s, i) => tk.gaps.push({ token: `--gap-${i + 1}`, value: `${s.value}px`, count: s.count }));
    list(model.radii).forEach((s, i) => tk.radii.push({ token: `--radius-${i + 1}`, value: s.value, count: s.count }));
    list(model.shadows).forEach((s, i) => tk.shadows.push({ token: `--shadow-${i + 1}`, value: s.value, count: s.count }));
    const motion = list(model.motion);
    motion.filter((m) => m.kind === "duration").forEach((m, i) => tk.durations.push({ token: `--duration-${i + 1}`, value: m.value, count: m.count }));
    motion.filter((m) => m.kind === "easing").forEach((m, i) => tk.easings.push({ token: `--ease-${i + 1}`, value: m.value, count: m.count }));
    return tk;
  }

  // A value safe to drop into a declaration inside a fenced block.
  const fenceValue = (value) => plain(value).replace(/[;`]/g, "");

  function rootBlock(tk) {
    const lines = [":root {"];
    const group = (label, entries, limit) => {
      const items = entries.slice(0, limit);
      if (!items.length) return;
      lines.push(`  /* ${label} */`);
      for (const item of items) lines.push(`  ${item.token}: ${fenceValue(item.value)};`);
    };
    group("colors", tk.colors, 8);
    group("type", tk.fonts, 3);
    group("spacing", tk.spaces, 6);
    group("radii", tk.radii, 4);
    group("shadows", tk.shadows, 3);
    group("layout gaps", tk.gaps, 3);
    group("motion", [...tk.durations, ...tk.easings], 6);
    if (lines.length === 1) lines.push("  /* No tokens could be measured on this page. */");
    lines.push("}");
    return lines;
  }

  /* ------------------------------------------------------------- render --- */

  const swatch = (hex) => (/^#[0-9a-f]{6}$/i.test(hex)
    ? `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${hex};border:1px solid #0003"></span> `
    : "");

  function pushSection(out, title, lead, body, empty, level = 2) {
    out.push(`${"#".repeat(level)} ${title}`, "");
    if (lead) out.push(lead, "");
    if (body.length) out.push(...body);
    else out.push(empty);
    out.push("");
  }

  const tokenTable = (entries) =>
    table(["Token", "Value", "Uses"], entries.map((entry) => [code(entry.token), code(entry.value), count(entry.count)]));

  function render(model, meta) {
    const m = model && typeof model === "object" ? model : emptyModel();
    const info = meta && typeof meta === "object" ? meta : {};
    const tk = tokenize(m);
    const stats = m.stats || {};
    const keyframes = Array.isArray(m.keyframes) ? m.keyframes : [];
    const breakpoints = Array.isArray(m.breakpoints) ? m.breakpoints : [];
    const variables = Array.isArray(m.variables) ? m.variables : [];
    const title = plain(info.title || m.title || "Untitled page");
    const url = plain(info.url || m.url || "");
    const viewport = m.viewport || {};
    const out = [];

    out.push(`# Design system — ${title}`, "");
    out.push(`${m.theme === "dark" ? "Dark" : "Light"} theme measured on ${count(stats.elements)} rendered elements: ` +
      `${plural(tk.colors.length, "colour", "colours")}, ${plural(tk.fonts.length, "font stack", "font stacks")}, ` +
      `${plural(tk.spaces.length, "spacing step", "spacing steps")}, ${plural(tk.radii.length, "corner radius", "corner radii")} ` +
      `and ${plural(tk.shadows.length, "shadow", "shadows")}.`, "");
    if (url) out.push(`- **Source:** ${url}`);
    if (viewport.width && viewport.height) out.push(`- **Viewport:** ${count(viewport.width)} × ${count(viewport.height)} px`);
    if (info.generatedAt) out.push(`- **Generated:** ${plain(info.generatedAt)}`);
    out.push(`- **Sample:** ${count(stats.elements)} rendered elements${stats.capped ? ` of ${count(stats.documentElements)} (cap reached)` : ""}`, "");
    out.push("Every value below was read from `getComputedStyle` on the live document, offline and with no network call. " +
      "Nothing is inferred: a value that was not measured is not written. The same capture always renders the same document.", "");
    out.push("Token names (`--color-1`, `--font-1`, …) are assigned by this report to the entries it lists; " +
      "the page's own custom property names are kept verbatim below.", "");

    // 1 — Color palette
    const colorRows = tk.colors.map((c) => [
      `${swatch(c.value)}${code(c.token)}`, code(c.value),
      `${count(c.count)} · ${c.roles.join(", ") || "unattributed"}${c.contrastWith ? ` · ${c.contrastWith.ratio}:1 on ${code(c.contrastWith.value)}` : ""}`,
    ]);
    pushSection(out, SECTIONS[0],
      "Only colours that occur in computed styles are listed, most used first. `border` covers visible borders and outlines. " +
      "The swatch is an sRGB preview; the middle column is the authoritative CSS value.",
      colorRows.length ? table(["Token", "Value", "Uses"], colorRows) : [], "_No colours detected._");

    // 2 — Typography
    const typeRows = tk.fonts.map((f) => [code(f.token), code(f.family), listText(f.sizes.map((size) => `${size}px`)),
      listText(f.weights), listText(f.lineHeights), count(f.count)]);
    const typeBody = typeRows.length ? table(["Token", "Family stack", "Sizes", "Weights", "Line heights", "Uses"], typeRows) : [];
    const samples = tk.fonts.filter((f) => f.sample).slice(0, 4);
    if (typeBody.length && samples.length) {
      typeBody.push("", "Sampled text:", "", ...samples.map((f) => `- ${code(f.token)} — “${cell(f.sample)}”`));
    }
    pushSection(out, SECTIONS[1],
      "Each row is one `font-family` stack that actually rendered text, with the distinct sizes, weights and line heights " +
      "seen on those elements. The sample is real page copy, truncated.",
      typeBody, "_No typography detected._");

    // 3 — Spacing, shape & motion (subsections keep the original outline order)
    out.push(`## ${SECTIONS[2]}`, "");
    out.push("Spacing is the distinct set of margin, padding and gap values in CSS pixels. `0` is not tokenised; " +
      "negative margins are kept because they are real layout decisions.", "");
    pushSection(out, "Spacing", "", tokenTable(tk.spaces), "_No spacing values detected._", 3);
    pushSection(out, "Layout gaps", "", tokenTable(tk.gaps), "_No flex or grid gaps detected._", 3);
    pushSection(out, "Corner radii", "", tokenTable(tk.radii), "_No corner radii detected._", 3);
    pushSection(out, "Shadows", "", tokenTable(tk.shadows), "_No box shadows detected._", 3);
    pushSection(out, "Motion durations", "", tokenTable(tk.durations), "_No transition or animation durations detected._", 3);
    pushSection(out, "Motion easing", "", tokenTable(tk.easings), "_No transition timing functions detected._", 3);

    // 4 — Keyframes
    pushSection(out, SECTIONS[3],
      "Named `@keyframes` animations reachable from the document's stylesheets. Only the names are listed; " +
      "the frames themselves are not re-emitted.",
      keyframes.map((name) => `- ${code(name)}`), "_No @keyframes detected._");

    // 5 — Component recipes
    const recipeRows = (Array.isArray(m.components) ? m.components : []).map((recipe, i) => {
      const ex = recipe.example || {};
      const spec = [`background ${ex.background}`, `radius ${ex.radius}`, `border ${ex.border}`,
        `shadow ${ex.shadow}`, `padding ${ex.padding}`, `text ${ex.color}`].map(code).join(" · ");
      return [code(`--recipe-${i + 1}`), spec, count(recipe.count), `${code(ex.tag)}${ex.text ? ` “${cell(ex.text)}”` : ""}`];
    });
    pushSection(out, SECTIONS[4],
      "Recipes group elements that share a background, corner radius, border width, box shadow and 4px padding bucket. " +
      "Only recipes seen at least twice are kept. These are computed-style specimens, not markup.",
      recipeRows.length ? table(["Token", "Recipe", "Uses", "Example"], recipeRows) : [], "_No recurring component recipes detected._");

    // 6 — Layout measurements
    const layoutRows = (Array.isArray(m.layout) ? m.layout : []).map((item) => [
      code(item.label), `${count(item.width)}px`, code(item.display),
      item.columns ? count(item.columns) : "—", item.gap ? code(item.gap) : "—", code(item.padding)]);
    pushSection(out, SECTIONS[5],
      "Measured boxes for landmark and container elements. Padding is reported top / right / bottom / left.",
      layoutRows.length ? table(["Element", "Width", "Display", "Columns", "Gap", "Padding (T R B L)"], layoutRows) : [],
      "_No layout containers detected._");

    // 7 — Responsive conditions
    pushSection(out, SECTIONS[6],
      "Width conditions found while crawling the document's stylesheets. These are the breakpoints the page itself declares, " +
      "not recommendations.",
      breakpoints.map((condition) => `- ${code(condition)}`), "_No accessible media conditions detected._");

    // 8 — CSS custom properties: declared first, derived token block second.
    out.push(`## ${SECTIONS[7]}`, "");
    out.push("Custom properties declared on `:root` come first, exactly as written. The block after them is derived from the " +
      "highest-use measurements above and is the only place new names are assigned.", "");
    if (variables.length) out.push(...table(["Property", "Value"], variables.map((v) => [code(v.name), code(v.value)])), "");
    else out.push("_No declared `:root` custom properties detected._", "");
    out.push("### Ready-to-paste tokens", "");
    out.push("Paste into a stylesheet and rename as needed. The block keeps the highest-use entries only; " +
      "the tables above list the full sample.", "");
    out.push("```css", ...rootBlock(tk), "```", "");

    // 9 — Capture coverage
    pushSection(out, SECTIONS[8], "What this capture covers, and what it explicitly does not.", [
      `- ${count(stats.elements)} rendered elements sampled in document order${stats.capped ? `; the ${count(CAP.elements)}-element cap was reached, so later elements are not represented.` : "; the whole document was sampled."}`,
      `- ${count(stats.stylesheets)} stylesheet(s) inspected, ${count(stats.unreadableSheets)} could not be read (cross-origin or blocked). Computed styles are measured either way.`,
      "- Colours are CSS values, not a screenshot palette: gradients, images, backdrop filters and alpha compositing change their visible appearance.",
      "- Contrast ratios use WCAG 2.1 relative luminance on the raw colour channels. Alpha is ignored, so translucent text is only approximated.",
      "- Hover, focus, active and disabled states are not captured — only the state the document was in.",
      `- Iframe documents, shadow trees and canvas/WebGL drawing are outside this capture${stats.canvases ? ` (${count(stats.canvases)} canvas element(s) were detected)` : ""}.`,
      "- Counts describe the sample, not the whole website.",
      "- Nothing is inferred: no palette, typography scale, brand personality or fabricated copy is presented as a measurement.",
    ], "_No coverage notes._");

    return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  }

  /* ----------------------------------------------------------- validate --- */

  const PLACEHOLDERS = [/\bTODO\b/i, /\bTBD\b/i, /\bFIXME\b/i, /\bXXX\b/, /lorem ipsum/i, /\{\{/, /<insert\b/i];

  /**
   * Local quality gate, mirroring the original's post-render assertions: all nine
   * headings present, no placeholder text, no unbalanced code fence, and the
   * paste-ready `:root` block actually emitted.
   */
  function validate(markdown) {
    const problems = [];
    if (typeof markdown !== "string" || !markdown.trim()) return { ok: false, problems: ["The document is empty."] };
    const text = markdown.replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    if (!/^# Design system\b/.test(lines[0] || "")) problems.push('The first line must be a level-1 "Design system" heading.');
    for (const name of SECTIONS) {
      if (!lines.some((line) => line.trim() === `## ${name}`)) problems.push(`Missing section heading: "## ${name}".`);
    }
    for (const pattern of PLACEHOLDERS) {
      const hit = pattern.exec(text);
      if (hit) problems.push(`Placeholder text remains: "${hit[0]}".`);
    }
    if ((text.match(/^```/gm) || []).length % 2 !== 0) problems.push("A fenced code block is not closed.");
    if (!/```css\n[\s\S]*?:root\s*\{/.test(text)) problems.push("The ready-to-paste `:root` CSS block is missing.");
    return { ok: problems.length === 0, problems };
  }

  /* ------------------------------------------------------------- export --- */

  F.designMd = { collect, render, validate };
})();
