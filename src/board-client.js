/* global CSS, document, window, location, IntersectionObserver, Element, HTMLElement */

const bootstrap = JSON.parse(document.getElementById("easel-board")?.textContent || "{}");
const key = String(bootstrap.key || "");
const cameraStorageKey = `easel:camera:${key}`;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

const state = {
  tabs: Array.isArray(bootstrap.tabs) ? bootstrap.tabs : [],
  items: Array.isArray(bootstrap.items) ? bootstrap.items : [],
  pairs: Array.isArray(bootstrap.pairs) ? bootstrap.pairs : [],
  chat: Array.isArray(bootstrap.chat) ? bootstrap.chat : [],
  ended: Boolean(bootstrap.ended),
  activeTab: "",
  camera: { x: 0, y: 0, zoom: 1 },
  entries: new Map(),
  mounted: new Set(),
  overflow: new Set(),
  full: new Set(loadFullItems()),
};

const fullStorageKey = `easel:full:${key}`;
const MAX_FULL_HEIGHT = 12000;

function loadFullItems() {
  try {
    const stored = JSON.parse(localStorage.getItem(fullStorageKey) || "[]");
    return Array.isArray(stored) ? stored.map(String) : [];
  } catch {
    return [];
  }
}

function saveFullItems() {
  try {
    localStorage.setItem(fullStorageKey, JSON.stringify([...state.full]));
  } catch {
    // A browser that refuses storage still keeps the toggle for this session.
  }
}

const plane = document.getElementById("plane");
const canvas = document.getElementById("canvas");
const tabsElement = document.getElementById("tabs");
const zoomLabel = document.getElementById("zoomLabel");
const presence = document.getElementById("presence");
const emptyElement = document.getElementById("empty");
/** @type {any} */
const composerInput = document.getElementById("composerInput");
/** @type {any} */
const sendButton = document.getElementById("send");
const dockStatus = document.getElementById("dockStatus");
const endedBanner = document.getElementById("ended");

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

function boundsOf(items) {
  if (items.length === 0) return null;
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.w));
  const bottom = Math.max(...items.map((item) => item.y + itemHeight(item)));
  return { left, top, width: right - left, height: bottom - top };
}

function fitTab(animate = true) {
  const items = activeItems();
  const bounds = boundsOf(items);
  if (!bounds) {
    state.camera = { x: 0, y: 0, zoom: 1 };
  } else {
    const padding = 72;
    const availableWidth = window.innerWidth - padding * 2;
    const availableHeight = window.innerHeight - 56 - padding - 170;
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

function setTab(id) {
  if (!state.tabs.some((tab) => tab.id === id)) return;
  state.activeTab = id;
  for (const [itemId, entry] of state.entries) {
    entry.element.dataset.active = String(itemById(itemId)?.tab === id);
  }
  renderTabs();
  applyCamera();
  const stored = storedCameraFor(id);
  if (stored) {
    state.camera = stored;
    applyCamera();
  } else {
    fitTab(false);
  }
  saveCamera();
}

function storedCameraFor(tabId) {
  try {
    const stored = JSON.parse(localStorage.getItem(cameraStorageKey) || "{}");
    const perTab = stored?.tabs?.[tabId];
    if (!perTab) return null;
    return {
      x: Number(perTab.x) || 0,
      y: Number(perTab.y) || 0,
      zoom: clamp(Number(perTab.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
    };
  } catch {
    return null;
  }
}

function renderTabs() {
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

function itemUrl(item) {
  return `/board/${encodeURIComponent(key)}/item/${encodeURIComponent(item.id)}/index.html`;
}

function pairFor(id) {
  return state.pairs.find((pair) => pair.locked && (pair.a === id || pair.b === id)) || null;
}

function toggleFullHeight(id) {
  const record = state.entries.get(id);
  const item = itemById(id);
  if (!record || !item) return;
  if (state.full.has(id)) state.full.delete(id);
  else state.full.add(id);
  saveFullItems();
  refreshItemChrome(id);
  positionItem(record.element, item);
}

/** @param {any} item */
function createItem(item) {
  const article = element("article", { class: "item", "data-id": item.id, "data-active": "true" });
  const bar = element("header", { class: "item-bar" });
  const dot = element("span", { class: "dot", "aria-hidden": "true" });
  const label = element("span", { class: "item-label", text: item.label });
  const meta = element("span", { class: "item-meta", text: `${item.w}×${item.h}` });
  const fullToggle = element("button", { class: "full-toggle", type: "button", text: "full height" });
  fullToggle.setAttribute("aria-pressed", String(state.full.has(item.id)));
  fullToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFullHeight(item.id);
  });
  bar.append(dot, label, meta);
  bar.append(fullToggle);
  const pair = pairFor(item.id);
  if (pair) bar.append(element("span", { class: "pair-badge", text: "locked pair" }));
  if (Array.isArray(item.tuneSpec) && item.tuneSpec.length > 0) {
    const tuneButton = element("button", { class: "tune-toggle", type: "button", text: "tune" });
    tuneButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openTune(item.id);
    });
    bar.append(tuneButton);
  }
  const frame = element("div", { class: "item-frame" });
  const iframe = element("iframe", {
    title: item.label,
    sandbox: "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
  });
  iframe.dataset.src = itemUrl(item);
  iframe.addEventListener("load", () => {
    if (state.mounted.has(item.id)) postPins(item.id);
  });
  frame.append(iframe);
  const resize = element("div", { class: "item-resize", title: "Resize" });
  article.append(bar, frame, resize);
  positionItem(article, item);
  article.dataset.pair = String(Boolean(pair));
  bindDrag(article, bar, item.id);
  bindResize(resize, item.id);
  return { element: article, iframe, bar, label, meta };
}

function itemHeight(item) {
  const record = state.entries.get(item.id);
  if (!state.full.has(item.id) || !record || !record.pageHeight) return item.h;
  return Math.min(MAX_FULL_HEIGHT, Math.max(item.h, record.pageHeight + 30));
}

function positionItem(article, item) {
  article.style.left = `${item.x}px`;
  article.style.top = `${item.y}px`;
  article.style.width = `${item.w}px`;
  article.style.height = `${itemHeight(item)}px`;
  article.dataset.full = String(state.full.has(item.id));
}

function refreshItemChrome(id) {
  const item = itemById(id);
  const entry = state.entries.get(id);
  if (!item || !entry) return;
  positionItem(entry.element, item);
  entry.label.textContent = item.label;
  const record = state.entries.get(id);
  const pageHeight = record?.pageHeight ? ` · page ${record.pageHeight}` : "";
  entry.meta.textContent = item.w + "×" + item.h + pageHeight + (state.overflow.has(id) ? " · overflows" : "");
  entry.element.dataset.full = String(state.full.has(id));
  const toggle = entry.element.querySelector(".full-toggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(state.full.has(id)));
    toggle.textContent = state.full.has(id) ? "fit height" : "full height";
  }
  entry.element.dataset.pair = String(Boolean(pairFor(id)));
  entry.element.dataset.state = itemState(item);
}

function syncItems() {
  const seen = new Set();
  for (const item of state.items) {
    seen.add(item.id);
    const entry = state.entries.get(item.id);
    if (entry) {
      entry.element.dataset.active = String(item.tab === state.activeTab);
      refreshItemChrome(item.id);
      continue;
    }
    const created = createItem(item);
    state.entries.set(item.id, created);
    canvas.append(created.element);
    mountObserver.observe(created.element);
  }
  for (const [id, entry] of state.entries) {
    if (seen.has(id)) continue;
    mountObserver.unobserve(entry.element);
    entry.element.remove();
    state.entries.delete(id);
  }
  emptyElement.hidden = activeItems().length > 0;
}

const mountObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      /** @type {any} */
      const article = entry.target;
      const id = article.dataset.id || "";
      const item = itemById(id);
      const record = state.entries.get(id);
      if (!item || !record) continue;
      if (!record.iframe.getAttribute("src")) record.iframe.setAttribute("src", record.iframe.dataset.src || "");
      state.mounted.add(id);
    }
  },
  { root: plane, rootMargin: "900px" },
);

function postToItem(id, message) {
  const entry = state.entries.get(id);
  if (!entry || !entry.iframe.contentWindow) return;
  entry.iframe.contentWindow.postMessage({ channel: "easel", item: id, ...message }, "*");
}

function postPins(id) {
  const item = itemById(id);
  if (!item) return;
  postToItem(id, { type: "pins", pins: pinsFor(item) });
}

function tuneCss(item, values = item.tune) {
  const css = {};
  for (const control of item.tuneSpec || []) {
    const raw = values?.[control.id];
    if (raw === undefined || raw === "") continue;
    css[control.css] = control.type === "number" && control.unit ? `${raw}${control.unit}` : String(raw);
  }
  return css;
}

function postTune(id) {
  const item = itemById(id);
  if (!item || !Array.isArray(item.tuneSpec) || item.tuneSpec.length === 0) return;
  postToItem(id, { type: "tune", values: tuneCss(item) });
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

function pinsFor(item) {
  return (item.notes || []).map((note) => ({
    id: note.id,
    number: note.number,
    selector: note.selector,
    x: note.x,
    y: note.y,
    text: note.text || note.label,
    state: receiptFor(note),
  }));
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
    if (event.target instanceof Element && event.target.closest("button")) return;
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
      refreshItemChrome(id);
      if (partner && partnerOrigin) {
        partner.x = Math.round(partnerOrigin.x + dx);
        partner.y = Math.round(partnerOrigin.y + dy);
        refreshItemChrome(partner.id);
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
    if (state.full.has(id)) return;
    event.preventDefault();
    event.stopPropagation();
    const item = itemById(id);
    if (!item) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { w: item.w, h: item.h };
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      item.w = Math.round(Math.max(160, origin.w + (moveEvent.clientX - startX) / state.camera.zoom));
      item.h = Math.round(Math.max(120, origin.h + (moveEvent.clientY - startY) / state.camera.zoom));
      refreshItemChrome(id);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      persist([{ id, w: item.w, h: item.h }]);
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
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.0016);
        zoomAt(event.clientX, event.clientY, factor);
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
  zoomAt(window.innerWidth / 2, window.innerHeight / 2, factor);
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
  dockStatus.scrollTop = 0;
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

async function send() {
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
      pin: { id: note.id, number: note.number },
    };
  });
  if (message) prompts.push({ uid: randomId(), prompt: message, tag: "message" });
  sendButton.disabled = true;
  try {
    const response = await fetch(`/api/${encodeURIComponent(key)}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts, domSnapshot: "" }),
    });
    if (!response.ok) {
      for (const entry of sent) delete entry.note.prompt_id;
      dockStatus.textContent = "Could not reach the agent. Your notes are still here.";
      renderChips();
      return;
    }
    composerInput.value = "";
    autosize();
    for (const itemId of new Set(sent.map((entry) => entry.item.id))) persistNotes(itemId, { immediate: true });
    renderChips();
    dockStatus.textContent = "Sent.";
    setTimeout(() => {
      if (dockStatus.textContent === "Sent.") dockStatus.textContent = "";
    }, 1800);
  } catch {
    for (const entry of sent) delete entry.note.prompt_id;
    renderChips();
    dockStatus.textContent = "Could not reach the agent. Your notes are still here.";
  } finally {
    sendButton.disabled = state.ended;
  }
}

function autosize() {
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(200, composerInput.scrollHeight + 2)}px`;
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

async function refreshBoard() {
  try {
    const response = await fetch(`/api/boards/${encodeURIComponent(key)}`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    if (Array.isArray(payload.items)) {
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
    }
    if (payload.ended) markEnded();
  } catch {
    // A board that cannot refresh keeps showing the items it has.
  }
}

/** @param {MessageEvent} event */
function onItemMessage(event) {
  const data = event.data;
  if (!data || data.channel !== "easel") return;
  const id = String(data.item || "");
  const entry = state.entries.get(id);
  if (!entry || event.source !== entry.iframe.contentWindow) return;
  if (data.type === "ready") {
    postPins(id);
    postTune(id);
  }
  if (data.type === "select") {
    const item = itemById(id);
    if (item && !state.ended) addNote(item, data);
  }
  if (data.type === "pin") focusNote(String(data.id || ""));
  if (data.type === "size") {
    const height = Math.max(0, Math.round(Number(data.height) || 0));
    if (height > 0) {
      entry.pageHeight = height;
      refreshItemChrome(id);
    }
  }
  if (data.type === "layout") {
    if (data.overflow) state.overflow.add(id);
    else state.overflow.delete(id);
    refreshItemChrome(id);
  }
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

function itemState(item) {
  const states = (item.notes || []).map((note) => receiptFor(note));
  if (states.length === 0) return "";
  if (states.includes("draft")) return "note";
  if (states.includes("working")) return "working";
  if (states.includes("queued") || states.includes("seen")) return "seen";
  return "done";
}

function anchorLabel(note) {
  const excerpt = String(note.label || "").slice(0, 48);
  return excerpt ? `${note.tag || "element"} "${excerpt}"` : note.tag || "element";
}

function createChip(item, note) {
  const chip = element("div", { class: "chip", "data-state": receiptFor(note), "data-note": note.id });
  chip.append(element("span", { class: "chip-number", text: String(note.number) }));
  const anchor = element("button", { class: "chip-anchor", type: "button", text: anchorLabel(note) });
  anchor.title = `Show pin ${note.number} on ${item.label}`;
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
      postPins(item.id);
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
  const entry = boardNotes().find((candidate) => candidate.note.id === noteId);
  if (!entry) return;
  /** @type {any} */
  const chip = document.getElementById("chips")?.querySelector(`[data-note="${CSS.escape(noteId)}"]`);
  if (!chip) return;
  if (entry.item.tab !== state.activeTab) setTab(entry.item.tab);
  chip.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  const input = chip.querySelector("input");
  if (input && !entry.note.prompt_id) input.focus();
  chip.dataset.flash = "true";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    delete chip.dataset.flash;
  }, 1100);
  postToItem(entry.item.id, { type: "focus", id: noteId });
}

function addNote(item, payload) {
  const note = {
    id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    number: nextNoteNumber(),
    label: String(payload.text || "").slice(0, 90),
    selector: payload.selector,
    tag: payload.tag,
    text: "",
    x: Math.round(Number(payload.x) || 0),
    y: Math.round(Number(payload.y) || 0),
    at: new Date().toISOString(),
  };
  item.notes = [...(item.notes || []), note];
  persistNotes(item.id, { immediate: true });
  renderChips();
  postPins(item.id);
  focusNote(note.id);
}

function renderNotes() {
  renderChips();
  for (const [id] of state.entries) {
    postPins(id);
    refreshItemChrome(id);
  }
}

let tuneItemId = "";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let tuneSaveTimer;

function tunePanel() {
  return document.getElementById("tune");
}

function openTune(id) {
  const item = itemById(id);
  if (!item) return;
  tuneItemId = id;
  for (const control of item.tuneSpec || []) {
    if (item.tune[control.id] === undefined || item.tune[control.id] === "") {
      item.tune[control.id] = control.value ?? "";
    }
  }
  const panel = tunePanel();
  if (panel) panel.hidden = false;
  renderTune();
}

function closeTune() {
  const panel = tunePanel();
  if (panel) panel.hidden = true;
  tuneItemId = "";
}

function renderTune() {
  const item = itemById(tuneItemId);
  const panel = tunePanel();
  if (!item || !panel) return;
  const sub = document.getElementById("tuneSub");
  if (sub) sub.textContent = item.file;
  const body = document.getElementById("tuneBody");
  if (!body) return;
  const spec = item.tuneSpec || [];
  if (spec.length === 0) {
    body.replaceChildren(
      element("p", {
        class: "tune-empty",
        text: `${item.file} declares no controls yet. Add a <script type="application/easel-tune"> array of {id,label,type,css} entries bound to its CSS custom properties to tune it here.`,
      }),
    );
  } else {
    body.replaceChildren(...spec.map((control) => createTuneControl(item, control)));
  }
  for (const id of ["tuneSave", "tuneCopy", "tuneReset"]) {
    const button = /** @type {any} */ (document.getElementById(id));
    if (button) button.disabled = spec.length === 0;
  }
  renderVersions(item);
}

function createTuneControl(item, control) {
  const wrapper = element("div", { class: "tune-control" });
  const valueLabel = element("span", { class: "tune-control-value", text: String(item.tune[control.id] ?? "") });
  const label = element("label", { class: "tune-control-label" });
  label.append(element("span", { text: control.label }), valueLabel);
  wrapper.append(label);
  const apply = (raw) => {
    // The five-second refresh replaces item objects, so a panel opened a moment ago
    // holds a stale one. Always write through the live item, never the captured copy.
    const live = itemById(item.id) || item;
    live.tune[control.id] = raw;
    item.tune = live.tune;
    valueLabel.textContent = String(raw);
    postToItem(item.id, { type: "tune", values: tuneCss(live) });
    persistTune(item.id);
  };
  if (control.type === "color") {
    const input = element("input", { type: "color" });
    input.value = item.tune[control.id] || "#000000";
    input.addEventListener("input", () => apply(input.value));
    wrapper.append(input);
  } else if (control.type === "select") {
    const select = element("select", {});
    for (const option of control.options || []) {
      const node = element("option", { value: option.value, text: option.label });
      select.append(node);
    }
    select.value = String(item.tune[control.id] ?? "");
    select.addEventListener("change", () => apply(select.value));
    wrapper.append(select);
  } else {
    const input = element("input", {
      type: "range",
      min: String(control.min ?? 0),
      max: String(control.max ?? 100),
      step: String(control.step ?? 1),
    });
    input.value = String(item.tune[control.id] ?? control.value ?? 0);
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

function renderVersions(item) {
  const container = document.getElementById("tuneVersions");
  if (!container) return;
  const versions = item.versions || [];
  container.replaceChildren(
    ...versions.map((version) => {
      const button = element("button", { class: "version", type: "button" });
      const thumb = element("div", { class: "version-thumb" });
      const frame = element("iframe", { sandbox: "allow-scripts allow-forms", loading: "lazy", title: version.label });
      frame.src = itemUrl(item);
      frame.addEventListener("load", () => {
        frame.contentWindow?.postMessage(
          { channel: "easel", item: item.id, type: "tune", values: tuneCss(item, version.values) },
          "*",
        );
      });
      thumb.append(frame);
      button.append(thumb, element("span", { class: "version-label", text: version.label }));
      const current = JSON.stringify(version.values) === JSON.stringify(item.tune);
      button.setAttribute("aria-current", String(current));
      button.addEventListener("click", () => {
        const live = itemById(item.id) || item;
        live.tune = { ...version.values };
        item.tune = live.tune;
        postToItem(item.id, { type: "tune", values: tuneCss(live) });
        persistTune(item.id);
        renderTune();
      });
      return button;
    }),
  );
}

async function saveTuneVersion() {
  const item = itemById(tuneItemId);
  if (!item) return;
  clearTimeout(tuneSaveTimer);
  await flushTune(item);
  const response = await fetch(`/api/boards/${encodeURIComponent(key)}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item: item.id }),
  }).catch(() => null);
  if (!response || !response.ok) return;
  const payload = await response.json().catch(() => null);
  if (payload?.versions) item.versions = payload.versions;
  renderVersions(item);
}

function resetTune() {
  const item = itemById(tuneItemId);
  if (!item) return;
  for (const control of item.tuneSpec || []) item.tune[control.id] = control.value ?? "";
  postToItem(item.id, { type: "tune", values: tuneCss(item) });
  persistTune(item.id);
  renderTune();
}

function copyTune() {
  const item = itemById(tuneItemId);
  if (!item) return;
  const text = item.tuneInstruction || `${item.label}: no tune values set.`;
  const done = () => {
    const sub = document.getElementById("tuneSub");
    if (!sub) return;
    sub.textContent = "Copied for the agent";
    setTimeout(() => {
      if (sub.textContent === "Copied for the agent") sub.textContent = item.file;
    }, 1800);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
  else done();
}

window.addEventListener("message", onItemMessage);
window.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  )
    return;
  if (event.key === "0") fitTab();
  if (event.key === "+" || event.key === "=") zoomBy(1.2);
  if (event.key === "-") zoomBy(1 / 1.2);
});

document.getElementById("tuneClose")?.addEventListener("click", closeTune);
document.getElementById("tuneSave")?.addEventListener("click", saveTuneVersion);
document.getElementById("tuneCopy")?.addEventListener("click", copyTune);
document.getElementById("tuneReset")?.addEventListener("click", resetTune);
document.getElementById("zoomIn")?.addEventListener("click", () => zoomBy(1.2));
document.getElementById("zoomOut")?.addEventListener("click", () => zoomBy(1 / 1.2));
document.getElementById("fit")?.addEventListener("click", () => fitTab());
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
applyCamera();
syncItems();
renderNotes();
bindPlane();
if (state.chat.length > 0) {
  const lastAgent = [...state.chat].reverse().find((entry) => entry.role === "agent");
  if (lastAgent) showReply(lastAgent);
}
if (state.ended) markEnded();
if (!storedCameraFor(state.activeTab)) fitTab(false);
connectLiveEvents();
setInterval(refreshBoard, 5000);
