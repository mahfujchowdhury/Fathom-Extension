/*
 * Tool: Arrange (move & delete).
 *
 * Page mode — no panel. A press on any page element starts a drag: the element
 * follows the pointer with an inline `transform: translate(dx, dy)` and a thin
 * violet dashed outline. Releasing after more than 4 px keeps the translation;
 * releasing without moving treats the press as a click and deletes the element.
 * Every move and deletion is reversible with Ctrl/⌘+Z, and Escape ends the mode
 * while leaving the page edits in place.
 *
 * The shell only tracks panels, so this file also wraps `runTool` (shared
 * through `ws.__fathomModeBus` with tool-text.js) to take the mode down before
 * another tool starts, plus `pagehide` for navigation.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  const MARKER = "data-fathom-arranging";
  const STYLE_ID = "arrange";
  const MOVE_THRESHOLD = 4;
  const TOAST = "Click to delete · drag to move · Ctrl/⌘+Z to undo · Esc to stop";

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

  F.workspace.register("arrange", async (api) => {
    /* `toggleTool` calls runTool again for panel-less tools: treat that as off. */
    if (session) {
      session.stop();
      return;
    }

    const teardown = [];
    const edits = [];
    const host = document.querySelector("fathom-workspace");
    let drag = null;
    let done = false;
    let stopSwitch = () => {};

    /** Every listener we add is paired with its removal in the same pass. */
    const on = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      teardown.push(() => target.removeEventListener(type, handler, options));
    };

    /* The shadow stylesheet cannot reach page elements, so the drag affordance
       needs one small style element in the page. Clear a stale copy first. */
    document.querySelector(`style[data-fathom-helper="${STYLE_ID}"]`)?.remove();
    const style = document.createElement("style");
    style.setAttribute("data-fathom-helper", STYLE_ID);
    style.textContent = [
      `[${MARKER}]{outline:1px dashed #bd91ff!important;outline-offset:2px;}`,
      `[${MARKER}],[${MARKER}] *{cursor:grabbing!important;}`,
    ].join("");
    (document.head || document.documentElement).append(style);
    teardown.push(() => style.remove());

    /* ----------------------------------------------------------- guards --- */

    const isOurs = (node) =>
      !!node &&
      (node === host ||
        (node instanceof Element && !!node.closest("fathom-workspace, [data-fathom-helper]")));

    /** Never remove the roots or the subtree that carries our own dock. */
    const protects = (el) =>
      el === document.documentElement ||
      el === document.body ||
      (!!host && (el === host || el.contains(host)));

    function dragTarget(event) {
      const el = event.target;
      if (!(el instanceof Element)) return null;
      if (event.button !== 0) return null;
      if (isOurs(el) || protects(el)) return null;
      /* A live selection means the user is selecting, not dragging. */
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && String(selection).trim()) return null;
      return el;
    }

    function setTransform(el, value) {
      if (value) el.style.transform = value;
      else el.style.removeProperty("transform");
    }

    /* -------------------------------------------------------------- drag --- */

    const onPointerDown = (event) => {
      const el = dragTarget(event);
      if (!el) return;
      /* Capture the press so the page's own drag or link handlers never see it. */
      event.preventDefault();
      event.stopPropagation();
      drag = {
        el,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        wasMarked: el.hasAttribute(MARKER),
        transform: el.style.transform,
        dx: 0,
        dy: 0,
      };
      el.setAttribute(MARKER, "");
    };

    const onPointerMove = (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.dx = dx;
      drag.dy = dy;
      if (Math.hypot(dx, dy) > MOVE_THRESHOLD) drag.moved = true;
      drag.el.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    /** Drop an in-flight drag without recording an edit. */
    function cancelDrag() {
      if (!drag) return;
      const active = drag;
      drag = null;
      setTransform(active.el, active.transform);
      if (!active.wasMarked) active.el.removeAttribute(MARKER);
    }

    function commitDelete(el) {
      if (protects(el)) return;
      const parent = el.parentNode;
      if (!parent) return;
      const next = el.nextSibling;
      el.remove();
      edits.push({ kind: "delete", el, parent, next });
    }

    const onPointerUp = (event) => {
      if (!drag) return;
      event.preventDefault();
      event.stopPropagation();

      const active = drag;
      drag = null;

      if (active.moved) {
        /* The translation is already live; keep it as the edit. */
        active.el.style.transform = `translate(${active.dx}px, ${active.dy}px)`;
        if (!active.wasMarked) active.el.removeAttribute(MARKER);
        edits.push({ kind: "move", el: active.el, before: active.transform });
        return;
      }

      /* No travel: this was a click, so drop the drag cosmetics and delete. */
      setTransform(active.el, active.transform);
      if (!active.wasMarked) active.el.removeAttribute(MARKER);
      commitDelete(active.el);
    };

    const onPointerCancel = () => cancelDrag();

    /* While the mode is on, page clicks are deletions, never navigation. */
    const onClick = (event) => {
      if (isOurs(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    /* Native image/link drags would race the pointer drag. */
    const onDragStart = (event) => {
      if (isOurs(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    /* ------------------------------------------------------------ undo --- */

    function undo() {
      const edit = edits.pop();
      if (!edit) return false;
      if (edit.kind === "move") {
        if (edit.el.isConnected) setTransform(edit.el, edit.before);
        return true;
      }
      if (!edit.parent || !edit.parent.isConnected) return false;
      const next = edit.next && edit.next.parentNode === edit.parent ? edit.next : null;
      edit.parent.insertBefore(edit.el, next);
      return true;
    }

    /* ---------------------------------------------------------- keyboard --- */

    const onKeydown = (event) => {
      /* Another tool owns the page now (or the dock is gone): stay out of it. */
      if (api.activeTool !== "arrange") return;

      if (event.key === "Escape") {
        event.preventDefault();
        /* Window capture runs before the shell's document listener; stopping
           the event here is what keeps the dock from closing as well. */
        event.stopPropagation();
        finish(false);
        return;
      }

      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== "z") return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
      if (!undo()) return;
      event.preventDefault();
      event.stopPropagation();
    };

    /* ------------------------------------------------------------ finish --- */

    function finish(notify) {
      if (done) return;
      done = true;
      cancelDrag();
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
      /* Edits stay on the page; only the undo history dies with the mode. */
      edits.length = 0;
      try {
        api.clearHint();
      } catch {
        /* the dock may already be gone */
      }
      if (notify) api.toast(TOAST);
    }

    const stopThis = () => finish(false);

    on(window, "pointerdown", onPointerDown, true);
    on(window, "pointermove", onPointerMove, true);
    on(window, "pointerup", onPointerUp, true);
    on(window, "pointercancel", onPointerCancel, true);
    on(window, "keydown", onKeydown, true);
    on(window, "click", onClick, true);
    on(window, "dragstart", onDragStart, true);
    on(window, "pagehide", () => finish(false));

    /* Closing the dock through its X (or the toolbar icon) leaves no event we
       could listen for; watch the host instead and end the mode with it. */
    if (host) {
      const observer = new MutationObserver(() => {
        if (!host.isConnected) finish(false);
      });
      observer.observe(document.documentElement, { childList: true });
      teardown.push(() => observer.disconnect());
    }

    stopSwitch = onToolSwitch("arrange", () => finish(false));
    session = { stop: stopThis };

    api.showHint("Click to delete · drag to move", [["⌘/Ctrl+Z", "undo"], ["Esc", "stop"]]);
    api.toast(TOAST);
  });
})();
