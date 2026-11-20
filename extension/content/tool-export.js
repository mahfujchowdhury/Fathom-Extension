/*
 * Tool: Pick element / Clone page → standalone code export.
 *
 * Both tools share one surface: they differ only in which subtree is snapshotted.
 * The heavy lifting lives in lib/export.js; this file is the UI and the ZIP assembly.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  const { h } = F.util;

  const MAX_ASSETS = 40;
  const MAX_ASSET_BYTES = 8 * 1024 * 1024;
  const MAX_ZIP_BYTES = 48 * 1024 * 1024;

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Could not read the file."));
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBytes(base64) {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const extFor = (mime) => {
    const map = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "image/gif": "gif",
      "image/avif": "avif",
      "font/woff2": "woff2",
      "font/woff": "woff",
      "font/ttf": "ttf",
    };
    return map[mime] || "bin";
  };

  async function download(blob, name) {
    const dataUrl = await blobToDataUrl(blob);
    await F.call({ operation: "download-file", dataUrl, name });
  }

  /** Shared export surface for both entry points. */
  async function showExport(api, target, { title, subtitle, allowPromptless = true }) {
    const panel = api.panel({
      title,
      subtitle,
      size: "wide",
      tool: "export",
    });

    panel.busy("Reading the page…");

    let snap;
    try {
      snap = F.exportLib.snapshot(target, { maxNodes: 6000, includeAssets: true });
    } catch (err) {
      panel.busy(null);
      panel.body.replaceChildren(
        h("p", { class: "empty", text: err.message || "That element could not be exported." }),
      );
      return;
    }

    const assets = snap.assets || [];
    const ruleCount = (snap.css.match(/:where\(/g) || []).length;
    const stats = h("p", {
      class: "meta",
      text: `${countNodes(snap.tree)} nodes · ${ruleCount} rule${ruleCount === 1 ? "" : "s"} · ${
        assets.length
      } asset${assets.length === 1 ? "" : "s"}`,
    });

    const pre = h("pre", { class: "code", tabindex: "0" });
    const tabs = h("div", { class: "segmented", role: "tablist", "aria-label": "Output format" });

    const views = [
      { id: "html", label: "HTML", text: () => snap.html },
      { id: "css", label: "CSS", text: () => snap.css },
      { id: "jsx", label: "JSX", text: () => snap.jsx },
    ];

    let active = "html";

    function paint() {
      const view = views.find((v) => v.id === active) || views[0];
      pre.textContent = view.text();
      for (const btn of tabs.children) {
        btn.setAttribute("aria-selected", String(btn.dataset.view === active));
      }
    }

    for (const view of views) {
      tabs.append(
        h("button", {
          type: "button",
          role: "tab",
          "data-view": view.id,
          "aria-selected": String(view.id === active),
          text: view.label,
          onclick: () => {
            active = view.id;
            paint();
          },
        }),
      );
    }

    panel.body.replaceChildren(
      h("div", { class: "row", style: { marginBottom: "8px" } }, tabs, h("span", { class: "grow" }), stats),
      pre,
    );
    paint();
    panel.busy(null);

    const copy = async () => {
      const view = views.find((v) => v.id === active) || views[0];
      await navigator.clipboard.writeText(view.text());
      api.toast("Copied to clipboard", { tone: "success", timeout: 1800 });
    };

    const saveHtml = async () => {
      const host = location.hostname.replace(/[^a-z0-9.-]/gi, "") || "page";
      await download(new Blob([snap.html], { type: "text/html" }), `fathom-${host}.html`);
      api.toast("Saved the HTML file", { tone: "success" });
    };

    const saveZip = async () => {
      panel.busy("Collecting assets…");
      try {
        const files = [
          { name: "index.html", data: snap.html },
          { name: "styles.css", data: snap.css },
          { name: "snapshot.json", data: JSON.stringify(snap.tree, null, 2) },
          {
            name: "README.txt",
            data: [
              "Exported by Fathom",
              `Source: ${location.href}`,
              `Created: ${new Date().toISOString()}`,
              "",
              "index.html  standalone document (open it directly)",
              "styles.css  generated computed-style rules",
              "snapshot.json  the DOM tree this export was built from",
              "assets/  images referenced by the snapshot",
            ].join("\n"),
          },
        ];

        let total = 0;
        let index = 0;
        for (const asset of assets.slice(0, MAX_ASSETS)) {
          if (total > MAX_ZIP_BYTES) break;
          try {
            const res = await F.call({ operation: "fetch-asset", url: asset.url });
            const bytes = base64ToBytes(res.base64);
            if (bytes.length > MAX_ASSET_BYTES) continue;
            total += bytes.length;
            files.push({ name: `assets/asset-${String(++index).padStart(3, "0")}.${extFor(res.mime)}`, data: bytes });
          } catch {
            /* one unreachable asset should not sink the export */
          }
        }

        const zipBlob = await F.exportLib.zip(files);
        const host = location.hostname.replace(/[^a-z0-9.-]/gi, "") || "page";
        await download(zipBlob, `fathom-${host}.zip`);
        api.toast(`Saved ZIP with ${index} asset${index === 1 ? "" : "s"}`, { tone: "success" });
      } catch (err) {
        api.toast(err.message || "The ZIP could not be saved.", { tone: "error" });
      } finally {
        panel.busy(null);
      }
    };

    panel.setActions([
      { label: "Copy", primary: true, icon: "M8 8h10v12H8zM4 16V4h10", onClick: copy },
      { label: "Download .html", icon: "M12 4v11m0 0l-4-4m4 4l4-4M5 20h14", onClick: saveHtml },
      { label: "Download ZIP", icon: "M6 4h12v16H6zM12 4v6", onClick: saveZip },
    ]);
  }

  function countNodes(tree) {
    if (!tree) return 0;
    let n = 1;
    for (const child of tree.children || []) n += countNodes(child);
    return n;
  }

  F.workspace.register("element", async (api) => {
    const panel = api.panel({
      title: "Pick element",
      subtitle: "Hover the page, then click the element to export",
      size: "compact",
      tool: "element",
    });
    panel.body.replaceChildren(
      h(
        "p",
        { class: "empty" },
        "Move the pointer over the page. The violet outline shows what will be exported.",
      ),
    );

    F.workspace.pick(
      (el) => {
        panel.close();
        if (!el) {
          api.toast("Picking cancelled");
          return;
        }
        showExport(api, el, {
          title: "Element export",
          subtitle: F.util.describe(el),
        });
      },
      { hint: "Click an element to export it", keys: [["Esc", "cancel"]] },
    );
  });

  F.workspace.register("page", async (api) => {
    await showExport(api, document.documentElement, {
      title: "Clone page",
      subtitle: document.title || location.href,
    });
  });
})();
