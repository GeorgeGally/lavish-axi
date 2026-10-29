/* global CSS, Element, HTMLElement, ResizeObserver, document, getComputedStyle, parent, window */
// The board item SDK. It is deliberately small: the board owns the notes, the pins and
// the composer, so an item only reports a clicked element, draws the pins it is told
// about, and applies tune values as CSS custom properties.
(function () {
  /** @type {any} */
  const script = document.currentScript;
  const url = new URL(script ? script.src : window.location.href);
  const itemId = url.searchParams.get("item") || "";
  const deviceId = url.searchParams.get("device") || "desktop";
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
          "transition:transform .16s ease, box-shadow .16s ease",
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
    if (!element) return;
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
    }
  }

  window.addEventListener(
    "message",
    (event) => {
      const target = parentWindow();
      if (!target || event.source !== target) return;
      const data = event.data;
      if (!data || data.channel !== channel) return;
      if (data.type === "pins") {
        state.pins = Array.isArray(data.pins) ? data.pins : [];
        schedulePins();
        return;
      }
      if (data.type === "focus") {
        const pin = state.pins.find((entry) => entry.id === String(data.id || ""));
        if (pin && data.reveal) {
          const anchor = resolution(pin);
          const top = anchor.y - window.scrollY;
          if (top < 40 || top > window.innerHeight - 40)
            window.scrollTo({ top: Math.max(0, anchor.y - window.innerHeight / 3) });
          schedulePins();
        }
        flashPin(String(data.id || ""));
        return;
      }
      if (data.type === "tune") {
        applyTune(data.values);
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
        const usable =
          target instanceof Element &&
          !target.closest("[data-easel-ui]") &&
          target !== document.body &&
          target !== document.documentElement;
        if (data.hover) {
          drawHover(!onPin && usable ? target : null);
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

  for (const type of ["scroll", "resize"])
    window.addEventListener(type, schedulePins, { capture: true, passive: true });

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
    const viewport = Math.round(window.innerHeight);
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
    // The board may open the frame at any height; a design's 100vh always means one
    // screen of the device it is shown on.
    const deviceHeights = { desktop: 900, ipad: 1112, phone: 844 };
    const viewport = deviceHeights[deviceId] || Math.round(window.innerHeight);
    if (!viewport) return;
    pinnedVh = viewport;
    const replace = (value) =>
      value.replace(/(\d*\.?\d+)(dvh|svh|lvh|vh)\b/g, (_match, amount, unit) => {
        if (unit !== "vh") return `${amount}${unit}`;
        return `${((Number(amount) * viewport) / 100).toFixed(2)}px`;
      });
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules) walk(rule.cssRules);
        const style = rule.style;
        if (!style) continue;
        for (const property of Array.from(style)) {
          const value = style.getPropertyValue(property);
          if (!/\d(dvh|svh|lvh|vh)\b/.test(value)) continue;
          const next = replace(value);
          if (next !== value) style.setProperty(property, next);
        }
      }
    };
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        if (!sheet.cssRules) continue;
        walk(sheet.cssRules);
      }
    } catch {
      // A stylesheet that cannot be read is left alone; the page still renders.
    }
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
