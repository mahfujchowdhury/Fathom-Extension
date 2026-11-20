/*
 * Tool: Design prompt (`brief`).
 *
 * The original sent this prompt to an AI provider and fell back to a local
 * template; Fathom has neither, so this is that template: a deterministic build
 * brief assembled from what the page actually renders. Same page in → identical
 * text out; page text reaches the DOM only through textContent; a page with
 * nothing measurable still gets every section.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;
  const { h } = F.util;
  /* The prompt contract: these headers, in this order, as plain text lines. */
  const SECTIONS = ["OVERALL AESTHETIC", "FONTS", "COLOR THEME", "COMPONENT CSS", "ASSETS & MEDIA", "SECTION-BY-SECTION",
    "SHAPE, DEPTH & SPACING", "ANIMATION"];
  /* Sampling bounds: elements read, longest URL printed, families/sections/blocks. */
  const MAX_SAMPLE = 480, MAX_URL = 110, MAX_FAMILIES = 4, MAX_SECTIONS = 8, MAX_COMPONENTS = 4;

  /* ------------------------------------------------------------- helpers --- */
  const str = (value, fallback = "") => (value === null || value === undefined ? "" : String(value).trim()) || fallback;
  const clean = (value, max = 120) => str(value).replace(/\s+/g, " ").slice(0, max);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : fallback);
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const rgbOf = (hex) => {
    const color = F.analyze?.parseColor?.(hex);
    return color ? { r: color.r, g: color.g, b: color.b } : { r: 255, g: 255, b: 255 };
  };
  const isGrey = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 24;
  const saturation = (c) => (Math.max(c.r, c.g, c.b) ? (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / Math.max(c.r, c.g, c.b) : 0);
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    return !sorted.length ? 0 : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  /** Most frequent entries first; numeric ties break numerically. */
  function ranked(map, limit) {
    const tie = (a, b) => (typeof a === "number" ? a - b : String(a).localeCompare(String(b)));
    return [...map.entries()].sort((a, b) => b[1] - a[1] || tie(a[0], b[0])).slice(0, limit);
  }
  function safeQuery(selector) {
    try { return [...document.querySelectorAll(selector)]; } catch { return []; }
  }
  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    const rect = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return rect.width >= 8 && rect.height >= 8 && cs.display !== "none" && cs.visibility !== "hidden";
  }
  /** First rendered element matching any selector, in the order given. */
  function firstVisible(selectors) {
    for (const selector of selectors) {
      for (const el of safeQuery(selector)) if (!el.closest("[data-fathom-helper]") && visible(el)) return el;
    }
    return null;
  }
  /** Comma-separated CSS durations → millisecond counters; true if any found. */
  function collectDurations(value, map) {
    let found = false;
    for (const token of String(value || "").split(",")) {
      const match = token.trim().match(/^(-?\d*\.?\d+)(ms|s)$/i);
      if (!match) continue;
      const raw = parseFloat(match[1]), ms = match[2].toLowerCase() === "s" ? raw * 1000 : raw;
      if (ms > 0 && ms <= 20000) { bump(map, Math.round(ms * 10) / 10); found = true; }
    }
    return found;
  }
  /** Inline SVG arrives as a large data URL; never paste that into the brief. */
  function shortUrl(url) {
    const value = str(url);
    if (value.startsWith("data:")) return `inline data URL (${Math.max(1, Math.round(value.length / 1024))} KB)`;
    return value.length > MAX_URL ? `${value.slice(0, MAX_URL)}…` : value;
  }

  /* -------------------------------------------------------------- sample --- */
  /** One bounded pass collecting radii, rhythm, shadows, real stacks, motion. */
  function collectSample() {
    const out = {
      radii: new Map(), spacing: new Map(), shadows: new Map(), stacks: new Map(), transitionDurations: new Map(),
      animationDurations: new Map(), easings: new Map(), properties: new Map(),
      transitioning: 0, animating: 0, sampled: 0,
    };
    const nodes = document.body ? [document.body, ...document.body.querySelectorAll("*")] : [];
    for (let i = 0, limit = Math.min(nodes.length, MAX_SAMPLE); i < limit; i++) {
      const el = nodes[i];
      if (!el || el.nodeType !== 1 || el.hasAttribute("data-fathom-helper")) continue;
      if (/^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT|BR|IFRAME)$/.test(el.tagName)) continue;
      const rect = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (rect.width < 1 || rect.height < 1 || cs.display === "none" || cs.visibility === "hidden") continue;
      out.sampled += 1;
      /* The exact stack the page declares for this family. */
      const stack = cs.fontFamily || "", primary = stack.split(",")[0].trim().replace(/^["']|["']$/g, "");
      if (primary && !out.stacks.has(primary)) out.stacks.set(primary, stack);
      /* Corner softness: px only, so percentages are not misread as pixels. */
      for (const corner of [cs.borderTopLeftRadius, cs.borderTopRightRadius]) {
        const match = String(corner || "").trim().match(/^(-?[\d.]+)px$/), radius = match ? parseFloat(match[1]) : 0;
        if (radius > 0 && radius <= 2000) bump(out.radii, Math.round(radius));
      }
      /* Rhythm: padding and gap are the values that repeat across a layout. */
      for (const raw of [cs.paddingTop, cs.paddingLeft, cs.gap]) {
        const match = String(raw || "").trim().match(/^(-?[\d.]+)px$/), value = match ? parseFloat(match[1]) : 0;
        if (value >= 4 && value <= 200) bump(out.spacing, Math.round(value));
      }
      const shadow = clean(cs.boxShadow, 90);
      if (shadow && shadow !== "none") bump(out.shadows, shadow);
      if (collectDurations(cs.transitionDuration, out.transitionDurations)) out.transitioning += 1;
      if (collectDurations(cs.animationDuration, out.animationDurations)) out.animating += 1;
      for (const token of String(cs.transitionProperty || "").split(",")) {
        const prop = token.trim();
        if (prop && prop !== "none" && (out.properties.has(prop) || out.properties.size < 12)) bump(out.properties, prop);
      }
      for (const token of String(cs.transitionTimingFunction || "").split(",")) {
        const fn = clean(token, 60);
        if (fn && (out.easings.has(fn) || out.easings.size < 10)) bump(out.easings, fn);
      }
    }
    return out;
  }

  /* --------------------------------------------------------------- model --- */
  /** Split the measured palette into roles; every role has a safe fallback. */
  function colorTokens(list, meta) {
    const backgrounds = list.filter((entry) => entry.roles.includes("background"));
    const texts = list.filter((entry) => entry.roles.includes("text"));
    const background = backgrounds[0] || { value: str(meta.background, "#ffffff"), count: 0 };
    const text = texts[0] || { value: str(meta.color, "#111111"), count: 0 };
    const border = list.filter((entry) => entry.roles.includes("border"))
      .find((entry) => entry.value !== background.value && entry.value !== text.value) || null;
    const surface = backgrounds[1] && backgrounds[1].value !== background.value ? backgrounds[1] : null;
    const muted = texts[1] && texts[1].value !== text.value ? texts[1] : null;
    /* Accent = most chromatic colour that still repeats, not a one-off tint. */
    const floor = Math.max(2, Math.round((list[0] ? list[0].count : 0) / 12));
    const accent = list.filter((entry) => entry.count >= floor && !isGrey(rgbOf(entry.value)))
      .sort((a, b) => saturation(rgbOf(b.value)) - saturation(rgbOf(a.value)) || b.count - a.count ||
        a.value.localeCompare(b.value))[0] || null;
    return { background, text, border, accent, surface, muted };
  }
  /** Turn measurements into the adjectives the first section uses. */
  function describeMetrics(tokens, sample, fonts) {
    const ratioRaw = F.analyze?.contrast ? F.analyze.contrast(rgbOf(tokens.text.value), rgbOf(tokens.background.value)) : 0;
    const radii = []; for (const [value, count] of sample.radii) if (Number(value) < 1000) radii.push(...Array(count).fill(Number(value)));
    const rhythm = median([...sample.spacing.keys()]), softness = median(radii);
    const density = rhythm <= 0 ? "measured" : rhythm <= 10 ? "compact" : rhythm <= 18 ? "balanced" : "airy";
    const cornerWord = softness === 0 ? "square, hard-edged" : softness <= 4 ? "subtly rounded"
      : softness <= 14 ? "softly rounded" : softness <= 28 ? "generously rounded" : "pill-shaped";
    const family = str(fonts[0] && fonts[0].family);
    const tone = /mono|code|consol|courier/i.test(family) ? "monospace"
      : /serif|georgia|times|garamond|playfair|lora|merriweather|slab/i.test(family) ? "serif" : "sans-serif";
    const heavy = ((fonts[0] && fonts[0].weights) || []).some((weight) => weight >= 700);
    const contrastWord = ratioRaw >= 7 ? "high" : ratioRaw >= 4.5 ? "comfortable" : ratioRaw >= 3 ? "modest" : "low";
    const theme = F.analyze?.luminance && F.analyze.luminance(rgbOf(tokens.background.value)) < 0.4 ? "dark" : "light";
    return { ratio: Math.round(ratioRaw * 10) / 10, ratioRaw, rhythm, softness, density, cornerWord, contrastWord, theme, typeWord: `${heavy ? "confident" : "restrained"} ${tone}` };
  }
  /** Two to four live style specimens; missing roles are skipped silently. */
  function collectComponents() {
    const out = [], seen = new Set();
    const add = (label, el, props) => {
      if (!el || out.length >= MAX_COMPONENTS || seen.has(el)) return;
      let css = "";
      try { css = F.inspect.cssBlock(el, props); } catch { return; }
      if (!css || css.indexOf("{") < 0) return;
      seen.add(el);
      out.push({ label: `${label} — ${F.util.describe(el)}`, css });
    };
    const heading = firstVisible(["h1", "h2", "h3"]) || firstVisible(["p"]);
    const action = firstVisible(["button", "[role=button]", "a.btn", ".btn", "input[type=submit]", "a[class*=button]"]);
    const card = firstVisible(["article", "[class*=card]", ".card", "main > section", "li[class*=card]"]);
    add("Page shell (body)", document.body, ["background-color", "color", "font-family", "font-size", "line-height", "letter-spacing", "background-image"]);
    add(heading && /^H[1-6]$/.test(heading.tagName) ? "Heading" : "Body copy", heading, ["color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-transform", "margin", "max-width"]);
    add("Interactive element", action, ["background-color", "color", "border", "border-radius", "padding", "font-size", "font-weight", "letter-spacing", "box-shadow", "transition"]);
    add("Content card", card, ["background-color", "border", "border-radius", "box-shadow", "padding", "backdrop-filter", "max-width", "gap"]);
    /* Blank documents may only have <html> to read. */
    if (out.length < 2) add("Document root (html)", document.documentElement, ["background-color", "color", "font-family", "font-size"]);
    return out;
  }
  function buildModel() {
    const meta = F.analyze.meta(), fonts = F.analyze.fonts(), colors = F.analyze.colors();
    const tokens = colorTokens(colors, meta), sample = collectSample();
    return {
      meta, colors, fonts, sample, tokens, outline: F.analyze.outline(), assets: F.analyze.assets(),
      metrics: describeMetrics(tokens, sample, fonts), components: collectComponents(),
    };
  }

  /* ------------------------------------------------------------ sections --- */
  /** OVERALL AESTHETIC — density, contrast, corners, type, title and viewport. */
  function aestheticLines(m) {
    const metrics = m.metrics;
    const width = num(m.meta.width, window.innerWidth), height = num(m.meta.height, window.innerHeight);
    const lines = [
      `Build a marketing page that feels ${metrics.density} and ${metrics.theme}: "${str(m.meta.title, "this page")}", with ${metrics.cornerWord} corners and ${metrics.typeWord} typography.`,
      `The measured document is ${width} × ${height} px at a ${num(window.innerWidth, width)} × ${num(window.innerHeight, height)} px viewport, so keep that container width and rhythm rather than inventing a new grid.`,
      `Body copy sits at ${metrics.ratio}:1 contrast on the page background — ${metrics.ratioRaw >= 4.5 ? "keep every pairing at or above that" : "raise it toward 4.5:1"} and hold body text between 15 and 18 px.`,
    ];
    if (m.tokens.accent) lines.push(`Use ${m.tokens.accent.value} only for primary actions and active states; everything else stays on the measured ${metrics.theme} surfaces.`);
    return lines;
  }
  /** FONTS — every measured family with its sizes, weights and real stack. */
  function fontLines(m) {
    if (!m.fonts.length) {
      return [
        `- No text-bearing elements could be sampled. Use the measured base stack: ${str(m.meta.fontFamily, "system-ui, sans-serif")};`,
        "- Set body copy at a readable 16 px / 1.5 and one display size for headings.",
      ];
    }
    const lines = [];
    for (const font of m.fonts.slice(0, MAX_FAMILIES)) {
      const sizes = (font.sizes || []).filter((size) => Number.isFinite(size) && size > 0).slice(0, 6).map((size) => `${size}px`).join(", ");
      const weights = (font.weights || []).filter((weight) => Number.isFinite(weight) && weight > 0);
      lines.push(
        `- ${font.family} — ${plural(font.count || 0, "text element", "text elements")}, sizes ${sizes || "unmeasured"}, weights ${weights.length ? weights.join(", ") : "400"}.`,
        `  font-family: ${m.sample.stacks.get(font.family) || `${font.family}, system-ui, sans-serif`};`,
      );
    }
    if (str(m.meta.baseSize)) lines.push(`- Base body size measured at ${m.meta.baseSize}; keep it as the midpoint of the scale.`);
    return lines;
  }
  /** COLOR THEME — backgrounds, text, border, accent and a :root block. */
  function colorLines(m) {
    const { tokens, metrics } = m;
    const lines = [
      `- Background: ${tokens.background.value} — page canvas and dominant surface (${plural(tokens.background.count, "sample", "samples")}).`,
      `- Text: ${tokens.text.value} — primary body and heading colour (${plural(tokens.text.count, "sample", "samples")}).`,
      tokens.border
        ? `- Border: ${tokens.border.value} — hairlines, dividers and outlines (${plural(tokens.border.count, "sample", "samples")}).`
        : "- Border: no distinct border colour was measured; derive one a step away from the background.",
      tokens.accent
        ? `- Suggested accent: ${tokens.accent.value} — the most saturated colour that repeats (${plural(tokens.accent.count, "sample", "samples")}).`
        : "- Suggested accent: the palette is neutral, so add one saturated accent for primary actions.",
      `Contrast: ${metrics.ratio}:1 body text on the background is ${metrics.contrastWord}; keep it at or above 4.5:1.`,
      "Reuse these values verbatim as custom properties:",
      ":root {",
      `  --background: ${tokens.background.value};`,
    ];
    if (tokens.surface) lines.push(`  --surface: ${tokens.surface.value};`);
    lines.push(`  --text: ${tokens.text.value};`);
    if (tokens.muted) lines.push(`  --text-muted: ${tokens.muted.value};`);
    lines.push(`  --border: ${tokens.border ? tokens.border.value : tokens.background.value};`, `  --accent: ${tokens.accent ? tokens.accent.value : tokens.text.value};`, "}");
    return lines;
  }
  /** COMPONENT CSS — real computed blocks, each prefixed by what it is. */
  function componentLines(m) {
    if (!m.components.length) return ["- No element styles could be read from this page; treat the colour and type values above as the source of truth."];
    const lines = [];
    for (const item of m.components) lines.push(`/* ${item.label} */`, item.css, "");
    lines.push("Reuse these declarations verbatim; they are computed styles from the live page, not a guess.");
    return lines;
  }
  /** ASSETS & MEDIA — a few URLs with kind, size and format. */
  function assetLines(m) {
    const assets = m.assets || [];
    if (!assets.length) return ["- No image or video assets were detected; build surfaces with CSS and inline SVG rather than stock imagery."];
    const area = (asset) => (Number(asset.width) || 0) * (Number(asset.height) || 0);
    const images = assets.filter((asset) => asset.kind === "image").sort((a, b) => area(b) - area(a) || a.url.localeCompare(b.url));
    const videos = assets.filter((asset) => asset.kind === "video");
    const lines = [`- ${plural(images.length, "image", "images")} and ${plural(videos.length, "video", "videos")} measured. Use these URLs directly:`];
    for (const asset of [...videos.slice(0, 2), ...images.slice(0, 5)]) {
      const size = F.analyze.formatSize ? F.analyze.formatSize(asset) : str(asset.format), format = str(asset.format).toUpperCase();
      const detail = format && format !== str(size).toUpperCase() ? `${size} · ${format}` : size;
      lines.push(`  - ${asset.kind}${detail ? ` · ${detail}` : ""} — ${shortUrl(asset.url)}`);
    }
    lines.push("- Keep the largest image as the hero and reuse the rest as supporting media.");
    return lines;
  }
  /** A short, inferred purpose for one outline entry. */
  function purposeOf(entry) {
    const tag = str(entry.tag).toLowerCase(), heading = str(entry.heading).toLowerCase(), height = Number(entry.height) || 0;
    const base = {
      header: "brand, navigation and the page's first impression", nav: "primary navigation between the site's main areas",
      footer: "closing links, legal and secondary navigation", aside: "secondary content that supports the main column",
      form: "the capture form and its call to action", article: "self-contained long-form content", main: "the primary content of the page",
    }[tag];
    if (base) return base;
    if (/pricing|plans?/.test(heading)) return "pricing comparison and plan selection";
    if (/faq|question/.test(heading)) return "objection handling";
    if (/testimonial|review|trust|clients/.test(heading)) return "social proof";
    if (/feature|benefit|how it works/.test(heading)) return "feature explanation";
    if (/cta|start|sign|join|contact/.test(heading)) return "the closing call to action";
    if (height >= 600) return "a full-height storytelling block";
    return "a content block below the fold";
  }
  /** SECTION-BY-SECTION — the measured outline as an ordered list. */
  function outlineLines(m) {
    const outline = (m.outline || []).slice(0, MAX_SECTIONS);
    if (!outline.length) return ["1. The page exposes no landmark sections; build one stacked column: hero, proof, detail, closing call to action."];
    const lines = outline.map((entry, index) => {
      const tag = str(entry.tag, "section"), heading = str(entry.heading) || clean(entry.text, 60) || "(untitled)";
      return `${index + 1}. <${tag}> "${heading}" — ${purposeOf(entry)}.`;
    });
    lines.push(`Reproduce these ${plural(outline.length, "block", "blocks")} in this order; keep each one's own background and media.`);
    return lines;
  }
  /** SHAPE, DEPTH & SPACING — radii, spacing steps and shadow presence. */
  function shapeLines(m) {
    const sample = m.sample, lines = [];
    const radii = ranked(sample.radii, 6).filter(([value]) => Number(value) < 1000);
    const pills = [...sample.radii.keys()].filter((value) => Number(value) >= 1000).length;
    if (radii.length) lines.push(`- Corner radii: ${radii.map(([value, count]) => `${value} px (${count})`).join(", ")}.`);
    else if (pills) lines.push("- Corner radii: fully rounded controls (pill radius) with square content surfaces.");
    else lines.push("- Corner radii: none measured; keep every surface square-edged.");
    const spacing = ranked(sample.spacing, 6);
    lines.push(spacing.length
      ? `- Spacing in use (padding and gaps): ${spacing.map(([value, count]) => `${value} px (${count})`).join(", ")} — build the scale from these steps.`
      : "- Spacing: no padding or gap values were measurable; fall back to 8 px increments.");
    const shadows = ranked(sample.shadows, 1);
    lines.push(shadows.length
      ? `- Shadows: ${plural(sample.shadows.size, "distinct box-shadow value", "distinct box-shadow values")}; the most common is "${shadows[0][0]}" — reuse it for raised cards.`
      : "- Shadows: none detected — keep surfaces flat and separate them with 1 px borders.");
    return lines;
  }
  /** ANIMATION — durations, easing and properties actually found in styles. */
  function motionLines(m) {
    const sample = m.sample;
    if (!sample.transitioning && !sample.animating) {
      return [
        "- No transitions or keyframe animations were found in the computed styles of the visible elements.",
        "- Add one restrained 150–200 ms ease-out transition on interactive elements only; do not animate layout properties.",
      ];
    }
    const transitions = ranked(sample.transitionDurations, 4), animations = ranked(sample.animationDurations, 4);
    const easings = ranked(sample.easings, 3), properties = ranked(sample.properties, 3), lines = [];
    if (sample.transitioning) lines.push(`- ${sample.transitioning} of ${sample.sampled} sampled visible elements declare a non-zero transition.`);
    if (transitions.length) lines.push(`- Transition durations: ${transitions.map(([ms, count]) => `${ms} ms (${count})`).join(", ")}.`);
    if (properties.length) lines.push(`- Most-transitioned properties: ${properties.map(([prop, count]) => `${prop} (${count})`).join(", ")}.`);
    if (easings.length) lines.push(`- Easing in use: ${easings.map(([fn, count]) => `${fn} (${count})`).join(", ")}.`);
    if (sample.animating) {
      const durations = animations.length ? `, with durations ${animations.map(([ms]) => `${ms} ms`).join(", ")}` : "";
      lines.push(`- ${plural(sample.animating, "element runs", "elements run")} a keyframe animation${durations}.`);
    }
    lines.push("- Reuse these timings; keep motion to opacity and transform and respect prefers-reduced-motion.");
    return lines;
  }

  /* ------------------------------------------------------------ renderer --- */
  const BUILDERS = {
    "OVERALL AESTHETIC": aestheticLines, FONTS: fontLines, "COLOR THEME": colorLines, "COMPONENT CSS": componentLines,
    "ASSETS & MEDIA": assetLines, "SECTION-BY-SECTION": outlineLines, "SHAPE, DEPTH & SPACING": shapeLines, ANIMATION: motionLines,
  };
  /** Fixed header → body, one blank line between sections, one trailing newline.
   *  The viewport is the only environment value, so re-running on the same page
   *  and window yields identical text. */
  function renderPrompt(model) {
    const lines = [];
    for (const header of SECTIONS) {
      lines.push(header);
      for (const line of BUILDERS[header](model)) lines.push(line);
      lines.push("");
    }
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }
  /** Last-resort brief: keeps the header contract when analysis throws. */
  function minimalBrief() {
    return `${SECTIONS.map((header) => `${header}\nNo measurable value was found on this page.`).join("\n\n")}\n`;
  }
  const pageTitle = () => str(document.title) || str(location.hostname) || "Current page";

  /* ------------------------------------------------------------------ UI --- */
  F.workspace.register("brief", async (api) => {
    const panel = api.panel({ title: "Design prompt", subtitle: pageTitle(), size: "compact", tool: "brief" });
    panel.busy("Reading layout, colours and typography…");
    await F.util.sleep(20); // let the busy state paint before the synchronous walk
    let model = null, current = "", editing = false;
    const status = h("p", { class: "prompt-status", text: "✓ Generated locally from this page — no AI service involved." });
    const stats = h("p", { class: "meta" });
    const article = h("article", { class: "prompt-content", tabindex: "0", "aria-label": "Generated design prompt" });
    const editor = h("textarea", { class: "prompt-editor", spellcheck: "false", "aria-label": "Edit the design prompt" });
    /* Keystrokes are the source of truth, so Copy/Save keep edits without Done. */
    editor.addEventListener("input", () => { current = editor.value; });
    function regenerate() {
      try { model = buildModel(); return renderPrompt(model); }
      catch (error) { console.error("[Fathom] brief generation failed", error); model = null; return minimalBrief(); }
    }
    function statsText() {
      const lines = plural(current ? current.split("\n").length : 0, "line", "lines");
      if (!model) return `${lines} · assembled from fallback defaults`;
      const { outline = [], fonts = [], components = [] } = model;
      return `${lines} · ${plural(outline.length, "section", "sections")} · ${plural(fonts.length, "font family", "font families")} · ${plural(components.length, "CSS block", "CSS blocks")}`;
    }
    /** Status line, stats line and whichever surface is active. */
    function paint() {
      article.textContent = current;
      editor.value = current;
      stats.textContent = statsText();
      panel.body.replaceChildren(status, stats, editing ? editor : article);
    }
    function actions() {
      return [
        { label: "Copy prompt", primary: true, icon: "M8 8h10v12H8zM4 16V4h10", onClick: copy },
        { label: editing ? "Done" : "Edit", icon: editing ? "M5 13l4 4L19 7" : "M4 20h4L20 8l-4-4L4 16z", onClick: toggleEdit },
        { label: "Save .md", icon: "M12 4v11m0 0l-4-4m4 4l4-4M5 20h14", onClick: save },
        { label: "Rescan", icon: "M4 12a8 8 0 1 1 2.3 5.6M4 20v-5h5", onClick: rescan },
      ];
    }
    async function copy() {
      if (editing) current = editor.value;
      try { await navigator.clipboard.writeText(current); api.toast("Design prompt copied", { tone: "success", timeout: 1800 }); }
      catch { api.toast("Could not copy the prompt", { tone: "error" }); }
    }
    function toggleEdit() {
      editing = !editing;
      if (!editing) current = editor.value;
      paint();
      panel.setActions(actions());
      if (editing) { editor.focus(); editor.setSelectionRange(0, 0); }
    }
    /** A date belongs in the filename, never inside the brief. */
    function fileName() {
      const host = (str(location.hostname).replace(/[^a-z0-9.-]/gi, "") || "page").slice(0, 60);
      return `design-prompt-${host}-${new Date().toISOString().slice(0, 10)}.md`;
    }
    async function save() {
      if (editing) current = editor.value;
      panel.busy("Preparing the download…");
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(new Error("Could not encode the prompt."));
          reader.readAsDataURL(new Blob([current], { type: "text/markdown" }));
        });
        await F.call({ operation: "download-file", dataUrl, name: fileName() });
        api.toast("Saved the design prompt", { tone: "success" });
      } catch (error) {
        api.toast(error?.message || "Could not save the file", { tone: "error" });
      } finally { panel.busy(null); }
    }
    async function rescan() {
      panel.busy("Re-reading the page…");
      await F.util.sleep(20);
      current = regenerate();
      editing = false;
      panel.setSubtitle(pageTitle());
      paint();
      panel.setActions(actions());
      panel.busy(null);
      api.toast("Brief regenerated from the current page", { tone: "success", timeout: 1600 });
    }
    current = regenerate();
    paint();
    panel.busy(null);
    panel.setActions(actions());
    panel.setSubtitle(pageTitle());
  });
})();
