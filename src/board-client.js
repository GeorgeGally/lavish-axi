/* global CSS, document, window, location, IntersectionObserver, Element, HTMLElement */

const bootstrap = JSON.parse(document.getElementById("easel-board")?.textContent || "{}");
const key = String(bootstrap.key || "");
const cameraStorageKey = `easel:camera:${key}`;
const deviceStorageKey = `easel:device:${key}`;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;
const BAR_HEIGHT = 30;

// A variant renders at real device viewports and is scaled as one row, so the 1440
// artboard sits beside the iPad and phone versions at the same proportional size.
const DEVICES = [
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
  { id: "ipad", label: "iPad", width: 834, height: 1112 },
  { id: "phone", label: "Phone", width: 390, height: 844 },
];
const DESKTOP_WIDTH = 1440;
const FRAME_PADDING = {
  desktop: { top: 10, bottom: 34, side: 12 },
  ipad: { top: 16, bottom: 16, side: 16 },
  phone: { top: 12, bottom: 18, side: 9 },
};

const state = {
  tabs: Array.isArray(bootstrap.tabs) ? bootstrap.tabs : [],
  items: Array.isArray(bootstrap.items) ? bootstrap.items : [],
  pairs: Array.isArray(bootstrap.pairs) ? bootstrap.pairs : [],
  chat: Array.isArray(bootstrap.chat) ? bootstrap.chat : [],
  ended: Boolean(bootstrap.ended),
  activeTab: "",
  deviceMode: loadDeviceMode(),
  camera: { x: 0, y: 0, zoom: 1 },
  entries: new Map(),
  mounted: new Set(),
  overflow: new Set(),
  autoSpecs: new Map(),
};

const plane = document.getElementById("plane");
const canvas = document.getElementById("canvas");
const tabsElement = document.getElementById("tabs");
const zoomLabel = document.getElementById("zoomLabel");
/** @type {any} */
const presence = document.getElementById("presence");
const emptyElement = document.getElementById("empty");
/** @type {any} */
const composerInput = document.getElementById("composerInput");
/** @type {any} */
const sendButton = document.getElementById("send");
/** @type {any} */
const dockStatus = document.getElementById("dockStatus");
/** @type {any} */
const endedBanner = document.getElementById("ended");
const deviceBar = document.getElementById("devices");

/**
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {Array<Node | string>} [children]
 * @returns {any}
 */
function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "text") node.textContent = value;
    else if (name === "class") node.className = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) node.append(child);
  return node;
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function itemById(id) {
  return state.items.find((item) => item.id === id) || null;
}

function artboardKey(itemId, deviceId) {
  return `${itemId}::${deviceId}`;
}

function loadDeviceMode() {
  const stored = localStorage.getItem(deviceStorageKey);
  return ["all", ...DEVICES.map((device) => device.id)].includes(stored || "") ? String(stored) : "all";
}

function saveDeviceMode() {
  try {
    localStorage.setItem(deviceStorageKey, state.deviceMode);
  } catch {
    // A browser that refuses storage keeps the choice for the session.
  }
}

function visibleDevices() {
  return state.deviceMode === "all" ? DEVICES : DEVICES.filter((device) => device.id === state.deviceMode);
}

function deviceById(id) {
  return DEVICES.find((device) => device.id === id) || DEVICES[0];
}

function noteDevice(note) {
  return DEVICES.some((device) => device.id === note.device) ? note.device : "desktop";
}

function scaleFor(item) {
  return Math.max(0.02, item.w / DESKTOP_WIDTH);
}

function loadCamera() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(cameraStorageKey) || "null");
  } catch {
    stored = null;
  }
  const tab = stored?.tab && state.tabs.some((entry) => entry.id === stored.tab) ? stored.tab : state.tabs[0]?.id || "";
  const perTab = stored?.tabs && typeof stored.tabs === "object" ? stored.tabs : {};
  const saved = perTab[tab] || {};
  state.activeTab = tab;
  state.camera = {
    x: Number(saved.x) || 0,
    y: Number(saved.y) || 0,
    zoom: clamp(Number(saved.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
  };
}

function saveCamera() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(cameraStorageKey) || "{}");
  } catch {
    stored = {};
  }
  const perTab = stored.tabs && typeof stored.tabs === "object" ? stored.tabs : {};
  perTab[state.activeTab] = { ...state.camera };
  try {
    localStorage.setItem(cameraStorageKey, JSON.stringify({ tab: state.activeTab, tabs: perTab }));
  } catch {
    // A browser that refuses storage still has a working board this session.
  }
}

function panelWidth() {
  const chat = document.getElementById("chat");
  if (!chat || chat.classList.contains("collapsed")) return 0;
  return Math.min(380, Math.max(300, Math.round(window.innerWidth * 0.26)));
}

function applyCamera() {
  canvas.style.transform = `translate(${state.camera.x}px, ${state.camera.y}px) scale(${state.camera.zoom})`;
  zoomLabel.textContent = `${Math.round(state.camera.zoom * 100)}%`;
}

function activeItems() {
  return state.items.filter((item) => item.tab === state.activeTab);
}

function framedView() {
  return state.deviceMode !== "all";
}

function buildUnits() {
  const units = [];
  const seen = new Set();
  for (const item of activeItems()) {
    const pair = item.pair;
    if (!pair) {
      units.push({ key: item.id, items: [item], caption: item.caption || "", origin: { x: 0, y: 0 } });
      continue;
    }
    const key = pair.key;
    if (seen.has(key)) continue;
    seen.add(key);
    const members = activeItems().filter((entry) => entry.pair && entry.pair.key === key);
    members.sort((left, right) => (left.pair.role === "today" ? -1 : 1) - (right.pair.role === "today" ? -1 : 1));
    const caption = members.map((entry) => entry.caption).find(Boolean) || "";
    units.push({ key, items: members, caption, origin: { x: 0, y: 0 } });
  }
  return units;
}

function displayLabel(item) {
  if (item.pair) return item.pair.role === "today" ? "Today" : "Proposed";
  return item.label;
}

function unitPositions() {
  const positions = new Map();
  const units = buildUnits();
  const framed = framedView();
  const gap = framed ? 80 : 120;
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const unit of units) {
    const first = unit.items[0];
    let x = framed ? cursorX : first.x;
    let y = framed ? cursorY : first.y;
    const originX = x;
    const originY = y;
    for (const item of unit.items) {
      if (!framed && item !== first) y = first.y;
      positions.set(item.id, { x, y });
      const boards = artboardBoxes(item, 0, 0);
      const rowWidth =
        boards.reduce((total, board) => total + board.width, 0) +
        Math.max(0, boards.length - 1) * Math.round(48 * scaleFor(item));
      const rowHeightForItem = boards.reduce((tallest, board) => Math.max(tallest, board.height), 0);
      x += rowWidth + gap;
      rowHeight = Math.max(rowHeight, rowHeightForItem);
    }
    unit.origin = { x: originX, y: originY };
    if (framed) {
      cursorX = x;
      if (cursorX > 4600) {
        cursorX = 0;
        cursorY += rowHeight + gap;
        rowHeight = 0;
      }
    }
  }
  return { positions, units };
}

function artboardBoxes(item, originX, originY) {
  const scale = scaleFor(item);
  const gap = Math.round(48 * scale);
  const framed = framedView();
  let x = originX;
  const boards = [];
  for (const device of visibleDevices()) {
    const record = state.entries.get(artboardKey(item.id, device.id));
    const screenWidth = Math.round(device.width * scale);
    const pad = framed ? FRAME_PADDING[device.id] : { top: 0, bottom: 0, side: 0 };
    const screenHeight = framed
      ? Math.round(device.height * scale)
      : Math.round((record?.pageHeight || device.height) * scale);
    const width = screenWidth + pad.side * 2;
    const height = screenHeight + pad.top + pad.bottom + BAR_HEIGHT;
    boards.push({
      device,
      record,
      x,
      y: originY,
      width,
      height,
      scale,
      screenWidth,
      screenHeight,
      pad,
      framed,
    });
    x += width + gap;
  }
  return boards;
}

function artboardsFor(item) {
  const placed = unitPositions().positions.get(item.id) || { x: item.x, y: item.y };
  return artboardBoxes(item, placed.x, placed.y);
}

function boundsOf(items) {
  if (items.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of items) {
    const boards = artboardsFor(item);
    for (const board of boards) {
      left = Math.min(left, board.x);
      top = Math.min(top, board.y);
      right = Math.max(right, board.x + board.width);
      bottom = Math.max(bottom, board.y + board.height);
    }
  }
  if (!Number.isFinite(left)) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function fitTab(animate = true) {
  const bounds = boundsOf(activeItems());
  if (!bounds) {
    state.camera = { x: 0, y: 0, zoom: 1 };
  } else {
    const padding = 64;
    const availableWidth = window.innerWidth - padding * 2;
    const availableHeight = window.innerHeight - 56 - padding - 150;
    const zoom = clamp(Math.min(1, availableWidth / bounds.width, availableHeight / bounds.height), MIN_ZOOM, MAX_ZOOM);
    state.camera = {
      zoom,
      x: (window.innerWidth - bounds.width * zoom) / 2 - bounds.left * zoom,
      y: 56 + (availableHeight - bounds.height * zoom) / 2 - bounds.top * zoom,
    };
  }
  if (animate) canvas.style.transition = "transform 320ms cubic-bezier(.2,.8,.2,1)";
  applyCamera();
  saveCamera();
  if (animate) {
    setTimeout(() => {
      canvas.style.transition = "";
    }, 340);
  }
}

function renderTabs() {
  if (!tabsElement) return;
  tabsElement.replaceChildren(
    ...state.tabs.map((tab) => {
      const button = element("button", {
        class: "tab",
        type: "button",
        role: "tab",
        "aria-selected": String(tab.id === state.activeTab),
        text: tab.label,
      });
      button.addEventListener("click", () => setTab(tab.id));
      return button;
    }),
  );
}

function zoomToActualSize(itemId = "", deviceId = "") {
  const preferred = itemId ? { itemId, deviceId } : activeArtboard.itemId ? activeArtboard : null;
  const item = preferred ? itemById(preferred.itemId) : activeItems()[0];
  if (!item) return;
  const boards = artboardsFor(item);
  if (boards.length === 0) return;
  const board = (preferred && boards.find((entry) => entry.device.id === preferred.deviceId)) || boards[0];
  const available = window.innerWidth - panelWidth() - 80;
  const x = board.width > available ? 40 - board.x : (window.innerWidth - panelWidth() - board.width) / 2 - board.x;
  state.camera = { zoom: 1, x: Math.round(x), y: Math.round(74 - board.y) };
  canvas.style.transition = "transform 300ms cubic-bezier(.2,.8,.2,1)";
  applyCamera();
  saveCamera();
  setTimeout(() => {
    canvas.style.transition = "";
  }, 320);
}

function setTab(id) {
  if (!state.tabs.some((tab) => tab.id === id)) return;
  state.activeTab = id;
  renderTabs();
  syncItems();
  fitTab(false);
}

function renderDevices() {
  if (!deviceBar) return;
  const options = [{ id: "all", label: "All" }, ...DEVICES];
  deviceBar.replaceChildren(
    ...options.map((device) => {
      const button = element("button", {
        class: "device",
        type: "button",
        "data-device": device.id,
        "aria-pressed": String(state.deviceMode === device.id),
        text: device.label,
      });
      button.addEventListener("click", () => setDeviceMode(device.id));
      return button;
    }),
  );
}

function setDeviceMode(mode) {
  state.deviceMode = mode;
  saveDeviceMode();
  renderDevices();
  syncItems();
  fitTab();
}

function itemUrl(item, deviceId = "desktop") {
  return `/board/${encodeURIComponent(key)}/item/${encodeURIComponent(item.id)}/index.html?device=${encodeURIComponent(deviceId)}`;
}

function pairFor(id) {
  return state.pairs.find((pair) => pair.locked && (pair.a === id || pair.b === id)) || null;
}

/** @param {any} item @param {any} device */
function createArtboard(item, device) {
  const id = artboardKey(item.id, device.id);
  const article = element("article", {
    class: "item",
    "data-id": item.id,
    "data-device": device.id,
    "data-active": "true",
  });
  const bar = element("header", { class: "item-bar" });
  const dot = element("span", { class: "dot", "aria-hidden": "true" });
  const label = element("span", { class: "item-label", text: `${item.label} · ${device.width}` });
  const meta = element("span", { class: "item-meta" });
  bar.append(dot, label, meta);
  const pair = pairFor(item.id);
  if (pair) bar.append(element("span", { class: "pair-badge", text: "locked pair" }));
  const tuneButton = element("button", { class: "tune-toggle", type: "button", text: "tune" });
  tuneButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openTune(item.id, device.id);
  });
  bar.append(tuneButton);
  const frame = element("div", { class: "item-frame" });
  const iframe = element("iframe", {
    title: `${item.label} at ${device.width}`,
    sandbox: "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
  });
  iframe.style.width = `${device.width}px`;
  iframe.style.height = `${device.height}px`;
  iframe.dataset.src = itemUrl(item, device.id);
  iframe.addEventListener("load", () => {
    if (state.mounted.has(id)) {
      postPins(item.id, device.id);
      postTune(item.id, device.id);
    }
  });
  const screen = element("div", { class: "device-screen" });
  screen.append(iframe);
  const shield = element("div", { class: "annotate-shield", "aria-hidden": "true" });
  screen.append(shield);
  frame.append(screen);
  article.append(bar, frame);
  if (device.id === visibleDevices()[visibleDevices().length - 1]?.id) {
    const resize = element("div", { class: "item-resize", title: "Resize row" });
    article.append(resize);
    bindResize(resize, item.id);
  }
  canvas.append(article);
  mountObserver.observe(article);
  const record = { element: article, iframe, bar, label, meta, shield, pageHeight: 0, device };
  state.entries.set(id, record);
  bindAnnotateShield(record);
  applyArtboardLayout(item, device.id);
  bar.addEventListener("pointerdown", () => {
    activeArtboard = { itemId: item.id, deviceId: device.id };
  });
  bindDrag(article, bar, item.id);
  bar.addEventListener("dblclick", () => toggleZoom100(item.id, device.id));
  return record;
}

/** @param {any} item @param {string} deviceId */
function applyArtboardLayout(item, deviceId) {
  const record = state.entries.get(artboardKey(item.id, deviceId));
  if (!record) return;
  const board = artboardsFor(item).find((entry) => entry.device.id === deviceId);
  if (!board) return;
  const device = board.device;
  const scale = board.scale;
  const pageHeight = board.framed ? device.height : record.pageHeight || device.height;
  record.element.style.left = `${board.x}px`;
  record.element.style.top = `${board.y}px`;
  record.element.style.width = `${board.width}px`;
  record.element.style.height = `${board.height}px`;
  record.element.dataset.framed = String(board.framed);
  const frame = record.element.querySelector(".item-frame");
  if (frame) {
    frame.style.padding = board.framed ? `${board.pad.top}px ${board.pad.side}px ${board.pad.bottom}px` : "0";
  }
  const screen = record.element.querySelector(".device-screen");
  if (screen) {
    screen.style.width = `${board.screenWidth}px`;
    screen.style.height = `${board.screenHeight}px`;
    screen.style.borderRadius = board.framed
      ? device.id === "phone"
        ? "18px"
        : device.id === "ipad"
          ? "12px"
          : "3px"
      : "0";
  }
  record.iframe.style.width = `${device.width}px`;
  record.iframe.style.height = `${pageHeight}px`;
  record.iframe.style.transform = `scale(${scale})`;
  record.label.textContent = `${displayLabel(item)} · ${device.width}`;
  record.meta.textContent = [
    record.pageHeight ? `page ${record.pageHeight}` : "",
    state.overflow.has(artboardKey(item.id, deviceId)) ? "overflows" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  record.element.dataset.active = String(
    item.tab === state.activeTab && visibleDevices().some((d) => d.id === deviceId),
  );
  record.element.dataset.pair = String(Boolean(pairFor(item.id)));
  record.element.dataset.state = itemState(item);
}

/** @param {string} itemId */
function layoutItem(itemId) {
  const item = itemById(itemId);
  if (!item) return;
  for (const device of visibleDevices()) applyArtboardLayout(item, device.id);
}

function syncItems() {
  const liveArtboards = new Set();
  for (const item of state.items) {
    for (const device of visibleDevices()) {
      const id = artboardKey(item.id, device.id);
      liveArtboards.add(id);
      if (!state.entries.has(id)) createArtboard(item, device);
      else applyArtboardLayout(item, device.id);
    }
  }
  for (const [id, record] of state.entries) {
    const [itemId, deviceId] = id.split("::");
    const item = itemById(itemId);
    const visible = item && item.tab === state.activeTab && visibleDevices().some((device) => device.id === deviceId);
    record.element.dataset.active = String(Boolean(visible));
    if (!item) {
      mountObserver.unobserve(record.element);
      record.element.remove();
      state.entries.delete(id);
    } else if (visible && !liveArtboards.has(id)) {
      liveArtboards.add(id);
    }
  }
  emptyElement.hidden = activeItems().length > 0;
}

const mountObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      /** @type {any} */
      const article = entry.target;
      const id = artboardKey(article.dataset.id || "", article.dataset.device || "");
      const record = state.entries.get(id);
      if (!record) continue;
      if (!record.iframe.getAttribute("src")) record.iframe.setAttribute("src", record.iframe.dataset.src || "");
      state.mounted.add(id);
    }
  },
  { root: plane, rootMargin: "1200px" },
);

/** @param {string} itemId @param {string} deviceId @param {Record<string, unknown>} message */
function postToArtboard(itemId, deviceId, message) {
  const record = state.entries.get(artboardKey(itemId, deviceId));
  if (!record || !record.iframe.contentWindow) return;
  record.iframe.contentWindow.postMessage({ channel: "easel", item: itemId, device: deviceId, ...message }, "*");
}

function pinsFor(item, deviceId) {
  return (item.notes || [])
    .filter((note) => noteDevice(note) === deviceId)
    .map((note) => ({
      id: note.id,
      number: note.number,
      selector: note.selector,
      x: note.x,
      y: note.y,
      text: note.text || note.label,
      state: receiptFor(note),
    }));
}

function postPins(itemId, deviceId) {
  const item = itemById(itemId);
  if (!item) return;
  postToArtboard(itemId, deviceId, { type: "pins", pins: pinsFor(item, deviceId) });
}

function tuneCss(item, spec, values = item.tune) {
  const css = {};
  for (const control of spec) {
    const raw = values?.[control.id];
    if (raw === undefined || raw === "") continue;
    css[control.css] = control.type === "number" && control.unit ? `${raw}${control.unit}` : String(raw);
  }
  return css;
}

function tuneSpecFor(itemId) {
  const item = itemById(itemId);
  if (item && Array.isArray(item.tuneSpec) && item.tuneSpec.length > 0) return item.tuneSpec;
  return state.autoSpecs.get(itemId) || [];
}

function postTune(itemId, deviceId) {
  const item = itemById(itemId);
  const spec = tuneSpecFor(itemId);
  if (!item || spec.length === 0) return;
  postToArtboard(itemId, deviceId, { type: "tune", values: tuneCss(item, spec) });
}

function postTuneAll(itemId) {
  const item = itemById(itemId);
  if (!item) return;
  const spec = tuneSpecFor(itemId);
  for (const device of DEVICES) {
    postToArtboard(itemId, device.id, { type: "tune", values: tuneCss(item, spec) });
  }
}

function receiptFor(note) {
  if (!note.prompt_id) return "draft";
  const entry = state.chat.find((message) => message && message.prompt_id === note.prompt_id);
  if (!entry) return "queued";
  if (entry.done_at) return "done";
  if (entry.working_at) return "working";
  if (entry.delivered_at) return "seen";
  return "queued";
}

function itemState(item) {
  const states = (item.notes || []).map((note) => receiptFor(note));
  if (states.length === 0) return "";
  if (states.includes("draft")) return "note";
  if (states.includes("working")) return "working";
  if (states.includes("queued") || states.includes("seen")) return "seen";
  return "done";
}

function persist(items) {
  if (state.ended) return;
  fetch(`/api/boards/${encodeURIComponent(key)}/place`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  }).catch(() => {});
}

function bindDrag(article, handle, id) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, select, input")) return;
    event.preventDefault();
    const item = itemById(id);
    if (!item) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { x: item.x, y: item.y };
    const partnerPair = pairFor(id);
    const partnerId = partnerPair ? (partnerPair.a === id ? partnerPair.b : partnerPair.a) : null;
    const partner = partnerId ? itemById(partnerId) : null;
    const partnerOrigin = partner ? { x: partner.x, y: partner.y } : null;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const dx = (moveEvent.clientX - startX) / state.camera.zoom;
      const dy = (moveEvent.clientY - startY) / state.camera.zoom;
      item.x = Math.round(origin.x + dx);
      item.y = Math.round(origin.y + dy);
      layoutItem(id);
      if (partner && partnerOrigin) {
        partner.x = Math.round(partnerOrigin.x + dx);
        partner.y = Math.round(partnerOrigin.y + dy);
        layoutItem(partner.id);
      }
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      const changes = [{ id, x: item.x, y: item.y }];
      if (partner) changes.push({ id: partner.id, x: partner.x, y: partner.y });
      persist(changes);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

function bindResize(handle, id) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const item = itemById(id);
    if (!item) return;
    const startX = event.clientX;
    const origin = { w: item.w };
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      item.w = Math.round(Math.max(480, origin.w + (moveEvent.clientX - startX) / state.camera.zoom));
      layoutItem(id);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      persist([{ id, w: item.w }]);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

function bindPlane() {
  let panning = false;
  let start = null;
  plane.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target instanceof Element && event.target.closest(".item")) return;
    userAdjustedCamera = true;
    panning = true;
    start = { x: event.clientX, y: event.clientY, cameraX: state.camera.x, cameraY: state.camera.y };
    plane.dataset.panning = "true";
    plane.setPointerCapture(event.pointerId);
  });
  plane.addEventListener("pointermove", (event) => {
    if (!panning || !start) return;
    state.camera.x = start.cameraX + (event.clientX - start.x);
    state.camera.y = start.cameraY + (event.clientY - start.y);
    scheduleApplyCamera();
  });
  const end = () => {
    if (!panning) return;
    panning = false;
    start = null;
    plane.dataset.panning = "false";
    saveCamera();
  };
  plane.addEventListener("pointerup", end);
  plane.addEventListener("pointercancel", end);
  plane.addEventListener("wheel", handleBoardWheel, { passive: false });
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let cameraSaveTimer;
let userAdjustedCamera = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let initialFitTimer;

// An artboard's real page height only arrives after it loads, so the first fit uses
// the device heights. Refit as those arrive, and stop the moment the person moves the
// camera themselves.
function refitForMeasuredPages() {
  if (userAdjustedCamera) return;
  clearTimeout(initialFitTimer);
  initialFitTimer = setTimeout(() => fitTab(false), 350);
}
function scheduleCameraSave() {
  clearTimeout(cameraSaveTimer);
  cameraSaveTimer = setTimeout(saveCamera, 350);
}

/** @type {number} */
let cameraFrame = 0;

function scheduleApplyCamera() {
  if (cameraFrame) return;
  cameraFrame = window.requestAnimationFrame(() => {
    cameraFrame = 0;
    applyCamera();
  });
}

// Trackpad pinch arrives as ctrl+wheel; Chrome scales deltaY with deltaMode, so a
// line-based wheel would otherwise zoom ~16x slower than a pixel one.
function normalizedWheelDelta(event) {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
  return event.deltaY * scale;
}

function handleBoardWheel(event) {
  event.preventDefault();
  userAdjustedCamera = true;
  // A gesture must not fight an easing transition left over from a fit or a zoom click.
  canvas.style.transition = "";
  if (event.ctrlKey || event.metaKey) {
    const worldX = (event.clientX - state.camera.x) / state.camera.zoom;
    const worldY = (event.clientY - state.camera.y) / state.camera.zoom;
    state.camera.zoom = clamp(state.camera.zoom * Math.exp(-normalizedWheelDelta(event) * 0.012), MIN_ZOOM, MAX_ZOOM);
    state.camera.x = event.clientX - worldX * state.camera.zoom;
    state.camera.y = event.clientY - worldY * state.camera.zoom;
    scheduleApplyCamera();
    scheduleCameraSave();
    return;
  }
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
  state.camera.x -= event.deltaX * scale;
  state.camera.y -= event.deltaY * scale;
  scheduleApplyCamera();
  scheduleCameraSave();
}

function zoomAt(clientX, clientY, factor) {
  const worldX = (clientX - state.camera.x) / state.camera.zoom;
  const worldY = (clientY - state.camera.y) / state.camera.zoom;
  state.camera.zoom = clamp(state.camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  state.camera.x = clientX - worldX * state.camera.zoom;
  state.camera.y = clientY - worldY * state.camera.zoom;
  scheduleApplyCamera();
  scheduleCameraSave();
}

function zoomBy(factor) {
  userAdjustedCamera = true;
  zoomAt((window.innerWidth - panelWidth()) / 2, window.innerHeight / 2, factor);
}

let activeArtboard = { itemId: "", deviceId: "" };
/** @type {ReturnType<typeof setTimeout> | undefined} */
let clickTimer;
let lastZoom = { key: "" };
let metaHeld = false;
let spaceHeld = false;

function panModeActive() {
  return metaHeld || spaceHeld;
}

function updatePanMode() {
  const active = panModeActive();
  document.body.dataset.pan = String(active);
  for (const [, record] of state.entries) record.element.dataset.pan = String(active);
  if (active) {
    for (const [, record] of state.entries) postHit(record, {}, true);
  }
}

function isTextTarget(target) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable)
  );
}

function clearHover() {
  for (const [, record] of state.entries) postHit(record, {}, true);
}

function removeRecentDraft() {
  const entries = boardNotes();
  const latest = entries[entries.length - 1];
  if (!latest) return;
  const age = Date.now() - new Date(latest.note.at || 0).getTime();
  if (age > 900 || latest.note.prompt_id || String(latest.note.text || "").trim()) return;
  latest.item.notes = (latest.item.notes || []).filter((note) => note.id !== latest.note.id);
  persistNotes(latest.item.id, { immediate: true });
  renderChips();
  postPins(latest.item.id, noteDevice(latest.note));
}

function toggleZoom100(itemId, deviceId) {
  const boardKey = artboardKey(itemId, deviceId);
  if (lastZoom.key === boardKey && Math.abs(state.camera.zoom - 1) < 0.02) {
    lastZoom = { key: "" };
    fitTab();
    return;
  }
  lastZoom = { key: boardKey };
  zoomToActualSize(itemId, deviceId);
}

function annotatePoint(record, event) {
  const rect = record.iframe.getBoundingClientRect();
  const item = itemById(record.element.dataset.id || "");
  const scale = item ? scaleFor(item) : 1;
  return {
    x: Math.round((event.clientX - rect.left) / scale),
    y: Math.round((event.clientY - rect.top) / scale),
  };
}

function postHit(record, point, clear = false) {
  const itemId = record.element.dataset.id || "";
  const deviceId = record.element.dataset.device || "";
  if (clear) {
    postToArtboard(itemId, deviceId, { type: "hit", hover: true, x: -1, y: -1 });
    return;
  }
  postToArtboard(itemId, deviceId, { type: "hit", ...point });
}

function bindAnnotateShield(record) {
  const shield = record.shield;
  if (!shield) return;
  let frame = 0;
  let panning = false;
  let start = null;
  shield.addEventListener("pointerdown", (event) => {
    if (!panModeActive() || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    panning = true;
    start = { x: event.clientX, y: event.clientY, cameraX: state.camera.x, cameraY: state.camera.y };
    userAdjustedCamera = true;
    document.body.dataset.grabbing = "true";
    shield.setPointerCapture(event.pointerId);
    postHit(record, {}, true);
  });
  shield.addEventListener("pointermove", (event) => {
    activeArtboard = {
      itemId: record.element.dataset.id || "",
      deviceId: record.element.dataset.device || "",
    };
    if (panning && start) {
      state.camera.x = start.cameraX + (event.clientX - start.x);
      state.camera.y = start.cameraY + (event.clientY - start.y);
      scheduleApplyCamera();
      return;
    }
    if (panModeActive() || frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      postHit(record, { ...annotatePoint(record, event), hover: true });
    });
  });
  const endPan = () => {
    if (!panning) return;
    panning = false;
    start = null;
    document.body.dataset.grabbing = "false";
    saveCamera();
  };
  shield.addEventListener("pointerup", endPan);
  shield.addEventListener("pointercancel", endPan);
  shield.addEventListener("pointerleave", () => postHit(record, {}, true));
  shield.addEventListener("click", (event) => {
    const itemId = record.element.dataset.id || "";
    const deviceId = record.element.dataset.device || "";
    activeArtboard = { itemId, deviceId };
    if (panModeActive()) return;
    event.preventDefault();
    event.stopPropagation();
    const point = annotatePoint(record, event);
    // A double-click means "zoom", not two pins: hold the pin for the double-click
    // window and drop it if the second click arrives.
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => postHit(record, point), 280);
  });
  shield.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(clickTimer);
    removeRecentDraft();
    toggleZoom100(record.element.dataset.id || "", record.element.dataset.device || "");
  });
  shield.addEventListener(
    "wheel",
    (event) => {
      // In a device view the screen scrolls the page; in the flat All view the wheel
      // belongs to the plane. Pinch always zooms the board.
      // The shield sits inside the plane, so every branch must stop the event or the
      // plane's own handler pans (or double-zooms) on top of it.
      event.stopPropagation();
      if (!event.ctrlKey && !event.metaKey && framedView()) {
        event.preventDefault();
        postToArtboard(record.element.dataset.id || "", record.element.dataset.device || "", {
          type: "scroll",
          dx: event.deltaX,
          dy: event.deltaY,
        });
        return;
      }
      handleBoardWheel(event);
    },
    { passive: false },
  );
}

function setPresence(value) {
  const next = value || "waiting";
  const label = next === "listening" ? "agent listening" : next === "working" ? "agent working" : "nobody listening";
  const changed = next !== agentPresence;
  agentPresence = next;
  presence.dataset.state = next;
  presence.textContent = label;
  if (changed) renderChatPanel();
}

function showReply(entry) {
  if (!entry) return;
  renderChatPanel();
  dockStatus.textContent = "";
}

function markEnded() {
  state.ended = true;
  endedBanner.hidden = false;
  composerInput.disabled = true;
  sendButton.disabled = true;
  composerInput.placeholder = "Session ended";
}

const panelStorageKey = `easel:panel:${key}`;

function setChatCollapsed(collapsed) {
  const chat = document.getElementById("chat");
  const open = document.getElementById("chatOpen");
  if (!chat) return;
  chat.classList.toggle("collapsed", collapsed);
  if (open) open.hidden = !collapsed;
  const toggle = document.getElementById("chatToggle");
  if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
  try {
    localStorage.setItem(panelStorageKey, collapsed ? "closed" : "open");
  } catch {
    // Storage is optional; the panel still toggles this session.
  }
  applyCamera();
  if (!collapsed) renderChatPanel();
}

function loadChatCollapsed() {
  try {
    return localStorage.getItem(panelStorageKey) === "closed";
  } catch {
    return false;
  }
}

function randomId() {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function boardNotes() {
  const entries = [];
  for (const item of state.items) {
    for (const note of item.notes || []) entries.push({ item, note });
  }
  return entries.sort((left, right) => left.note.number - right.note.number);
}

let nextNumber = 0;

function nextNoteNumber() {
  const highest = boardNotes().reduce((value, entry) => Math.max(value, entry.note.number || 0), 0);
  nextNumber = Math.max(nextNumber, highest) + 1;
  return nextNumber;
}

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const noteTimers = new Map();

function persistNotes(itemId, { immediate = false } = {}) {
  const item = itemById(itemId);
  if (!item || state.ended) return;
  const pending = noteTimers.get(itemId);
  if (pending) clearTimeout(pending);
  const write = () => {
    noteTimers.delete(itemId);
    fetch(`/api/boards/${encodeURIComponent(key)}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: itemId, notes: item.notes || [] }),
    }).catch(() => {});
  };
  if (immediate) write();
  else noteTimers.set(itemId, setTimeout(write, 450));
}

function messageState(entry, note) {
  if (entry?.prompt_id && sendingPrompts.has(entry.prompt_id)) return "sending";
  if (note?.prompt_id && sendingPrompts.has(note.prompt_id)) return "sending";
  if (!note) return "sent";
  if (entry?.done_at) return "replied";
  if (entry?.delivered_at) return "received";
  return "sent";
}

let agentPresence = "waiting";

function formatTime(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

function liveNote(noteId) {
  for (const item of state.items) {
    const note = (item.notes || []).find((entry) => entry.id === noteId);
    if (note) return { item, note };
  }
  return null;
}

function noteByPromptId(promptId) {
  if (!promptId) return null;
  return boardNotes().find(({ note }) => note.prompt_id === promptId) || null;
}

function designHeading(item, note) {
  const width = note ? deviceById(noteDevice(note)).width : 0;
  return width && width !== 1440 ? `${item.label} · ${width}` : item.label;
}

/** @param {any} entry */
function agentRow(entry) {
  const row = element("article", { class: "entry entry-agent" });
  row.title = formatTime(entry.at);
  row.append(element("div", { class: "entry-text", text: String(entry.text || "") }));
  return row;
}

/** @param {any} entry @param {any} matched */
function userRow(entry, matched) {
  const { item, note } = matched || {};
  const state = messageState(entry, note);
  const row = element("article", { class: "entry", "data-note": note ? note.id : "", "data-state": state });
  row.title = formatTime(entry.at);
  if (note) row.append(element("span", { class: "entry-number", text: String(note.number) }));
  row.append(element("div", { class: "entry-text", text: String(entry.text || "") }));
  const quiet = state === "sending" ? "Sending" : state === "sent" && agentPresence === "waiting" ? "Not read yet" : "";
  if (quiet) row.append(element("span", { class: "entry-state", text: quiet }));
  if (note) row.addEventListener("click", () => focusPinOnBoard(item, note));
  return row;
}

// Renumber notes as one board-wide sequence; older boards can carry duplicates, which
// makes "pin 3" ambiguous between two artboards.
function ensureUniqueNumbers() {
  const entries = boardNotes();
  if (entries.length === 0) return;
  const needsFix = entries.some(({ note }, index) => (Number(note.number) || 0) !== index + 1);
  if (!needsFix) return;
  const touched = new Set();
  entries.forEach(({ item, note }, index) => {
    if (note.number !== index + 1) {
      note.number = index + 1;
      touched.add(item.id);
    }
  });
  for (const itemId of touched) persistNotes(itemId, { immediate: true });
  nextNumber = entries.length;
}

function renderChatPanel() {
  const log = document.getElementById("chatLog");
  if (!log) return;
  const rows = [];
  let lastDesign = "";
  for (const entry of state.chat) {
    if (!entry) continue;
    if (entry.role === "agent") {
      rows.push(agentRow(entry));
      continue;
    }
    const matched = noteByPromptId(entry.prompt_id);
    if (matched) {
      const heading = designHeading(matched.item, matched.note);
      if (heading !== lastDesign) {
        rows.push(element("h3", { class: "chat-group", text: heading }));
        lastDesign = heading;
      }
    }
    rows.push(userRow(entry, matched));
  }
  if (rows.length === 0) rows.push(element("p", { class: "chat-empty", text: "No notes yet." }));
  log.replaceChildren(...rows);
  log.scrollTop = log.scrollHeight;
  renderDrafts();
}

function renderDrafts() {
  const container = document.getElementById("chatDrafts");
  if (!container) return;
  const drafts = boardNotes().filter(({ note }) => !note.prompt_id);
  container.replaceChildren(
    ...drafts.map(({ item, note }) => {
      const card = element("article", { class: "draft", "data-note": note.id });
      card.append(element("div", { class: "draft-name", text: designHeading(item, note) }));
      const input = element("textarea", { class: "draft-input", rows: "2", placeholder: "What should change?" });
      input.value = note.text || "";
      input.addEventListener("input", () => {
        const live = liveNote(note.id);
        if (live) live.note.text = input.value;
        persistNotes(item.id);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          sendNoteNow(note.id);
        }
      });
      const tools = element("div", { class: "draft-tools" });
      const remove = element("button", { class: "draft-remove", type: "button", text: "×", "aria-label": "Remove" });
      remove.addEventListener("click", () => {
        item.notes = (item.notes || []).filter((entry) => entry.id !== note.id);
        persistNotes(item.id, { immediate: true });
        renderChatPanel();
        postPins(item.id, noteDevice(note));
      });
      const sendOne = element("button", { class: "draft-send", type: "button", text: "Send" });
      sendOne.textContent = "Send";
      sendOne.addEventListener("click", () => sendNoteNow(note.id));
      tools.append(remove, sendOne);
      card.append(input, tools);
      return card;
    }),
  );
}

function renderChips() {
  renderChatPanel();
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let flashTimer;
function focusNote(noteId, anchor = null) {
  const found = boardNotes().find((candidate) => candidate.note.id === noteId);
  if (!found) return;
  const { item, note } = found;
  if (anchor) {
    note.vx = Math.round(Number(anchor.vx) || 0);
    note.vy = Math.round(Number(anchor.vy) || 0);
  }
  if (item.tab !== state.activeTab) setTab(item.tab);
  postToArtboard(item.id, noteDevice(note), { type: "focus", id: noteId });
  /** @type {any} */
  const row = document.getElementById("chatLog")?.querySelector(`[data-note="${CSS.escape(noteId)}"]`);
  if (row) {
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    row.dataset.flash = "true";
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      delete row.dataset.flash;
    }, 1400);
  }
  if (!note.prompt_id) showNoteWindow(item, note);
}

function focusPinOnBoard(item, note) {
  if (!item || !note) return;
  if (item.tab !== state.activeTab) setTab(item.tab);
  const deviceId = noteDevice(note);
  zoomToActualSize(item.id, deviceId);
  const board = artboardsFor(item).find((entry) => entry.device.id === deviceId);
  if (!board) return;
  const scale = scaleFor(item);
  state.camera.x = Math.round((window.innerWidth - panelWidth()) / 2 - (board.x + note.x * scale));
  state.camera.y = Math.round(56 + (window.innerHeight - 56) / 2 - (board.y + note.y * scale));
  applyCamera();
  saveCamera();
  postToArtboard(item.id, deviceId, { type: "focus", id: note.id });
}

/** @type {any} */
let noteWindow = null;

function closeNoteWindow(keep = false) {
  if (!noteWindow) return;
  const noteId = noteWindow.dataset.note || "";
  noteWindow.remove();
  noteWindow = null;
  if (!keep && noteId) discardEmptyNote(noteId);
}

function discardEmptyNote(noteId) {
  const live = liveNote(noteId);
  if (!live || live.note.prompt_id || String(live.note.text || "").trim()) return;
  live.item.notes = (live.item.notes || []).filter((entry) => entry.id !== noteId);
  persistNotes(live.item.id, { immediate: true });
  renderChatPanel();
  postPins(live.item.id, noteDevice(live.note));
}

function sendNoteNow(noteId) {
  const live = liveNote(noteId);
  if (!live || state.ended) return;
  const { item, note } = live;
  const text = String(note.text || "").trim();
  if (!text) return;
  const promptId = randomId();
  note.prompt_id = promptId;
  sendingPrompts.add(promptId);
  const prompt = {
    uid: randomId(),
    prompt_id: promptId,
    prompt: text,
    selector: note.selector,
    text: note.label,
    tag: "pin",
    item: { id: item.id, label: item.label },
    pin: { id: note.id, number: note.number, viewport: deviceById(noteDevice(note)).width },
  };
  fetch(`/api/${encodeURIComponent(key)}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts: [prompt], domSnapshot: "" }),
  })
    .then((response) => {
      if (!response.ok) throw new Error("not accepted");
      sendingPrompts.delete(promptId);
      persistNotes(item.id, { immediate: true });
      renderChatPanel();
      postPins(item.id, noteDevice(note));
      closeNoteWindow();
    })
    .catch(() => {
      sendingPrompts.delete(promptId);
      delete note.prompt_id;
      renderChatPanel();
      dockStatus.textContent = "Could not reach the agent. Your note is still here.";
    });
}

/** @param {any} item @param {any} note */
function showNoteWindow(item, note) {
  closeNoteWindow();
  const record = state.entries.get(artboardKey(item.id, noteDevice(note)));
  if (!record) return;
  const rect = record.iframe.getBoundingClientRect();
  const scale = scaleFor(item);
  // Mirror of popoverPosition in src/board-geometry.js (this file is served raw).
  const vx = note.vx !== undefined ? Number(note.vx) || 0 : Number(note.x) || 0;
  const vy = note.vy !== undefined ? Number(note.vy) || 0 : Number(note.y) || 0;
  const anchorLeft = rect.left + vx * scale;
  const anchorTop = rect.top + vy * scale;
  const cardWidth = 290;
  const cardHeight = 190;
  const margin = 16;
  const left = Math.min(Math.max(anchorLeft + 18, margin), Math.max(margin, window.innerWidth - cardWidth - margin));
  const fitsBelow = anchorTop + cardHeight + margin <= window.innerHeight;
  const top = fitsBelow
    ? Math.max(70, anchorTop - 6)
    : Math.min(Math.max(anchorTop - cardHeight - 12, 70), Math.max(70, window.innerHeight - cardHeight - margin));
  noteWindow = element("div", { class: "note-window", "data-note": note.id });
  noteWindow.style.left = `${left}px`;
  noteWindow.style.top = `${top}px`;
  const head = element("div", { class: "note-window-head" });
  head.append(
    element("span", { class: "chip-number", text: String(note.number) }),
    element("span", { class: "note-window-title", text: `${item.label} · ${deviceById(noteDevice(note)).width}` }),
  );
  const closeX = element("button", { class: "note-window-x", type: "button", text: "×", "aria-label": "Close" });
  closeX.addEventListener("click", () => closeNoteWindow());
  head.append(closeX);
  const textarea = element("textarea", { class: "note-window-input", rows: "2", placeholder: "What should change?" });
  textarea.value = note.text || "";
  textarea.addEventListener("input", () => {
    const live = liveNote(note.id);
    if (live) live.note.text = textarea.value;
    const draft = /** @type {any} */ (
      document.getElementById("chatDrafts")?.querySelector(`[data-note="${CSS.escape(note.id)}"] textarea`)
    );
    if (draft) draft.value = textarea.value;
    persistNotes(item.id);
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeNoteWindow();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendNoteNow(note.id);
    }
  });
  const actions = element("div", { class: "note-window-actions" });
  const existedWithText = Boolean(String(note.text || "").trim());
  const remove = element("button", { class: "note-window-remove", type: "button", text: "Remove" });
  remove.hidden = !existedWithText || Boolean(note.prompt_id);
  remove.addEventListener("click", () => {
    const live = liveNote(note.id);
    if (live) {
      live.item.notes = (live.item.notes || []).filter((entry) => entry.id !== note.id);
      persistNotes(live.item.id, { immediate: true });
      renderChatPanel();
      postPins(live.item.id, noteDevice(live.note));
    }
    closeNoteWindow(true);
  });
  actions.append(remove);
  const queue = element("button", { class: "note-window-queue", type: "button", text: "Queue" });
  queue.addEventListener("click", () => {
    const live = liveNote(note.id);
    if (live) live.note.text = textarea.value;
    persistNotes(item.id, { immediate: true });
    renderChatPanel();
    closeNoteWindow(true);
  });
  const send = element("button", {
    class: "note-window-send",
    type: "button",
    text: note.prompt_id ? "Sent" : "Send now",
  });
  send.disabled = Boolean(note.prompt_id);
  send.addEventListener("click", () => {
    const live = liveNote(note.id);
    if (live) live.note.text = textarea.value;
    sendNoteNow(note.id);
  });
  actions.append(queue, send);
  noteWindow.append(head, textarea, actions);
  document.body.append(noteWindow);
  textarea.focus();
}

/** @param {any} item @param {any} payload @param {string} deviceId */
function addNote(item, payload, deviceId) {
  const live = itemById(item.id) || item;
  const note = {
    id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    number: nextNoteNumber(),
    label: String(payload.text || "").slice(0, 90),
    selector: payload.selector,
    tag: payload.tag,
    device: deviceId,
    text: "",
    x: Math.round(Number(payload.x) || 0),
    y: Math.round(Number(payload.y) || 0),
    vx: Math.round(Number(payload.vx) || 0),
    vy: Math.round(Number(payload.vy) || 0),
    at: new Date().toISOString(),
  };
  live.notes = [...(live.notes || []), note];
  persistNotes(live.id, { immediate: true });
  renderChips();
  postPins(live.id, deviceId);
  focusNote(note.id);
}

function send() {
  if (state.ended) return;
  const message = composerInput.value.trim();
  const drafts = boardNotes().filter(({ note }) => !note.prompt_id && String(note.text || "").trim());
  if (!message && drafts.length === 0) return;
  const sent = [];
  /** @type {any[]} */
  const prompts = drafts.map(({ item, note }) => {
    const promptId = randomId();
    note.prompt_id = promptId;
    sent.push({ item, note, promptId });
    return {
      uid: randomId(),
      prompt_id: promptId,
      prompt: String(note.text || "").trim(),
      selector: note.selector,
      text: note.label,
      tag: "pin",
      item: { id: item.id, label: item.label },
      pin: { id: note.id, number: note.number, viewport: deviceById(noteDevice(note)).width },
    };
  });
  if (message) prompts.push({ uid: randomId(), prompt: message, tag: "message" });
  for (const entry of sent) sendingPrompts.add(entry.promptId);
  if (sent.length > 0) renderChatPanel();
  sendButton.disabled = true;
  fetch(`/api/${encodeURIComponent(key)}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts, domSnapshot: "" }),
  })
    .then((response) => {
      if (!response.ok) throw new Error("not accepted");
      for (const entry of sent) sendingPrompts.delete(entry.promptId);
      composerInput.value = "";
      autosize();
      for (const itemId of new Set(sent.map((entry) => entry.item.id))) persistNotes(itemId, { immediate: true });
      renderChips();
      for (const [id] of state.entries) {
        const separator = id.lastIndexOf("::");
        postPins(id.slice(0, separator), id.slice(separator + 2));
      }
      dockStatus.textContent = "Sent.";
      setTimeout(() => {
        if (dockStatus.textContent === "Sent.") dockStatus.textContent = "";
      }, 1800);
    })
    .catch(() => {
      for (const entry of sent) {
        sendingPrompts.delete(entry.promptId);
        delete entry.note.prompt_id;
      }
      renderChips();
      dockStatus.textContent = "Could not reach the agent. Your notes are still here.";
    })
    .finally(() => {
      sendButton.disabled = state.ended;
    });
}

function autosize() {
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(200, composerInput.scrollHeight + 2)}px`;
}

let tuneItemId = "";
let tuneDeviceId = "";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let tuneSaveTimer;

function openTune(itemId, deviceId) {
  const item = itemById(itemId);
  if (!item) return;
  tuneItemId = itemId;
  tuneDeviceId = deviceId;
  const spec = tuneSpecFor(itemId);
  for (const control of spec) {
    if (item.tune[control.id] === undefined || item.tune[control.id] === "") {
      item.tune[control.id] = control.value ?? "";
    }
  }
  const panel = document.getElementById("tune");
  if (panel) panel.hidden = false;
  renderTune();
  if (spec.length === 0) postToArtboard(itemId, deviceId, { type: "tune-spec" });
}

function closeTune() {
  const panel = document.getElementById("tune");
  if (panel) panel.hidden = true;
  tuneItemId = "";
}

function specGroups(spec) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const control of spec) {
    const group = control.group || "Controls";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(control);
  }
  return groups;
}

function renderTune() {
  const item = itemById(tuneItemId);
  if (!item) return;
  const sub = document.getElementById("tuneSub");
  if (sub) sub.textContent = `${item.file} · ${deviceById(tuneDeviceId).width}`;
  const body = document.getElementById("tuneBody");
  if (!body) return;
  const spec = tuneSpecFor(tuneItemId);
  if (spec.length === 0) {
    body.replaceChildren(
      element("p", {
        class: "tune-empty",
        text: `Reading ${item.file} for CSS custom properties...`,
      }),
    );
  } else {
    const nodes = [];
    const grouped = spec.some((control) => control.group);
    for (const [group, controls] of specGroups(spec)) {
      if (grouped) nodes.push(element("div", { class: "tune-group-name", text: group }));
      for (const control of controls) nodes.push(createTuneControl(item, control));
    }
    body.replaceChildren(...nodes);
  }
  for (const id of ["tuneSave", "tuneCopy", "tuneReset"]) {
    const button = /** @type {any} */ (document.getElementById(id));
    if (button) button.disabled = spec.length === 0;
  }
  renderVersions(item, spec);
}

function createTuneControl(item, control) {
  const wrapper = element("div", { class: "tune-control" });
  const valueLabel = element("span", { class: "tune-control-value", text: String(item.tune[control.id] ?? "") });
  const label = element("label", { class: "tune-control-label" });
  label.append(element("span", { text: control.label }), valueLabel);
  wrapper.append(label);
  const apply = (raw) => {
    const live = itemById(item.id) || item;
    live.tune[control.id] = raw;
    item.tune = live.tune;
    valueLabel.textContent = String(raw);
    postTuneAll(live.id);
    persistTune(live.id);
  };
  if (control.type === "color") {
    const input = element("input", { type: "color" });
    input.value = item.tune[control.id] || "#000000";
    input.addEventListener("input", () => apply(input.value));
    wrapper.append(input);
  } else if (control.type === "select") {
    const select = element("select", {});
    for (const option of control.options || []) {
      select.append(element("option", { value: option.value, text: option.label }));
    }
    select.value = String(item.tune[control.id] ?? "");
    select.addEventListener("change", () => apply(select.value));
    wrapper.append(select);
  } else {
    const value = Number(item.tune[control.id] ?? control.value ?? 0);
    const max = control.max !== undefined && control.max > 0 ? control.max : Math.max(64, Math.ceil(value * 3 || 64));
    const input = element("input", {
      type: "range",
      min: String(control.min ?? 0),
      max: String(max),
      step: String(control.step ?? 1),
    });
    input.value = String(value);
    input.addEventListener("input", () => apply(input.value));
    wrapper.append(input);
  }
  return wrapper;
}

function flushTune(item) {
  if (!item || state.ended) return Promise.resolve(false);
  return fetch(`/api/boards/${encodeURIComponent(key)}/tune`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item: item.id, values: item.tune }),
  })
    .then((response) => response.ok)
    .catch(() => false);
}

function persistTune(itemId) {
  clearTimeout(tuneSaveTimer);
  tuneSaveTimer = setTimeout(() => flushTune(itemById(itemId)), 350);
}

function renderVersions(item, spec) {
  const container = document.getElementById("tuneVersions");
  if (!container) return;
  const versions = item.versions || [];
  const rows = versions.map((version) => {
    const button = element("button", { class: "version", type: "button" });
    const thumb = element("div", { class: "version-thumb" });
    const frame = element("iframe", { sandbox: "allow-scripts allow-forms", loading: "lazy", title: version.label });
    frame.src = itemUrl(item, tuneDeviceId);
    frame.addEventListener("load", () => {
      frame.contentWindow?.postMessage(
        { channel: "easel", item: item.id, type: "tune", values: tuneCss(item, spec, version.values) },
        "*",
      );
    });
    thumb.append(frame);
    button.append(thumb, element("span", { class: "version-label", text: version.label }));
    button.setAttribute("aria-current", String(JSON.stringify(version.values) === JSON.stringify(item.tune)));
    button.addEventListener("click", () => {
      const live = itemById(item.id) || item;
      live.tune = { ...version.values };
      item.tune = live.tune;
      postTuneAll(live.id);
      persistTune(live.id);
      renderTune();
    });
    return button;
  });
  container.replaceChildren(...rows);
}

function saveTuneVersion() {
  const item = itemById(tuneItemId);
  if (!item) return;
  clearTimeout(tuneSaveTimer);
  flushTune(item).then(() =>
    fetch(`/api/boards/${encodeURIComponent(key)}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: item.id }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload?.versions) item.versions = payload.versions;
        renderVersions(item, tuneSpecFor(item.id));
      })
      .catch(() => {}),
  );
}

function resetTune() {
  const item = itemById(tuneItemId);
  if (!item) return;
  for (const control of tuneSpecFor(item.id)) item.tune[control.id] = control.value ?? "";
  postTuneAll(item.id);
  persistTune(item.id);
  renderTune();
}

function tuneInstructionText(item, spec) {
  if (item.tuneInstruction) return item.tuneInstruction;
  const lines = spec
    .filter((control) => item.tune[control.id] !== undefined && item.tune[control.id] !== "")
    .map((control) => {
      const value =
        control.type === "number" && control.unit ? `${item.tune[control.id]}${control.unit}` : item.tune[control.id];
      return `- ${control.label}: ${value}  (${control.css})`;
    });
  if (lines.length === 0) return `No tune values set for ${item.label} (${item.file}).`;
  return `Bake these tune values into ${item.file} as CSS custom properties:\n${lines.join("\n")}`;
}

function copyTune() {
  const item = itemById(tuneItemId);
  if (!item) return;
  const text = tuneInstructionText(item, tuneSpecFor(item.id));
  const done = () => {
    const sub = document.getElementById("tuneSub");
    if (!sub) return;
    sub.textContent = "Copied for the agent";
    setTimeout(() => {
      if (sub.textContent === "Copied for the agent") sub.textContent = `${item.file}`;
    }, 1800);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
  else done();
}

function connectLiveEvents() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let delay = 500;
  const connect = () => {
    const socket = new WebSocket(`${protocol}//${location.host}/events/${encodeURIComponent(key)}`);
    socket.addEventListener("open", () => {
      delay = 500;
    });
    socket.addEventListener("message", (message) => {
      let payload;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      if (payload?.type === "agent-presence") setPresence(payload.data?.state);
      if (payload?.type === "agent-reply") showReply(payload.data);
      if (payload?.type === "chat-sync") {
        state.chat = Array.isArray(payload.data?.chat) ? payload.data.chat : state.chat;
        renderNotes();
      }
      if (payload?.type === "ended") markEnded();
    });
    socket.addEventListener("close", () => {
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 5000);
    });
  };
  connect();
}

function refreshBoard() {
  fetch(`/api/boards/${encodeURIComponent(key)}`, { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (!payload || !Array.isArray(payload.items)) return;
      const previousTabs = state.tabs.map((tab) => tab.id).join(",");
      const pendingNotes = new Set(noteTimers.keys());
      state.items = payload.items.map((item) => {
        const local = itemById(item.id);
        return pendingNotes.has(item.id) && local ? { ...item, notes: local.notes } : item;
      });
      state.tabs = payload.tabs || state.tabs;
      state.pairs = payload.pairs || state.pairs;
      state.chat = Array.isArray(payload.chat) ? payload.chat : state.chat;
      if (!state.tabs.some((tab) => tab.id === state.activeTab)) state.activeTab = state.tabs[0]?.id || "";
      if (state.tabs.map((tab) => tab.id).join(",") !== previousTabs) renderTabs();
      syncItems();
      ensureUniqueNumbers();
      renderNotes();
      if (payload.ended) markEnded();
    })
    .catch(() => {});
}

/** @param {MessageEvent} event */
function onArtboardMessage(event) {
  const data = event.data;
  if (!data || data.channel !== "easel") return;
  const itemId = String(data.item || "");
  const deviceId = String(data.device || "");
  const record = state.entries.get(artboardKey(itemId, deviceId));
  if (!record || event.source !== record.iframe.contentWindow) return;
  if (data.type === "ready") {
    postPins(itemId, deviceId);
    postTune(itemId, deviceId);
    return;
  }
  if (data.type === "select") {
    const item = itemById(itemId);
    if (item && !state.ended) addNote(item, data, deviceId);
    return;
  }
  if (data.type === "pin") {
    focusNote(String(data.id || ""), { vx: data.vx, vy: data.vy });
    return;
  }
  if (data.type === "size") {
    // A page that keeps growing as it is measured would drag the whole plane with
    // it; the cap keeps one bad item from making the board unusable.
    const height = Math.min(30000, Math.max(0, Math.round(Number(data.height) || 0)));
    if (height > 0 && height !== record.pageHeight) {
      record.pageHeight = height;
      layoutItem(itemId);
      refitForMeasuredPages();
    }
    return;
  }
  if (data.type === "tune-spec") {
    const controls = Array.isArray(data.controls) ? data.controls : [];
    if (controls.length > 0) {
      state.autoSpecs.set(itemId, controls);
      const item = itemById(itemId);
      if (item) {
        for (const control of controls) {
          if (item.tune[control.id] === undefined || item.tune[control.id] === "") {
            item.tune[control.id] = control.value ?? "";
          }
        }
      }
      if (tuneItemId === itemId) renderTune();
      postTune(itemId, deviceId);
    }
    return;
  }
  if (data.type === "layout") {
    const id = artboardKey(itemId, deviceId);
    if (data.overflow) state.overflow.add(id);
    else state.overflow.delete(id);
    layoutItem(itemId);
  }
}

function renderNotes() {
  renderChatPanel();
  for (const [id] of state.entries) {
    const separator = id.lastIndexOf("::");
    postPins(id.slice(0, separator), id.slice(separator + 2));
    layoutItem(id.slice(0, separator));
  }
}

document.addEventListener("pointerdown", (event) => {
  if (!noteWindow) return;
  if (event.target instanceof Element && noteWindow.contains(event.target)) return;
  closeNoteWindow();
});

window.addEventListener("message", onArtboardMessage);
window.addEventListener("keydown", (event) => {
  if (event.key === "Meta") {
    if (!metaHeld) {
      metaHeld = true;
      updatePanMode();
    }
    return;
  }
  if (event.code === "Space" && !isTextTarget(event.target)) {
    event.preventDefault();
    if (!spaceHeld) {
      spaceHeld = true;
      updatePanMode();
    }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && ["+", "=", "-", "0"].includes(event.key)) {
    event.preventDefault();
    userAdjustedCamera = true;
    if (event.key === "0") fitTab();
    else if (event.key === "-") zoomBy(1 / 1.2);
    else zoomBy(1.2);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable)
  ) {
    return;
  }
  if (event.key === "0") {
    userAdjustedCamera = true;
    fitTab();
  }
  if (event.key === "1") {
    userAdjustedCamera = true;
    zoomToActualSize();
  }
  if (event.key === "+" || event.key === "=") zoomBy(1.2);
  if (event.key === "-") zoomBy(1 / 1.2);
  if (event.key === "Escape") {
    closeNoteWindow();
    closeTune();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.key === "Meta") {
    metaHeld = false;
    updatePanMode();
  }
  if (event.code === "Space" && (spaceHeld || !isTextTarget(event.target))) {
    spaceHeld = false;
    updatePanMode();
  }
});

window.addEventListener("blur", () => {
  if (!metaHeld && !spaceHeld) return;
  metaHeld = false;
  spaceHeld = false;
  updatePanMode();
});

document.getElementById("tuneClose")?.addEventListener("click", closeTune);
document.getElementById("tuneSave")?.addEventListener("click", saveTuneVersion);
document.getElementById("tuneCopy")?.addEventListener("click", copyTune);
document.getElementById("tuneReset")?.addEventListener("click", resetTune);
document.getElementById("zoomIn")?.addEventListener("click", () => zoomBy(1.2));
document.getElementById("zoomOut")?.addEventListener("click", () => zoomBy(1 / 1.2));
document.getElementById("fit")?.addEventListener("click", () => {
  userAdjustedCamera = true;
  fitTab();
});
document.getElementById("actual")?.addEventListener("click", () => {
  userAdjustedCamera = true;
  zoomToActualSize();
});
sendButton?.addEventListener("click", send);
document.getElementById("chatToggle")?.addEventListener("click", () => setChatCollapsed(true));
document.getElementById("chatOpen")?.addEventListener("click", () => setChatCollapsed(false));
composerInput?.addEventListener("input", autosize);
composerInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

loadCamera();
renderTabs();
renderDevices();
applyCamera();
syncItems();
ensureUniqueNumbers();
renderNotes();
setChatCollapsed(loadChatCollapsed());
bindPlane();
clearHover();
if (state.chat.length > 0) {
  const lastAgent = [...state.chat].reverse().find((entry) => entry.role === "agent");
  if (lastAgent) showReply(lastAgent);
}
if (state.ended) markEnded();
fitTab(false);
connectLiveEvents();
setInterval(refreshBoard, 5000);
