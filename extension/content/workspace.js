/*
 * Fathom — in-page workspace shell.
 *
 * Creates a `<fathom-workspace>` host pinned at 0×0 with `all: initial`, an open
 * shadow root, and the docked rail + floating panel inside it. Because everything
 * lives in the shadow root, the host page's CSS cannot reach our UI and ours
 * cannot leak into the page. z-index is the maximum the platform allows.
 *
 * Tools do not live here: they register themselves through `Fathom.workspace.register`
 * and are loaded after this file (see SPEC-interfaces.md).
 */
(() => {
  const F = globalThis.Fathom;
  if (!F) return;
  if (F.workspace && F.workspace.mounted) return;

  const CH = F.channel;
  const { h, svg } = F.util;

  const state = {
    host: null,
    root: null,
    rail: null,
    groups: null,
    panel: null,
    picker: null,
    toastStack: null,
    hint: null,
    highlight: null,
    open: false,
    activeTool: null,
    lastTool: null,
    collapsed: false,
  };

  const ws = (F.workspace = {
    mounted: false,
    tools: {},
    ops: {},
    register(id, fn) {
      ws.tools[id] = fn;
    },
  });

  /* ------------------------------------------------------------- mounting --- */

  /**
   * The dock respects saved preferences: disabled tools are hidden, and the
   * order is whatever the options page stored. Unknown ids are ignored so a
   * stale preference can never brick the toolbar.
   */
  async function resolveTools() {
    const fallback = F.tools;
    try {
      const stored = (await chrome.storage.local.get("fathomPrefsV1")).fathomPrefsV1;
      if (!stored) return fallback;
      const enabled = new Set(Array.isArray(stored.enabled) ? stored.enabled : fallback.map((t) => t.id));
      const byId = new Map(F.tools.map((tool) => [tool.id, tool]));
      const ordered = [];
      for (const id of Array.isArray(stored.order) ? stored.order : []) {
        const tool = byId.get(id);
        if (tool && enabled.has(id) && !ordered.includes(tool)) ordered.push(tool);
      }
      for (const tool of F.tools) if (enabled.has(tool.id) && !ordered.includes(tool)) ordered.push(tool);
      return ordered.length ? ordered : fallback;
    } catch {
      return fallback;
    }
  }

  /* --------------------------------------------------------------- layout --- */

  /** Dock placement comes from the dashboard; CSS does the rest. */
  async function applyDockSettings() {
    if (!state.wrap) return;
    let dock = { layout: "bottom", side: "right", minimized: false };
    try {
      if (F.settings) dock = (await F.settings.load()).dock;
    } catch {
      /* settings are advisory; fall back to the default dock */
    }
    state.wrap.dataset.layout = dock.layout;
    state.wrap.dataset.side = dock.side;
    state.wrap.dataset.minimized = String(dock.minimized === true);
  }

  async function setMinimized(minimized) {
    if (F.settings) {
      try {
        await F.settings.save({ dock: { minimized } });
      } catch {
        /* still apply it for this page */
      }
    }
    if (state.wrap) state.wrap.dataset.minimized = String(minimized);
    if (!minimized) state.groups?.querySelector(".tool")?.focus?.();
  }

  function openDashboard(route) {
    F.call({ operation: "open-dashboard", route })
      .then(() => ws.toast("Dashboard opened", { timeout: 1800 }))
      .catch((err) => ws.toast(err.message || "The dashboard could not open", { tone: "error" }));
  }

  ws.openDashboard = openDashboard;

  /**
   * Single-flight mount. Both the toolbar toggle and the navigation restore can
   * call this within the same tick, and mount() awaits a stylesheet fetch — so
   * without this guard two docks get built.
   */
  ws.mount = async function mount() {
    if (state.host) return;
    if (state.mounting) return state.mounting;
    state.mounting = doMount().finally(() => {
      state.mounting = null;
    });
    return state.mounting;
  };

  async function doMount() {
    if (state.host) return;

    /* Drop stray hosts left by an interrupted earlier mount. */
    for (const stray of document.querySelectorAll("fathom-workspace")) stray.remove();

    const host = document.createElement("fathom-workspace");
    host.setAttribute("data-fathom-helper", "");
    Object.assign(host.style, {
      all: "initial",
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      zIndex: "2147483647",
      display: "block",
    });
    const root = host.attachShadow({ mode: "open" });

    try {
      const css = await fetch(chrome.runtime.getURL("ui/workspace.css")).then((r) => r.text());
      const style = document.createElement("style");
      style.textContent = css;
      root.append(style);
    } catch {
      /* Without the stylesheet the dock is unusable; fail loudly instead. */
      throw new Error("Fathom could not load its stylesheet.");
    }

    const wrap = h("div", { class: "workspace", "data-collapsed": "false" });

    const groups = h("div", {
      class: "tool-groups",
      role: "toolbar",
      "aria-label": "Website tools",
      "aria-orientation": "horizontal",
    });

    for (const tool of await resolveTools()) {
      const btn = h(
        "button",
        {
          class: "tool",
          type: "button",
          "data-tool": tool.id,
          "aria-label": tool.label,
          "aria-pressed": "false",
          onclick: () => ws.toggleTool(tool.id),
        },
        svg(tool.icon),
        h("span", { class: "tool-caption", "aria-hidden": "true", text: tool.caption }),
        h("span", { role: "tooltip", text: tool.label }),
      );
      groups.append(btn);
    }

    const rail = h(
      "div",
      { class: "rail", role: "region", "aria-label": "Fathom tools" },
      h(
        "button",
        {
          class: "rail-handle",
          type: "button",
          "aria-label": "Expand the Fathom tools",
          title: "Expand Fathom",
          onclick: () => setMinimized(false),
        },
        svg("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"),
      ),
      h("span", { class: "rail-title" }, svg("M6 3l12 7-5.2 1.6L10.4 17z"), "Fathom"),
      groups,
      h(
        "div",
        { class: "rail-footer" },
        h(
          "button",
          {
            class: "icon-button",
            type: "button",
            "aria-label": "Fathom dashboard",
            title: "Dashboard",
            onclick: () => openDashboard(),
          },
          svg("M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8M12 2.5v2.4M12 19.1v2.4M21.5 12h-2.4M4.9 12H2.5M18.7 5.3l-1.7 1.7M7 17l-1.7 1.7M18.7 18.7L17 17M7 7L5.3 5.3"),
        ),
        h(
          "button",
          {
            class: "icon-button",
            type: "button",
            "aria-label": "Minimize Fathom",
            title: "Minimize",
            onclick: () => setMinimized(true),
          },
          svg("M5 12h14"),
        ),
        h(
          "button",
          {
            class: "icon-button",
            type: "button",
            "aria-label": "Close Fathom",
            title: "Close (Esc)",
            onclick: () => ws.close(),
          },
          svg("M6 6l12 12M18 6L6 18"),
        ),
      ),
    );

    const toastStack = h("div", { class: "toast-stack", role: "status", "aria-live": "polite" });

    wrap.append(rail, toastStack);
    root.append(wrap);
    document.documentElement.append(host);

    state.host = host;
    state.root = root;
    state.rail = rail;
    state.groups = groups;
    state.toastStack = toastStack;
    state.wrap = wrap;
    ws.mounted = true;

    await applyDockSettings();
    /* The dashboard may change layout while the dock is open. */
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes["fathomPrefsV1"]) applyDockSettings();
    });

    document.addEventListener("keydown", onKeydown, true);
  }

  /* --------------------------------------------------------------- toasts --- */

  ws.toast = function toast(message, opts = {}) {
    if (!state.toastStack) return;
    const tone = opts.tone || "info";
    const el = h(
      "div",
      { class: "toast", "data-tone": tone },
      h("span", { class: "dot" }),
      h("span", { text: String(message) }),
    );
    state.toastStack.append(el);
    const ttl = opts.timeout ?? (message.length > 60 ? 6500 : 3500);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .2s";
      setTimeout(() => el.remove(), 220);
    }, ttl);
  };

  /* ---------------------------------------------------------------- panel --- */

  ws.panel = function panel(opts = {}) {
    if (state.panel) state.panel.close();

    const head = h("div", { class: "panel-head" });
    const title = h("h2", { text: opts.title || "Fathom" });
    const subtitle = h("p", { class: "subtitle", text: opts.subtitle || "" });
    if (!opts.subtitle) subtitle.hidden = true;
    head.append(
      h("div", { class: "grow" }, title, subtitle),
      h(
        "button",
        {
          class: "icon-button",
          type: "button",
          "aria-label": "Close panel",
          title: "Close (Esc)",
          onclick: () => ctl.close(),
        },
        svg("M6 6l12 12M18 6L6 18"),
      ),
    );

    const body = h("div", { class: "panel-body" });
    const foot = h("div", { class: "panel-foot" });

    const root = h(
      "section",
      {
        class: "panel",
        role: "dialog",
        "aria-label": opts.title || "Fathom",
        "data-size": opts.size || "default",
        "data-tool": opts.tool || "",
      },
      head,
      body,
      foot,
    );

    state.wrap.append(root);

    const ctl = {
      root,
      body,
      foot,
      head,
      setSubtitle(text) {
        subtitle.textContent = text || "";
        subtitle.hidden = !text;
      },
      setActions(actions) {
        foot.replaceChildren();
        foot.hidden = !actions || !actions.length;
        for (const action of actions || []) {
          foot.append(
            h(
              "button",
              {
                class: "btn" + (action.primary ? " btn-primary" : ""),
                type: "button",
                onclick: action.onClick,
              },
              action.icon ? svg(action.icon) : null,
              action.label,
            ),
          );
        }
      },
      busy(text, opts2 = {}) {
        if (!text) {
          body.querySelector("[data-busy]")?.remove();
          return;
        }
        const overlay = h(
          "div",
          {
            "data-busy": "",
            class: "row",
            style: {
              gap: "10px",
              padding: "14px",
              marginBottom: "10px",
              background: "#141217",
              border: "1px solid #ffffff38",
              borderRadius: "9px",
              color: "#bbb6c3",
            },
          },
          h("span", { class: "spinner" }),
          h("span", { text }),
        );
        body.querySelector("[data-busy]")?.remove();
        body.prepend(overlay);
        if (opts2.cancel) {
          const btn = h("button", { class: "btn btn-sm", type: "button", text: "Cancel" });
          btn.addEventListener("click", opts2.cancel);
          overlay.append(btn);
        }
      },
      close() {
        ws.cancelPick();
        root.remove();
        if (state.panel === ctl) state.panel = null;
        state.activeTool = null;
        markPressed(null);
        if (opts.onClose) opts.onClose();
      },
    };

    state.panel = ctl;

    ctl.setActions(opts.actions || []);
    opts.onReady?.(ctl);

    /* Click outside does not close: the panel is a workspace, not a popover.
       Escape and the X are the documented exits. */
    return ctl;
  };

  function markPressed(id) {
    if (!state.groups) return;
    for (const btn of state.groups.querySelectorAll(".tool")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.tool === id));
    }
  }

  /* ------------------------------------------------------------ open/close --- */

  ws.open = async function open(toolId, opts = {}) {
    await ws.mount();
    state.open = true;
    state.collapsed = !!opts.collapsed;
    state.wrap.dataset.collapsed = String(state.collapsed);
    /* Opening the dock does not auto-run a tool: the user picks one. */
    if (toolId) await ws.runTool(toolId);
    persistOpen(true, state.collapsed);
  };

  ws.runTool = async function runTool(id) {
    const meta = F.tools.find((t) => t.id === id);
    const fn = ws.tools[id];
    if (!meta || !fn) {
      ws.toast("That tool is not part of this build.", { tone: "error" });
      return;
    }
    ws.cancelPick();
    state.activeTool = id;
    state.lastTool = id;
    markPressed(id);
    try {
      await fn(api);
    } catch (err) {
      console.error("[Fathom]", err);
      ws.toast(err?.message || "That tool failed to open.", { tone: "error" });
    }
  };

  ws.toggleTool = function toggleTool(id) {
    /* Clicking the active tool closes its panel but keeps the dock. */
    if (state.panel && state.activeTool === id) {
      state.panel.close();
      return;
    }
    state.open = true;
    ws.runTool(id);
    persistOpen(true, false);
  };

  ws.close = function close() {
    ws.cancelPick();
    state.panel?.close();
    if (state.host) state.host.remove();
    document.removeEventListener("keydown", onKeydown, true);
    state.host = null;
    state.root = null;
    state.rail = null;
    state.groups = null;
    state.toastStack = null;
    state.wrap = null;
    state.open = false;
    state.activeTool = null;
    ws.mounted = false;
    persistOpen(false);
  };

  ws.toggle = async function toggle() {
    if (state.open) ws.close();
    else await ws.open();
    return state.open;
  };

  function persistOpen(open, collapsed) {
    try {
      chrome.runtime.sendMessage({
        channel: CH,
        operation: "workspace-state",
        open,
        collapsed: !!collapsed,
      });
    } catch {
      /* worker asleep or page unloading — state is best effort */
    }
  }

  /* --------------------------------------------------------------- picker --- */

  /**
   * Hover-to-highlight, click-to-select. Resolves with the element or null when
   * cancelled. Pointer events are captured so the page cannot hijack the click.
   */
  ws.pick = function pick(onPick, opts = {}) {
    const host = state.host;
    if (!host) throw new Error("Fathom is not mounted.");

    const highlight = h("div", { class: "highlight" }, h("span"));
    const label = highlight.firstChild;
    state.root.append(highlight);
    showHint(
      opts.hint || "Click an element",
      opts.keys || [["Esc", "cancel"]],
    );

    let current = null;

    const isOurs = (el) => !!el && (el === host || host.contains(el) || !!el.closest?.("fathom-workspace"));

    const onMove = (event) => {
      const target = event.target;
      if (isOurs(target) || !(target instanceof Element)) return;
      if (target === current) return;
      current = target;
      const r = target.getBoundingClientRect();
      Object.assign(highlight.style, {
        top: `${r.top}px`,
        left: `${r.left}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      label.textContent = `${F.util.describe(target)}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
    };

    const swallow = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const finish = (result, silent = false) => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      highlight.remove();
      clearHint();
      if (state.picker === picker) state.picker = null;
      if (!silent) onPick(result);
    };

    /* Do NOT cancel the press here: preventDefault() on pointerdown suppresses
       the compatibility `click` event, and the click is where we commit the
       selection. The click handler below swallows the page's reaction instead. */
    const onDown = (event) => {
      if (isOurs(event.target)) return;
      if (event.target instanceof Element) current = event.target;
    };

    const onClick = (event) => {
      if (isOurs(event.target)) return;
      swallow(event);
      finish(current || event.target);
    };

    const onKey = (event) => {
      if (event.key === "Escape") {
        swallow(event);
        finish(null);
      }
    };

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);

    const picker = { cancel: (silent = false) => finish(null, silent) };
    state.picker = picker;
    return picker;
  };

  /** Drop an in-flight picker without firing its callback. */
  ws.cancelPick = function cancelPick() {
    const picker = state.picker;
    state.picker = null;
    if (picker) picker.cancel(true);
  };

  /* ---------------------------------------------------------------- hints --- */

  ws.showHint = showHint;
  ws.clearHint = clearHint;

  function showHint(text, keys = []) {
    clearHint();
    const hint = h("div", { class: "hint-card" }, text);
    for (const [key, what] of keys) {
      hint.append(h("kbd", { text: key }), h("span", { text: what }));
    }
    state.root.append(hint);
    state.hint = hint;
  }

  function clearHint() {
    state.hint?.remove();
    state.hint = null;
  }

  /* ------------------------------------------------------------- keyboard --- */

  function onKeydown(event) {
    if (event.key !== "Escape") return;
    if (state.panel) {
      event.preventDefault();
      event.stopPropagation();
      state.panel.close();
    } else if (state.open) {
      ws.close();
    }
  }

  /* --------------------------------------------------------------- bridge --- */

  const api = {
    panel: ws.panel,
    toast: ws.toast,
    pick: ws.pick,
    showHint,
    clearHint,
    close: () => ws.close(),
    runTool: (id) => ws.runTool(id),
    get activeTool() {
      return state.activeTool;
    },
  };

  ws.api = api;

  /** Read-only snapshot of the shell state, for diagnostics and tests. */
  ws.inspect = () => ({
    mounted: ws.mounted,
    open: state.open,
    activeTool: state.activeTool,
    panel: !!state.panel,
    picker: !!state.picker,
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.channel !== CH) return;
    const op = msg.operation;

    if (op === "ping") {
      sendResponse({ ok: true, version: F.version, open: state.open });
      return;
    }

    if (op === "toggle") {
      ws.toggle().then(
        () => sendResponse({ ok: true, open: state.open }),
        (err) => sendResponse({ ok: false, error: err.message }),
      );
      return true;
    }

    if (op === "restore-workspace") {
      /* Restore the dock, not a tool: re-opening a picker on page load would
         arm the overlay before the user asked for anything. */
      ws.open(msg.tool || null, { collapsed: msg.collapsed === true }).then(
        () => sendResponse({ ok: true, open: true }),
        (err) => sendResponse({ ok: false, error: err.message }),
      );
      return true;
    }

    const handler = ws.ops[op];
    if (!handler) return;
    Promise.resolve(handler(msg, sender)).then(
      (result) => sendResponse({ ok: true, ...(result || {}) }),
      (err) => sendResponse({ ok: false, error: err.message || String(err) }),
    );
    return true;
  });
})();
