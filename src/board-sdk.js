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

  /** @param {Element} element */
  function anchorOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      // Document coordinates keep the pin glued to the content as the page scrolls.
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      // Viewport coordinates are where the element is right now, which is where a
      // popover opened from this click belongs.
      vx: Math.round(rect.left),
      vy: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
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
        element = document.createElement("button");
        element.setAttribute("type", "button");
        element.className = "easel-pin";
        element.dataset.pin = pin.id;
        element.style.cssText = [
          "position:absolute",
          "display:grid",
          "place-content:center",
          "min-width:22px",
          "height:22px",
          "padding:0 5px",
          "border-radius:999px",
          "border:1px solid rgba(0,0,0,.35)",
          "background:#f4c95d",
          "color:#17130a",
          "font:600 11px/1 'Geist Mono',ui-monospace,Menlo,monospace",
          "box-shadow:0 3px 10px rgba(0,0,0,.35)",
          "cursor:pointer",
          "transition:background-color .18s ease, transform .18s ease",
          "z-index:2147483000",
        ].join(";");
        element.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = element.getBoundingClientRect();
          post({ type: "pin", id: pin.id, vx: Math.round(rect.left), vy: Math.round(rect.top) });
        });
        layer.appendChild(element);
      }
      element.textContent = String(pin.number);
      element.title = pin.text || "";
      element.dataset.state = pin.state || "draft";
      const colors = {
        queued: "#b9c0cf",
        seen: "#6fa8ff",
        working: "#f4c95d",
        done: "#8fe39e",
        sent: "#f4c95d",
      };
      if (pin.state === "draft") {
        // A pin that has not been sent is an outline; a sent one is filled, so the
        // artboard itself shows what the agent has already received.
        element.style.background = "rgba(15,17,21,.55)";
        element.style.color = "#f4c95d";
        element.style.border = "2px solid #f4c95d";
      } else {
        const color = colors[pin.state] || colors.sent;
        element.style.background = color;
        element.style.color = "#17130a";
        element.style.border = "1px solid rgba(0,0,0,.35)";
      }
      const anchor = resolution(pin);
      if (!anchor.visible) {
        element.style.display = "none";
        continue;
      }
      element.style.display = "grid";
      element.style.left = `${anchor.x - 10}px`;
      element.style.top = `${anchor.y - 10}px`;
    }
    for (const node of Array.from(layer.children)) {
      if (!(node instanceof HTMLElement) || !seen.has(node.dataset.pin)) node.remove();
    }
  }

  /** @param {{ selector?: string, x?: number, y?: number }} pin */
  function resolution(pin) {
    let rect = null;
    if (pin.selector) {
      const element = document.querySelector(pin.selector);
      if (element) rect = element.getBoundingClientRect();
    }
    if (!rect) return { visible: true, x: Number(pin.x) || 0, y: Number(pin.y) || 0 };
    if (rect.bottom < -40 || rect.top > window.innerHeight + 40 || rect.right < -40) return { visible: false };
    return { visible: true, x: rect.left + window.scrollX, y: rect.top + window.scrollY };
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
    element.style.transform = "scale(1.45)";
    element.style.boxShadow = "0 0 0 7px rgba(244,201,93,.22), 0 3px 10px rgba(0,0,0,.35)";
    window.setTimeout(() => {
      element.style.transform = "";
      element.style.boxShadow = "";
    }, 900);
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
      "border:1.5px solid rgba(244,201,93,.9)",
      "border-radius:3px",
      "background:rgba(244,201,93,.08)",
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
        const target = document.elementFromPoint(x, y);
        if (data.hover) {
          drawHover(target instanceof Element && !target.closest("[data-easel-ui]") ? target : null);
          return;
        }
        if (!(target instanceof Element) || target.closest("[data-easel-ui]")) return;
        if (target === document.body || target === document.documentElement) return;
        const selector = selectorFor(target);
        if (!selector) return;
        post({
          type: "select",
          selector,
          tag: target.tagName.toLowerCase(),
          text: snippet(target),
          ...anchorOf(target),
        });
      }
    },
    false,
  );

  for (const type of ["scroll", "resize"])
    window.addEventListener(type, schedulePins, { capture: true, passive: true });

  let reportedHeight = 0;
  function reportSize() {
    const height = Math.round(
      Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight),
    );
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
    const viewport = Math.round(window.innerHeight);
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
