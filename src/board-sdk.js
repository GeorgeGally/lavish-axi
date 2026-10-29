/* global CSS, Element, HTMLElement, ResizeObserver, document, parent, window */
// The board item SDK. It is deliberately small: the board owns the notes, the pins and
// the composer, so an item only reports a clicked element, draws the pins it is told
// about, and applies tune values as CSS custom properties.
(function () {
  /** @type {any} */
  const script = document.currentScript;
  const url = new URL(script ? script.src : window.location.href);
  const itemId = url.searchParams.get("item") || "";
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
      target.postMessage({ channel, item: itemId, ...message }, "*");
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
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
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
          post({ type: "pin", id: pin.id });
        });
        layer.appendChild(element);
      }
      element.textContent = String(pin.number);
      element.title = pin.text || "";
      element.dataset.state = pin.state || "draft";
      const colors = {
        draft: "#f4c95d",
        queued: "#b9c0cf",
        seen: "#6fa8ff",
        working: "#f4c95d",
        done: "#8fe39e",
      };
      element.style.background = colors[pin.state] || colors.draft;
      if (pin.state === "draft") element.style.borderStyle = "dashed";
      else element.style.borderStyle = "solid";
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

  function applyTune(values) {
    if (!values || typeof values !== "object") return;
    state.tuning = values;
    for (const [property, value] of Object.entries(values)) {
      if (!property.startsWith("--")) continue;
      document.documentElement.style.setProperty(property, String(value));
    }
  }

  /** @param {EventTarget | null} target */
  function isEditable(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        "a, button, input, select, textarea, label, summary, [contenteditable=true], [data-easel-action], [data-easel-ui]",
      ),
    );
  }

  document.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (isEditable(event.target) || event.altKey || event.metaKey || event.ctrlKey) return;
      const element = event.target;
      if (element === document.body || element === document.documentElement) return;
      const selected = window.getSelection();
      if (selected && String(selected).trim().length > 0) return;
      const selector = selectorFor(element);
      if (!selector) return;
      post({
        type: "select",
        selector,
        tag: element.tagName.toLowerCase(),
        text: snippet(element),
        ...anchorOf(element),
      });
    },
    true,
  );

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
  function pinViewportUnits() {
    const viewport = Math.round(window.innerHeight);
    if (!viewport) return;
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
