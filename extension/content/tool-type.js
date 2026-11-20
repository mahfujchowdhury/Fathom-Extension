/*
 * Tool: Detect fonts.
 *
 * `Fathom.analyze.fonts()` returns one entry per family actually used for text
 * on the page, with counts, size/weight/line-height sets and a text sample.
 * This tool presents those entries as live specimens, lets the user retype the
 * phrase, filter families, outline every element that uses a family, and copy
 * ready-to-paste `font-family` declarations.
 *
 * `Fathom.inspect.outline()` draws the violet overlays directly on the page, so
 * they must be cleaned up on the next highlight, on panel close and on a short
 * timer — nothing may outlive the tool.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  const { h } = F.util;

  const ICON = { copy: "M8 8h10v12H8zM4 16V4h10" };

  const DEFAULT_PHRASE = "The quick brown fox jumps over the lazy dog";
  const MAX_OUTLINES = 160;
  const HIGHLIGHT_MS = 4000;

  /** First family of a computed `font-family` stack, quotes stripped. */
  function firstFamily(stack) {
    return String(stack).split(",")[0].trim().replace(/^["']|["']$/g, "");
  }

  /** Make a page-derived family safe to drop inside double quotes. */
  function cssFamily(family) {
    return String(family).replace(/["\\]/g, "").trim() || "sans-serif";
  }

  function truncate(text, limit) {
    const value = String(text);
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  }

  F.workspace.register("type", async (api) => {
    const families = F.analyze.fonts(document);

    let phrase = DEFAULT_PHRASE;
    let query = "";
    let closed = false;

    /* One live overlay list + timer shared by every card. */
    let overlays = [];
    let highlightTimer = null;

    /* Cache family → ", fallback, fallback" so Copy CSS does not rescan the
     * whole document once per card. */
    const fallbackCache = new Map();

    const panel = api.panel({
      title: "Detect fonts",
      subtitle: `${families.length} families`,
      size: "default",
      tool: "type",
      onClose: () => cleanup(),
    });

    /* ------------------------------------------------------------ helpers --- */

    async function writeClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        api.toast("The browser refused clipboard access.", { tone: "error" });
        return false;
      }
    }

    /**
     * The page's own fallback stack for a family, including the leading comma.
     * Falls back to sans-serif when the family cannot be found any more (the
     * page may have changed since the scan).
     */
    function fallbackFor(family) {
      if (fallbackCache.has(family)) return fallbackCache.get(family);
      let rest = ", sans-serif";
      const needle = family.toLowerCase();
      const all = document.querySelectorAll("*");
      const limit = Math.min(all.length, 4000);
      for (let i = 0; i < limit; i++) {
        const stack = getComputedStyle(all[i]).fontFamily;
        if (firstFamily(stack).toLowerCase() !== needle) continue;
        const comma = stack.indexOf(",");
        if (comma >= 0) {
          const tail = stack.slice(comma).trim();
          if (tail && tail !== ",") rest = tail;
        }
        break;
      }
      fallbackCache.set(family, rest);
      return rest;
    }

    function declaration(family) {
      return `font-family: "${cssFamily(family)}"${fallbackFor(family)};`;
    }

    /* --------------------------------------------------------- highlighting --- */

    function clearHighlights() {
      for (const overlay of overlays) overlay.remove();
      overlays = [];
      if (highlightTimer) {
        clearTimeout(highlightTimer);
        highlightTimer = null;
      }
    }

    /** Outline every element whose *first* computed family matches. */
    function highlightFamily(family) {
      clearHighlights();
      const needle = family.toLowerCase();
      const all = document.querySelectorAll("body, body *");
      let count = 0;

      for (const el of all) {
        if (el.closest("fathom-workspace")) continue;
        if (firstFamily(getComputedStyle(el).fontFamily).toLowerCase() !== needle) continue;
        overlays.push(F.inspect.outline(el, { label: family }));
        count += 1;
        if (count >= MAX_OUTLINES) break;
      }

      if (!count) {
        api.toast(`No elements use ${family} any more`, { tone: "error" });
        return;
      }

      highlightTimer = setTimeout(clearHighlights, HIGHLIGHT_MS);
      api.toast(
        `Outlined ${count}${count >= MAX_OUTLINES ? "+" : ""} element${
          count === 1 ? "" : "s"
        } using ${family}`,
        { tone: "info", timeout: 2600 },
      );
    }

    /* ------------------------------------------------------------- clipboard --- */

    async function copyFamily(family) {
      const text = `/* ${family} */\n${declaration(family)}`;
      if (await writeClipboard(text)) {
        api.toast(`Copied the CSS for ${family}`, { tone: "success", timeout: 1600 });
      }
    }

    /** Panel-level copy: one declaration per family currently visible. */
    async function copyAllCss() {
      const visible = visibleFamilies();
      if (!visible.length) {
        api.toast("No fonts to copy.", { tone: "error" });
        return;
      }
      const host = location.hostname || "this page";
      const lines = visible.map((entry) => declaration(entry.family));
      const text = [`/* Font families detected on ${host} */`, ...lines].join("\n");
      if (await writeClipboard(text)) {
        api.toast(`Copied ${visible.length} font famil${visible.length === 1 ? "y" : "ies"}`, {
          tone: "success",
        });
      }
    }

    /* ----------------------------------------------------------------- cards --- */

    function fontCard(entry) {
      const card = h("div", { class: "font-card" });

      /* The phrase is rendered in the family itself; `.font-sample` handles the
       * one-line truncation with an ellipsis. */
      const sample = h("div", { class: "font-sample", title: phrase });
      sample.textContent = truncate(phrase, 140);
      sample.style.fontFamily = `"${cssFamily(entry.family)}", sans-serif`;

      const sizes = (entry.sizes || []).slice(0, 4);
      const sizeText = sizes.length ? `${sizes.join(", ")}px` : "unknown";
      const lineHeight =
        (entry.lineHeights || []).find((value) => value && value !== "normal") || "normal";
      const meta = h(
        "div",
        { class: "font-meta" },
        h("strong", { class: "font-name", text: entry.family }),
        ` · ${entry.count} text element${entry.count === 1 ? "" : "s"} · sizes ${sizeText} · line-height ${lineHeight}`,
      );

      const weights = (entry.weights && entry.weights.length ? entry.weights : [400]).map((weight) =>
        h("span", { class: "chip", text: String(weight) }),
      );
      const chips = h("div", { class: "chips" }, weights);

      const actions = h(
        "div",
        { class: "row", style: { marginTop: "8px" } },
        h("button", {
          class: "btn btn-sm",
          type: "button",
          text: "Highlight",
          onclick: () => highlightFamily(entry.family),
        }),
        h("button", {
          class: "btn btn-sm",
          type: "button",
          text: "Copy CSS",
          onclick: () => copyFamily(entry.family),
        }),
        h("span", { class: "grow" }),
        h("a", {
          class: "meta",
          href: `https://fonts.google.com/specimen/${encodeURIComponent(entry.family).replace(/%20/g, "+")}`,
          target: "_blank",
          rel: "noopener",
          text: "Google Fonts",
        }),
      );

      card.append(sample, meta, chips, actions);
      return card;
    }

    function visibleFamilies() {
      const needle = query.trim().toLowerCase();
      if (!needle) return families;
      return families.filter((entry) => entry.family.toLowerCase().includes(needle));
    }

    function renderList() {
      const visible = visibleFamilies();
      if (!visible.length) {
        list.replaceChildren(
          h("p", {
            class: "empty",
            text: families.length ? "No fonts match these filters." : "No fonts found on this page.",
          }),
        );
        return;
      }
      list.replaceChildren(...visible.map(fontCard));
    }

    /* -------------------------------------------------------------- cleanup --- */

    function cleanup() {
      closed = true;
      clearHighlights();
      document.removeEventListener("pointermove", onPointerMove, true);
      if (hoverRaf) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = 0;
      }
    }

    /* --------------------------------------------------------- hover readout --- */

    let hoverRaf = 0;
    let hoverEvent = null;

    function onPointerMove(event) {
      hoverEvent = event;
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(updateHover);
    }

    /** Keep the hint card honest: show the family under the pointer. */
    function updateHover() {
      hoverRaf = 0;
      if (closed || !hoverEvent) return;
      const el = hoverEvent.target;
      if (!(el instanceof Element) || el.closest("fathom-workspace")) {
        hoverNote.textContent = "";
        return;
      }
      const cs = getComputedStyle(el);
      const family = firstFamily(cs.fontFamily);
      hoverNote.textContent = family ? `Under the pointer: ${family} · ${cs.fontSize}` : "";
    }

    /* --------------------------------------------------------------- shell --- */

    const phraseInput = h("input", {
      id: "fathom-type-phrase",
      class: "grow",
      type: "text",
      value: phrase,
      "aria-label": "Preview text",
      placeholder: "Preview text",
    });
    phraseInput.addEventListener("input", () => {
      phrase = phraseInput.value || DEFAULT_PHRASE;
      renderList();
    });

    const searchInput = h("input", {
      class: "font-search grow",
      type: "search",
      placeholder: "Filter families…",
      "aria-label": "Filter font families",
      autocomplete: "off",
      spellcheck: "false",
    });
    searchInput.addEventListener("input", () => {
      query = searchInput.value;
      renderList();
    });

    const hoverNote = h("span", { class: "meta", text: "" });
    const hint = h(
      "div",
      { class: "card", style: { marginBottom: "10px" } },
      h("p", {
        class: "meta",
        text: "Hover over text on the page to see its family. Click a card's Highlight button to outline every element using it.",
      }),
      hoverNote,
    );

    const list = h("div", { class: "font-list" });

    panel.body.replaceChildren(
      h(
        "div",
        { class: "toolbar-row" },
        h("label", { class: "meta", for: "fathom-type-phrase", text: "Preview text" }),
        phraseInput,
      ),
      h("div", { class: "toolbar-row" }, searchInput),
      hint,
      list,
    );

    renderList();

    panel.setActions([
      { label: "Copy CSS", primary: true, icon: ICON.copy, onClick: copyAllCss },
    ]);

    /* Hover readout is passive and lives only while the panel is open. */
    document.addEventListener("pointermove", onPointerMove, true);
  });
})();
