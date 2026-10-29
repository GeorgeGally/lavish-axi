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

const state = {
  tabs: Array.isArray(bootstrap.tabs) ? bootstrap.tabs : [],
  items: Array.isArray(bootstrap.items) ? bootstrap.items : [],
  pairs: Array.isArray(bootstrap.pairs) ? bootstrap.pairs : [],
  chat: Array.isArray(bootstrap.chat) ? bootstrap.chat : [],
  ended: Boolean(bootstrap.ended),
  activeTab: "",
  deviceMode: loadDeviceMode(),
  annotate: false,
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
/** @type {any} */
const annotateButton = document.getElementById("annotate");
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

function applyCamera() {
  canvas.style.transform = `translate(${state.camera.x}px, ${state.camera.y}px) scale(${state.camera.zoom})`;
  zoomLabel.textContent = `${Math.round(state.camera.zoom * 100)}%`;
}

function activeItems() {
  return state.items.filter((item) => item.tab === state.activeTab);
}

function artboardsFor(item) {
  const scale = scaleFor(item);
  const gap = Math.round(48 * scale);
  let x = item.x;
  const boards = [];
  for (const device of visibleDevices()) {
    const record = state.entries.get(artboardKey(item.id, device.id));
    const pageHeight = record?.pageHeight || device.height;
    const width = Math.round(device.width * scale);
    const height = Math.round(pageHeight * scale) + BAR_HEIGHT;
    boards.push({ device, record, x, y: item.y, width, height, scale });
    x += width + gap;
  }
  return boards;
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

function zoomToArtboard(itemId, deviceId) {
  const item = itemById(itemId);
  if (!item) return;
  const board = artboardsFor(item).find((entry) => entry.device.id === deviceId);
  if (!board) return;
  const padding = 40;
  const zoom = clamp((window.innerWidth - padding * 2) / board.width, 0.05, 1);
  state.camera = {
    zoom,
    x: padding - board.x * zoom,
    y: 56 + 18 - board.y * zoom,
  };
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
      postToArtboard(item.id, device.id, { type: "mode", annotate: state.annotate });
      postPins(item.id, device.id);
      postTune(item.id, device.id);
    }
  });
  frame.append(iframe);
  article.append(bar, frame);
  if (device.id === visibleDevices()[visibleDevices().length - 1]?.id) {
    const resize = element("div", { class: "item-resize", title: "Resize row" });
    article.append(resize);
    bindResize(resize, item.id);
  }
  canvas.append(article);
  mountObserver.observe(article);
  const record = { element: article, iframe, bar, label, meta, pageHeight: 0, device };
  state.entries.set(id, record);
  applyArtboardLayout(item, device.id);
  bindDrag(article, bar, item.id);
  bar.addEventListener("dblclick", () => zoomToArtboard(item.id, device.id));
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
  const pageHeight = record.pageHeight || device.height;
  record.element.style.left = `${board.x}px`;
  record.element.style.top = `${board.y}px`;
  record.element.style.width = `${board.width}px`;
  record.element.style.height = `${BAR_HEIGHT + Math.round(pageHeight * scale)}px`;
  record.iframe.style.width = `${device.width}px`;
  record.iframe.style.height = `${pageHeight}px`;
  record.iframe.style.transform = `scale(${scale})`;
  record.label.textContent = `${item.label} · ${device.width}`;
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
    applyCamera();
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
  plane.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      userAdjustedCamera = true;
      if (event.ctrlKey || event.metaKey) {
        zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0016));
        return;
      }
      state.camera.x -= event.deltaX;
      state.camera.y -= event.deltaY;
      applyCamera();
      scheduleCameraSave();
    },
    { passive: false },
  );
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

function zoomAt(clientX, clientY, factor) {
  const worldX = (clientX - state.camera.x) / state.camera.zoom;
  const worldY = (clientY - state.camera.y) / state.camera.zoom;
  state.camera.zoom = clamp(state.camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  state.camera.x = clientX - worldX * state.camera.zoom;
  state.camera.y = clientY - worldY * state.camera.zoom;
  applyCamera();
  scheduleCameraSave();
}

function zoomBy(factor) {
  userAdjustedCamera = true;
  zoomAt(window.innerWidth / 2, window.innerHeight / 2, factor);
}

function setAnnotate(value) {
  state.annotate = value;
  document.body.dataset.annotate = String(value);
  if (annotateButton) annotateButton.setAttribute("aria-pressed", String(value));
  postToItemArtboardsAll({ type: "mode", annotate: value });
  if (!value) closeNoteWindow();
}

function postToItemArtboardsAll(message) {
  for (const [id] of state.entries) {
    const separator = id.lastIndexOf("::");
    postToArtboard(id.slice(0, separator), id.slice(separator + 2), message);
  }
}

function setPresence(value) {
  const label = value === "listening" ? "agent listening" : value === "working" ? "agent working" : "agent idle";
  presence.dataset.state = value || "waiting";
  presence.textContent = label;
}

function showReply(entry) {
  if (!entry) return;
  const reply = element("div", { class: "reply" });
  reply.textContent = String(entry.text || "");
  dockStatus.replaceChildren(reply);
}

function markEnded() {
  state.ended = true;
  endedBanner.hidden = false;
  composerInput.disabled = true;
  sendButton.disabled = true;
  composerInput.placeholder = "Session ended";
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

function nextNoteNumber() {
  return boardNotes().reduce((highest, entry) => Math.max(highest, entry.note.number || 0), 0) + 1;
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

function anchorLabel(note) {
  const excerpt = String(note.label || "").slice(0, 44);
  const width = deviceById(noteDevice(note)).width;
  const anchor = excerpt ? `${note.tag || "element"} "${excerpt}"` : note.tag || "element";
  return `${anchor} · ${width}`;
}

function createChip(item, note) {
  const chip = element("div", { class: "chip", "data-state": receiptFor(note), "data-note": note.id });
  chip.append(element("span", { class: "chip-number", text: String(note.number) }));
  const anchor = element("button", { class: "chip-anchor", type: "button", text: anchorLabel(note) });
  anchor.title = `Show pin ${note.number} on ${item.label} at ${deviceById(noteDevice(note)).width}`;
  anchor.addEventListener("click", () => focusNote(note.id));
  const input = element("input", { class: "chip-input", type: "text", placeholder: "What should change?" });
  input.value = note.text || "";
  input.addEventListener("input", () => {
    note.text = input.value;
    persistNotes(item.id);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  const close = element("button", { class: "chip-close", type: "button", text: "×" });
  close.title = note.prompt_id ? "Sent notes stay on the board" : "Remove this note";
  close.disabled = Boolean(note.prompt_id);
  if (!note.prompt_id) {
    close.addEventListener("click", () => {
      item.notes = (item.notes || []).filter((entry) => entry.id !== note.id);
      persistNotes(item.id, { immediate: true });
      renderChips();
      postPins(item.id, noteDevice(note));
    });
  }
  chip.append(anchor, input, close);
  return chip;
}

function renderChips() {
  const chips = document.getElementById("chips");
  if (!chips) return;
  chips.replaceChildren(...boardNotes().map(({ item, note }) => createChip(item, note)));
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let flashTimer;
function focusNote(noteId) {
  const found = boardNotes().find((candidate) => candidate.note.id === noteId);
  if (!found) return;
  const { item, note } = found;
  if (item.tab !== state.activeTab) setTab(item.tab);
  const deviceId = noteDevice(note);
  postToArtboard(item.id, deviceId, { type: "focus", id: noteId });
  showNoteWindow(item, note);
  /** @type {any} */
  const chip = document.getElementById("chips")?.querySelector(`[data-note="${CSS.escape(noteId)}"]`);
  if (chip) {
    chip.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    chip.dataset.flash = "true";
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      delete chip.dataset.flash;
    }, 1100);
  }
}

/** @type {any} */
let noteWindow = null;

function closeNoteWindow() {
  if (noteWindow) {
    noteWindow.remove();
    noteWindow = null;
  }
}

/** @param {any} item @param {any} note */
function showNoteWindow(item, note) {
  closeNoteWindow();
  const record = state.entries.get(artboardKey(item.id, noteDevice(note)));
  if (!record) return;
  const rect = record.iframe.getBoundingClientRect();
  const scale = scaleFor(item);
  const left = clamp(rect.left + (Number(note.x) || 0) * scale + 18, 16, window.innerWidth - 320);
  const top = clamp(rect.top + (Number(note.y) || 0) * scale - 6, 70, window.innerHeight - 190);
  noteWindow = element("div", { class: "note-window" });
  noteWindow.style.left = `${left}px`;
  noteWindow.style.top = `${top}px`;
  const head = element("div", { class: "note-window-head" });
  head.append(
    element("span", { class: "chip-number", text: String(note.number) }),
    element("span", { class: "note-window-title", text: `${item.label} · ${deviceById(noteDevice(note)).width}` }),
  );
  const textarea = element("textarea", { class: "note-window-input", rows: "2", placeholder: "What should change?" });
  textarea.value = note.text || "";
  textarea.addEventListener("input", () => {
    note.text = textarea.value;
    persistNotes(item.id);
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeNoteWindow();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const chip = document.getElementById("chips")?.querySelector(`[data-note="${CSS.escape(note.id)}"]`);
      const chipInput = chip?.querySelector("input");
      if (chipInput) chipInput.value = textarea.value;
      closeNoteWindow();
    }
  });
  const actions = element("div", { class: "note-window-actions" });
  const close = element("button", { class: "note-window-close", type: "button", text: "Close" });
  close.addEventListener("click", closeNoteWindow);
  const remove = element("button", {
    class: "note-window-close",
    type: "button",
    text: note.prompt_id ? "Sent" : "Remove",
  });
  remove.disabled = Boolean(note.prompt_id);
  if (!note.prompt_id) {
    remove.addEventListener("click", () => {
      item.notes = (item.notes || []).filter((entry) => entry.id !== note.id);
      persistNotes(item.id, { immediate: true });
      renderChips();
      postPins(item.id, noteDevice(note));
      closeNoteWindow();
    });
  }
  actions.append(remove, close);
  noteWindow.append(head, textarea, actions);
  document.body.append(noteWindow);
  textarea.focus();
}

/** @param {any} item @param {any} payload @param {string} deviceId */
function addNote(item, payload, deviceId) {
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
    at: new Date().toISOString(),
  };
  item.notes = [...(item.notes || []), note];
  persistNotes(item.id, { immediate: true });
  renderChips();
  postPins(item.id, deviceId);
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
  sendButton.disabled = true;
  fetch(`/api/${encodeURIComponent(key)}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts, domSnapshot: "" }),
  })
    .then((response) => {
      if (!response.ok) throw new Error("not accepted");
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
      for (const entry of sent) delete entry.note.prompt_id;
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
    postToArtboard(itemId, deviceId, { type: "mode", annotate: state.annotate });
    postPins(itemId, deviceId);
    postTune(itemId, deviceId);
    return;
  }
  if (data.type === "select") {
    const item = itemById(itemId);
    if (item && !state.ended && state.annotate) addNote(item, data, deviceId);
    return;
  }
  if (data.type === "pin") {
    focusNote(String(data.id || ""));
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
  renderChips();
  for (const [id] of state.entries) {
    const separator = id.lastIndexOf("::");
    postPins(id.slice(0, separator), id.slice(separator + 2));
    layoutItem(id.slice(0, separator));
  }
}

window.addEventListener("message", onArtboardMessage);
window.addEventListener("keydown", (event) => {
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
  if (event.key === "a" || event.key === "A") setAnnotate(!state.annotate);
  if (event.key === "0") {
    userAdjustedCamera = true;
    fitTab();
  }
  if (event.key === "+" || event.key === "=") zoomBy(1.2);
  if (event.key === "-") zoomBy(1 / 1.2);
  if (event.key === "Escape") {
    closeNoteWindow();
    closeTune();
  }
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
annotateButton?.addEventListener("click", () => setAnnotate(!state.annotate));
sendButton?.addEventListener("click", send);
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
renderNotes();
bindPlane();
setAnnotate(false);
if (state.chat.length > 0) {
  const lastAgent = [...state.chat].reverse().find((entry) => entry.role === "agent");
  if (lastAgent) showReply(lastAgent);
}
if (state.ended) markEnded();
fitTab(false);
connectLiveEvents();
setInterval(refreshBoard, 5000);
