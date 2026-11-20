/*
 * Fathom — DOM → code exporter (the "export engine" of the original product).
 *
 * Models the shipped export-engine.js / export.js / sanitize.js behaviour:
 *
 *   walk the live subtree depth-first, read computed styles, keep only a fixed
 *   whitelist of layout/typography/paint properties, dedupe identical style
 *   signatures into generated classes and emit them as zero-specificity
 *   `:where(.fN){…}` rules. HTML and CSS are produced from that walk, never by
 *   serialising the live page, so nothing is ever mutated.
 *
 * Everything is derived from the *rendered* state: one viewport, one set of
 * interaction states, no shadow DOM, no iframe/canvas content.
 *
 * Classic script; exposes globalThis.Fathom.exportLib. No DOM access happens at
 * evaluation time — only inside snapshot().
 */
(() => {
  const F = (globalThis.Fathom = globalThis.Fathom || {});

  /* ------------------------------------------------------------ constants --- */

  /**
   * Computed-style whitelist, in emission order. `getComputedStyle` exposes
   * ~340 longhands (mostly `-webkit-*`, `animation-*`, `mask-*` noise); a fixed
   * ordered list keeps output deterministic, keeps the sheet small, and makes
   * the signature dedupe below put identical elements in the same class.
   */
  const STYLE_PROPS = [
    // layout & box
    "display", "position", "top", "right", "bottom", "left", "z-index",
    "box-sizing", "width", "height", "min-width", "min-height", "max-width", "max-height",
    "aspect-ratio",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "overflow", "overflow-x", "overflow-y", "visibility", "opacity",
    // flex
    "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis",
    "justify-content", "align-items", "align-content", "align-self", "order",
    // grid
    "gap", "row-gap", "column-gap",
    "grid-template-columns", "grid-template-rows", "grid-template-areas",
    "grid-auto-flow", "grid-auto-rows", "grid-column", "grid-row",
    // borders
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
    "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
    "border-radius",
    // background & paint
    "background-color", "background-image", "background-position", "background-size",
    "background-repeat", "background-attachment", "background-clip",
    "box-shadow", "filter", "backdrop-filter", "mix-blend-mode",
    "transform", "transform-origin", "transition", "cursor",
    // typography
    "color", "font-family", "font-size", "font-weight", "font-style", "font-stretch",
    "line-height", "letter-spacing", "text-align", "text-transform",
    "text-decoration-line", "text-decoration-color",
    "text-indent", "text-shadow", "text-overflow", "white-space", "overflow-wrap",
    // lists & replaced media
    "list-style-type", "list-style-position", "list-style-image",
    "object-fit", "object-position",
  ];

  /**
   * Values equal to the property's *initial* value that are safe to omit.
   * Inherited properties are never omitted: a child whose computed value is the
   * initial one still needs its own declaration, otherwise it would inherit the
   * value declared by an ancestor's class.
   */
  const OMIT_WHEN = new Map([
    ["background-image", new Set(["none"])],
    ["box-shadow", new Set(["none"])],
    ["filter", new Set(["none"])],
    ["backdrop-filter", new Set(["none"])],
    ["mix-blend-mode", new Set(["normal"])],
    ["transform", new Set(["none"])],
    ["transition", new Set(["all 0s ease 0s", "all 0s ease 0s 0s", "none"])],
    ["grid-template-areas", new Set(["none"])],
    ["grid-auto-flow", new Set(["row"])],
  ]);

  /** Whole subtrees that must never reach an exported artifact. */
  const DROP_TAGS = new Set([
    "script", "noscript", "template", "style", "link", "meta", "base", "head",
    "iframe", "object", "embed", "portal", "applet",
    "animate", "animatemotion", "animatetransform", "set", "discard", "foreignobject",
  ]);

  /** Attributes that carry state, secrets or navigation we refuse to export. */
  const DROP_ATTRS = new Set([
    "srcdoc", "nonce", "integrity", "action", "formaction", "formtarget",
    "target", "ping", "download", "autofocus", "is", "checked", "selected", "data",
  ]);

  /** Attributes whose value is a URL that must be resolved (or dropped). */
  const URL_ATTRS = new Set(["src", "href", "xlink:href", "poster", "background", "cite", "longdesc"]);

  /** Query keys that usually carry credentials or signatures (sanitize.js). */
  const SECRET_PARAM = /^(?:token|access_token|refresh_token|api[_-]?key|apikey|key|signature|sig|authorization|auth|password|passwd|secret|session|csrf|jwt|code)$/i;

  const SAFE_DATA_URL = /^data:(?:image\/(?:png|jpe?g|gif|webp|avif|bmp|ico)|font\/(?:woff2?|ttf|otf|sfnt)|application\/font-woff2?|application\/x-font-woff|application\/vnd\.ms-fontobject|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)[;,]/i;

  const FONT_EXT = new Set(["woff", "woff2", "ttf", "otf", "eot", "sfnt"]);
  const MEDIA_EXT = new Set(["mp4", "webm", "ogv", "ogg", "mp3", "wav", "m4a", "m4v", "mov", "m3u8", "mpd"]);

  /** The output CSP is injected *before* the stylesheet in every standalone doc. */
  const CSP = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'";

  const MAX_ASSETS = 600;
  const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;

  /** DOM attribute name → React prop name, for the props React renames. */
  const JSX_ATTRS = {
    for: "htmlFor",
    "xlink:href": "xlinkHref",
    tabindex: "tabIndex",
    readonly: "readOnly",
    maxlength: "maxLength",
    minlength: "minLength",
    colspan: "colSpan",
    rowspan: "rowSpan",
    autocomplete: "autoComplete",
    autofocus: "autoFocus",
    contenteditable: "contentEditable",
    crossorigin: "crossOrigin",
    datetime: "dateTime",
    enctype: "encType",
    novalidate: "noValidate",
    spellcheck: "spellCheck",
    referrerpolicy: "referrerPolicy",
    usemap: "useMap",
    acceptcharset: "acceptCharset",
    frameborder: "frameBorder",
  };

  /* --------------------------------------------------------------- URLs --- */

  function stripControls(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
  }

  /**
   * Resolve one URL against the page and reject anything script-ish.
   * `allowData` permits only the data: MIME families an image/font/media export
   * can legitimately need; `allowContact` additionally keeps mailto:/tel: links.
   */
  function resolveUrl(raw, base, options) {
    const opts = options || {};
    const value = stripControls(raw);
    if (!value) return "";
    if (value.startsWith("#")) return value; // in-page anchor, not a resource
    if (/^(?:javascript|vbscript|blob|filesystem):/i.test(value)) return "";
    if (/^data:/i.test(value)) {
      return opts.allowData && SAFE_DATA_URL.test(value) ? value : "";
    }
    if (opts.allowContact && /^(?:mailto|tel):/i.test(value)) return value;

    let url;
    try {
      url = new URL(value, base);
    } catch (_error) {
      return "";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return ""; // embedded credentials
    for (const key of Array.from(url.searchParams.keys())) {
      if (SECRET_PARAM.test(key)) url.searchParams.delete(key);
    }
    if (url.hash && SECRET_PARAM.test(url.hash.slice(1).split(/[=&]/)[0] || "")) url.hash = "";
    return url.href;
  }

  /** Best-effort asset classification, by extension (or data: MIME). */
  function urlKind(url) {
    if (/^data:/i.test(url)) {
      if (/^data:font\/|^data:application\/(?:font|x-font|vnd\.ms-fontobject)/i.test(url)) return "font";
      if (/^data:(?:audio|video)\//i.test(url)) return "media";
      return "image";
    }
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch (_error) {
      path = url;
    }
    const ext = (path.split(".").pop() || "").toLowerCase();
    if (FONT_EXT.has(ext)) return "font";
    if (MEDIA_EXT.has(ext)) return "media";
    return "image";
  }

  function addAsset(ctx, url, kind) {
    if (!ctx.includeAssets || !url) return;
    if (!/^(?:https?:|data:)/i.test(url)) return;
    if (ctx.assets.size >= MAX_ASSETS && !ctx.assets.has(url)) return;
    if (!ctx.assets.has(url)) ctx.assets.set(url, kind || urlKind(url));
  }

  function cssQuote(url) {
    return String(url).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
  }

  /**
   * Minimal CSS filter for inline styles and computed values: reject
   * script-capable constructs, rewrite every url() through the URL sanitizer
   * (dropping the declaration to `none` when it does not survive) and collect
   * the surviving resources as assets.
   */
  function sanitizeCss(text, base, ctx) {
    let css = String(text === null || text === undefined ? "" : text);
    if (!css) return "";
    if (/(?:expression\s*\(|javascript:|-moz-binding|behavior\s*:)/i.test(css)) return "";
    css = css.replace(CSS_URL_RE, (_match, doubleQuoted, singleQuoted, bare) => {
      const raw = doubleQuoted !== undefined ? doubleQuoted : singleQuoted !== undefined ? singleQuoted : bare || "";
      const url = resolveUrl(raw, base, { allowData: true });
      if (!url) return "none";
      addAsset(ctx, url, urlKind(url));
      return `url("${cssQuote(url)}")`;
    });
    return css;
  }

  /** Parse a `srcset` value into `[{ url, descriptor }]` (no rewriting). */
  function parseSrcset(value) {
    const input = String(value || "");
    const out = [];
    let i = 0;
    while (i < input.length) {
      while (i < input.length && /[\s,]/.test(input[i])) i += 1;
      if (i >= input.length) break;
      const dataUrl = input.slice(i, i + 5).toLowerCase() === "data:";
      const start = i;
      while (i < input.length && !/\s/.test(input[i]) && (dataUrl || input[i] !== ",")) i += 1;
      let url = input.slice(start, i);
      let descriptor = "";
      if (url.endsWith(",")) {
        url = url.slice(0, -1);
      } else {
        while (i < input.length && /\s/.test(input[i])) i += 1;
        const descriptorStart = i;
        while (i < input.length && input[i] !== ",") i += 1;
        descriptor = input.slice(descriptorStart, i).trim();
        if (input[i] === ",") i += 1;
      }
      if (url) out.push({ url, descriptor });
    }
    return out;
  }

  /* ---------------------------------------------------------- DOM helpers --- */

  function isOwnElement(el) {
    return !!(el && el.closest && el.closest("fathom-workspace, [data-fathom-helper]"));
  }

  function tagOf(node) {
    return String(node.localName || node.tagName || "").toLowerCase();
  }

  /** Wrapper roots lose their tag in the output (see build()); they only wrap. */
  function isWrapperRoot(el) {
    const tag = tagOf(el);
    return tag === "html" || tag === "body";
  }

  /* ------------------------------------------------------------- snapshot --- */

  /**
   * Walk `rootEl` and produce every artifact in one pass.
   * Never mutates the live page: styles are read, clones are built inside an
   * inert document, attributes are sanitized on the clone only.
   */
  function build(rootEl, options) {
    const doc = rootEl.ownerDocument || document;
    const win = doc.defaultView || globalThis;
    const base = (win.location && win.location.href) || doc.baseURI || "about:blank";
    const inert = doc.implementation.createHTMLDocument("");
    const container = inert.createElement("div");

    const ctx = { includeAssets: options.includeAssets, assets: new Map() };
    const rules = [];
    const signatures = new Map(); // style text -> generated class name
    let nodes = 0;
    let truncated = false;

    /** Generated class for one style signature (create-on-first-use). */
    function classFor(styleText) {
      if (!styleText) return "";
      const existing = signatures.get(styleText);
      if (existing) return existing;
      const name = `f${signatures.size + 1}`;
      signatures.set(styleText, name);
      rules.push(`:where(.${name}) {\n${styleText}\n}`);
      return name;
    }

    /**
     * Read the whitelisted computed values for one element.
     * @returns {Array<[string, string]> | null} null when the element is not
     *   rendered at all (display:none) and its subtree must be skipped.
     */
    function styleEntries(el) {
      const computed = win.getComputedStyle(el);
      if (!computed || computed.display === "none") return null;
      const entries = [];
      for (const prop of STYLE_PROPS) {
        let value = computed.getPropertyValue(prop);
        if (!value) continue;
        value = String(value).trim();
        if (!value) continue;
        const omit = OMIT_WHEN.get(prop);
        if (omit && omit.has(value)) continue;
        if (value.indexOf("url(") !== -1) {
          value = sanitizeCss(value, base, ctx);
          if (!value) continue;
        }
        entries.push([prop, value]);
      }
      return entries;
    }

    /** Sanitize one cloned element and produce its JSON tree node. */
    function makeElementNode(live, parentClone, parentTree) {
      if (nodes >= options.maxNodes) {
        truncated = true;
        return null;
      }
      const tag = tagOf(live);
      if (!tag || DROP_TAGS.has(tag)) return null;
      if (isOwnElement(live)) return null;
      if (tag === "input" && String(live.getAttribute("type") || "").toLowerCase() === "hidden") return null;

      const entries = styleEntries(live);
      if (!entries) return null; // display:none

      nodes += 1;
      const clone = inert.importNode(live, false);
      const styleText = entries.map(([prop, value]) => `  ${prop}: ${value};`).join("\n");
      const generated = classFor(styleText);
      const node = { tag };
      const attrs = {};
      let originalClass = "";

      for (const attr of Array.from(clone.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value;

        if (name === "class") {
          originalClass = value.trim();
          continue;
        }
        if (name === "id") {
          if (value) node.id = value;
          continue;
        }
        if (name === "style") {
          const css = sanitizeCss(value, base, ctx);
          if (css) attr.value = css;
          else clone.removeAttributeNode(attr);
          continue;
        }
        if (name === "srcset" || name === "imagesrcset") {
          // Collected first (assets), then removed: srcset would let the page
          // re-fetch images and the single `src` below is the rendered truth.
          if (name === "srcset" && (tag === "img" || tag === "source")) {
            for (const candidate of parseSrcset(value)) {
              const resolved = resolveUrl(candidate.url, base, { allowData: true });
              if (resolved) addAsset(ctx, resolved, "image");
            }
          }
          clone.removeAttributeNode(attr);
          continue;
        }
        if (name.startsWith("on") || DROP_ATTRS.has(name) || name.startsWith("data-")) {
          clone.removeAttributeNode(attr);
          continue;
        }
        if (name === "value" && (tag === "input" || tag === "textarea" || tag === "select" || tag === "option")) {
          clone.removeAttributeNode(attr);
          continue;
        }
        if (URL_ATTRS.has(name)) {
          const isImage = tag === "img" || tag === "image";
          const isMediaTag = tag === "video" || tag === "audio";
          const inPicture = !!(live.parentElement && tagOf(live.parentElement) === "picture");
          const resolved = resolveUrl(value, base, {
            allowData: isImage || isMediaTag || tag === "source" || tag === "track",
            allowContact: tag === "a" || tag === "area",
          });
          if (!resolved) {
            clone.removeAttributeNode(attr);
            continue;
          }
          attr.value = resolved;
          if (name === "poster" || name === "background" || (name === "href" && isImage)) {
            addAsset(ctx, resolved, "image");
          } else if (name === "src") {
            addAsset(ctx, resolved, tag === "source" && !inPicture ? "media" : isMediaTag ? "media" : "image");
          } else if (name === "xlink:href" && isImage) {
            addAsset(ctx, resolved, "image");
          }
        }
        attrs[attr.name] = attr.value;
      }

      // The effective (responsive) source is what the page actually painted.
      if (tag === "img") {
        const current = live.currentSrc ? resolveUrl(live.currentSrc, base, { allowData: true }) : "";
        const plain = resolveUrl(live.getAttribute("src") || "", base, { allowData: true });
        const chosen = current || plain;
        if (chosen) {
          clone.setAttribute("src", chosen);
          attrs.src = chosen;
          addAsset(ctx, chosen, "image");
        } else if (clone.hasAttribute("src")) {
          clone.removeAttribute("src");
          delete attrs.src;
        }
      }

      // Keep the page's classes; append the generated one (importNode copied the
      // whole class attribute, so only the generated name has to be added).
      if (generated) clone.classList.add(generated);
      const mergedClass = [originalClass, generated].filter(Boolean).join(" ");
      if (mergedClass) node.class = mergedClass;

      if (Object.keys(attrs).length) node.attrs = attrs;
      if (entries.length) node.style = Object.fromEntries(entries);
      node.children = [];

      if (parentTree) parentTree.children.push(node);
      if (parentClone) parentClone.appendChild(clone);
      return { clone, tree: node };
    }

    /** Copy one text node verbatim; whitespace-only runs collapse to a space. */
    function makeTextNode(live, parentClone, parentTree) {
      if (nodes >= options.maxNodes) {
        truncated = true;
        return false;
      }
      let text = live.nodeValue || "";
      if (!text) return false;
      if (!text.trim()) text = " ";
      nodes += 1;
      parentClone.appendChild(inert.createTextNode(text));
      parentTree.children.push({ tag: "#text", text, children: [] });
      return true;
    }

    function pushChildren(live, parentClone, parentTree) {
      // Form values are user data, never exported (matches sanitize.js).
      if (tagOf(live) === "textarea") return;
      const kids = Array.from(live.childNodes || []);
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        stack.push({ live: kids[i], clone: parentClone, tree: parentTree });
      }
    }

    // Explicit stack instead of recursion: a 4,000-node page can also be a
    // 4,000-deep page, and recursion would throw instead of truncating.
    const stack = [];
    let rootNode;

    if (isWrapperRoot(rootEl)) {
      // <html>/<body> become the fragment's children; a synthetic div gives the
      // tree (and the JSX component) a valid container instead of a nested body.
      rootNode = { tag: "div", children: [] };
      pushChildren(rootEl, container, rootNode);
    } else {
      const made = makeElementNode(rootEl, container, null);
      if (made) {
        rootNode = made.tree;
        pushChildren(rootEl, made.clone, made.tree);
      } else {
        rootNode = { tag: "div", children: [] };
      }
    }

    while (stack.length) {
      if (truncated) break;
      const frame = stack.pop();
      const live = frame.live;
      if (!live) continue;
      if (live.nodeType === 1) {
        const tag = tagOf(live);
        // The page tool snapshots document.documentElement, so <html>/<body> can
        // appear below the root. They are document scaffolding, not content:
        // splice their children in instead of emitting a nested document tag.
        if (tag === "html" || tag === "body") {
          pushChildren(live, frame.clone, frame.tree);
          continue;
        }
        const made = makeElementNode(live, frame.clone, frame.tree);
        if (!made) continue;
        pushChildren(live, made.clone, made.tree);
      } else if (live.nodeType === 3) {
        makeTextNode(live, frame.clone, frame.tree);
      }
      // Comments, CDATA, processing instructions: intentionally dropped.
    }

    if (truncated) rootNode.truncated = true;

    return {
      markup: container.innerHTML,
      css: rules.join("\n\n"),
      tree: rootNode,
      assets: ctx.assets,
      nodeCount: nodes,
      classCount: signatures.size,
      truncated,
    };
  }

  /* ---------------------------------------------------------------- JSX --- */

  function reactProp(prop) {
    if (prop.startsWith("--")) return prop;
    if (prop === "float") return "float";
    return prop.replace(/-([a-z])/g, (_match, chr) => chr.toUpperCase());
  }

  function jsxName(tag) {
    return /^[A-Za-z][A-Za-z0-9_-]*$/.test(tag) ? tag : "div";
  }

  function quote(value) {
    return JSON.stringify(String(value));
  }

  /** Attribute value: `name="v"`, or `name={"…"}` when quoting would need escapes. */
  function jsxAttrValue(value) {
    const text = String(value);
    return /["\\\r\n<>&]/.test(text) ? `{${quote(text)}}` : `"${text}"`;
  }

  function jsxText(text) {
    const src = String(text);
    if (!src.trim()) return '{" "}';
    // JSX strips whitespace at the edges of a text line, so any meaningful edge
    // space (or a newline / repeated space, e.g. <pre>) must be an explicit
    // string child. Ordinary prose and other text stay real JSX text nodes.
    const needsExact = /^[\s]|[\s]$|[<>{}\\&]|\n|\s{2,}/.test(src);
    if (needsExact) return `{${quote(src)}}`;
    return src;
  }

  /** Attribute block (leading space included) built from one tree node. */
  function jsxAttrs(node, depth) {
    const parts = [];
    if (node.id) parts.push(`id=${jsxAttrValue(node.id)}`);
    if (node.class) parts.push(`className=${jsxAttrValue(node.class)}`);

    for (const [rawName, value] of Object.entries(node.attrs || {})) {
      const lower = rawName.toLowerCase();
      // SVG keeps camelCase attribute names (viewBox, gradientTransform); React
      // expects exactly those, so only fall back to lower case for HTML attrs.
      const name = JSX_ATTRS[lower] || (/[A-Z]/.test(rawName) ? rawName : lower);
      if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(name)) continue;
      parts.push(`${name}=${jsxAttrValue(value)}`);
    }

    if (node.style) {
      const props = Object.keys(node.style);
      if (props.length) {
        const pairs = props.map((prop) => {
          const key = prop.startsWith("--") ? quote(prop) : reactProp(prop);
          return `${key}: ${quote(node.style[prop])}`;
        });
        const inline = `style={{ ${pairs.join(", ")} }}`;
        if (inline.length <= 110) {
          parts.push(inline);
        } else {
          const propPad = "  ".repeat(depth + 1);
          const closePad = "  ".repeat(depth);
          const body = pairs.map((pair) => `${propPad}${pair},`).join("\n");
          parts.push(`style={{\n${body}\n${closePad}}}`);
        }
      }
    }

    return parts.length ? ` ${parts.join(" ")}` : "";
  }

  function renderJsx(node, depth) {
    const pad = "  ".repeat(depth);
    if (!node) return `${pad}{null}`;
    if (node.tag === "#text") return `${pad}${jsxText(node.text)}`;
    const tag = jsxName(node.tag);
    const attrs = jsxAttrs(node, depth);
    const children = node.children || [];
    if (!children.length) return `${pad}<${tag}${attrs} />`;
    const inner = children.map((child) => renderJsx(child, depth + 1)).join("\n");
    return `${pad}<${tag}${attrs}>\n${inner}\n${pad}</${tag}>`;
  }

  function buildJsx(tree, info) {
    return [
      "/*",
      " * Standalone React snapshot generated by Fathom.",
      ` * ${info.nodeCount} node(s), ${info.classCount} generated style class(es).`,
      " * Computed styles are inlined so the component renders without the CSS file.",
      " */",
      "",
      "function Snapshot() {",
      "  return (",
      renderJsx(tree, 2),
      "  );",
      "}",
      "",
    ].join("\n");
  }

  /* ------------------------------------------------------------ documents --- */

  function buildDocument(css, markup) {
    // `</style` inside a value would break out of the style element.
    const safeCss = String(css || "").replace(/<\/style/gi, "<\\/style");
    return [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
      "<style>",
      safeCss,
      "</style>",
      "</head>",
      "<body>",
      markup || "",
      "</body>",
      "</html>",
      "",
    ].join("\n");
  }

  /* ------------------------------------------------------------ public API --- */

  /**
   * Snapshot a subtree into standalone artifacts. Read-only.
   * @param {Element} el
   * @param {{maxNodes?: number, includeAssets?: boolean}} [options]
   * @returns {{markup: string, css: string, html: string, jsx: string, tree: object, assets: Array<{url: string, kind: string}>}}
   */
  function snapshot(el, options) {
    if (!el || el.nodeType !== 1) {
      throw new TypeError("Fathom.exportLib.snapshot(el) needs a DOM element.");
    }
    const opts = options || {};
    const rawMax = Number(opts.maxNodes);
    const maxNodes = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 4000;
    const includeAssets = opts.includeAssets !== false;

    const built = build(el, { maxNodes, includeAssets });
    const assets = Array.from(built.assets, ([url, kind]) => ({ url, kind }));

    return {
      markup: built.markup,
      css: built.css,
      html: buildDocument(built.css, built.markup),
      jsx: buildJsx(built.tree, built),
      tree: built.tree,
      assets,
    };
  }

  /** ZIP a list of { name, data } — delegates to Fathom.zip (lib/zip.js). */
  async function zip(files) {
    const impl = F.zip;
    if (typeof impl !== "function") {
      throw new Error("Fathom.zip is unavailable — include lib/zip.js in the injected bundle.");
    }
    return impl(files);
  }

  F.exportLib = { snapshot, zip };
})();
