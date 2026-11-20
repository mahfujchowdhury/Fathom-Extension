/*
 * Tool: Swap fonts.
 *
 * The only Fathom tool that mutates the page: one injected
 * <style data-fathom-helper="font-swap"> carries a `font-family: … !important`
 * rule for the active scope, and Google families get a fonts.googleapis.com
 * <link> first. Every exit funnels through revertAll() — panel close (Escape
 * included), both Revert buttons and pagehide — and it is idempotent.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  const { h } = F.util;

  /* Elements this tool injects into the page carry this marker. */
  const HELPER = "font-swap";
  const GOOGLE_CSS = "https://fonts.googleapis.com/css2?family=";
  const GOOGLE_WAIT = 2000;

  /* The page selector each scope overrides. "All text" is the whole document. */
  const SCOPES = [
    { id: "all", label: "All text", selector: "*" },
    { id: "headings", label: "Headings", selector: "h1,h2,h3,h4,h5,h6" },
    { id: "body", label: "Body", selector: "p,li,td,dd,blockquote" },
  ];

  /* A generic tail keeps an unloaded face readable instead of invisible. */
  const FALLBACKS = {
    serif: "Georgia, Times New Roman, serif",
    sans: 'system-ui, "Segoe UI", Arial, sans-serif',
    mono: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
    display: 'Impact, "Arial Black", sans-serif',
  };

  const KEYWORDS = new Set(["system-ui", "ui-monospace"]); // stay unquoted

  /* Built-in catalogue as "Family|category"; the category labels each row. */
  const SYSTEM_SPECS = [
    "Arial|sans", "Helvetica|sans", "Verdana|sans", "Tahoma|sans", "Trebuchet MS|sans",
    "Georgia|serif", "Times New Roman|serif", "Garamond|serif", "Palatino|serif",
    "Cambria|serif", "Didot|serif", "Baskerville|serif",
    "Courier New|mono", "Consolas|mono", "Menlo|mono", "Monaco|mono", "SF Mono|mono",
    "ui-monospace|mono", "system-ui|sans",
    "Impact|display", "Copperplate|display", "Rockwell|serif",
    "Gill Sans|sans", "Futura|sans", "Optima|sans",
  ];

  /* Free Google families; these are the only rows that need a network fetch. */
  const GOOGLE_SPECS = [
    "Inter|sans", "Roboto|sans", "Open Sans|sans", "Lato|sans", "Montserrat|sans",
    "Poppins|sans", "Source Sans 3|sans", "Work Sans|sans", "Nunito|sans",
    "Raleway|sans", "DM Sans|sans", "Manrope|sans", "Space Grotesk|sans",
    "IBM Plex Sans|sans", "IBM Plex Serif|serif", "IBM Plex Mono|mono",
    "Playfair Display|display", "Merriweather|serif", "Lora|serif",
    "Libre Baskerville|serif", "Crimson Pro|serif", "Fraunces|display",
    "Newsreader|serif", "Instrument Serif|serif", "Bricolage Grotesque|display",
    "Sora|sans", "Outfit|sans", "Figtree|sans", "Plus Jakarta Sans|sans",
    "Karla|sans", "Rubik|sans", "Barlow|sans", "Archivo|sans", "Epilogue|sans",
    "JetBrains Mono|mono", "Fira Code|mono", "DM Mono|mono", "Space Mono|mono",
    "Courier Prime|mono",
  ];

  const parseSpecs = (specs, source) =>
    specs.map((spec) => {
      const [family, category] = spec.split("|");
      return { family, category: category || "sans", source };
    });

  const SYSTEM = parseSpecs(SYSTEM_SPECS, "system");
  const GOOGLE = parseSpecs(GOOGLE_SPECS, "google");
  const CATALOGUE = SYSTEM.concat(GOOGLE);

  /* Everything the tool owns. Cleared by teardown(), not by a panel rebuild. */
  const state = {
    scope: "all",
    current: null, // applied entry, or null = the page's original fonts
    history: [], // previous entries, for Undo
    loaded: new Set(), // Google families already linked
    links: new Set(), // injected <link> elements
    faces: new Map(), // family -> FontFace injected from a local file
    applySeq: 0, // invalidates an await when a newer pick wins
    ui: null,
    api: null,
  };

  /* ------------------------------------------------------------ helpers --- */

  /** Strip anything that could break out of a font-family token. */
  const cleanFamily = (name) =>
    String(name || "").replace(/["'\\{};<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);

  /** Quoted CSS family plus a generic fallback stack. */
  function fontStack(family, category) {
    const clean = cleanFamily(family);
    const fallback = FALLBACKS[category] || FALLBACKS.sans;
    return clean ? `${KEYWORDS.has(clean) ? clean : `"${clean}"`}, ${fallback}` : fallback;
  }

  const pageHead = () => document.head || document.documentElement;
  const scopeFor = (id) => SCOPES.find((scope) => scope.id === id) || SCOPES[0];

  function notify(message, tone, timeout) {
    try {
      state.api?.toast(message, { tone, timeout });
    } catch {
      /* The shell closed while an async load was in flight. */
    }
  }

  /* ------------------------------------------------------ page mutation --- */

  /** Reuse one style element, so repeated picks never stack duplicate rules. */
  function ensureStyle() {
    let el = document.querySelector(`style[data-fathom-helper="${HELPER}"]`);
    if (el) return el;
    el = document.createElement("style");
    el.setAttribute("data-fathom-helper", HELPER);
    pageHead().append(el);
    return el;
  }

  /** Rewrite the single rule for the current scope and family. */
  function writeRule(entry) {
    const stack = fontStack(entry.family, entry.category);
    ensureStyle().textContent = `${scopeFor(state.scope).selector}{font-family:${stack} !important}`;
  }

  /** Remove just the override, keeping faces and links around for Undo. */
  function removeRule() {
    for (const el of document.querySelectorAll(`style[data-fathom-helper="${HELPER}"]`)) el.remove();
  }

  /** Full cleanup: page rule, injected links, file-loaded faces, history. */
  function teardown() {
    state.applySeq += 1; // any in-flight apply is now stale
    removeRule();
    for (const link of document.querySelectorAll(`link[data-fathom-helper="${HELPER}"]`)) link.remove();
    for (const link of state.links) link.remove();
    state.links.clear();
    state.loaded.clear();
    for (const face of state.faces.values()) {
      try { document.fonts.delete(face); } catch { /* FontFaceSet absent */ }
    }
    state.faces.clear();
    state.current = null;
    state.history.length = 0;
  }

  /** The single exit used by every close path. Safe to call twice. */
  function revertAll(announce) {
    const hadFonts = !!state.current || state.links.size > 0;
    teardown();
    renderStatus();
    if (announce && hadFonts) notify("Page fonts restored", "success", 1800);
  }

  /* ------------------------------------------------------------- apply --- */

  /**
   * Inject the Google Fonts CSS for a family and wait for it. One 2 s budget
   * covers both the stylesheet hop and document.fonts.ready; a failure or a
   * timeout only means the fallback stack is used. Never throws.
   */
  async function ensureGoogle(entry) {
    if (entry.source !== "google" || state.loaded.has(entry.family)) return;

    const family = encodeURIComponent(entry.family).replace(/%20/g, "+");
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${GOOGLE_CSS}${family}:wght@400;600;700&display=swap`;
    link.setAttribute("data-fathom-helper", HELPER);
    link.setAttribute("data-fathom-font", entry.family);

    const settled = new Promise((resolve) => {
      link.addEventListener("load", () => resolve(true), { once: true });
      link.addEventListener("error", () => resolve(false), { once: true });
    });

    pageHead().append(link);
    state.links.add(link);
    state.loaded.add(entry.family);

    try {
      const faces = document.fonts?.ready ? document.fonts.ready.catch(() => {}) : Promise.resolve();
      const outcome = await Promise.race([
        Promise.all([settled, faces]).then(([ok]) => ok),
        F.util.sleep(GOOGLE_WAIT).then(() => "slow"),
      ]);
      if (outcome === false) {
        /* Offline or blocked: drop the dead link so a later pick can retry. */
        link.remove();
        state.links.delete(link);
        state.loaded.delete(entry.family);
      }
    } catch {
      /* A blocked CDN must never stop the swap; the fallback stack covers it. */
    }
  }

  async function apply(entry, opts = {}) {
    const seq = ++state.applySeq;
    const previous = state.current;

    if (entry.source === "google" && state.ui?.status.isConnected) {
      state.ui.status.textContent = `Loading ${entry.family}…`;
    }
    await ensureGoogle(entry);
    if (seq !== state.applySeq) return; // a newer pick or a close won

    state.current = entry;
    if (previous && previous.family !== entry.family) state.history.push(previous);
    writeRule(entry);
    renderStatus();
    if (opts.announce !== false) notify(`Applied ${entry.family}`, "success", 1800);
  }

  /** Previous family from the stack, or the page's original fonts. */
  function undo() {
    state.applySeq += 1;
    const previous = state.history.pop();
    if (previous) {
      state.current = previous;
      writeRule(previous);
      renderStatus();
      notify(`Back to ${previous.family}`, "info", 1500);
    } else if (state.current) {
      state.current = null;
      removeRule();
      renderStatus();
      notify("Original fonts restored", "success", 1800);
    } else notify("Nothing to undo", "info", 1200);
  }

  /** Load a local .woff2/.woff/.ttf/.otf file and apply it to the page. */
  async function applyFontFile(file) {
    const family = cleanFamily(String(file.name || "").replace(/\.[^.]+$/, ""));
    if (!family) {
      notify("That file has no usable family name.", "error", 3000);
      return;
    }
    try {
      if (typeof FontFace !== "function" || !document.fonts) throw new Error("no FontFace");
      const face = new FontFace(family, await file.arrayBuffer());
      await face.load(); // rejects on an unsupported or corrupt file
      try { document.fonts.delete(state.faces.get(family)); } catch { /* already dropped */ }
      document.fonts.add(face);
      state.faces.set(family, face);
      await apply({ family, category: "sans", source: "file" }, { announce: false });
      notify(`Loaded ${family}`, "success", 2200);
    } catch {
      notify(`Could not load ${file.name}. Try a .woff2 or .ttf file.`, "error", 5000);
    }
  }

  /* ---------------------------------------------------------------- UI --- */

  function renderStatus() {
    const ui = state.ui;
    if (!ui) return;
    ui.status.textContent = state.current ? `Now using: ${state.current.family}` : "Original fonts";
    for (const button of ui.options) {
      const active = !!state.current && button.dataset.family === state.current.family;
      if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
      button.style.borderColor = active ? "var(--purple)" : "";
      button.style.background = active ? "var(--soft)" : "";
    }
  }

  function buildPanel(api) {
    const panel = api.panel({
      title: "Swap fonts",
      subtitle: "Applies to this page only",
      size: "default",
      tool: "fonts",
      onClose: () => revertAll(),
    });

    state.api = api;

    /* Current-font bar: the page's own fonts until something is applied. */
    const status = h("span", { class: "grow truncate", text: "Original fonts" });
    const barRevert = h("button", {
      class: "btn btn-sm", type: "button", text: "Revert", onclick: () => revertAll(true),
    });
    const bar = h("div", { class: "font-current" }, status, barRevert);

    /* Scope chips retarget the live rule without dropping the family. */
    const chipRow = h("div", { class: "chips", role: "group", "aria-label": "Scope" });
    const chips = SCOPES.map((scope) => {
      const chip = h("button", {
        class: "chip", type: "button", text: scope.label,
        "aria-pressed": String(scope.id === state.scope),
        onclick: () => selectScope(scope.id),
      });
      chip.dataset.scope = scope.id;
      chipRow.append(chip);
      return chip;
    });

    function selectScope(id) {
      if (state.scope === id) return;
      state.scope = id;
      for (const chip of chips) chip.setAttribute("aria-pressed", String(chip.dataset.scope === id));
      if (state.current) writeRule(state.current);
    }

    /* Search + count + the family list. */
    const search = h("input", {
      class: "font-search", type: "search", placeholder: "Search all fonts…",
      "aria-label": "Search all fonts", autocomplete: "off", spellcheck: "false",
    });
    const count = h("span", { class: "meta", text: `${CATALOGUE.length} families` });
    const list = h("div", { class: "font-options", role: "group", "aria-label": "Font families" });
    const empty = h("p", { class: "empty", text: "No fonts match this search.", hidden: true });

    const options = CATALOGUE.map((entry) => {
      const button = h("button", {
        class: "font-option",
        type: "button",
        title: `Apply ${entry.family}`,
        style: { fontFamily: fontStack(entry.family, entry.category) },
      }, entry.family, h("span", { text: entry.category }));
      button.dataset.family = entry.family;
      button.addEventListener("click", () => apply(entry));
      list.append(button);
      return button;
    });

    const visibleOptions = () => options.filter((button) => !button.hidden);

    function refilter(raw) {
      const needle = raw.trim().toLowerCase();
      let shown = 0;
      for (const button of options) {
        const match = !needle || button.dataset.family.toLowerCase().includes(needle);
        button.hidden = !match;
        if (match) shown += 1;
      }
      count.textContent = needle ? `${shown} of ${CATALOGUE.length} families` : `${CATALOGUE.length} families`;
      empty.hidden = shown > 0;
      list.hidden = shown === 0;
    }

    search.addEventListener("input", () => refilter(search.value));

    /* Arrows walk the visible rows and keep focus on a real button. */
    function step(delta, from) {
      const visible = visibleOptions();
      if (!visible.length) return;
      const root = from.getRootNode ? from.getRootNode() : document;
      const index = visible.indexOf(root.activeElement);
      const next = index === -1 ? (delta > 0 ? 0 : visible.length - 1) : (index + delta + visible.length) % visible.length;
      const button = visible[next];
      button.focus({ preventScroll: true });
      button.scrollIntoView({ block: "nearest" });
    }

    const arrows = (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      step(event.key === "ArrowDown" ? 1 : -1, event.target);
    };

    list.addEventListener("keydown", arrows);
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return arrows(event);
      event.preventDefault();
      visibleOptions()[0]?.click(); // Enter from the search applies the top result
    });

    /* Custom family: accepted as-is, never fetched. */
    const custom = h("input", {
      class: "font-custom", type: "text", placeholder: "Family name, e.g. Inter",
      "aria-label": "Custom font family", autocomplete: "off",
    });

    function applyCustom() {
      const name = cleanFamily(custom.value);
      if (!name) {
        notify("Type a family name first.", "error", 2000);
        custom.focus();
        return;
      }
      /* A catalogue name keeps its source, so a Google row still loads. */
      const known = CATALOGUE.find((entry) => entry.family.toLowerCase() === name.toLowerCase());
      apply(known || { family: name, category: "sans", source: "custom" });
    }

    custom.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applyCustom();
    });

    const customRow = h("div", { class: "row" },
      h("div", { class: "grow" }, custom),
      h("button", { class: "btn btn-sm", type: "button", text: "Apply", onclick: applyCustom }),
    );

    /* Local font files become FontFace entries on this document only. */
    const file = h("input", {
      type: "file", accept: ".woff2,.woff,.ttf,.otf", "aria-label": "Load a font file",
    });
    file.addEventListener("change", () => {
      const picked = file.files && file.files[0];
      file.value = ""; // allow picking the same file again
      if (picked) applyFontFile(picked);
    });

    panel.body.replaceChildren(
      bar,
      h("div", { class: "section" }, h("h3", { text: "Scope" }), chipRow),
      h("div", { class: "section" },
        h("h3", { text: "Font family" }),
        h("div", { class: "row", style: { marginBottom: "8px" } }, h("div", { class: "grow" }, search), count),
        list,
        empty,
      ),
      h("div", { class: "section" }, h("h3", { text: "Custom family" }), customRow),
      h("div", { class: "section" },
        h("h3", { text: "Load a font file" }),
        file,
        h("p", { class: "meta", style: { marginTop: "6px" }, text: ".woff2, .woff, .ttf or .otf — used on this page only." }),
      ),
      h("p", { class: "meta", text: "↑ ↓ to browse · Enter to apply · closing this panel restores the page's fonts." }),
    );

    state.ui = { status, barRevert, chips, options, list, empty, search, custom, file };

    panel.setActions([
      { label: "Undo", icon: "M3 7h11a5 5 0 0 1 0 10H8M3 7l4-4M3 7l4 4", onClick: undo },
      { label: "Revert", icon: "M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5", onClick: () => revertAll(true) },
    ]);

    refilter("");
    renderStatus();
  }

  F.workspace.register("fonts", async (api) => {
    buildPanel(api);
  });

  /* Last exit: the page is unloading. Also covers a bfcache restore. */
  window.addEventListener("pagehide", () => revertAll(false), { capture: true });
})();
