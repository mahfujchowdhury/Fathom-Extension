/*
 * Tool: Design MD.
 *
 * Samples the live page and renders a deterministic design-system document.
 * 100% local: no network, no model, same page in → same markdown out.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  const { h } = F.util;

  F.workspace.register("designmd", async (api) => {
    const panel = api.panel({
      title: "Design MD",
      subtitle: "Reading this page's design system",
      size: "default",
      tool: "designmd",
    });
    panel.busy("Sampling colours, type and spacing…");

    // Let the browser paint the busy state before the synchronous walk.
    await F.util.sleep(30);

    let model;
    let markdown;
    try {
      model = F.designMd.collect(document);
      markdown = F.designMd.render(model, {
        url: location.href,
        title: document.title || location.hostname,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      panel.busy(null);
      panel.body.replaceChildren(h("p", { class: "empty", text: err.message || "Sampling failed." }));
      return;
    }
    panel.busy(null);

    const check = F.designMd.validate ? F.designMd.validate(markdown) : { ok: true, problems: [] };

    const swatches = h("div", { class: "token-grid" });
    for (const color of (model.colors || []).slice(0, 8)) {
      swatches.append(
        h(
          "div",
          { class: "swatch" },
          h("div", { class: "paint", style: { background: color.value } }),
          h("div", { class: "label" }, h("span", { text: color.value })),
        ),
      );
    }

    const pre = h("pre", { class: "code code-wrap", tabindex: "0", style: { maxHeight: "42vh" } });
    pre.textContent = markdown;

    const stats = h("p", {
      class: "meta",
      text: `${(model.colors || []).length} colours · ${(model.typography || []).length} families · ${
        (model.spacing || []).length
      } spacing steps · ${(model.components || []).length} recipes · ${markdown.split("\n").length} lines`,
    });

    panel.body.replaceChildren(
      stats,
      swatches.childElementCount ? h("div", { style: { margin: "10px 0" } }, swatches) : h("span"),
      h("p", { class: "eyebrow", text: "Markdown" }),
      pre,
    );

    if (!check.ok) {
      panel.body.prepend(
        h("p", { class: "meta", style: { color: "#ff9b9b", marginBottom: "8px" }, text: check.problems.join(" · ") }),
      );
    }

    const copy = async () => {
      await navigator.clipboard.writeText(markdown);
      api.toast("Design MD copied", { tone: "success", timeout: 1800 });
    };

    const save = async () => {
      const url = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(new Blob([markdown], { type: "text/markdown" }));
      });
      const host = location.hostname.replace(/[^a-z0-9.-]/gi, "") || "page";
      await F.call({ operation: "download-file", dataUrl: url, name: `design-md-${host}.md` });
      api.toast("Saved DESIGN.md", { tone: "success" });
    };

    const rebuild = async () => {
      panel.close();
      await F.workspace.runTool("designmd");
    };

    panel.setActions([
      { label: "Copy markdown", primary: true, icon: "M8 8h10v12H8zM4 16V4h10", onClick: copy },
      { label: "Save .md", icon: "M12 4v11m0 0l-4-4m4 4l4-4M5 20h14", onClick: save },
      { label: "Rescan", icon: "M4 12a8 8 0 1 1 2.3 5.6M4 20v-5h5", onClick: rebuild },
    ]);

    panel.setSubtitle(document.title || location.hostname);
  });
})();
