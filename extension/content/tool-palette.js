/*
 * Tool: Extract colors.
 *
 * `Fathom.analyze.colors()` walks the computed styles of the page and returns
 * every painted colour with its occurrence count and the roles it plays. This
 * tool turns that list into a filterable palette with copy affordances.
 *
 * Colours picked with the EyeDropper API are kept in a separate `picked` array
 * so a rescan never discards them. They are shown at the top of the "All" view
 * and carry `count: 0` + `roles: []` because they are not part of the page.
 *
 * Read-only apart from the EyeDropper overlay Chrome itself draws.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  const { h, svg } = F.util;

  const ICON = {
    copy: "M8 8h10v12H8zM4 16V4h10",
    json: "M9 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2M15 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2",
    pick: "M4 20l6-6M13 3l8 8-9 9H6v-6z",
    rescan: "M4 12a8 8 0 1 1 2.3 5.6M4 20v-5h5",
  };

  /* Order is the order a designer scans a palette: everything, then canvas,
   * then ink, then hairlines, then the rare accent colours. */
  const ROLE_ORDER = ["All", "Background", "Text", "Border", "Accent"];

  F.workspace.register("palette", async (api) => {
    let colors = F.analyze.colors(document);
    let roles = F.analyze.roles(colors);
    let background = F.analyze.meta(document).background;
    let role = "All";
    let closed = false;

    const picked = [];

    const panel = api.panel({
      title: "Extract colors",
      subtitle: `${colors.length} colours`,
      size: "default",
      tool: "palette",
      onClose: () => {
        closed = true;
      },
    });

    /* ------------------------------------------------------------ helpers --- */

    /** The rows currently on screen for the active role chip. */
    function visibleColors() {
      if (role === "All") return [...picked, ...roles.All];
      return roles[role] || [];
    }

    /** True when a role filter still has entries after a rescan. */
    function roleAvailable(name) {
      if (name === "All") return true;
      return (roles[name] || []).length > 0;
    }

    async function writeClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        api.toast("The browser refused clipboard access.", { tone: "error" });
        return false;
      }
    }

    async function copyHex(value) {
      if (await writeClipboard(value)) {
        api.toast(`Copied ${value}`, { tone: "success", timeout: 1500 });
      }
    }

    /**
     * A WCAG ratio is only meaningful for text colours, so we compute one there
     * and leave background/border rows alone. Ratios at or above 7:1 already
     * pass AAA and are not worth the pixels.
     */
    function contrastSuffix(entry) {
      if (!entry.roles.includes("text")) return "";
      const foreground = F.analyze.parseColor(entry.value);
      const backdrop = F.analyze.parseColor(background);
      if (!foreground || !backdrop) return "";
      const ratio = F.analyze.contrast(foreground, backdrop);
      if (!(ratio > 0) || ratio >= 7) return "";
      return ` · ${ratio.toFixed(1)}:1`;
    }

    function countLabel(entry) {
      if (entry.picked) return "picked";
      const uses = `${entry.count} use${entry.count === 1 ? "" : "s"}`;
      return uses + contrastSuffix(entry);
    }

    /* --------------------------------------------------------------- rows --- */

    function colorRow(entry) {
      const copyBtn = h(
        "button",
        {
          class: "icon-button",
          type: "button",
          "aria-label": `Copy ${entry.value}`,
          title: "Copy hex",
          onclick: (event) => {
            event.stopPropagation();
            copyHex(entry.value);
          },
        },
        svg(ICON.copy),
      );

      const row = h(
        "li",
        {
          class: "color-row",
          tabindex: "0",
          title: `Click to copy ${entry.value}`,
        },
        h("span", { class: "color-chip" }),
        h("code", { class: "color-hex", text: entry.value }),
        h("span", { class: "color-count", text: countLabel(entry) }),
        copyBtn,
      );

      /* The swatch is a custom property, so it must go through setProperty —
       * assigning style["--swatch"] would be a no-op. */
      row.style.setProperty("--swatch", entry.value);

      row.addEventListener("click", (event) => {
        if (event.target.closest(".icon-button")) return;
        copyHex(entry.value);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        copyHex(entry.value);
      });

      return row;
    }

    function renderRoles() {
      if (!roleAvailable(role)) role = "All";
      const chips = ROLE_ORDER.filter(roleAvailable).map((name) =>
        h("button", {
          class: "chip",
          type: "button",
          "aria-pressed": String(role === name),
          text: name,
          onclick: () => {
            role = name;
            renderRoles();
            renderList();
          },
        }),
      );
      roleRow.replaceChildren(h("span", { class: "meta", text: "Role" }), ...chips);
    }

    function renderList() {
      const items = visibleColors();
      if (!items.length) {
        list.replaceChildren(h("li", { class: "empty", text: "No colors in this group." }));
        return;
      }
      list.replaceChildren(...items.map(colorRow));
    }

    function render() {
      renderRoles();
      renderList();
      panel.setSubtitle(`${colors.length} colours`);
    }

    /* -------------------------------------------------------------- actions --- */

    /**
     * EyeDropper stays armed until the user presses Esc. Each successful pick is
     * prepended; the loop ends on the first rejection (Esc or an unsupported
     * browser), which is exactly the platform's cancel signal.
     */
    async function pick() {
      if (typeof window.EyeDropper !== "function") {
        api.toast("This browser has no colour picker.", { tone: "error" });
        return;
      }

      let added = 0;
      while (!closed) {
        let result;
        try {
          result = await new window.EyeDropper().open();
        } catch {
          break;
        }
        const parsed = F.analyze.parseColor(result.sRGBHex);
        if (!parsed) continue;
        const value = F.analyze.toHex(parsed);

        const previous = picked.findIndex((entry) => entry.value === value);
        if (previous >= 0) picked.splice(previous, 1);
        picked.unshift({ value, count: 0, roles: [], picked: true });

        role = "All";
        render();
        added += 1;
      }

      if (added) {
        api.toast(`Added ${added} picked colour${added === 1 ? "" : "s"}`, { tone: "success" });
      }
    }

    function rescan() {
      colors = F.analyze.colors(document);
      roles = F.analyze.roles(colors);
      background = F.analyze.meta(document).background;
      render();
      api.toast("Palette rescanned", { tone: "success", timeout: 1600 });
    }

    async function copyCss() {
      const items = visibleColors();
      if (!items.length) {
        api.toast("No colors to copy.", { tone: "error" });
        return;
      }
      const body = items.map((entry, index) => `  --color-${index + 1}: ${entry.value};`).join("\n");
      if (await writeClipboard(`:root {\n${body}\n}`)) {
        api.toast(`Copied ${items.length} CSS variable${items.length === 1 ? "" : "s"}`, {
          tone: "success",
        });
      }
    }

    async function copyJson() {
      const items = visibleColors();
      if (!items.length) {
        api.toast("No colors to copy.", { tone: "error" });
        return;
      }
      const payload = items.map((entry) => ({
        value: entry.value,
        count: entry.count,
        roles: entry.roles,
      }));
      if (await writeClipboard(JSON.stringify(payload, null, 2))) {
        api.toast(`Copied ${items.length} colour${items.length === 1 ? "" : "s"} as JSON`, {
          tone: "success",
        });
      }
    }

    /* --------------------------------------------------------------- shell --- */

    const roleRow = h("div", {
      class: "toolbar-row",
      role: "group",
      "aria-label": "Colour role",
    });
    const list = h("ul", { class: "color-list" });
    const note = h("p", {
      class: "meta",
      style: { marginTop: "10px" },
      text: "Counts are computed-style occurrences. Ratios compare text colours with the page background.",
    });

    panel.body.replaceChildren(roleRow, list, note);

    panel.setActions([
      { label: "Pick", icon: ICON.pick, onClick: pick },
      { label: "Rescan", icon: ICON.rescan, onClick: rescan },
      { label: "Copy CSS", primary: true, icon: ICON.copy, onClick: copyCss },
      { label: "Copy JSON", icon: ICON.json, onClick: copyJson },
    ]);

    render();
  });
})();
