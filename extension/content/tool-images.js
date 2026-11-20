/*
 * Tool: Extract assets.
 *
 * `Fathom.analyze.assets()` lists every image, video and CSS background on the
 * page; this file is the filterable gallery and its two exports — Copy URLs and
 * ZIP n, which fetches binaries through the worker (`fetch-asset`) because a
 * content script cannot read cross-origin bytes itself.
 *
 * Read-only: our UI lives in the workspace shadow root, never in the page.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  const { h, svg } = F.util;

  /* A ZIP is a user-initiated, sequential download; keep the batch small so a
   * huge gallery cannot hold the worker hostage. */
  const MAX_ZIP = 40;

  const ICON = {
    copy: "M8 8h10v12H8zM4 16V4h10",
    download: "M12 4v11m0 0l-4-4m4 4l4-4M5 20h14",
  };

  const MIME_EXT = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg",
    "image/gif": "gif", "image/avif": "avif", "image/x-icon": "ico", "image/bmp": "bmp",
    "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogv", "video/quicktime": "mov",
  };

  /** FileReader is the only bridge from a Blob to the worker's data URL. */
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Could not read the archive."));
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** A readable, filesystem-safe name for a URL. */
  function fileName(asset) {
    const ext = String(asset.format || "bin").toLowerCase();
    try {
      const url = new URL(asset.url, document.baseURI);
      if (url.protocol === "data:") return `inline-asset.${ext}`;
      const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      if (last) return last;
      return `${url.hostname || "asset"}.${ext}`;
    } catch {
      return `asset.${ext}`;
    }
  }

  function safeName(name) {
    const clean = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^\.+/, "");
    return clean.slice(0, 120) || "asset";
  }

  /** "PNG · 800 × 600", or just "SVG" when formatSize repeats the format. */
  function detailLine(asset) {
    const format = String(asset.format || asset.kind || "img").toUpperCase();
    const size = F.analyze.formatSize(asset);
    if (!size || size.toUpperCase() === format) return format;
    return `${format} · ${size}`;
  }

  /** Which size bucket an asset falls in, based on its longest rendered side. */
  function sizeBucket(asset) {
    const side = Math.max(asset.width || 0, asset.height || 0);
    if (!side) return null;
    if (side >= 512) return "large";
    if (side >= 128) return "medium";
    return "small";
  }

  function extFor(asset, mime) {
    const fromMime = MIME_EXT[String(mime || "").toLowerCase()];
    if (fromMime) return fromMime;
    const format = String(asset.format || "").toLowerCase();
    return /^[a-z0-9]{1,5}$/.test(format) ? format : "bin";
  }

  F.workspace.register("images", async (api) => {
    const assets = F.analyze.assets(document);
    const formats = [...new Set(assets.map((a) => String(a.format || "img").toLowerCase()))].sort();

    /* Filter state — one value per toolbar row. */
    let category = "all";
    let format = "all";
    let size = "any";

    /* Selected URLs survive filter changes, so a user can build a batch from
     * several categories. The footer always reports the whole selection. */
    const selected = new Set();
    const cardRefs = new Map();

    const panel = api.panel({
      title: "Extract assets",
      subtitle: `${assets.length} on this page`,
      size: "wide",
      tool: "images",
    });

    /* ------------------------------------------------------------ helpers --- */

    function visibleAssets() {
      return assets.filter((asset) => {
        if (category !== "all" && asset.kind !== category) return false;
        if (format !== "all" && String(asset.format || "img").toLowerCase() !== format) return false;
        if (size !== "any" && sizeBucket(asset) !== size) return false;
        return true;
      });
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

    async function copyUrl(asset) {
      if (await writeClipboard(asset.url)) {
        api.toast(`Copied ${fileName(asset)}`, { tone: "success", timeout: 1600 });
      }
    }

    async function downloadAsset(asset) {
      try {
        const res = await F.call({ operation: "fetch-asset", url: asset.url });
        /* The worker's download bridge only accepts a short MIME list; other
         * media (video, avif, ico…) travels as a binary stream and the filename
         * extension carries the real type. */
        const mime = /^image\/(?:png|jpeg|webp|gif|svg\+xml)$/i.test(res.mime || "")
          ? res.mime
          : "application/octet-stream";
        const dataUrl = `data:${mime};base64,${res.base64}`;
        await F.call({ operation: "download-file", dataUrl, name: safeName(fileName(asset)) });
        api.toast(`Saved ${fileName(asset)}`, { tone: "success" });
      } catch (err) {
        api.toast(err.message || "That asset could not be downloaded.", { tone: "error" });
      }
    }

    /* ----------------------------------------------------------- selection --- */

    function syncSelection() {
      countLabel.textContent = `${selected.size} selected`;
      panel.setActions([
        { label: "Copy URLs", primary: true, icon: ICON.copy, onClick: copyUrls },
        { label: `ZIP ${selected.size}`, icon: ICON.download, onClick: zipSelected },
      ]);
    }

    function paintCard(asset) {
      const entry = cardRefs.get(asset.url);
      if (!entry) return;
      const on = selected.has(asset.url);
      entry.card.dataset.selected = String(on);
      entry.check.checked = on;
    }

    function setSelected(asset, on) {
      if (on) selected.add(asset.url);
      else selected.delete(asset.url);
      paintCard(asset);
      syncSelection();
    }

    function selectAllVisible() {
      for (const asset of visibleAssets()) {
        selected.add(asset.url);
        paintCard(asset);
      }
      syncSelection();
    }

    function deselectAll() {
      selected.clear();
      for (const asset of assets) paintCard(asset);
      syncSelection();
    }

    /* -------------------------------------------------------------- export --- */

    async function copyUrls() {
      const list = selected.size ? assets.filter((a) => selected.has(a.url)) : visibleAssets();
      if (!list.length) {
        api.toast("No asset URLs to copy.", { tone: "error" });
        return;
      }
      if (await writeClipboard(list.map((a) => a.url).join("\n"))) {
        api.toast(`Copied ${list.length} URL${list.length === 1 ? "" : "s"}`, {
          tone: "success",
          timeout: 1800,
        });
      }
    }

    async function zipSelected() {
      const list = assets.filter((a) => selected.has(a.url)).slice(0, MAX_ZIP);
      if (!list.length) {
        api.toast("Select at least one asset first.", { tone: "error" });
        return;
      }

      panel.busy("Fetching assets…");
      let saved = 0;
      try {
        const files = [];
        for (const asset of list) {
          try {
            const res = await F.call({ operation: "fetch-asset", url: asset.url });
            const bytes = base64ToBytes(res.base64);
            if (!bytes.length) continue;
            saved += 1;
            files.push({
              name: `assets/asset-${String(saved).padStart(3, "0")}.${extFor(asset, res.mime)}`,
              data: bytes,
            });
          } catch {
            /* One unreachable asset must not sink the archive. */
          }
        }

        if (!files.length) throw new Error("None of the selected assets could be fetched.");
        const blob = await F.exportLib.zip(files);
        const dataUrl = await blobToDataUrl(blob);
        const host = location.hostname.replace(/[^a-z0-9.-]/gi, "") || "page";
        await F.call({ operation: "download-file", dataUrl, name: `fathom-assets-${host}.zip` });
        api.toast(`Saved ZIP with ${saved} asset${saved === 1 ? "" : "s"}`, { tone: "success" });
      } catch (err) {
        api.toast(err.message || "The ZIP could not be saved.", { tone: "error" });
      } finally {
        panel.busy(null);
      }
    }

    /* ---------------------------------------------------------------- cards --- */

    function iconButton(label, title, path, onClick) {
      return h(
        "button",
        { class: "icon-button", type: "button", "aria-label": label, title, onclick: onClick },
        svg(path),
      );
    }

    function assetCard(asset) {
      const name = fileName(asset);
      const card = h("div", {
        class: "asset-card",
        dataset: { selected: String(selected.has(asset.url)) },
      });

      const check = h("input", {
        class: "asset-check",
        type: "checkbox",
        "aria-label": `Select ${name}`,
      });
      check.checked = selected.has(asset.url);
      check.addEventListener("change", () => setSelected(asset, check.checked));

      const thumb = h("div", { class: "asset-thumb" });
      const img = h("img", {
        src: asset.url,
        alt: asset.alt || name,
        loading: "lazy",
        decoding: "async",
      });
      img.addEventListener(
        "error",
        () => {
          thumb.classList.add("asset-thumb--empty");
          thumb.replaceChildren(
            h("span", { text: "Preview unavailable — you can still copy its URL" }),
          );
        },
        { once: true },
      );
      thumb.append(img);

      const meta = h(
        "div",
        { class: "asset-meta" },
        h("strong", { text: name, title: asset.url }),
        h("span", { text: detailLine(asset) }),
      );

      const actions = h(
        "div",
        { class: "asset-actions" },
        iconButton(`Copy URL for ${name}`, "Copy URL", ICON.copy, () => copyUrl(asset)),
        iconButton(`Download ${name}`, "Download", ICON.download, () => downloadAsset(asset)),
      );

      card.append(check, thumb, meta, actions);
      cardRefs.set(asset.url, { card, check });
      return card;
    }

    /* ------------------------------------------------------------- filters --- */

    function chip(label, active, onClick) {
      return h("button", {
        class: "chip",
        type: "button",
        "aria-pressed": String(active),
        text: label,
        onclick: onClick,
      });
    }

    function renderFilters() {
      const images = assets.filter((a) => a.kind === "image").length;
      const videos = assets.length - images;

      /* Each chip updates one state slot, then repaints chips + grid. */
      const pick = (apply) => (value) => () => {
        apply(value);
        renderFilters();
        renderGrid();
      };
      const pickCategory = pick((value) => (category = value));
      const pickFormat = pick((value) => (format = value));
      const pickSize = pick((value) => (size = value));

      categoryRow.replaceChildren(
        h("span", { class: "meta", text: "Type" }),
        chip(`All ${assets.length}`, category === "all", pickCategory("all")),
        chip(`Images ${images}`, category === "image", pickCategory("image")),
        chip(`Videos ${videos}`, category === "video", pickCategory("video")),
      );

      formatRow.replaceChildren(
        h("span", { class: "meta", text: "Format" }),
        chip("All", format === "all", pickFormat("all")),
        ...formats.map((value) => chip(value, format === value, pickFormat(value))),
      );

      sizeRow.replaceChildren(
        h("span", { class: "meta", text: "Size" }),
        chip("Any size", size === "any", pickSize("any")),
        chip("Large ≥512", size === "large", pickSize("large")),
        chip("Medium 128–511", size === "medium", pickSize("medium")),
        chip("Small <128", size === "small", pickSize("small")),
      );
    }

    function renderGrid() {
      const visible = visibleAssets();
      cardRefs.clear();
      if (!visible.length) {
        grid.replaceChildren();
        results.replaceChildren(
          h("p", {
            class: "empty",
            text: assets.length
              ? "No assets match these filters."
              : "No images or videos found on this page.",
          }),
        );
        syncSelection();
        return;
      }
      grid.replaceChildren(...visible.map(assetCard));
      results.replaceChildren(grid);
      syncSelection();
    }

    /* --------------------------------------------------------------- shell --- */

    const categoryRow = h("div", {
      class: "toolbar-row", role: "group", "aria-label": "Asset type",
    });
    const formatRow = h("div", {
      class: "toolbar-row", role: "group", "aria-label": "Asset format",
    });
    const sizeRow = h("div", {
      class: "toolbar-row", role: "group", "aria-label": "Asset size",
    });

    const countLabel = h("span", { class: "meta", text: "0 selected" });
    const selectAllBtn = h("button", {
      class: "btn btn-sm", type: "button", text: "Select all", onclick: selectAllVisible,
    });
    const deselectBtn = h("button", {
      class: "btn btn-sm", type: "button", text: "Deselect all", onclick: deselectAll,
    });

    const selectionRow = h(
      "div",
      { class: "row", style: { margin: "2px 0 8px" } },
      selectAllBtn,
      deselectBtn,
      h("span", { class: "grow" }),
      countLabel,
    );

    const grid = h("div", { class: "asset-grid" });
    const results = h("div");

    panel.body.replaceChildren(categoryRow, formatRow, sizeRow, selectionRow, results);
    renderFilters();
    renderGrid();
  });
})();
