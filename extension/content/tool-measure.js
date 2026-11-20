/*
 * Tool: Inspect & measure.
 *
 * Pick one element, read its computed box model, then edit any curated property
 * live. Edits are inline `!important` overrides so they always win, they are
 * validated with CSS.supports() before being applied, and every one of them is
 * reversible.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  const { h } = F.util;
  const NUMERIC = /^-?\d*\.?\d+(px|em|rem|%|vh|vw|ch|pt)?$/;

  function bump(value, delta) {
    const match = String(value).trim().match(/^(-?\d*\.?\d+)([a-z%]*)$/i);
    if (!match) return null;
    const n = parseFloat(match[1]) + delta;
    const rounded = Math.round(n * 100) / 100;
    return `${rounded}${match[2] || "px"}`;
  }

  F.workspace.register("inspect", async (api) => {
    const panel = api.panel({
      title: "Inspect & measure",
      subtitle: "Click an element to inspect it",
      size: "default",
      tool: "inspect",
      /* Never leave the outline floating over the page after the panel goes. */
      onClose: () => cleanup(),
    });

    panel.body.replaceChildren(
      h("p", { class: "empty" }, "Click any element on the page. Its computed CSS appears here and can be edited in place."),
    );

    let outline = null;
    let current = null;
    const overrides = new Set();

    const updateOutline = () => outline?.update();
    window.addEventListener("scroll", updateOutline, true);
    window.addEventListener("resize", updateOutline);

    const cleanup = () => {
      outline?.remove();
      outline = null;
      window.removeEventListener("scroll", updateOutline, true);
      window.removeEventListener("resize", updateOutline);
    };

    const reset = () => {
      if (!current) return;
      for (const prop of overrides) current.style.removeProperty(prop);
      overrides.clear();
      render(current);
      api.toast("Overrides removed", { tone: "success", timeout: 1800 });
    };

    const copyCss = async () => {
      if (!current) return;
      await navigator.clipboard.writeText(F.inspect.cssBlock(current));
      api.toast("Copied CSS", { tone: "success", timeout: 1800 });
    };

    function render(el) {
      current = el;
      cleanup();
      outline = F.inspect.outline(el, { label: F.util.describe(el) });

      const summary = F.inspect.summary(el);
      const metrics = F.inspect.measure(el);

      const head = h(
        "div",
        { class: "card", style: { marginBottom: "12px" } },
        h(
          "div",
          { class: "row" },
          h("strong", { text: summary.label, style: { fontSize: "12px" } }),
          h("span", { class: "grow" }),
          h("span", { class: "meta", text: summary.size }),
        ),
        h("dl", { class: "kv", style: { marginTop: "8px" } },
          h("dt", { text: "display" }),
          h("dd", { text: summary.display }),
          h("dt", { text: "font" }),
          h("dd", { text: summary.font }),
          h("dt", { text: "colour" }),
          h("dd", { text: `${summary.color} on ${summary.background}` }),
          h("dt", { text: "box model" }),
          h("dd", {
            text: `content ${metrics.width}×${metrics.height} · pad ${metrics.padding} · border ${metrics.border} · margin ${metrics.margin}`,
          }),
        ),
      );

      const code = h("pre", { class: "code", style: { maxHeight: "22vh" } });
      const refreshCode = () => {
        code.textContent = F.inspect.cssBlock(el);
      };

      const groupsEl = h("div");

      for (const group of F.inspect.groups(el)) {
        const fieldset = h("fieldset", { class: "prop-group" }, h("legend", { text: group.name }));

        for (const row of group.rows) {
          const input = h("input", {
            type: "text",
            value: row.value,
            spellcheck: "false",
            "aria-label": row.prop,
            dataset: { property: row.prop },
          });

          const apply = () => {
            const ok = F.inspect.apply(el, row.prop, input.value);
            input.setAttribute("aria-invalid", String(!ok));
            input.classList.toggle("edited", ok);
            if (ok) {
              overrides.add(row.prop);
              refreshCode();
              outline?.update();
            }
          };

          input.addEventListener("change", apply);
          input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              apply();
              input.blur();
            }
          });

          const up = h("button", { type: "button", "aria-label": `Increase ${row.prop}`, text: "▲" });
          const down = h("button", { type: "button", "aria-label": `Decrease ${row.prop}`, text: "▼" });
          for (const [btn, delta] of [[up, 1], [down, -1]]) {
            btn.addEventListener("click", () => {
              const next = bump(input.value, delta);
              if (!next) return;
              input.value = next;
              apply();
            });
          }

          const steppers = NUMERIC.test(row.value) || !row.value.includes(" ")
            ? h("div", { class: "steppers" }, up, down)
            : h("div", { class: "steppers" });

          fieldset.append(
            h("div", { class: "prop-row" }, h("span", { text: row.prop, title: row.prop }), input, steppers),
          );
        }

        groupsEl.append(fieldset);
      }

      refreshCode();

      panel.body.replaceChildren(
        head,
        h(
          "div",
          { class: "row", style: { marginBottom: "10px" } },
          h("button", {
            class: "btn btn-sm",
            type: "button",
            text: "Pick another",
            onclick: () => startPicking(),
          }),
          h("span", { class: "grow" }),
          h("span", { class: "meta", text: "Enter applies · ▲▼ steps" }),
        ),
        groupsEl,
        h("p", { class: "eyebrow", text: "Generated CSS" }),
        code,
      );

      panel.setSubtitle(`Editing ${F.util.describe(el)}`);
      panel.setActions([
        { label: "Copy CSS", primary: true, icon: "M8 8h10v12H8zM4 16V4h10", onClick: copyCss },
        { label: "Reset", icon: "M4 4v6h6M20 20v-6h-6", onClick: reset },
      ]);
    }

    function startPicking() {
      panel.setSubtitle("Click an element to inspect it");
      api.toast("Click an element to inspect");
      F.workspace.pick(
        (el) => {
          if (!el) return;
          render(el);
        },
        { hint: "Click an element to inspect", keys: [["Esc", "cancel"]] },
      );
    }

    panel.setActions([]);
    startPicking();

    // Keep the outline glued to the element while the panel scrolls too.
    panel.body.addEventListener("scroll", updateOutline, { passive: true });
  });
})();
