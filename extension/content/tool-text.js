/*
 * Tool: Edit text.
 *
 * Page mode — no panel. Every element that directly owns a non-empty text node
 * becomes a `contenteditable="plaintext-only"` host, so typing edits the live
 * DOM in place. Edits are grouped per element (a 400 ms input debounce) and the
 * last one can be undone with Ctrl/⌘+Z. Escape ends the mode: the injected
 * helper stylesheet, the dashed affordance and the original `contenteditable`
 * values are restored, while the typed text itself is kept.
 *
 * The shell only tracks panels, so this file also wraps `runTool` (shared
 * through `ws.__fathomModeBus` with tool-arrange.js) to take the mode down
 * before another tool starts, plus `pagehide` for navigation.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  const MARKER = "data-fathom-text";
  const CLASS = "text-editable";
  const STYLE_ID = "text";
  const EDITOR_ATTR = "contenteditable";
  const EDITOR_VALUE = "plaintext-only";
  const DEBOUNCE_MS = 400;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const DONE_TOAST = "Text edits kept — reload the page to discard them.";

  /* Elements that must never become editing hosts: form/embedded controls,
     verbatim blocks, and the structural roots. <body> is excluded because
     making it plain-text editable would collapse the document into one field. */
  const SKIP_TAGS = new Set([
    "HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "NOSCRIPT",
    "TEXTAREA", "INPUT", "SELECT", "OPTION", "CODE", "PRE",
  ]);

  /** One live mode at a time; clicking the active tool again ends it. */
  let session = null;

  /**
   * The shell never tells a panel-less tool that another tool is starting, so
   * both page modes share one wrapper around `runTool`. It runs their cleanup
   * before the incoming tool's callback and is removed again as soon as the
   * last mode stops, leaving the shell exactly as it was.
   */
  function onToolSwitch(mine, stop) {
    const ws = F.workspace;
    let bus = ws.__fathomModeBus;
    if (!bus) {
      bus = ws.__fathomModeBus = new Set();
      const original = ws.runTool;
      ws.__fathomModeOriginalRun = original;
      ws.runTool = function runTool(id) {
        for (const cleanup of [...bus]) {
          try {
            cleanup(id);
          } catch (err) {
            console.error("[Fathom]", err);
          }
        }
        return original.call(ws, id);
      };
    }
    const entry = (id) => {
      if (id !== mine) stop();
    };
    bus.add(entry);
    return () => {
      bus.delete(entry);
      if (bus.size === 0) {
        ws.runTool = ws.__fathomModeOriginalRun;
        delete ws.__fathomModeBus;
        delete ws.__fathomModeOriginalRun;
      }
    };
  }

  F.workspace.register("text", async (api) => {
    /* `toggleTool` calls runTool again for panel-less tools: treat that as off. */
    if (session) {
      session.stop();
      return;
    }

    const teardown = [];
    const edits = [];
    const pending = new Map();
    let done = false;
    let stopSwitch = () => {};

    /** Every listener we add is paired with its removal in the same pass. */
    const on = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      teardown.push(() => target.removeEventListener(type, handler, options));
    };

    /* The shadow stylesheet cannot reach page elements, so the affordance needs
       one small style element in the page. Clear a stale copy first. */
    document.querySelector(`style[data-fathom-helper="${STYLE_ID}"]`)?.remove();
    const style = document.createElement("style");
    style.setAttribute("data-fathom-helper", STYLE_ID);
    style.textContent = `.${CLASS}{outline:1px dashed #bd91ff;outline-offset:2px}`;
    (document.head || document.documentElement).append(style);
    teardown.push(() => style.remove());

    function restore(el, before, hadClass, hadMarker) {
      if (before === null) el.removeAttribute(EDITOR_ATTR);
      else el.setAttribute(EDITOR_ATTR, before);
      if (!hadClass) el.classList.remove(CLASS);
      if (hadMarker) el.setAttribute(MARKER, "");
      else el.removeAttribute(MARKER);
    }

    function mark(el) {
      const before = el.getAttribute(EDITOR_ATTR);
      const hadClass = el.classList.contains(CLASS);
      const hadMarker = el.hasAttribute(MARKER);
      el.setAttribute(MARKER, "");
      el.setAttribute(EDITOR_ATTR, EDITOR_VALUE);
      if (!hadClass) el.classList.add(CLASS);
      teardown.push(() => restore(el, before, hadClass, hadMarker));
    }

    /** An element is eligible when its own (direct) child list holds real text. */
    function ownsText(el) {
      if (el.namespaceURI !== HTML_NS) return false;
      if (SKIP_TAGS.has(el.tagName)) return false;
      if (el.closest("fathom-workspace") || el.closest("[data-fathom-helper]")) return false;
      if (el.isContentEditable || el.closest(`[${EDITOR_ATTR}]`)) return false;
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return true;
      }
      return false;
    }

    function walk() {
      if (!document.body) return;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      const candidates = [];
      while (walker.nextNode()) {
        if (ownsText(walker.currentNode)) candidates.push(walker.currentNode);
      }
      for (const el of candidates) {
        /* An outer host already covers its descendants; nested editing hosts
           would fight over the caret, so only mark the outermost candidate. */
        if (!el.closest(`[${MARKER}]`)) mark(el);
      }
    }

    /* ------------------------------------------------------- edit history --- */

    function commit(el) {
      const entry = pending.get(el);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(el);
      const after = el.innerHTML;
      if (after !== entry.before) edits.push({ el, before: entry.before, after });
    }

    const onInput = (event) => {
      if (!(event.target instanceof Element)) return;
      /* The editing host is the element we marked, even if the event was
         retargeted to a nested node. */
      const el = event.target.closest(`[${MARKER}]`);
      if (!el) return;
      let entry = pending.get(el);
      if (!entry) {
        entry = { before: el.innerHTML, timer: 0 };
        pending.set(el, entry);
      }
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => commit(el), DEBOUNCE_MS);
    };

    function undo() {
      /* Typing that has not hit the debounce yet counts as the newest edit. */
      for (const el of [...pending.keys()]) commit(el);
      const edit = edits.pop();
      if (!edit) return false;
      if (edit.el.isConnected) edit.el.innerHTML = edit.before;
      return true;
    }

    /* ------------------------------------------------------------ keyboard --- */

    const onKeydown = (event) => {
      /* Another tool owns the page now (or the dock is gone): stay out of it. */
      if (api.activeTool !== "text") return;

      if (event.key === "Escape") {
        event.preventDefault();
        /* Window capture runs before the shell's document listener; stopping
           the event here is what keeps the dock from closing as well. */
        event.stopPropagation();
        finish(true);
        return;
      }

      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== "z") return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
      if (!undo()) return;
      event.preventDefault();
      event.stopPropagation();
    };

    /* -------------------------------------------------------------- finish --- */

    function finish(notify) {
      if (done) return;
      done = true;
      if (session && session.stop === stopThis) session = null;

      /* One pass: style, attribute restores and listeners all come back out. */
      while (teardown.length) {
        const step = teardown.pop();
        try {
          step();
        } catch (err) {
          console.error("[Fathom]", err);
        }
      }
      stopSwitch();
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      edits.length = 0;
      try {
        api.clearHint();
      } catch {
        /* the dock may already be gone */
      }
      if (notify) api.toast(DONE_TOAST);
    }

    const stopThis = () => finish(true);

    walk();

    on(window, "keydown", onKeydown, true);
    on(document, "input", onInput, true);
    on(window, "pagehide", () => finish(false));

    /* Closing the dock through its X (or the toolbar icon) leaves no event we
       could listen for; watch the host instead and end the mode with it. */
    const host = document.querySelector("fathom-workspace");
    if (host) {
      const observer = new MutationObserver(() => {
        if (!host.isConnected) finish(false);
      });
      observer.observe(document.documentElement, { childList: true });
      teardown.push(() => observer.disconnect());
    }

    stopSwitch = onToolSwitch("text", () => finish(false));
    session = { stop: stopThis };

    api.showHint("Click text to edit", [["Esc", "finish"], ["⌘/Ctrl+Z", "undo"]]);
  });
})();
