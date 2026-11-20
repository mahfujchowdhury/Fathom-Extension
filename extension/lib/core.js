/*
 * Fathom — shared core for the injected workspace bundle.
 *
 * Every file in the injected bundle is a classic script (chrome.scripting.executeScript
 * with `files`), so modules share state through one global namespace instead of imports.
 * Order matters: core → inspect → export → designmd → workspace.
 */
(() => {
  const F = (globalThis.Fathom = globalThis.Fathom || {});

  F.version = "0.1.0";
  F.channel = "fathom/v1";

  /* ---------------------------------------------------------------- tools ---
   * The dock is data-driven. Order is the original product's canonical order
   * (lib/preferences.js), so saved preferences survive.
   * `size` selects the panel geometry: "default" | "wide" | "compact" | "auto",
   * or "" for tools that work directly on the page and open no panel.
   */
  F.tools = [
    {
      id: "element",
      caption: "Pick",
      label: "Pick element",
      size: "wide",
      icon: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M9 9l8 3-4 1-1 4z",
    },
    {
      id: "page",
      caption: "Clone page",
      label: "Clone page",
      size: "wide",
      icon: "M8 8h12v12H8zM4 16V4h12",
    },
    {
      id: "brief",
      caption: "Prompt",
      label: "Design prompt",
      size: "compact",
      icon: "M6 19L18 7l3 3L9 22zM5 3v6M2 6h6M16 2v4M14 4h4",
    },
    {
      id: "designmd",
      caption: "Design MD",
      label: "Design MD",
      size: "default",
      icon: "M5 3h9l5 5v13H5zM14 3v6h5M7 17v-5l2 2 2-2v5M14 12v5m-2-2 2 2 2-2",
    },
    {
      id: "images",
      caption: "Assets",
      label: "Extract assets",
      size: "wide",
      icon: "M3 4h18v16H3zM3 16l5-5 5 5 3-3 5 5M9 8h.01",
    },
    {
      id: "palette",
      caption: "Colors",
      label: "Extract colors",
      size: "default",
      icon: "M12 3C9 7 5 11 5 15a7 7 0 0 0 14 0c0-4-4-8-7-12zM5 15h14",
    },
    {
      id: "type",
      caption: "Fonts",
      label: "Detect fonts",
      size: "default",
      icon: "M3 5h12M9 5v14M5 19h8M15 10h7M18.5 10v9",
    },
    {
      id: "inspect",
      caption: "Measure",
      label: "Inspect & measure",
      size: "default",
      icon: "M4 4h16v16H4zM8 4v5M12 4v3M16 4v5M4 12h4M4 16h6",
    },
    {
      id: "text",
      caption: "Edit text",
      label: "Edit text",
      size: "",
      icon: "M4 5h16M12 5v15M8 20h8",
    },
    {
      id: "capture",
      caption: "Capture",
      label: "Screenshot",
      size: "auto",
      icon: "M8 6l2-2h4l2 2h4v14H4V6zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    },
    {
      id: "responsive",
      caption: "Responsive",
      label: "Responsive viewer",
      size: "compact",
      icon: "M3 4h15v12H3zM8 20h5M10 16v4M16 10h5v11h-5z",
    },
    {
      id: "fonts",
      caption: "Swap font",
      label: "Swap fonts",
      size: "default",
      icon: "M3 7h17l-4-4M21 17H4l4 4M20 7v4M4 17v-4",
    },
    {
      id: "arrange",
      caption: "Arrange",
      label: "Move & delete",
      size: "",
      icon: "M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4",
    },
  ];

  /* -------------------------------------------------------------- helpers --- */
  const util = (F.util = {});

  /** Terse DOM factory: h("div", {class:"x", onclick:fn}, child, "text"). */
  util.h = function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k === "text") node.textContent = v;
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, String(v));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  util.svg = function svg(path, size) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.setAttribute("viewBox", "0 0 24 24");
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "currentColor");
    el.setAttribute("stroke-width", "1.6");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("aria-hidden", "true");
    if (size) {
      el.setAttribute("width", size);
      el.setAttribute("height", size);
    }
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", path);
    el.append(p);
    return el;
  };

  util.escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /** Human label for an element: div.card#hero[data-x] */
  util.describe = function describe(el) {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : "";
    return tag + id + cls;
  };

  /** Single message hop to the service worker. */
  F.send = (payload) => chrome.runtime.sendMessage({ channel: F.channel, ...payload });

  /** Send and surface the worker's {ok,error} envelope as a rejected promise. */
  F.call = async (payload) => {
    const res = await F.send(payload);
    if (!res) throw new Error("The extension worker did not answer.");
    if (res.ok === false) throw new Error(res.error || "The action failed.");
    return res;
  };

  util.bytes = (n) => {
    if (!Number.isFinite(n)) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };

  util.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  F.ready = true;
})();
