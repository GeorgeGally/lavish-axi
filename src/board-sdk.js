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
  const channel = "liesel";
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
      // An id anchors the path only when it names one element, or the path would land on
      // whichever element carries that id first.
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
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
      if (heading.closest("[data-liesel-ui]")) continue;
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
    let layer = document.getElementById("liesel-pins");
    if (layer) return layer;
    layer = document.createElement("div");
    layer.id = "liesel-pins";
    layer.setAttribute("data-liesel-ui", "pins");
    layer.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483000;";
    document.body.appendChild(layer);
    return layer;
  }

  let reportedParked = "";
  function renderPins() {
    const layer = pinLayer();
    const seen = new Set();
    const parked = [];
    for (const pin of state.pins) {
      // An answered pin is never drawn on the design: the board parks it in its gutter,
      // so the frame only reports where its anchor sits in this window now.
      if (pin.state === "done") {
        parked.push({ id: pin.id, number: pin.number, y: Math.round(resolution(pin).y - window.scrollY) });
        continue;
      }
      seen.add(pin.id);
      /** @type {HTMLElement | null} */
      let element = layer.querySelector(`[data-pin="${CSS.escape(pin.id)}"]`);
      if (!element) {
        element = document.createElement("div");
        element.className = "liesel-pin";
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
    const report = JSON.stringify(parked);
    if (report !== reportedParked) {
      reportedParked = report;
      post({ type: "parked", pins: parked });
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
    let layer = document.getElementById("liesel-hover");
    if (layer) return layer;
    layer = document.createElement("div");
    layer.id = "liesel-hover";
    layer.setAttribute("data-liesel-ui", "hover");
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
    window.dispatchEvent(new CustomEvent("liesel:tune", { detail: { ...values } }));
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

  /* ------------------------------------------------- inherited and page controls */

  // What a picked element takes from the elements it sits in, the way DevTools'
  // "Inherited from" does: typography and colour flow down until something sets them.
  const INHERITED_PROPERTIES = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "color",
    "text-align",
    "text-transform",
  ];
  // What each inherited property reads as when nothing on the page set it.
  /** @type {Record<string, (value: string) => boolean>} */
  const BROWSER_DEFAULT = {
    "font-family": (value) => /^"?times( new roman)?"?(,\s*serif)?$|^serif$/i.test(value.trim()),
    "font-size": (value) => value === "16px",
    "font-weight": (value) => value === "400",
    "font-style": (value) => value === "normal",
    "line-height": (value) => value === "normal",
    "letter-spacing": (value) => value === "normal" || value === "0px",
    color: (value) => /^rgba?\(0,\s*0,\s*0(,\s*1)?\)$/.test(value.trim()),
    "text-align": (value) => value === "start" || value === "left",
    "text-transform": (value) => value === "none",
  };
  const FONT_STACKS = [
    { value: "system-ui, -apple-system, sans-serif", label: "System sans" },
    { value: '"Helvetica Neue", Helvetica, Arial, sans-serif', label: "Helvetica" },
    { value: "Georgia, 'Times New Roman', serif", label: "Serif" },
    { value: "ui-monospace, SFMono-Regular, Menlo, monospace", label: "Mono" },
  ];

  /** @param {string} family */
  function fontName(family) {
    return (
      String(family || "")
        .split(",")[0]
        .replace(/["']/g, "")
        .trim() || "Font"
    );
  }

  /**
   * One control for a property, read from a computed style. Shared by inherited groups
   * and the page controls so a property looks the same wherever it shows.
   * @param {string} css @param {CSSStyleDeclaration} style @param {string} [label]
   */
  function propertyControl(css, style, label) {
    const value = style.getPropertyValue(css);
    const round = (raw) => Math.round(pxOf(raw) * 100) / 100;
    if (css === "color" || css === "background-color") {
      return {
        id: css,
        css,
        label: label || (css === "color" ? "Colour" : "Background"),
        type: "color",
        value: hexOf(value),
      };
    }
    if (css === "font-family") {
      const known = FONT_STACKS.some((stack) => stack.value === value);
      return {
        id: css,
        css,
        label: label || "Font",
        type: "select",
        value,
        options: known ? FONT_STACKS : [{ value, label: fontName(value) }, ...FONT_STACKS],
      };
    }
    if (css === "font-weight") {
      const weights = ["300", "400", "500", "600", "700", "800", "900"];
      return {
        id: css,
        css,
        label: label || "Weight",
        type: "select",
        value,
        options: (weights.includes(value) ? weights : [value, ...weights]).map((entry) => ({
          value: entry,
          label: entry,
        })),
      };
    }
    /** @type {Record<string, string[]>} */
    const choices = {
      "font-style": ["normal", "italic"],
      "text-align": ["start", "left", "center", "right", "justify"],
      "text-transform": ["none", "uppercase", "lowercase", "capitalize"],
    };
    /** @type {Record<string, string>} */
    const names = { "font-style": "Style", "text-align": "Align", "text-transform": "Case" };
    if (choices[css]) {
      const options = choices[css].includes(value) ? choices[css] : [value, ...choices[css]];
      return {
        id: css,
        css,
        label: label || names[css],
        type: "select",
        value,
        options: options.map((entry) => ({ value: entry, label: entry.charAt(0).toUpperCase() + entry.slice(1) })),
      };
    }
    if (css === "font-size") {
      const size = Math.max(8, Math.round(pxOf(value)));
      return {
        id: css,
        css,
        label: label || "Size",
        type: "number",
        unit: "px",
        value: String(size),
        min: 8,
        max: Math.max(32, size * 3),
        step: 1,
      };
    }
    if (css === "line-height") {
      const fontSize = pxOf(style.fontSize) || 16;
      const height = round(value) || Math.round(fontSize * 1.5);
      return {
        id: css,
        css,
        label: label || "Line height",
        type: "number",
        unit: "px",
        value: String(height),
        min: 8,
        max: Math.max(48, Math.round(height * 2)),
        step: 1,
      };
    }
    if (css === "letter-spacing") {
      return {
        id: css,
        css,
        label: label || "Tracking",
        type: "number",
        unit: "px",
        value: String(round(value)),
        min: -4,
        max: 12,
        step: 0.1,
      };
    }
    return null;
  }

  /**
   * The elements a picked one sits in, nearest first, up to and including body.
   * @param {Element} element
   */
  function ancestorsOf(element) {
    const chain = [];
    let node = element === document.body ? null : element.parentElement;
    while (node && node !== document.documentElement && chain.length < 24) {
      chain.push(node);
      if (node === document.body) break;
      node = node.parentElement;
    }
    return chain;
  }

  /** A breadcrumb's name: Page for body, otherwise the tag and its id or first class. @param {Element} element */
  function crumbLabel(element) {
    if (element === document.body) return "Page";
    const tag = element.tagName.toLowerCase();
    if (element.id) return `${tag}#${element.id}`.slice(0, 40);
    const first = String(element.getAttribute("class") || "")
      .split(/\s+/)
      .find((name) => name && !name.startsWith("liesel"));
    return first ? `${tag}.${first}`.slice(0, 40) : tag;
  }

  /**
   * For each element the picked one sits in, the inherited properties that element
   * itself sets and the picked one still takes from it. An element "sets" a property
   * when its value differs from the one it would inherit; body also owns anything
   * that reaches it with a value the browser would not have given.
   * @param {Element} element
   * @param {Element[]} chain
   */
  function inheritedGroups(element, chain) {
    if (chain.length === 0) return [];
    const styles = new Map();
    const styleOf = (node) => {
      if (!styles.has(node)) styles.set(node, getComputedStyle(node));
      return styles.get(node);
    };
    /** @type {Map<Element, string[]>} */
    const owned = new Map();
    for (const css of INHERITED_PROPERTIES) {
      const value = (node) => styleOf(node).getPropertyValue(css);
      // The picked element sets it itself: that is one of its own controls, not inherited.
      if (value(element) !== value(chain[0])) continue;
      let setter = null;
      for (const node of chain) {
        if (node === document.body) {
          const html = document.documentElement;
          const reached = value(node) !== value(html) || !BROWSER_DEFAULT[css](value(html));
          if (reached) setter = node;
          break;
        }
        const above = node.parentElement;
        if (above && value(node) !== value(above)) {
          setter = node;
          break;
        }
      }
      if (!setter) continue;
      owned.set(setter, [...(owned.get(setter) || []), css]);
    }
    return chain
      .filter((node) => owned.has(node))
      .map((node) => ({
        selector: selectorFor(node),
        label: crumbLabel(node),
        controls: /** @type {string[]} */ (owned.get(node))
          .map((css) => propertyControl(css, styleOf(node)))
          .filter(Boolean)
          .map((control) => ({ ...control, scope: "ancestor" })),
      }))
      .filter((group) => group.selector && group.controls.length > 0);
  }

  /** The whole page's controls, offered when Page (body) is picked. */
  function pageControls() {
    const body = document.body;
    const style = getComputedStyle(body);
    const html = getComputedStyle(document.documentElement);
    const clear = (value) => /^rgba?\(0,\s*0,\s*0,\s*0\)$|^transparent$/.test(String(value).trim());
    const background = clear(style.backgroundColor)
      ? clear(html.backgroundColor)
        ? "#ffffff"
        : hexOf(html.backgroundColor)
      : hexOf(style.backgroundColor);
    const width = Math.round(body.getBoundingClientRect().width);
    const maxWidth = style.maxWidth === "none" ? width : Math.round(pxOf(style.maxWidth));
    const side = Math.max(0, Math.round(pxOf(style.paddingLeft)));
    return [
      { id: "background-color", css: "background-color", label: "Background", type: "color", value: background },
      propertyControl("font-family", style, "Base font"),
      propertyControl("font-size", style, "Base size"),
      {
        id: "max-width",
        css: "max-width",
        label: "Max width",
        type: "number",
        unit: "px",
        value: String(maxWidth),
        min: 240,
        max: Math.max(1920, maxWidth),
        step: 1,
      },
      {
        id: "padding-inline",
        css: "padding-inline",
        label: "Side padding",
        type: "number",
        unit: "px",
        value: String(side),
        min: 0,
        max: Math.max(160, side * 3),
        step: 1,
      },
    ]
      .filter(Boolean)
      .map((control) => ({ ...control, scope: "element" }));
  }

  // Boxes that read as a section of the page: near their edge the selector prefers them
  // to the child under the pointer, so a whole section is easy to pick.
  const SECTION_TAGS = new Set(["SECTION", "HEADER", "FOOTER", "MAIN", "NAV", "ASIDE"]);
  const SECTION_EDGE = 12;
  // A child that runs to the section's edge keeps the pointer unless it is right on it.
  const SECTION_EDGE_SHARED = 4;

  /**
   * What the controls selector picks at a point: the element under it, a section when
   * the point is near that section's edge, then `depth` steps up toward the page.
   * @param {number} x @param {number} y @param {number} [depth]
   */
  function tunePick(x, y, depth = 0) {
    const leaf = document.elementFromPoint(x, y);
    let element =
      leaf instanceof Element && !leaf.closest("[data-liesel-ui]") && leaf !== document.documentElement
        ? leaf
        : document.body;
    const picked = element;
    /** @param {DOMRect} rect */
    const edgeDistance = (rect) => Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y);
    const leafEdge = edgeDistance(element.getBoundingClientRect());
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      if (!SECTION_TAGS.has(node.tagName)) continue;
      const distance = edgeDistance(node.getBoundingClientRect());
      const near = distance < SECTION_EDGE && (leafEdge >= SECTION_EDGE || distance < SECTION_EDGE_SHARED);
      if (near) {
        element = node;
        break;
      }
    }
    let steps = 0;
    while (steps < depth && element !== document.body && element.parentElement) {
      element = element.parentElement;
      steps += 1;
    }
    return { element, depth: steps, leaf: picked };
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

  /**
   * Inline overrides this SDK set, so Reset can take them all back off. Each records
   * whether it came from a selector naming several elements ("All like this"): an
   * element's own override always wins over the one it shares with its siblings.
   * @type {Map<Element, Map<string, { value: string, group: boolean }>>}
   */
  const elementStyles = new Map();
  /** Shared overrides by selector, so an element whose own one is taken off falls back to them. */
  /** @type {Map<string, Map<string, string>>} */
  const groupStyles = new Map();

  /** @param {string} selector */
  function elementsFor(selector) {
    try {
      return [...document.querySelectorAll(selector)].filter(
        (node) => (node instanceof HTMLElement || node instanceof SVGElement) && !node.closest("[data-liesel-ui]"),
      );
    } catch {
      return [];
    }
  }

  /** @param {Element} element @param {string} css */
  function groupValueFor(element, css) {
    let found = "";
    for (const [selector, values] of groupStyles) {
      const value = values.get(css);
      if (!value) continue;
      try {
        if (element.matches(selector)) found = value;
      } catch {
        // A stored selector this browser cannot parse names nothing.
      }
    }
    return found;
  }

  /** @param {string} selector @param {string} css @param {string} value */
  function applyElementStyle(selector, css, value) {
    if (!selector || !css) return;
    const elements = elementsFor(selector);
    const group = elements.length > 1;
    if (group) {
      const values = groupStyles.get(selector) || new Map();
      values.set(css, value);
      groupStyles.set(selector, values);
    }
    for (const element of elements) setElementStyle(/** @type {HTMLElement} */ (element), css, value, group);
  }

  /** @param {HTMLElement} element @param {string} css @param {string} value @param {boolean} group */
  function setElementStyle(element, css, value, group) {
    let applied = elementStyles.get(element);
    if (!applied) {
      applied = new Map();
      elementStyles.set(element, applied);
    }
    const current = applied.get(css);
    if (group && current && !current.group && current.value) return;
    let next = { value, group };
    // Its own override taken off: the element goes back to what its siblings share.
    if (!value) {
      const shared = groupValueFor(element, css);
      if (shared) next = { value: shared, group: true };
    }
    applied.set(css, next);
    element.style.setProperty(css, next.value);
    // A narrower page stays centred, the way a max-width page is built.
    if (element === document.body && css === "max-width") {
      applied.set("margin-inline", { value: next.value ? "auto" : "", group: false });
      element.style.setProperty("margin-inline", next.value ? "auto" : "");
    }
  }

  function resetElementStyles() {
    for (const [element, applied] of elementStyles) {
      for (const css of applied.keys()) /** @type {HTMLElement} */ (element).style.removeProperty(css);
    }
    elementStyles.clear();
    groupStyles.clear();
  }

  /** @param {Element} node */
  function classPart(node) {
    return [...node.classList]
      .filter((name) => /^[A-Za-z_-][\w-]*$/.test(name) && !name.startsWith("liesel"))
      .slice(0, 3)
      .map((name) => `.${CSS.escape(name)}`)
      .join("");
  }

  /** @param {Element} node how a node reads among its siblings: tag, classes and the tags it holds */
  function signatureOf(node) {
    return `${node.tagName}${classPart(node)}|${[...node.children].map((child) => child.tagName).join(",")}`;
  }

  /** @param {Element} node one step of a structural selector: its class when that names it among its siblings */
  function stepPart(node) {
    const parent = node.parentElement;
    const tag = node.tagName.toLowerCase();
    if (!parent) return tag;
    const classes = classPart(node);
    if (classes && [...parent.children].filter((child) => child.matches(`${tag}${classes}`)).length === 1)
      return `${tag}${classes}`;
    const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
    return sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag;
  }

  /**
   * The elements "like this one": the same spot inside each of a run of repeated
   * siblings (every card's text block in a rail), or failing that every element with
   * its tag and classes. Null when the element is one of a kind.
   * @param {Element} element
   */
  function likeSelectorFor(element) {
    if (!(element instanceof HTMLElement) || element === document.body) return null;
    /** @param {string} selector */
    const usable = (selector) => {
      const matches = elementsFor(selector);
      return matches.length > 1 && matches.length <= 300 && matches.includes(element) ? matches.length : 0;
    };
    const path = [];
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      const signature = signatureOf(node);
      const repeats = [...parent.children].filter((child) => signatureOf(child) === signature).length > 1;
      if (repeats) {
        const base = parent === document.body ? "body" : selectorFor(parent);
        const selector = [base, `${node.tagName.toLowerCase()}${classPart(node)}`, ...path].join(" > ");
        const count = base ? usable(selector) : 0;
        if (count) return { selector, count };
      }
      path.unshift(stepPart(node));
      if (path.length > 6) break;
    }
    const classes = classPart(element);
    if (classes) {
      const selector = `${element.tagName.toLowerCase()}${classes}`;
      const count = usable(selector);
      if (count) return { selector, count };
    }
    return null;
  }

  /**
   * Text inside a tuned box that sets this property itself, so changing the box will
   * not reach it: the panel names them and offers a jump to the first.
   * @param {Element} element @param {string} css
   */
  function overridesOf(element, css) {
    const value = (node) => getComputedStyle(node).getPropertyValue(css);
    const own = value(element);
    /** @type {Map<string, { selector: string, label: string, count: number }>} */
    const setters = new Map();
    const seen = new Set();
    let scanned = 0;
    for (const node of element.querySelectorAll("*")) {
      if (++scanned > 800) break;
      if (node.closest("[data-liesel-ui]")) continue;
      const ownText = [...node.childNodes].some((child) => child.nodeType === 3 && String(child.textContent).trim());
      if (!ownText || value(node) === own) continue;
      // Name the element that sets it, not each line of text that inherits it from there.
      let setter = node;
      while (setter.parentElement && setter.parentElement !== element && value(setter.parentElement) === value(setter))
        setter = setter.parentElement;
      if (seen.has(setter)) continue;
      seen.add(setter);
      const label = crumbLabel(setter);
      const entry = setters.get(label);
      if (entry) entry.count += 1;
      else setters.set(label, { selector: selectorFor(setter), label, count: 1 });
    }
    const items = [...setters.values()];
    return items.length > 0
      ? {
          total: items.length,
          items: items.slice(0, 3).map((entry) => ({
            selector: entry.selector,
            label: entry.count > 1 ? `${entry.label} (${entry.count})` : entry.label,
          })),
        }
      : null;
  }

  /** Where the panel's "All like this" reaches, outlined lightly in the design. */
  let groupOutline = "";
  function drawGroupOutline(selector = groupOutline) {
    groupOutline = selector;
    let layer = document.getElementById("liesel-group");
    if (!selector) {
      layer?.remove();
      return;
    }
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "liesel-group";
      layer.setAttribute("data-liesel-ui", "group");
      layer.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:2147482890";
      document.body.appendChild(layer);
    }
    layer.replaceChildren(
      ...elementsFor(selector)
        .slice(0, 120)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const box = document.createElement("div");
          box.style.cssText = [
            "position:absolute",
            "box-sizing:border-box",
            "border:1px dashed rgba(37,99,235,.7)",
            "border-radius:2px",
            `left:${rect.left + window.scrollX}px`,
            `top:${rect.top + window.scrollY}px`,
            `width:${rect.width}px`,
            `height:${rect.height}px`,
          ].join(";");
          return box;
        }),
    );
  }
  window.addEventListener("resize", () => {
    if (groupOutline) drawGroupOutline();
  });

  /** What the board tunes when a controls-selector click lands on a point in the page. */
  function reportTuneTarget(x, y, depth = 0) {
    const { element, leaf } = tunePick(x, y, depth);
    if (!(element instanceof Element)) return;
    // The breadcrumb runs down to what was under the pointer, so Down can get back to it.
    reportTuneFor(element, leaf.contains(element) ? element : leaf);
  }

  /**
   * @param {Element} element what is tuned
   * @param {Element} [trail] the deepest element of the breadcrumb, at or inside `element`
   */
  function reportTuneFor(element, trail = element) {
    const page = element === document.body;
    const owner = page ? null : gapOwnerOf(element);
    const parent = page ? null : element.parentElement;
    const chain = ancestorsOf(element);
    // Read the page's own values, not the ones this panel is currently previewing, so
    // Copy shows exactly what still differs from the file.
    /** @type {[HTMLElement, Map<string, { value: string, group: boolean }> | undefined][]} */
    const held = [...new Set([element, owner, ...chain].filter(Boolean))].map((node) => [
      /** @type {HTMLElement} */ (node),
      elementStyles.get(/** @type {Element} */ (node)),
    ]);
    for (const [node, applied] of held) {
      if (applied) for (const css of applied.keys()) node.style.removeProperty(css);
    }
    /** @type {any[]} */
    const controls = page ? pageControls() : elementTuneControls(element, owner);
    // A box's text settings reach only the text that does not set its own.
    if (!page && element.children.length > 0) {
      for (const control of controls) {
        if (
          control.scope !== "element" ||
          !["color", "line-height", "letter-spacing", "font-weight"].includes(control.css)
        )
          continue;
        const overrides = overridesOf(element, control.css);
        if (overrides) control.overrides = overrides;
      }
    }
    const like = page ? null : likeSelectorFor(element);
    const text = shortText(element.textContent).length > 0;
    const inherited = text ? inheritedGroups(element, chain) : [];
    const path = [];
    for (let node = trail; node && node !== element; node = node.parentElement) path.push(node);
    const crumbs = [...(element.contains(trail) ? path : []), element, ...chain]
      .reverse()
      .map((node) => ({ selector: selectorFor(node), label: crumbLabel(node) }))
      .filter((crumb) => crumb.selector);
    const selector = selectorFor(element);
    let named;
    try {
      named = document.querySelector(selector) === element;
    } catch {
      named = false;
    }
    const payload = {
      // A selector that would land on another element is never saved: the panel says so.
      ...(named ? {} : { error: "unnamed" }),
      like,
      crumbs,
      inherited,
      selector,
      // The gap belongs to this container, not to the clicked child.
      sectionSelector: owner ? selectorFor(owner) : "",
      label: page ? "Page" : targetLabel(element),
      sectionLabel: owner && owner !== element ? sectionLabel(owner) : "",
      // One click steps up: the panel offers the element this one sits in.
      parentSelector: parent ? selectorFor(parent) : "",
      parentLabel: parent ? targetLabel(parent) : "",
    };
    for (const [node, applied] of held) {
      if (applied) for (const [css, entry] of applied) node.style.setProperty(css, entry.value);
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
    if (!(element instanceof Element) || element.closest("[data-liesel-ui]")) return;
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
        // What a controls-selector click tuned and the board saved: applied again on every load,
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
        // Instant, or a page with scroll-behavior: smooth restarts its animation on
        // every wheel event and the scroll crawls.
        window.scrollBy({ left: dx, top: dy, behavior: "instant" });
        schedulePins();
        return;
      }
      if (data.type === "scroll-to") {
        // A locked partner scrolled: follow it to the same place.
        window.scrollTo({ left: Number(data.x) || 0, top: Number(data.y) || 0, behavior: "instant" });
        schedulePins();
        return;
      }
      if (data.type === "tune-spec") {
        post({ type: "tune-spec", controls: collectTuneControls() });
        return;
      }
      if (data.type === "tune-target") {
        reportTuneTarget(Number(data.x), Number(data.y), Math.max(0, Number(data.depth) || 0));
        return;
      }
      if (data.type === "outline-all") {
        drawGroupOutline(String(data.selector || ""));
        return;
      }
      if (data.type === "outline") {
        // A breadcrumb or inherited group hovered in the panel shows which element it is.
        /** @type {Element | null} */
        let element;
        try {
          element = data.selector ? document.querySelector(String(data.selector)) : null;
        } catch {
          element = null;
        }
        drawHover(element instanceof Element && !element.closest("[data-liesel-ui]") ? element : null);
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
          target instanceof Element && !target.closest("[data-liesel-ui]") && target !== document.documentElement;
        if (data.hover && data.tune) {
          // The controls selector outlines what a click would pick, the whole page included,
          // and says how far up it could go so the board's Up and Down keys stay in range.
          const picked = tunePick(x, y, Math.max(0, Number(data.depth) || 0));
          drawHover(picked.element);
          post({ type: "tune-depth", depth: picked.depth });
          return;
        }
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
  // `other` is Shift or Ctrl: with either held, a Cmd or Option press is never a tap.
  const held = { space: false, alt: false, meta: false, other: false };
  /**
   * @param {boolean} [blur] focus left the frame: what was held was let go somewhere else
   * @param {number} [at] the key event's time on the wall clock, so the board times a tap by
   *   the keys themselves and not by when a busy design got round to reporting them
   */
  function reportHeld(blur = false, at = performance.timeOrigin + performance.now()) {
    post({ type: "held", space: held.space, alt: held.alt, meta: held.meta, other: held.other, blur, at });
  }
  function readHeld(event, down) {
    // A space typed into a field is a space, never the hand.
    const space = event.code === "Space" && !editable(event.target);
    const next = {
      alt: Boolean(event.altKey),
      meta: Boolean(event.metaKey),
      other: Boolean(event.shiftKey || event.ctrlKey),
      space: space ? down : held.space,
    };
    if (next.alt === held.alt && next.meta === held.meta && next.space === held.space && next.other === held.other)
      return;
    Object.assign(held, next);
    reportHeld(false, performance.timeOrigin + event.timeStamp);
  }
  function editable(target) {
    return (
      target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    );
  }
  // The board's own keys - 0, 1, +, - and Escape, and Cmd +/-/0 - reach it from here
  // too, so the camera answers whichever document has focus.
  // Cmd-Z and Cmd-Shift-Z step the tune changes, and Tab switches the sidebar's tabs.
  // Cmd-D duplicates the design. Up and Down (or [ and ]) widen and narrow the controls selection.
  const BOARD_KEYS = new Set([
    "0",
    "1",
    "+",
    "=",
    "-",
    "Escape",
    "z",
    "Z",
    "Tab",
    "ArrowUp",
    "ArrowDown",
    "[",
    "]",
    "d",
    "D",
  ]);
  const MODIFIER_KEYS = new Set(["Meta", "Alt", "Control", "Shift"]);
  function forwardKey(event) {
    if (MODIFIER_KEYS.has(event.key) || event.code === "Space") return;
    // Escape typed in a field stays the field's too, but still turns a board mode off.
    if (event.key === "Escape" && editable(event.target)) {
      post({ type: "mode-off" });
      return;
    }
    const ours = BOARD_KEYS.has(event.key) && !event.altKey && !editable(event.target);
    if (!ours) return;
    // D is the board's only with Cmd: Cmd-D duplicates the design.
    if (/^d$/i.test(event.key) && !event.metaKey && !event.ctrlKey) return;
    // Tab would move focus inside the design; Cmd +/-/0 would zoom the browser window.
    if (event.key === "Tab") {
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
    } else if (event.metaKey || event.ctrlKey) {
      if (!/^z$/i.test(event.key)) event.preventDefault();
    }
    post({ type: "key", key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey });
  }
  document.addEventListener(
    "keydown",
    (event) => {
      // Space is the board's hand, so the page never scrolls or presses a button under it.
      if (event.code === "Space" && !editable(event.target)) event.preventDefault();
      readHeld(event, true);
      // Any other key pressed with Cmd or Option held is a shortcut, which the board must
      // hear so a lone Cmd or Option tap stays a toggle.
      if ((event.metaKey || event.altKey) && event.key !== "Meta" && event.key !== "Alt") post({ type: "chord" });
      forwardKey(event);
    },
    true,
  );
  document.addEventListener("keyup", (event) => readHeld(event, false), true);
  window.addEventListener("blur", () => {
    if (!held.space && !held.alt && !held.meta && !held.other) return;
    held.space = false;
    held.alt = false;
    held.meta = false;
    held.other = false;
    reportHeld(true);
  });
  // Cmd or Option held through a click, a drag or a scroll was a chord, never a toggle.
  for (const type of ["pointerdown", "wheel"])
    window.addEventListener(
      type,
      (event) => {
        const mouse = /** @type {MouseEvent} */ (event);
        if (mouse.metaKey || mouse.altKey) post({ type: "chord" });
      },
      { capture: true, passive: true },
    );

  // Where the pointer rests, so a gesture armed by a key outlines its target at once
  // instead of waiting for the next move. At most one report a frame.
  let pointerFrame = 0;
  /** @type {null | { x: number, y: number }} */
  let pointerAt = null;
  window.addEventListener(
    "pointermove",
    (event) => {
      pointerAt = { x: event.clientX, y: event.clientY };
      if (pointerFrame) return;
      pointerFrame = window.requestAnimationFrame(() => {
        pointerFrame = 0;
        if (pointerAt) post({ type: "pointer", ...pointerAt });
      });
    },
    { capture: true, passive: true },
  );

  // Option is the controls selector's key: inside a frame the browser would otherwise
  // start a text selection, follow a link clicked with Option, or download it. None of
  // that belongs to the board, so an Option press never reaches the page's own defaults.
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

  // Where the page itself is scrolled to, at most once a frame, so a design locked to
  // another (a duplicate and its original) can scroll as one.
  let scrollReportFrame = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollReportFrame) return;
      scrollReportFrame = window.requestAnimationFrame(() => {
        scrollReportFrame = 0;
        post({ type: "scrolled", x: Math.round(window.scrollX), y: Math.round(window.scrollY) });
      });
    },
    { passive: true },
  );

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
    if (!(node instanceof Element) || node.closest("[data-liesel-ui]") || node === document.documentElement)
      return null;
    return imageTargetAt(node);
  }

  function dropBoxLayer() {
    let layer = document.getElementById("liesel-drop");
    if (layer) return layer;
    layer = document.createElement("div");
    layer.id = "liesel-drop";
    layer.setAttribute("data-liesel-ui", "drop");
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
      // HTML files dropped on a design are new designs for the board, not page content.
      const pages = Array.from(event.dataTransfer.files || []).filter((entry) => /\.html?$/i.test(entry.name));
      if (!file && pages.length > 0) {
        post({ type: "html-drop", files: pages });
        return;
      }
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
      if (child.closest("[data-liesel-ui]") || /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(child.tagName)) continue;
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
    if (link.hasAttribute("data-liesel-pinned")) return;
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
      style.setAttribute("data-liesel-pinned", href);
      if (link.media) style.media = link.media;
      style.textContent = css;
      link.after(style);
      link.setAttribute("data-liesel-pinned", "");
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
    style.setAttribute("data-liesel-ui", "scrollbars");
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
