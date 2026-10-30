/* global CSS, Element, HTMLElement, HTMLImageElement, SVGElement, ResizeObserver, document, getComputedStyle, parent, window */
// The board item SDK. It is deliberately small: the board owns the notes, the pins and
// the composer, so an item only reports a clicked element, draws the pins it is told
// about, and applies tune values as CSS custom properties.
(function () {
  /** @type {any} */
  const script = document.currentScript;
  const url = new URL(script ? script.src : window.location.href);
  const itemId = url.searchParams.get("item") || "";
  const deviceId = url.searchParams.get("device") || "desktop";

  // The board grows the frame to the page's whole height, so to the page's own scripts
  // the window must stay one screen of the device, as its vh units do: a script that
  // sizes a canvas or a section from `innerHeight` would otherwise read the grown frame,
  // grow the page, and grow the frame again. The SDK keeps the real reading for itself.
  const DEVICE_SCREEN = { ultrawide: 1440, desktop: 900, ipad: 1194, phone: 844 }[deviceId] || 0;
  const innerHeightOf = (() => {
    const own = Object.getOwnPropertyDescriptor(window, "innerHeight");
    const getter = own?.get || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), "innerHeight")?.get;
    return getter ? () => getter.call(window) : () => window.innerHeight;
  })();
  function pinWindowHeight() {
    if (!DEVICE_SCREEN) return;
    const screenHeight = () => DEVICE_SCREEN;
    try {
      Object.defineProperty(window, "innerHeight", { configurable: true, get: screenHeight });
    } catch {
      // A page that locked the property keeps the real one.
    }
    try {
      const root = document.documentElement;
      if (root) Object.defineProperty(root, "clientHeight", { configurable: true, get: screenHeight });
    } catch {
      // Same.
    }
    try {
      if (window.visualViewport) {
        Object.defineProperty(window.visualViewport, "height", { configurable: true, get: screenHeight });
      }
    } catch {
      // Same.
    }
  }
  pinWindowHeight();
  const channel = "easel";
  const state = { pins: [], tuning: {} };

  function parentWindow() {
    return parent && parent !== window ? parent : null;
  }

  /** @param {Record<string, unknown>} message */
  function post(message) {
    const target = parentWindow();
    if (!target) return;
    try {
      target.postMessage({ channel, item: itemId, device: deviceId, ...message }, "*");
    } catch {
      // A parent that went away is not an item failure.
    }
  }

  /** @param {Element} element */
  function selectorFor(element) {
    if (!(element instanceof HTMLElement)) return "";
    if (element.id) {
      const byId = `#${CSS.escape(element.id)}`;
      if (document.querySelectorAll(byId).length === 1) return byId;
    }
    const parts = [];
    let node = element;
    while (node && node !== document.documentElement) {
      if (node === document.body) {
        parts.unshift("body");
        break;
      }
      let part = node.tagName.toLowerCase();
      const parentNode = node.parentElement;
      if (parentNode) {
        const sameTag = Array.from(parentNode.children).filter((child) => child.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node.id) {
        parts[0] = `#${CSS.escape(node.id)}`;
        break;
      }
      node = parentNode;
    }
    return parts.join(" > ");
  }

  /** @param {Element} element */
  function snippet(element) {
    const text = String(element.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 120);
  }

  /**
   * @param {Element} element
   * @param {number} clickX viewport x of the click
   * @param {number} clickY viewport y of the click
   */
  function anchorOf(element, clickX, clickY) {
    const rect = element.getBoundingClientRect();
    return {
      // Document coordinates of the click keep the pin where it was dropped as the
      // page scrolls; the offset inside the element keeps it there if layout shifts.
      x: Math.round(clickX + window.scrollX),
      y: Math.round(clickY + window.scrollY),
      ox: Math.round(clickX - rect.left),
      oy: Math.round(clickY - rect.top),
    };
  }

  // What the agent is told about a pinned element: the text a reader sees in it, the
  // heading of the section it sits in, and its box on the page (for its picture).
  function visibleText(element) {
    const own = element instanceof HTMLElement ? element.innerText : element.textContent;
    const words = String(own || element.getAttribute("aria-label") || element.getAttribute("alt") || "")
      .replace(/\s+/g, " ")
      .trim();
    return words.slice(0, 120);
  }

  function sectionHeading(element) {
    const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']");
    let found = null;
    for (const heading of headings) {
      if (heading.closest("[data-easel-ui]")) continue;
      if (
        heading instanceof HTMLElement &&
        heading.offsetParent === null &&
        getComputedStyle(heading).position !== "fixed"
      )
        continue;
      if (heading === element || heading.contains(element) || element.contains(heading)) return visibleText(heading);
      if (heading.compareDocumentPosition(element) & window.Node.DOCUMENT_POSITION_FOLLOWING) found = heading;
      else break;
    }
    return found ? visibleText(found) : "";
  }

  function pageBox(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  function pinLayer() {
    let layer = document.getElementById("easel-pins");
    if (layer) return layer;
    layer = document.createElement("div");
    layer.id = "easel-pins";
    layer.setAttribute("data-easel-ui", "pins");
    layer.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483000;";
    document.body.appendChild(layer);
    return layer;
  }

  function renderPins() {
    const layer = pinLayer();
    const seen = new Set();
    for (const pin of state.pins) {
      seen.add(pin.id);
      /** @type {HTMLElement | null} */
      let element = layer.querySelector(`[data-pin="${CSS.escape(pin.id)}"]`);
      if (!element) {
        element = document.createElement("div");
        element.className = "easel-pin";
        element.dataset.pin = pin.id;
        element.style.cssText = [
          "position:absolute",
          "display:grid",
          "place-content:center",
          "box-sizing:border-box",
          "min-width:24px",
          "height:24px",
          "padding:0 6px",
          "border-radius:999px",
          "font:600 12px/1 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
          "font-variant-numeric:tabular-nums",
          "box-shadow:0 1px 2px rgba(0,0,0,.18),0 4px 12px rgba(0,0,0,.18)",
          "pointer-events:none",
          "transition:transform .18s ease, left .3s cubic-bezier(.2,.9,.2,1), opacity .3s ease, box-shadow .16s ease",
          "transform:translate(-50%,-50%)",
          "z-index:2147483000",
        ].join(";");
        layer.appendChild(element);
      }
      element.textContent = String(pin.number);
      element.dataset.state = pin.state || "draft";
      if (pin.state === "draft") {
        // Not sent yet: an outline. Sent: filled. The artboard itself shows what the
        // agent already has.
        element.style.background = "#ffffff";
        element.style.color = "#16181d";
        element.style.border = "2px solid #16181d";
      } else {
        element.style.background = "#16181d";
        element.style.color = "#ffffff";
        element.style.border = "2px solid #ffffff";
      }
      const anchor = resolution(pin);
      if (!anchor.visible) {
        element.style.display = "none";
        continue;
      }
      element.style.display = "grid";
      element.style.left = `${anchor.x}px`;
      element.style.top = `${anchor.y}px`;
      element.style.transform = "translate(-50%,-50%)";
    }
    for (const node of Array.from(layer.children)) {
      if (!(node instanceof HTMLElement) || !seen.has(node.dataset.pin)) node.remove();
    }
  }

  /** @param {{ selector?: string, x?: number, y?: number, ox?: number, oy?: number }} pin */
  function resolution(pin) {
    if (pin.selector && Number.isFinite(Number(pin.ox)) && Number.isFinite(Number(pin.oy))) {
      let element;
      try {
        element = document.querySelector(pin.selector);
      } catch {
        element = null;
      }
      if (element) {
        const rect = element.getBoundingClientRect();
        return {
          visible: true,
          x: rect.left + window.scrollX + Math.min(Number(pin.ox), rect.width),
          y: rect.top + window.scrollY + Math.min(Number(pin.oy), rect.height),
        };
      }
    }
    return { visible: true, x: Number(pin.x) || 0, y: Number(pin.y) || 0 };
  }

  /** The pin drawn at a viewport point, so a click on it opens that note. */
  function pinAt(x, y) {
    const docX = x + window.scrollX;
    const docY = y + window.scrollY;
    for (const pin of state.pins) {
      // An answered pin has left the page; it no longer takes clicks there.
      if (pin.state === "done") continue;
      const anchor = resolution(pin);
      if (Math.abs(anchor.x - docX) <= 13 && Math.abs(anchor.y - docY) <= 13) return pin;
    }
    return null;
  }

  let frame = 0;
  function schedulePins() {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      renderPins();
    });
  }

  function flashPin(id) {
    /** @type {HTMLElement | null} */
    const element = pinLayer().querySelector(`[data-pin="${CSS.escape(id)}"]`);
    const pin = state.pins.find((entry) => entry.id === id);
    if (!element || !pin) return;
    element.style.transform = "translate(-50%,-50%) scale(1.35)";
    element.style.boxShadow = "0 0 0 6px rgba(37,99,235,.28), 0 4px 12px rgba(0,0,0,.2)";
    window.setTimeout(() => {
      element.style.transform = "translate(-50%,-50%)";
      element.style.boxShadow = "0 1px 2px rgba(0,0,0,.18),0 4px 12px rgba(0,0,0,.18)";
    }, 1100);
  }

  function hoverLayer() {
    let layer = document.getElementById("easel-hover");
    if (layer) return layer;
    layer = document.createElement("div");
    layer.id = "easel-hover";
    layer.setAttribute("data-easel-ui", "hover");
    layer.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "border:1.5px solid #2563eb",
      "border-radius:2px",
      "background:rgba(37,99,235,.06)",
      "z-index:2147482900",
      "display:none",
    ].join(";");
    document.body.appendChild(layer);
    return layer;
  }

  let hoverTarget = null;
  function drawHover(target) {
    const layer = hoverLayer();
    if (!target) {
      layer.style.display = "none";
      hoverTarget = null;
      return;
    }
    if (hoverTarget === target && layer.style.display === "block") return;
    hoverTarget = target;
    const rect = target.getBoundingClientRect();
    layer.style.display = "block";
    layer.style.left = `${rect.left + window.scrollX}px`;
    layer.style.top = `${rect.top + window.scrollY}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
  }

  function plainLabel(name) {
    const text = String(name).replace(/^--/, "").replace(/[-_]+/g, " ").trim();
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function groupLabel(name) {
    const parts = String(name).replace(/^--/, "").split(/[-_]/);
    if (parts.length < 2) return "Page";
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }

  function isColor(value) {
    return (
      /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|color\()/i.test(value) ||
      /^(white|black|red|green|blue|gray|grey)$/i.test(value)
    );
  }

  // With no declaration from the page, the panel is built from the CSS custom
  // properties the page actually uses, so every variant is tunable.
  function collectTuneControls() {
    const names = new Set();
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules) walk(rule.cssRules);
        const style = rule.style;
        if (!style) continue;
        for (const property of Array.from(style)) {
          if (property.startsWith("--")) names.add(property);
          const value = style.getPropertyValue(property);
          for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) names.add(match[1]);
        }
      }
    };
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        if (sheet.cssRules) walk(sheet.cssRules);
      }
    } catch {
      // Cross-origin sheets are not readable; the page's own sheet is.
    }
    const root = getComputedStyle(document.documentElement);
    const controls = [];
    for (const name of names) {
      const value = root.getPropertyValue(name).trim();
      if (!value) continue;
      const control = { id: name.slice(2), css: name, label: plainLabel(name), group: groupLabel(name) };
      if (isColor(value)) {
        controls.push({ ...control, type: "color", value });
        continue;
      }
      const px = /^(-?\d*\.?\d+)px$/.exec(value);
      const unitless = /^-?\d*\.?\d+$/.exec(value);
      if (px) {
        const size = Number(px[1]);
        controls.push({
          ...control,
          type: "number",
          unit: "px",
          value: String(size),
          min: Math.min(0, Math.floor(size / 2)),
          max: Math.max(64, Math.ceil(Math.abs(size) * 3)),
          step: 1,
        });
        continue;
      }
      if (unitless) {
        const size = Number(value);
        controls.push({
          ...control,
          type: "number",
          value: String(size),
          min: Math.min(0, Math.floor(size / 2)),
          max: Math.max(2, Number((Math.abs(size) * 3).toFixed(2))),
          step: 0.1,
        });
        continue;
      }
      const rem = /^(-?\d*\.?\d+)(rem|em)$/.exec(value);
      if (rem) {
        const size = Number(rem[1]);
        controls.push({
          ...control,
          type: "number",
          unit: rem[2],
          value: String(size),
          min: 0,
          max: Math.max(4, Math.ceil(size * 3)),
          step: 0.1,
        });
      }
    }
    controls.sort((left, right) => {
      if (left.group !== right.group) return left.group.localeCompare(right.group);
      return left.css.localeCompare(right.css);
    });
    return controls.slice(0, 18);
  }

  function applyTune(values) {
    if (!values || typeof values !== "object") return;
    state.tuning = values;
    for (const [property, value] of Object.entries(values)) {
      if (!property.startsWith("--")) continue;
      // A tuned `vh` would re-open the loop the layout pinning closed: the taller
      // frame makes the value bigger, which makes the page taller again. Express it
      // against the viewport height the page opened at instead.
      const relative = /^(-?\d*\.?\d+)(dvh|svh|vh)$/.exec(String(value).trim());
      const next = relative && pinnedVh ? `${((Number(relative[1]) * pinnedVh) / 100).toFixed(2)}px` : String(value);
      document.documentElement.style.setProperty(property, next);
      // A page that re-declares a variable deeper (a theme class on body) would ignore a
      // value set only on :root, so the body carries the same value and wins.
      if (document.body) document.body.style.setProperty(property, next);
    }
    window.dispatchEvent(new CustomEvent("easel:tune", { detail: { ...values } }));
  }

  /* ---------------------------------------------------------- element tuning */

  // Properties a clicked element can be tuned by, each written as an inline override.
  // `applies` decides which of them make sense for that element at all.
  const SHADOW_PRESETS = [
    { value: "0 1px 2px rgba(0,0,0,0.08)", label: "Soft" },
    { value: "0 8px 24px rgba(0,0,0,0.14)", label: "Lifted" },
    { value: "none", label: "None" },
  ];

  /** @param {string} value */
  function hexOf(value) {
    const rgb = /^rgba?\(([^)]+)\)$/.exec(String(value).trim());
    if (!rgb) return /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
    const parts = rgb[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .slice(0, 4)
      .map(Number);
    if (parts.length > 3 && parts[3] === 0) return "#000000";
    return `#${parts
      .slice(0, 3)
      .map((part) =>
        Math.max(0, Math.min(255, Math.round(part)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  }

  /** @param {string} value */
  function pxOf(value) {
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** @param {string} text */
  function shortText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 28);
  }

  /** @param {Element} element */
  function targetLabel(element) {
    const tag = element.tagName.toLowerCase();
    const words = shortText(element.textContent);
    return words ? `${tag} · “${words}”` : tag;
  }

  /** @param {Element | null} element */
  function sectionLabel(element) {
    if (!element) return "";
    const head = element.querySelector("h1, h2, h3, legend, summary");
    const text = shortText(head ? head.textContent : "");
    return text ? `${element.tagName.toLowerCase()} · ${text}` : element.tagName.toLowerCase();
  }

  /**
   * The controls that genuinely apply to a clicked element, plus the ones its nearest
   * section owns (a flex or grid gap belongs to the container, not the child). A
   * property that cannot show on this element - no fill, no border, no text - is left
   * out rather than offered as a control that changes nothing.
   * @param {Element} element
   * @param {Element | null} section
   */
  function elementTuneControls(element, section) {
    const style = getComputedStyle(element);
    const box = style.display !== "inline" && element.tagName !== "BR";
    const text = shortText(element.textContent).length > 0;
    const replaced = ["IMG", "VIDEO", "SVG", "CANVAS", "PICTURE"].includes(element.tagName);
    const bordered = style.borderTopWidth !== "0px" && style.borderTopStyle !== "none";
    const paints =
      replaced ||
      bordered ||
      style.backgroundImage !== "none" ||
      !/^rgba?\(0,\s*0,\s*0,\s*0\)$|^transparent$/.test(style.backgroundColor.trim());
    const controls = [];
    /** @param {string} id @param {string} css @param {string} label @param {Record<string, unknown>} control */
    const add = (id, css, label, control) => controls.push({ id, css, label, scope: "element", ...control });
    /** @param {string} value */
    const round = (value) => Math.round(pxOf(value) * 100) / 100;

    if (text) {
      add("color", "color", "Colour", { type: "color", value: hexOf(style.color) });
      const fontSize = Math.max(8, Math.round(pxOf(style.fontSize)));
      add("font-size", "font-size", "Type size", {
        type: "number",
        unit: "px",
        value: String(fontSize),
        min: 8,
        max: Math.max(32, Math.round(fontSize * 3)),
        step: 1,
      });
      const weights = ["300", "400", "500", "600", "700", "800", "900"];
      const weight = String(style.fontWeight);
      add("weight", "font-weight", "Weight", {
        type: "select",
        value: weight,
        options: (weights.includes(weight) ? weights : [weight, ...weights]).map((value) => ({ value, label: value })),
      });
      add("letter-spacing", "letter-spacing", "Tracking", {
        type: "number",
        unit: "px",
        value: String(round(style.letterSpacing)),
        min: -4,
        max: 12,
        step: 0.1,
      });
      const lineHeight = round(style.lineHeight) || Math.round(fontSize * 1.5);
      add("line-height", "line-height", "Line height", {
        type: "number",
        unit: "px",
        value: String(lineHeight),
        min: 8,
        max: Math.max(48, Math.round(lineHeight * 2)),
        step: 1,
      });
    }
    if (paints) {
      add("fill", "background-color", "Fill", { type: "color", value: hexOf(style.backgroundColor) });
    }
    if (bordered) {
      add("border-color", "border-color", "Border", { type: "color", value: hexOf(style.borderTopColor) });
      add("border-width", "border-width", "Border width", {
        type: "number",
        unit: "px",
        value: String(Math.max(0, Math.round(pxOf(style.borderTopWidth)))),
        min: 0,
        max: 12,
        step: 1,
      });
    }
    if (box) {
      const pad = Math.max(0, Math.round(pxOf(style.paddingTop)));
      add("padding", "padding", "Padding", {
        type: "number",
        unit: "px",
        value: String(pad),
        min: 0,
        max: Math.max(48, Math.round(pad * 4)),
        step: 1,
      });
      const margin = Math.round(pxOf(style.marginTop));
      add("margin", "margin", "Margin", {
        type: "number",
        unit: "px",
        value: String(margin),
        min: Math.min(0, margin * 2),
        max: Math.max(48, Math.round(margin * 4)),
        step: 1,
      });
      const width = Math.round(element.getBoundingClientRect().width);
      add("width", "width", "Width", {
        type: "number",
        unit: "px",
        value: String(width),
        min: 40,
        max: Math.max(320, Math.round(width * 2)),
        step: 1,
      });
      const rect = element.getBoundingClientRect();
      add("height", "height", "Height", {
        type: "number",
        unit: "px",
        value: String(Math.round(rect.height)),
        min: 0,
        max: Math.max(320, Math.round(rect.height * 3)),
        step: 1,
      });
      if (paints) {
        const radius = Math.max(0, Math.round(pxOf(style.borderTopLeftRadius)));
        add("radius", "border-radius", "Radius", {
          type: "number",
          unit: "px",
          value: String(radius),
          min: 0,
          max: Math.max(32, Math.round(radius * 4)),
          step: 1,
        });
        const shadow = String(style.boxShadow);
        const known = SHADOW_PRESETS.some((preset) => preset.value === shadow);
        add("shadow", "box-shadow", "Shadow", {
          type: "select",
          value: shadow,
          options: known ? SHADOW_PRESETS : [{ value: shadow, label: "Current" }, ...SHADOW_PRESETS],
        });
      }
    }
    if (section) {
      const sectionStyle = getComputedStyle(section);
      if (/flex|grid/.test(sectionStyle.display)) {
        const gap = Math.max(0, Math.round(pxOf(sectionStyle.columnGap || sectionStyle.gap)));
        controls.push({
          id: "gap",
          css: "gap",
          label: "Gap",
          type: "number",
          unit: "px",
          value: String(gap),
          min: 0,
          max: Math.max(64, Math.round(gap * 4)),
          step: 1,
          scope: "section",
        });
      }
    }
    return controls;
  }

  /**
   * The box that owns a gap for this element: the element itself when it lays its
   * children out in a row or grid, otherwise the section it sits in.
   * @param {Element} element
   */
  function gapOwnerOf(element) {
    if (/flex|grid/.test(getComputedStyle(element).display)) return element;
    const above = element.closest("section, article, header, footer, main, nav, form, aside");
    return above && /flex|grid/.test(getComputedStyle(above).display) ? above : null;
  }

  /** Inline overrides this SDK set, so Reset can take them all back off. */
  const elementStyles = new Map();

  /** @param {string} selector @param {string} css @param {string} value */
  function applyElementStyle(selector, css, value) {
    if (!selector || !css) return;
    /** @type {Element | null} */
    let element;
    try {
      element = document.querySelector(selector);
    } catch {
      return;
    }
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return;
    let applied = elementStyles.get(element);
    if (!applied) {
      applied = new Map();
      elementStyles.set(element, applied);
    }
    applied.set(css, value);
    element.style.setProperty(css, value);
  }

  function resetElementStyles() {
    for (const [element, applied] of elementStyles) {
      for (const css of applied.keys()) element.style.removeProperty(css);
    }
    elementStyles.clear();
  }

  /** What the board tunes when an Option click lands on a point in the page. */
  function reportTuneTarget(x, y) {
    const leaf = document.elementFromPoint(x, y);
    const element = leaf instanceof Element && !leaf.closest("[data-easel-ui]") ? leaf : document.body;
    if (!(element instanceof Element)) return;
    reportTuneFor(element);
  }

  /** @param {Element} element */
  function reportTuneFor(element) {
    const owner = gapOwnerOf(element);
    const parent = element.parentElement;
    // Read the page's own values, not the ones this panel is currently previewing, so
    // Copy shows exactly what still differs from the file.
    const held = [...new Set([element, owner, parent].filter(Boolean))].map((node) => [node, elementStyles.get(node)]);
    for (const [node, applied] of held) {
      if (applied) for (const css of applied.keys()) node.style.removeProperty(css);
    }
    const controls = elementTuneControls(element, owner);
    const payload = {
      selector: selectorFor(element),
      // The gap belongs to this container, not to the clicked child.
      sectionSelector: owner ? selectorFor(owner) : "",
      label: targetLabel(element),
      sectionLabel: owner && owner !== element ? sectionLabel(owner) : "",
      // One click steps up: the panel offers the element this one sits in.
      parentSelector: parent ? selectorFor(parent) : "",
      parentLabel: parent ? targetLabel(parent) : "",
    };
    for (const [node, applied] of held) {
      if (applied) for (const [css, value] of applied) node.style.setProperty(css, value);
    }
    post({ type: "tune-target", ...payload, controls });
  }

  /** @param {string} selector */
  function reportTuneSelector(selector) {
    /** @type {Element | null} */
    let element;
    try {
      element = document.querySelector(selector);
    } catch {
      element = null;
    }
    if (!(element instanceof Element) || element.closest("[data-easel-ui]")) return;
    reportTuneFor(element);
  }

  window.addEventListener(
    "message",
    (event) => {
      const target = parentWindow();
      if (!target || event.source !== target) return;
      const data = event.data;
      if (!data || data.channel !== channel) return;
      if (data.type === "stylesheet") {
        adoptStylesheet(String(data.href || ""), typeof data.text === "string" ? data.text : null);
        return;
      }
      if (data.type === "pins") {
        state.pins = Array.isArray(data.pins) ? data.pins : [];
        schedulePins();
        return;
      }
      if (data.type === "image-drops") {
        applyImageDrops(data.drops);
        return;
      }
      if (data.type === "focus") {
        const pin = state.pins.find((entry) => entry.id === String(data.id || ""));
        if (pin && data.reveal) {
          const anchor = resolution(pin);
          const top = anchor.y - window.scrollY;
          if (top < 40 || top > innerHeightOf() - 40)
            window.scrollTo({ top: Math.max(0, anchor.y - innerHeightOf() / 3) });
          schedulePins();
        }
        flashPin(String(data.id || ""));
        return;
      }
      if (data.type === "tune") {
        applyTune(data.values);
        return;
      }
      if (data.type === "element-tune") {
        // What an Option click tuned and the board saved: applied again on every load,
        // so the design reads the way the reviewer left it rather than as the file is.
        const values = data.values && typeof data.values === "object" ? data.values : {};
        for (const [selector, css] of Object.entries(values)) {
          if (!css || typeof css !== "object") continue;
          for (const [property, value] of Object.entries(css)) {
            applyElementStyle(String(selector), String(property), String(value));
          }
        }
        return;
      }
      if (data.type === "scroll") {
        const dx = Number(data.dx) || 0;
        const dy = Number(data.dy) || 0;
        window.scrollBy(dx, dy);
        schedulePins();
        return;
      }
      if (data.type === "tune-spec") {
        post({ type: "tune-spec", controls: collectTuneControls() });
        return;
      }
      if (data.type === "tune-target") {
        reportTuneTarget(Number(data.x), Number(data.y));
        return;
      }
      if (data.type === "tune-element") {
        reportTuneSelector(String(data.selector || ""));
        return;
      }
      if (data.type === "style") {
        applyElementStyle(String(data.selector || ""), String(data.css || ""), String(data.value ?? ""));
        return;
      }
      if (data.type === "style-reset") {
        resetElementStyles();
        return;
      }
      // The board covers each artboard with a transparent shield while annotating and
      // asks the document what sits under that point, so a page's own click handlers,
      // links or overlays can never swallow the annotation.
      if (data.type === "hit") {
        const x = Number(data.x);
        const y = Number(data.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < 0 || y < 0) {
          drawHover(null);
          return;
        }
        const onPin = pinAt(x, y);
        const target = document.elementFromPoint(x, y);
        // Empty page background still takes a note: it is about that part of the page.
        const usable =
          target instanceof Element && !target.closest("[data-easel-ui]") && target !== document.documentElement;
        if (data.hover) {
          drawHover(!onPin && usable && target !== document.body ? target : null);
          return;
        }
        if (onPin) {
          post({ type: "pin", id: onPin.id });
          return;
        }
        if (!usable) return;
        const selector = selectorFor(target);
        if (!selector) return;
        drawHover(null);
        post({
          type: "select",
          selector,
          tag: target.tagName.toLowerCase(),
          text: snippet(target),
          ...anchorOf(target, x, y),
          excerpt: visibleText(target),
          heading: sectionHeading(target),
          box: pageBox(target),
        });
      }
    },
    false,
  );

  // A pinch or Cmd+scroll that reaches the page itself zooms the board, never the
  // browser window: the frame swallows the wheel, so hand it to the board.
  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      post({
        type: "zoom-wheel",
        x: event.clientX,
        y: event.clientY,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      });
    },
    { capture: true, passive: false },
  );

  // Keys go to whichever document holds focus, and one click into a page moves focus
  // into this frame. So the board is told what is held here too: without that, Space,
  // Cmd and Option stop arming as soon as the reviewer touches the design itself.
  const held = { space: false, alt: false, meta: false };
  function reportHeld() {
    post({ type: "held", space: held.space, alt: held.alt, meta: held.meta });
  }
  function readHeld(event, down) {
    const next = {
      alt: Boolean(event.altKey),
      meta: Boolean(event.metaKey),
      space: down ? event.code === "Space" : event.code === "Space" ? false : held.space,
    };
    if (next.alt === held.alt && next.meta === held.meta && next.space === held.space) return;
    Object.assign(held, next);
    reportHeld();
  }
  function editable(target) {
    return (
      target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    );
  }
  document.addEventListener(
    "keydown",
    (event) => {
      // Space is the board's hand, so the page never scrolls under it.
      if (event.code === "Space" && !editable(event.target)) event.preventDefault();
      readHeld(event, true);
    },
    true,
  );
  document.addEventListener("keyup", (event) => readHeld(event, false), true);
  window.addEventListener("blur", () => {
    if (!held.space && !held.alt && !held.meta) return;
    held.space = false;
    held.alt = false;
    held.meta = false;
    reportHeld();
  });

  // Option is the tune gesture: inside a frame the browser would otherwise start a text
  // selection, follow a link clicked with Option, or download it. None of that belongs
  // to the board, so an Option press never reaches the page's own defaults.
  function swallowOption(event) {
    if (!event.altKey && !held.alt) return;
    event.preventDefault();
    event.stopPropagation();
  }
  for (const type of ["pointerdown", "mousedown", "pointerup", "click", "auxclick", "dblclick"])
    document.addEventListener(type, swallowOption, true);
  for (const type of ["selectstart", "dragstart"])
    document.addEventListener(
      type,
      (event) => {
        if (/** @type {MouseEvent} */ (event).altKey || held.alt) event.preventDefault();
      },
      true,
    );

  for (const type of ["scroll", "resize"])
    window.addEventListener(type, schedulePins, { capture: true, passive: true });

  /* ----------------------------------------------------------- image drops */

  // A file dragged off the desktop can replace the picture it lands on. The frame only
  // finds the element and hands the file up; the board writes it into its own folder
  // and tells every frame what to show, so the swap survives a reload.
  const IMAGE_FILE = /^image\/(png|jpeg|webp)$/;
  /** @type {Map<string, { kind: string, original: string }>} */
  const imageDrops = new Map();

  function imageFileOf(transfer) {
    for (const entry of Array.from(transfer?.items || [])) {
      if (entry.kind !== "file") continue;
      const file = entry.getAsFile();
      if (file && IMAGE_FILE.test(file.type)) return file;
    }
    for (const file of Array.from(transfer?.files || [])) if (IMAGE_FILE.test(file.type)) return file;
    return null;
  }

  /** @param {Element} element */
  function backgroundSource(element) {
    const value = String(getComputedStyle(element).backgroundImage || "").trim();
    if (!value || value === "none") return "";
    const match = /^url\(["']?([^"')]+)["']?\)/.exec(value);
    return match ? match[1] : "";
  }

  /** @param {Element} node */
  function imageTargetAt(node) {
    const inside = node.closest("img");
    if (inside instanceof HTMLImageElement) {
      return { element: inside, kind: "img", source: inside.getAttribute("src") || "" };
    }
    // A picture often sits under a link or a figure: the image is still the thing the
    // pointer is on.
    const wrapped = node.closest("a, picture, figure, button")?.querySelector("img");
    if (wrapped instanceof HTMLImageElement) {
      return { element: wrapped, kind: "img", source: wrapped.getAttribute("src") || "" };
    }
    for (let element = node; element && element !== document.documentElement; element = element.parentElement) {
      const source = backgroundSource(element);
      if (source) return { element, kind: "background", source };
    }
    return null;
  }

  function dropTargetAt(x, y) {
    const node = document.elementFromPoint(x, y);
    if (!(node instanceof Element) || node.closest("[data-easel-ui]") || node === document.documentElement) return null;
    return imageTargetAt(node);
  }

  function dropBoxLayer() {
    let layer = document.getElementById("easel-drop");
    if (layer) return layer;
    layer = document.createElement("div");
    layer.id = "easel-drop";
    layer.setAttribute("data-easel-ui", "drop");
    layer.style.cssText = [
      "position:fixed",
      "display:none",
      "pointer-events:none",
      "z-index:2147483001",
      "border:2px solid #2563eb",
      "border-radius:4px",
      "box-shadow:0 0 0 4px rgba(37,99,235,.16)",
      "transition:opacity .12s ease",
    ].join(";");
    document.body.appendChild(layer);
    return layer;
  }

  /** @param {Element | null} element */
  function showDropBox(element) {
    const layer = dropBoxLayer();
    if (!element) {
      layer.style.display = "none";
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(layer.style, {
      display: "block",
      left: `${Math.round(rect.left)}px`,
      top: `${Math.round(rect.top)}px`,
      width: `${Math.round(rect.width)}px`,
      height: `${Math.round(rect.height)}px`,
    });
  }

  /** @param {HTMLElement | SVGElement} element @param {string} src */
  function swapImage(element, src) {
    if (!(element instanceof HTMLImageElement)) {
      element.setAttribute("src", src);
      return;
    }
    // Keep the box the design gave the old picture: a square swap into a wide crop
    // must not move the layout.
    const before = element.getBoundingClientRect();
    element.src = src;
    element.addEventListener(
      "load",
      () => {
        const after = element.getBoundingClientRect();
        if (Math.abs(after.width - before.width) > 1 || Math.abs(after.height - before.height) > 1) {
          element.style.width = `${before.width}px`;
          element.style.height = `${before.height}px`;
        }
      },
      { once: true },
    );
  }

  /** @param {{ selector?: string, kind?: string, src?: string }} drop */
  function applyImageDrop(drop) {
    const selector = String(drop.selector || "");
    if (!selector) return;
    /** @type {Element | null} */
    let element;
    try {
      element = document.querySelector(selector);
    } catch {
      element = null;
    }
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return;
    const kind = drop.kind === "background" ? "background" : "img";
    if (!imageDrops.has(selector)) {
      imageDrops.set(selector, {
        kind,
        original: kind === "img" ? element.getAttribute("src") || "" : String(element.style.backgroundImage || ""),
      });
    }
    const src = String(drop.src || "");
    if (!src) return;
    if (kind === "img") swapImage(element, src);
    else element.style.backgroundImage = `url("${src}")`;
  }

  /** @param {Array<{ selector?: string, kind?: string, src?: string }>} drops */
  function applyImageDrops(drops) {
    const wanted = new Set();
    for (const drop of Array.isArray(drops) ? drops : []) {
      if (!drop || !drop.selector) continue;
      wanted.add(String(drop.selector));
      applyImageDrop(drop);
    }
    // Undo is the absence of a drop: put back what the file itself had.
    for (const [selector, held] of imageDrops) {
      if (wanted.has(selector)) continue;
      /** @type {Element | null} */
      let element;
      try {
        element = document.querySelector(selector);
      } catch {
        element = null;
      }
      if (element) {
        if (held.kind === "img") element.setAttribute("src", held.original);
        else /** @type {HTMLElement} */ (element).style.backgroundImage = held.original;
      }
      imageDrops.delete(selector);
    }
  }

  document.addEventListener(
    "dragover",
    (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      const target = dropTargetAt(event.clientX, event.clientY);
      event.dataTransfer.dropEffect = target ? "copy" : "none";
      showDropBox(target ? target.element : null);
    },
    true,
  );

  document.addEventListener(
    "drop",
    (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
      // A file that misses an image changes nothing, and never navigates the frame.
      event.preventDefault();
      event.stopPropagation();
      showDropBox(null);
      const target = dropTargetAt(event.clientX, event.clientY);
      const file = imageFileOf(event.dataTransfer);
      if (!target || !file) return;
      post({
        type: "image-drop",
        selector: selectorFor(target.element),
        kind: target.kind,
        oldSource: target.source || "",
        file,
      });
    },
    true,
  );

  document.addEventListener(
    "dragleave",
    (event) => {
      if (event.target === document.documentElement) showDropBox(null);
    },
    true,
  );

  // The board sizes each artboard to its content, so the height reported here must
  // be the content's own, never the frame's: scrollHeight can only grow with the
  // frame, which leaves short sections as tall white columns. When the content
  // overflows, scrollHeight is exact; when it fits, the bottom of the body's own
  // boxes is. The floor stops a page whose overflow comes from something outside those
  // boxes from bouncing between the two answers.
  let reportedHeight = 0;
  let overflowFloor = 0;
  function contentHeight() {
    const root = document.documentElement;
    const body = document.body;
    const viewport = Math.round(innerHeightOf());
    if (root.scrollHeight > viewport + 1 || !body) {
      overflowFloor = Math.max(overflowFloor, root.scrollHeight);
      return root.scrollHeight;
    }
    let bottom = 0;
    for (const child of Array.from(body.children)) {
      if (child.closest("[data-easel-ui]") || /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(child.tagName)) continue;
      const style = getComputedStyle(child);
      if (style.display === "none" || style.position === "fixed") continue;
      const range = document.createRange();
      range.selectNode(child);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      bottom = Math.max(bottom, rect.bottom + (Number.parseFloat(style.marginBottom) || 0));
    }
    const bodyStyle = getComputedStyle(body);
    bottom +=
      (Number.parseFloat(bodyStyle.paddingBottom) || 0) +
      (Number.parseFloat(bodyStyle.borderBottomWidth) || 0) +
      (Number.parseFloat(bodyStyle.marginBottom) || 0) +
      window.scrollY;
    const measured = Math.ceil(Math.max(bottom, overflowFloor, 40));
    // Only a clear shrink counts; anything near the frame is the frame itself.
    return measured < viewport - 4 ? measured : viewport;
  }

  function reportSize() {
    // Until every stylesheet's viewport units are pinned, the page's height still
    // follows the frame's, and reporting it would grow the frame for nothing.
    if (sheetsPending.size > 0) return;
    const height = contentHeight();
    if (height === reportedHeight) return;
    reportedHeight = height;
    post({ type: "size", height, width: document.documentElement.scrollWidth });
  }

  let sizeTimer = 0;
  function scheduleSize() {
    window.clearTimeout(sizeTimer);
    sizeTimer = window.setTimeout(reportSize, 180);
  }

  // A page that sizes a band with `100vh` re-lays itself out when the review frame
  // grows, so "full height" could never settle: the taller viewport makes the page
  // taller again. Pinning viewport units to the height the item opened at keeps the
  // design exactly as it renders at its normal size, and the frame can then grow to
  // the full document height without the page reflowing.
  let pinnedVh = 0;
  function pinViewportUnits() {
    // The board may open the frame at any height; a design's 100vh (and svh, dvh, lvh)
    // always means one screen of the device it is shown on, whether the artboard is
    // grown to the whole page or scrolls inside a device frame.
    const deviceHeights = { ultrawide: 1440, desktop: 900, ipad: 1194, phone: 844 };
    const viewport = deviceHeights[deviceId] || Math.round(window.innerHeight);
    if (!viewport) return;
    pinnedVh = viewport;
    const pattern = /(-?\d*\.?\d+)(dvh|svh|lvh|vh)\b/g;
    const replace = (value) =>
      value.replace(pattern, (_match, amount) => `${((Number(amount) * viewport) / 100).toFixed(2)}px`);
    /** @param {CSSStyleDeclaration} style */
    const pinStyle = (style) => {
      for (const property of Array.from(style)) {
        const value = style.getPropertyValue(property);
        if (!/\d(dvh|svh|lvh|vh)\b/.test(value)) continue;
        const next = replace(value);
        if (next !== value) style.setProperty(property, next, style.getPropertyPriority(property));
      }
    };
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules) walk(rule.cssRules);
        if (rule.style) pinStyle(rule.style);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        if (sheet.cssRules) walk(sheet.cssRules);
      } catch {
        // The frame's origin is opaque, so a linked stylesheet's rules cannot be read.
        // The board, on this item's own origin, reads its text instead, and a pinned
        // copy takes its place.
        requestStylesheet(sheet);
      }
    }
    for (const element of Array.from(document.querySelectorAll("[style]"))) {
      if (element instanceof HTMLElement) pinStyle(element.style);
    }
  }

  /** @type {Map<string, any>} */
  const sheetsPending = new Map();
  const SHEET_WAIT_MS = 3000;
  function requestStylesheet(sheet) {
    const link = sheet.ownerNode;
    if (!link || link.nodeName !== "LINK" || !sheet.href || sheetsPending.has(sheet.href)) return;
    if (link.hasAttribute("data-easel-pinned")) return;
    sheetsPending.set(sheet.href, link);
    post({ type: "stylesheet", href: sheet.href });
    // A board that never answers must not hold the size back for good.
    window.setTimeout(() => {
      if (!sheetsPending.delete(sheet.href)) return;
      scheduleSize();
    }, SHEET_WAIT_MS);
  }

  function adoptStylesheet(href, text) {
    const link = sheetsPending.get(href);
    if (!link) return;
    sheetsPending.delete(href);
    if (text !== null && pinnedVh) {
      const absolute = (value) => {
        if (/^(data:|[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(value)) return value;
        try {
          return new URL(value, href).href;
        } catch {
          return value;
        }
      };
      const css = text
        .replace(
          /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
          (_match, quote, value) => `url(${quote}${absolute(value)}${quote})`,
        )
        .replace(/@import\s+(['"])([^'"]+)\1/g, (_match, quote, value) => `@import ${quote}${absolute(value)}${quote}`)
        .replace(
          /(-?\d*\.?\d+)(dvh|svh|lvh|vh)\b/g,
          (_match, amount) => `${((Number(amount) * pinnedVh) / 100).toFixed(2)}px`,
        );
      const style = document.createElement("style");
      style.setAttribute("data-easel-pinned", href);
      if (link.media) style.media = link.media;
      style.textContent = css;
      link.after(style);
      link.setAttribute("data-easel-pinned", "");
      link.disabled = true;
    }
    if (sheetsPending.size === 0) scheduleSize();
  }

  function auditLayout() {
    const root = document.documentElement;
    const overflow = root.scrollWidth > root.clientWidth + 2;
    post({
      type: "layout",
      overflow,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
    });
  }

  let auditTimer = 0;
  function scheduleAudit() {
    window.clearTimeout(auditTimer);
    auditTimer = window.setTimeout(auditLayout, 400);
  }

  // A phone or tablet shows no scrollbar; the preview should not either. Scrolling
  // still works. Only this served document changes, never the file.
  if (deviceId === "ipad" || deviceId === "phone") {
    const style = document.createElement("style");
    style.setAttribute("data-easel-ui", "scrollbars");
    style.textContent =
      "html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}";
    (document.head || document.documentElement).appendChild(style);
  }

  pinViewportUnits();
  if (document.readyState === "complete") {
    auditLayout();
    reportSize();
  } else {
    window.addEventListener("load", () => {
      window.setTimeout(auditLayout, 120);
      reportSize();
      window.setTimeout(reportSize, 600);
    });
  }
  // A page can finish laying out long after load (fonts, images, charts). Report the
  // height a few more times while that settles, then only on real resizes.
  let settleChecks = 0;
  const settle = window.setInterval(() => {
    settleChecks += 1;
    reportSize();
    if (settleChecks >= 15) window.clearInterval(settle);
  }, 1000);
  window.addEventListener("resize", scheduleAudit, { passive: true });
  window.addEventListener("resize", scheduleSize, { passive: true });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(scheduleAudit);
    observer.observe(document.documentElement);
    if (document.body) {
      const sizeObserver = new ResizeObserver(scheduleSize);
      sizeObserver.observe(document.body);
    }
  }

  post({ type: "ready", title: document.title, height: document.documentElement.scrollHeight });
})();
