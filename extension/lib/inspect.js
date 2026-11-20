/*
 * Fathom — inspection primitives.
 *
 * Everything here reads *computed* styles only: what the browser actually
 * resolved, not what the stylesheet asked for. That keeps the numbers honest
 * across inheritance, cascade layers and CSS variables.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F) return;

  const inspect = (F.inspect = {});

  /* The editable property groups shown in the Measure panel. Order is the
     order a designer reads them: box → layout → type → paint → motion. */
  inspect.GROUPS = [
    {
      name: "Size & box",
      props: [
        "display",
        "box-sizing",
        "width",
        "height",
        "min-width",
        "max-width",
        "margin",
        "padding",
        "overflow",
      ],
    },
    {
      name: "Position",
      props: ["position", "top", "right", "bottom", "left", "z-index"],
    },
    {
      name: "Flex & grid",
      props: [
        "flex-direction",
        "flex-wrap",
        "justify-content",
        "align-items",
        "gap",
        "grid-template-columns",
        "grid-template-rows",
      ],
    },
    {
      name: "Typography",
      props: [
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
        "letter-spacing",
        "text-align",
        "text-transform",
        "color",
      ],
    },
    {
      name: "Paint",
      props: [
        "background-color",
        "background-image",
        "border",
        "border-radius",
        "box-shadow",
        "opacity",
      ],
    },
    {
      name: "Motion",
      props: ["transition", "transform"],
    },
  ];

  const EDITABLE = new Set(inspect.GROUPS.flatMap((g) => g.props));

  inspect.computed = function computed(el) {
    if (!el || el.nodeType !== 1) return {};
    const cs = getComputedStyle(el);
    const out = {};
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i];
      if (!EDITABLE.has(prop)) continue;
      out[prop] = cs.getPropertyValue(prop);
    }
    return out;
  };

  inspect.styleMap = function styleMap(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const prop of EDITABLE) out[prop] = cs.getPropertyValue(prop);
    return out;
  };

  /** Same data, but split into the panel's groups. */
  inspect.groups = function groups(el) {
    const cs = getComputedStyle(el);
    return inspect.GROUPS.map((group) => ({
      name: group.name,
      rows: group.props.map((prop) => ({ prop, value: cs.getPropertyValue(prop) })),
    }));
  };

  inspect.box = function box(el) {
    const r = el.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      top: r.top,
      left: r.left,
      right: r.right,
      bottom: r.bottom,
    };
  };

  /** Write an inline override, which always beats the page's own rules. */
  inspect.apply = function apply(el, prop, value) {
    if (!el || el.nodeType !== 1) return false;
    const clean = String(value).trim();
    if (!clean) {
      el.style.removeProperty(prop);
      return true;
    }
    if (!CSS.supports(prop, clean)) return false;
    el.style.setProperty(prop, clean, "important");
    return true;
  };

  /** A stable, valid selector for the element, used in generated CSS. */
  inspect.selector = function selector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const classes = [...el.classList].filter((c) => c && !/^\d/.test(c)).slice(0, 2);
    if (classes.length) return `.${classes.map((c) => CSS.escape(c)).join(".")}`;
    const parent = el.parentElement;
    if (!parent) return tag;
    const index = [...parent.children].indexOf(el) + 1;
    return `${parent.tagName.toLowerCase()} > ${tag}:nth-child(${index})`;
  };

  inspect.cssBlock = function cssBlock(el, props) {
    const cs = getComputedStyle(el);
    const list = props || [...EDITABLE];
    const body = list
      .filter((prop) => {
        const v = cs.getPropertyValue(prop);
        return v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px";
      })
      .map((prop) => `  ${prop}: ${cs.getPropertyValue(prop)};`)
      .join("\n");
    return `${inspect.selector(el)} {\n${body || "  /* no notable computed properties */"}\n}`;
  };

  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  /** The classic box-model readout, in CSS pixels. */
  inspect.measure = function measure(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const sides = ["top", "right", "bottom", "left"];
    const sum = (prefix) => sides.reduce((acc, side) => acc + px(cs.getPropertyValue(`${prefix}-${side}`)), 0);
    const border = sides.reduce((acc, side) => {
      if (cs.getPropertyValue(`border-${side}-style`) === "none") return acc;
      return acc + px(cs.getPropertyValue(`border-${side}-width`));
    }, 0);
    return {
      width: Math.round(r.width * 100) / 100,
      height: Math.round(r.height * 100) / 100,
      margin: sum("margin"),
      padding: sum("padding"),
      border,
      radius: cs.borderRadius,
    };
  };

  /** Draw a violet outline with a label; returns a removable overlay. */
  inspect.outline = function outline(el, opts = {}) {
    const host = document.createElement("div");
    host.setAttribute("data-fathom-helper", "");
    Object.assign(host.style, {
      position: "fixed",
      zIndex: "2147483645",
      pointerEvents: "none",
      border: `1px solid ${opts.color || "#bd91ff"}`,
      background: opts.fill || "transparent",
      boxShadow: "0 0 0 1px #0006",
      transition: "all .05s",
    });
    const label = document.createElement("span");
    Object.assign(label.style, {
      position: "absolute",
      left: "-1px",
      top: "100%",
      marginTop: "3px",
      padding: "2px 6px",
      background: "#111",
      color: "#fff",
      font: "10px/1.3 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      borderRadius: "3px",
      border: "1px solid #ffffff40",
      whiteSpace: "nowrap",
    });
    label.textContent = opts.label || "";
    host.append(label);
    document.documentElement.append(host);

    const place = () => {
      const r = el.getBoundingClientRect();
      Object.assign(host.style, {
        top: `${r.top}px`,
        left: `${r.left}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
    };
    place();

    return {
      el: host,
      update: place,
      remove: () => host.remove(),
    };
  };

  inspect.summary = function summary(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      label: F.util.describe(el),
      size: `${Math.round(r.width)} × ${Math.round(r.height)}`,
      display: cs.display,
      font: `${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily.split(",")[0].replace(/["']/g, "")}`,
      color: cs.color,
      background: cs.backgroundColor,
    };
  };
})();
