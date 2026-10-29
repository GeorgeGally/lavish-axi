/* global CSS, document, window, location, Element, HTMLElement */

const bootstrap = JSON.parse(document.getElementById("easel-board")?.textContent || "{}");
const key = String(bootstrap.key || "");
const cameraStorageKey = `easel:camera2:${key}`;
const deviceStorageKey = `easel:device:${key}`;
const heightStorageKey = `easel:heights:${key}`;
const panelStorageKey = `easel:panel:${key}`;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;
// Pinch arrives as ctrl+wheel. Zoom is exp(-delta * k): continuous, no steps.
const PINCH_SPEED = 0.016;
const CAPTION_PX = 15;
const LABEL_PX = 13;

// Every artboard renders at a real device viewport, in real CSS pixels: the camera is
// the only scale on the board, so a point on screen maps into a page by one division.
const DEVICES = [
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
  { id: "ipad", label: "iPad", width: 834, height: 1194 },
  { id: "phone", label: "Phone", width: 390, height: 844 },
];
// Bezel thickness of the CSS device frames, in board pixels. `below` is room for the
// desktop stand, which hangs under the frame.
const FRAME = {
  desktop: { top: 20, side: 20, bottom: 44, below: 70 },
  ipad: { top: 26, side: 26, bottom: 26, below: 0 },
  // A phone page starts below the status bar, so the island sits in the bezel.
  phone: { top: 54, side: 14, bottom: 14, below: 0 },
};
const DEVICE_GAP = 56;
const MEMBER_GAP = { all: 200, desktop: 140, ipad: 100, phone: 72 };

const state = {
  tabs: Array.isArray(bootstrap.tabs) ? bootstrap.tabs : [],
  items: Array.isArray(bootstrap.items) ? bootstrap.items : [],
  chat: Array.isArray(bootstrap.chat) ? bootstrap.chat : [],
  ended: Boolean(bootstrap.ended),
  activeTab: "",
  deviceMode: loadDeviceMode(),
  camera: { x: 0, y: 0, zoom: 1 },
  /** @type {Map<string, any>} */
  artboards: new Map(),
  /** @type {Map<string, any>} */
  explains: new Map(),
  /** @type {Map<string, any>} */
  choices: new Map(),
  /** @type {Map<string, number>} */
  heights: loadHeights(),
  /** @type {Map<string, any[]>} */
  autoSpecs: new Map(),
  /** @type {any} */
  layout: null,
};

const plane = /** @type {HTMLElement} */ (document.getElementById("plane"));
const canvas = /** @type {HTMLElement} */ (document.getElementById("canvas"));
const tabsElement = document.getElementById("tabs");
const zoomLabel = /** @type {HTMLElement} */ (document.getElementById("zoomLabel"));
/** @type {any} */
const presence = document.getElementById("presence");
const emptyElement = /** @type {HTMLElement} */ (document.getElementById("empty"));
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

/** @param {string} name */
function readStorage(name) {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

/** @param {string} name @param {string} value */
function writeStorage(name, value) {
  try {
    localStorage.setItem(name, value);
  } catch {
    // A browser that refuses storage still has a working board this session.
  }
}

function itemById(id) {
  return state.items.find((item) => item.id === id) || null;
}

function artboardKey(itemId, deviceId) {
  return `${itemId}::${deviceId}`;
}

function loadDeviceMode() {
  const stored = readStorage(deviceStorageKey);
  return ["all", ...DEVICES.map((device) => device.id)].includes(stored || "") ? String(stored) : "all";
}

function loadHeights() {
  /** @type {Map<string, number>} */
  const heights = new Map();
  try {
    const stored = JSON.parse(readStorage(heightStorageKey) || "{}");
    for (const [id, value] of Object.entries(stored)) {
      if (Number.isFinite(Number(value)) && Number(value) > 0) heights.set(id, Number(value));
    }
  } catch {
    // Heights are only a head start; every frame measures itself again.
  }
  return heights;
}

let heightSaveTimer = 0;
function saveHeights() {
  clearTimeout(heightSaveTimer);
  heightSaveTimer = window.setTimeout(() => {
    writeStorage(heightStorageKey, JSON.stringify(Object.fromEntries(state.heights)));
  }, 600);
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

function framedView() {
  return state.deviceMode !== "all";
}

function activeItems() {
  return state.items
    .filter((item) => item.tab === state.activeTab)
    .sort((left, right) => String(left.file).localeCompare(String(right.file)));
}

function panelWidth() {
  const chat = document.getElementById("chat");
  if (!chat || chat.classList.contains("collapsed")) return 0;
  return chat.getBoundingClientRect().width;
}

function barHeight() {
  return document.querySelector(".bar")?.getBoundingClientRect().height || 56;
}

/* ------------------------------------------------------------------ groups */

function capitalize(text) {
  const value = String(text || "").trim();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function memberLabel(item, group) {
  const pair = item.pair;
  if (!pair) return "";
  if (pair.role === "today") return "Today";
  const lettered = group.members.some((member) => member.item.pair?.variant);
  const letter = pair.variant ? pair.variant.toUpperCase() : lettered ? "A" : "";
  return letter ? `Proposed ${letter}` : "Proposed";
}

// A caption usually opens with its own label ("Hero today: ...", "2A · ..."); the
// explanation already says which version a line is about, so that prefix goes.
function captionBody(caption) {
  let text = String(caption || "").trim();
  const prefix = /^([^:]{1,60}):\s+/.exec(text);
  if (prefix && /\b(today|proposed)\b/i.test(prefix[1])) text = text.slice(prefix[0].length);
  text = text.replace(/^\d+[a-z]?\s*·\s*/i, "");
  return capitalize(text);
}

function captionTitle(caption) {
  const prefix = /^([^:]{1,60}):\s+/.exec(String(caption || "").trim());
  if (!prefix || !/\b(today|proposed)\b/i.test(prefix[1])) return "";
  return capitalize(prefix[1].replace(/\s*\b(today|proposed)\b.*$/i, ""));
}

function buildGroups() {
  /** @type {any[]} */
  const groups = [];
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const item of activeItems()) {
    if (!item.pair) {
      groups.push({ key: `item:${item.id}`, members: [{ item }], single: true });
      continue;
    }
    let group = byKey.get(item.pair.key);
    if (!group) {
      group = { key: `pair:${item.pair.key}`, name: item.pair.name, members: [], single: false };
      byKey.set(item.pair.key, group);
      groups.push(group);
    }
    group.members.push({ item });
  }
  for (const group of groups) {
    const rank = (member) => (member.item.pair?.role === "today" ? "0" : `1${member.item.pair?.variant || ""}`);
    group.members.sort((left, right) => rank(left).localeCompare(rank(right)));
    for (const member of group.members) member.label = memberLabel(member.item, group);
    if (group.single) {
      const item = group.members[0].item;
      group.title = item.title || item.label;
      group.lines = item.caption ? [{ label: "", text: captionBody(item.caption) }] : [];
    } else {
      const titled = group.members.map((member) => member.item.title).find(Boolean);
      const fromCaption = group.members.map((member) => captionTitle(member.item.caption)).find(Boolean);
      group.title = titled || fromCaption || capitalize(group.name);
      group.lines = group.members
        .filter((member) => member.item.caption)
        .map((member) => ({ label: member.label, text: captionBody(member.item.caption) }));
    }
  }
  return groups;
}

function groupOfItem(itemId) {
  for (const group of state.layout?.groups || []) {
    const member = group.members.find((entry) => entry.item.id === itemId);
    if (member) return { group, member };
  }
  return null;
}

function designName(item, deviceId) {
  const found = groupOfItem(item.id);
  const parts = found ? [found.group.title, found.member.label].filter(Boolean) : [item.label];
  if (deviceId && deviceId !== "desktop") parts.push(String(deviceById(deviceId).width));
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ layout */

const measure = element("div", { class: "explain", "aria-hidden": "true" });
measure.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;";
document.body.append(measure);

function explainContent(group) {
  const inner = element("div", { class: "explain-inner" });
  inner.append(element("h2", { class: "explain-title", text: group.title }));
  if (group.lines.length > 0) {
    const list = element("ul", { class: "explain-lines" });
    for (const line of group.lines) {
      const row = element("li");
      if (line.label) row.append(element("b", { text: `${line.label}.` }), " ");
      row.append(line.text);
      list.append(row);
    }
    inner.append(list);
  }
  return inner;
}

/** The world height an explanation takes at its largest size. */
function explainHeight(group, width, size) {
  measure.style.width = `${width}px`;
  measure.style.setProperty("--zoom", "0.0001");
  measure.style.setProperty("--cap-max", `${size}px`);
  measure.replaceChildren(explainContent(group));
  return measure.offsetHeight;
}

function contentHeight(itemId, device) {
  return state.heights.get(artboardKey(itemId, device.id)) || device.height;
}

function artboardSize(itemId, device, framed) {
  if (framed) {
    const pad = FRAME[device.id];
    return {
      width: device.width + pad.side * 2,
      height: device.height + pad.top + pad.bottom,
      below: pad.below,
      screenWidth: device.width,
      screenHeight: device.height,
      pad,
    };
  }
  const height = contentHeight(itemId, device);
  return {
    width: device.width,
    height,
    below: 0,
    screenWidth: device.width,
    screenHeight: height,
    pad: { top: 0, side: 0, bottom: 0 },
  };
}

function availableArea() {
  return {
    width: Math.max(200, window.innerWidth - panelWidth()),
    height: Math.max(200, window.innerHeight - barHeight()),
  };
}

const FIT_PADDING = 48;

// Fit shows everything, unless that would shrink a long board past reading: then it
// fits the width and the board scrolls down, the way a long page does.
function fitZoomFor(bounds) {
  if (!bounds) return 1;
  const area = availableArea();
  const byWidth = (area.width - FIT_PADDING * 2) / bounds.width;
  const byHeight = (area.height - FIT_PADDING * 2) / bounds.height;
  const zoom = byHeight < byWidth * 0.6 ? byWidth : Math.min(byWidth, byHeight);
  return clamp(Math.min(1, zoom), MIN_ZOOM, MAX_ZOOM);
}

/**
 * Place every group: its explanation on top, then each version's artboards side by
 * side. Groups pack into rows sized to the window, so a phone view reads as a grid of
 * phones and the All view as one design per row.
 */
function computeLayout(groups, captionMax, labelMax) {
  const framed = framedView();
  const devices = visibleDevices();
  const memberGap = MEMBER_GAP[state.deviceMode] || MEMBER_GAP.all;
  const labelReserve = Math.ceil(labelMax * 2);
  // Room under a compared design for its Accept / Keep today choice.
  const choiceReserve = Math.ceil(labelMax * 6);
  const placed = [];
  for (const group of groups) {
    let x = 0;
    let contentH = 0;
    const members = [];
    for (const member of group.members) {
      let mx = 0;
      let mh = 0;
      const boards = [];
      for (const device of devices) {
        const size = artboardSize(member.item.id, device, framed);
        boards.push({ key: artboardKey(member.item.id, device.id), item: member.item, device, x: mx, y: 0, ...size });
        mx += size.width + DEVICE_GAP;
        mh = Math.max(mh, size.height + size.below);
      }
      const width = mx - DEVICE_GAP;
      members.push({ ...member, x, width, boards, contentH: mh });
      x += width + memberGap;
      contentH = Math.max(contentH, mh);
    }
    const width = x - memberGap;
    const captionH = captionMax > 0 ? explainHeight(group, width, captionMax) : 0;
    const below = group.single ? 0 : choiceReserve;
    placed.push({ ...group, members, width, captionH, height: captionH + labelReserve + contentH + below, x: 0, y: 0 });
  }
  const area = availableArea();
  const aspect = area.width / area.height;
  const totalArea = placed.reduce((sum, group) => sum + group.width * group.height, 0);
  const widest = placed.reduce((max, group) => Math.max(max, group.width), 0);
  // The All view is one design per row; a single-device view packs a grid.
  const rowWidth = framed ? Math.max(widest, Math.sqrt(totalArea * aspect)) : widest;
  const columnGap = memberGap * 2;
  const rowGap = Math.max(memberGap * 2, captionMax * 3);
  // Rows first, so every design in a row stands on one line: the explanations sit
  // above it, each ending just over its own artboards.
  const rows = [];
  let current = [];
  let currentWidth = 0;
  for (const group of placed) {
    if (current.length > 0 && currentWidth + columnGap + group.width > rowWidth + 1) {
      rows.push(current);
      current = [];
      currentWidth = 0;
    }
    currentWidth += (current.length > 0 ? columnGap : 0) + group.width;
    current.push(group);
  }
  if (current.length > 0) rows.push(current);
  let cursorY = 0;
  for (const row of rows) {
    const captionH = Math.max(...row.map((group) => group.captionH));
    const contentH = Math.max(...row.map((group) => group.height - group.captionH));
    let cursorX = 0;
    for (const group of row) {
      group.x = cursorX;
      group.y = cursorY + captionH - group.captionH;
      const top = cursorY + captionH + labelReserve;
      for (const member of group.members) {
        for (const board of member.boards) {
          board.x = cursorX + member.x + board.x;
          board.y = top;
        }
        member.choiceX = cursorX + member.x;
        member.choiceY = top + member.contentH;
      }
      group.height = captionH - (group.y - cursorY) + contentH;
      cursorX += group.width + columnGap;
    }
    cursorY += captionH + contentH + rowGap;
  }
  const width = placed.reduce((max, group) => Math.max(max, group.x + group.width), 0);
  const height = placed.reduce((max, group) => Math.max(max, group.y + group.height), 0);
  return {
    groups: placed,
    captionMax,
    labelMax,
    labelReserve,
    choiceReserve,
    bounds: placed.length > 0 ? { left: 0, top: 0, width, height } : null,
  };
}

/** Lay out, then size the text for the zoom the board will be fitted at. */
function planLayout() {
  const groups = buildGroups();
  let layout = computeLayout(groups, 0, LABEL_PX);
  for (let pass = 0; pass < 2; pass += 1) {
    const zoom = fitZoomFor(layout.bounds);
    layout = computeLayout(groups, Math.max(CAPTION_PX, CAPTION_PX / zoom), Math.max(LABEL_PX, LABEL_PX / zoom));
  }
  return layout;
}

function relayout() {
  state.layout = planLayout();
  render();
}

let layoutTimer = 0;
function scheduleLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(() => {
    relayout();
    if (!userAdjustedCamera) fit(false);
  }, 120);
}

/* ------------------------------------------------------------------ render */

function itemUrl(item, deviceId) {
  return `/board/${encodeURIComponent(key)}/item/${encodeURIComponent(item.id)}/index.html?device=${encodeURIComponent(deviceId)}`;
}

function createArtboard(item, device) {
  const id = artboardKey(item.id, device.id);
  const root = element("div", { class: "artboard", "data-key": id, "data-device": device.id });
  const screen = element("div", { class: "screen" });
  const iframe = element("iframe", {
    title: `${item.label} at ${device.width}`,
    sandbox: "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
  });
  iframe.style.width = `${device.width}px`;
  iframe.style.height = `${device.height}px`;
  iframe.addEventListener("load", () => {
    postPins(item.id, device.id);
    postTune(item.id, device.id);
  });
  const shield = element("div", { class: "shield", "data-key": id });
  screen.append(iframe, shield);
  root.append(screen);
  const label = element("div", { class: "artboard-label" });
  const name = element("span", { class: "name" });
  const width = element("span", { class: "width" });
  const tune = element("button", { class: "tune-toggle", type: "button", text: "Tune" });
  tune.addEventListener("click", (event) => {
    event.stopPropagation();
    openTune(item.id, device.id);
  });
  label.append(name, width, tune);
  canvas.append(root, label);
  // Every frame loads up front: the layout needs each page's real height.
  iframe.src = itemUrl(item, device.id);
  const record = { id, itemId: item.id, device, root, screen, iframe, shield, label, name, width };
  state.artboards.set(id, record);
  return record;
}

function render() {
  const layout = state.layout;
  const framed = framedView();
  const seen = new Set();
  const seenGroups = new Set();
  canvas.style.setProperty("--cap-max", `${layout.captionMax}px`);
  canvas.style.setProperty("--label-max", `${layout.labelMax}px`);
  for (const group of layout.groups) {
    seenGroups.add(group.key);
    let explain = state.explains.get(group.key);
    if (!explain) {
      explain = element("div", { class: "explain" });
      canvas.append(explain);
      state.explains.set(group.key, explain);
    }
    explain.replaceChildren(explainContent(group));
    explain.style.left = `${group.x}px`;
    explain.style.top = `${group.y}px`;
    explain.style.width = `${group.width}px`;
    explain.style.height = `${group.captionH}px`;
    for (const member of group.members) {
      member.boards.forEach((board, index) => {
        seen.add(board.key);
        const record = state.artboards.get(board.key) || createArtboard(board.item, board.device);
        record.root.hidden = false;
        record.label.hidden = false;
        record.root.dataset.framed = String(framed);
        record.root.style.left = `${board.x}px`;
        record.root.style.top = `${board.y}px`;
        record.root.style.width = `${board.width}px`;
        record.root.style.height = `${board.height}px`;
        record.screen.style.position = "absolute";
        record.screen.style.left = `${board.pad.side}px`;
        record.screen.style.top = `${board.pad.top}px`;
        record.screen.style.width = `${board.screenWidth}px`;
        record.screen.style.height = `${board.screenHeight}px`;
        record.iframe.style.height = `${board.screenHeight}px`;
        record.label.style.left = `${board.x}px`;
        record.label.style.top = `${board.y - layout.labelReserve}px`;
        record.label.style.width = `${board.width}px`;
        record.label.style.height = `${layout.labelReserve}px`;
        record.name.textContent = index === 0 ? member.label : "";
        record.width.textContent = framed && member.label ? "" : String(board.device.width);
      });
    }
  }
  for (const [id, record] of state.artboards) {
    if (seen.has(id)) continue;
    if (!itemById(record.itemId)) {
      record.root.remove();
      record.label.remove();
      state.artboards.delete(id);
      continue;
    }
    record.root.hidden = true;
    record.label.hidden = true;
  }
  const seenChoices = new Set();
  for (const group of layout.groups) {
    if (group.single) continue;
    for (const member of group.members) {
      seenChoices.add(member.item.id);
      let choice = state.choices.get(member.item.id);
      if (!choice) {
        choice = element("div", { class: "choice", "data-item": member.item.id });
        canvas.append(choice);
        state.choices.set(member.item.id, choice);
      }
      choice.style.left = `${member.choiceX}px`;
      choice.style.top = `${member.choiceY}px`;
      choice.style.width = `${member.width}px`;
      choice.style.height = `${layout.choiceReserve}px`;
      renderChoice(choice, group, member);
    }
  }
  for (const [id, choice] of state.choices) {
    if (seenChoices.has(id)) continue;
    choice.remove();
    state.choices.delete(id);
  }
  for (const [id, explain] of state.explains) {
    if (seenGroups.has(id)) continue;
    explain.remove();
    state.explains.delete(id);
  }
  emptyElement.hidden = layout.groups.length > 0;
}

/* ----------------------------------------------------------------- choices */

// Choosing a version is one click: Accept under a proposal, Keep today under today.
// The choice lives on the item's `status` in board.json, and each click (or undo) is
// sent to the agent at once, so the decision never waits in a queue.
const CHOSEN = { today: "kept", proposed: "accepted" };

function chosenStatus(item) {
  return CHOSEN[item.pair?.role === "today" ? "today" : "proposed"];
}

function renderChoice(container, group, member) {
  const item = member.item;
  const today = item.pair?.role === "today";
  const chosen = item.status === chosenStatus(item);
  container.dataset.chosen = String(chosen);
  if (chosen) {
    const mark = element("span", { class: "choice-mark", text: today ? "✓ Kept" : "✓ Accepted" });
    const undo = element("button", { class: "button button-quiet choice-undo", type: "button", text: "Undo" });
    undo.addEventListener("click", () => choose(group, member, false));
    container.replaceChildren(mark, undo);
    return;
  }
  const button = element("button", {
    class: today ? "button choice-button" : "button button-primary choice-button",
    type: "button",
    text: today ? "Keep today" : "Accept",
  });
  button.disabled = state.ended;
  button.addEventListener("click", () => choose(group, member, true));
  container.replaceChildren(button);
}

function choose(group, member, accept) {
  if (state.ended) return;
  const scope = framedView() ? String(visibleDevices()[0].width) : "all sizes";
  const item = member.item;
  const today = item.pair?.role === "today";
  const changes = [];
  for (const other of group.members) {
    const next = accept && other === member ? chosenStatus(other.item) : "open";
    if (other.item.status !== next) {
      other.item.status = next;
      changes.push({ id: other.item.id, status: next });
    }
  }
  if (changes.length > 0) {
    fetch(`/api/boards/${encodeURIComponent(key)}/place`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: changes }),
    }).catch(() => {});
  }
  const message = accept
    ? today
      ? `Keep today: ${group.title} (${scope})`
      : `Accepted: ${group.title} - ${member.label} (${scope})`
    : `Changed my mind: ${group.title} - ${member.label} is no longer ${today ? "kept" : "accepted"}`;
  sendPrompts([], message);
  render();
}

/* ------------------------------------------------------------------ camera */

let userAdjustedCamera = false;
let movingTimer = 0;

// Camera coordinates are relative to the plane, which starts under the bar.
function applyCamera() {
  const { x, y, zoom } = state.camera;
  canvas.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  canvas.style.setProperty("--zoom", String(zoom));
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

let cameraFrame = 0;
// Gestures write the camera once per frame and never through a CSS transition. While
// the board moves it keeps its raster, and it sharpens again once it stops.
function scheduleApplyCamera() {
  canvas.dataset.moving = "true";
  clearTimeout(movingTimer);
  movingTimer = window.setTimeout(() => {
    delete canvas.dataset.moving;
  }, 180);
  if (cameraFrame) return;
  cameraFrame = window.requestAnimationFrame(() => {
    cameraFrame = 0;
    applyCamera();
  });
}

function cameraKey() {
  return `${state.activeTab}:${state.deviceMode}`;
}

function loadCamera() {
  try {
    const stored = JSON.parse(readStorage(cameraStorageKey) || "{}");
    const saved = stored?.[cameraKey()];
    if (!saved) return false;
    state.camera = {
      x: Number(saved.x) || 0,
      y: Number(saved.y) || 0,
      zoom: clamp(Number(saved.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
    };
    return true;
  } catch {
    return false;
  }
}

let cameraSaveTimer = 0;
function saveCamera() {
  clearTimeout(cameraSaveTimer);
  cameraSaveTimer = window.setTimeout(() => {
    let stored;
    try {
      stored = JSON.parse(readStorage(cameraStorageKey) || "{}") || {};
    } catch {
      stored = {};
    }
    stored[cameraKey()] = { ...state.camera };
    writeStorage(cameraStorageKey, JSON.stringify(stored));
  }, 300);
}

let animationTimer = 0;
function setCamera(next, animate) {
  state.camera = next;
  canvas.style.transition = animate ? "transform 260ms cubic-bezier(.2,.8,.2,1)" : "";
  applyCamera();
  saveCamera();
  clearTimeout(animationTimer);
  if (animate) {
    animationTimer = window.setTimeout(() => {
      canvas.style.transition = "";
    }, 280);
  }
}

function fit(animate = true) {
  const bounds = state.layout?.bounds;
  if (!bounds) {
    setCamera({ x: 0, y: 0, zoom: 1 }, false);
    return;
  }
  const area = availableArea();
  const zoom = fitZoomFor(bounds);
  const tall = bounds.height * zoom > area.height - FIT_PADDING * 2;
  setCamera(
    {
      zoom,
      x: (area.width - bounds.width * zoom) / 2 - bounds.left * zoom,
      y: tall ? FIT_PADDING - bounds.top * zoom : (area.height - bounds.height * zoom) / 2 - bounds.top * zoom,
    },
    animate,
  );
}

function zoomAt(clientX, clientY, factor) {
  const localY = clientY - barHeight();
  const worldX = (clientX - state.camera.x) / state.camera.zoom;
  const worldY = (localY - state.camera.y) / state.camera.zoom;
  const zoom = clamp(state.camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  state.camera = { zoom, x: clientX - worldX * zoom, y: localY - worldY * zoom };
}

function wheelDelta(event, axis = "deltaY") {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
  return (Number(event[axis]) || 0) * scale;
}

function zoomWithWheel(clientX, clientY, event) {
  userAdjustedCamera = true;
  canvas.style.transition = "";
  // A mouse wheel notch is a firm step, not a jump.
  const delta = clamp(wheelDelta(event), -60, 60);
  zoomAt(clientX, clientY, Math.exp(-delta * PINCH_SPEED));
  scheduleApplyCamera();
  saveCamera();
}

function zoomBy(factor) {
  userAdjustedCamera = true;
  const area = availableArea();
  zoomAt(area.width / 2, barHeight() + area.height / 2, factor);
  setCamera({ ...state.camera }, true);
}

function eachBoard() {
  const boards = [];
  for (const group of state.layout?.groups || []) {
    for (const member of group.members) boards.push(...member.boards);
  }
  return boards;
}

function boardByKey(id) {
  return eachBoard().find((board) => board.key === id) || null;
}

function boardAtCenter() {
  const area = availableArea();
  const centerX = (area.width / 2 - state.camera.x) / state.camera.zoom;
  const centerY = (area.height / 2 - state.camera.y) / state.camera.zoom;
  let best = null;
  let bestDistance = Infinity;
  for (const board of eachBoard()) {
    const dx = Math.max(board.x - centerX, 0, centerX - (board.x + board.width));
    const dy = Math.max(board.y - centerY, 0, centerY - (board.y + board.height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = board;
    }
  }
  return best;
}

/** 100%: one CSS pixel per screen pixel, framed on the artboard in view. */
function actualSize() {
  userAdjustedCamera = true;
  const board = (lastHoverKey && boardByKey(lastHoverKey)) || boardAtCenter();
  if (!board) return;
  const area = availableArea();
  const x = board.width + 80 > area.width ? 40 - board.x : (area.width - board.width) / 2 - board.x;
  setCamera({ zoom: 1, x: Math.round(x), y: Math.round(32 - board.y) }, true);
}

/** Double-click: 100% around the point clicked; at 100% it fits the board again. */
function toggleActual(clientX, clientY) {
  userAdjustedCamera = true;
  if (Math.abs(state.camera.zoom - 1) < 0.01) {
    fit();
    return;
  }
  zoomAt(clientX, clientY, 1 / state.camera.zoom);
  setCamera({ ...state.camera }, true);
}

/* ------------------------------------------------------------- navigation */

let metaHeld = false;
let spaceHeld = false;
let lastHoverKey = "";
let hoverFrame = 0;
let panWheelAt = 0;

function panModeActive() {
  return metaHeld || spaceHeld;
}

function updatePanMode() {
  document.body.dataset.pan = String(panModeActive());
  if (panModeActive()) clearHover();
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

function recordForShield(target) {
  if (!(target instanceof Element)) return null;
  const shield = target.closest(".shield");
  return shield ? state.artboards.get(shield.getAttribute("data-key") || "") || null : null;
}

/** A screen point inside an artboard's own viewport: one division by the zoom. */
function pointInFrame(record, clientX, clientY) {
  const rect = record.iframe.getBoundingClientRect();
  const scale = rect.width / record.device.width || state.camera.zoom;
  return { x: Math.round((clientX - rect.left) / scale), y: Math.round((clientY - rect.top) / scale) };
}

function postHit(record, payload) {
  postToArtboard(record.itemId, record.device.id, { type: "hit", ...payload });
}

function clearHover() {
  if (!lastHoverKey) return;
  const record = state.artboards.get(lastHoverKey);
  if (record) {
    postHit(record, { hover: true, x: -1, y: -1 });
    delete record.root.dataset.hover;
  }
}

function bindNavigation() {
  /** @type {null | { x: number, y: number, cameraX: number, cameraY: number, id: number, moved: boolean }} */
  let drag = null;
  let suppressClick = false;

  plane.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    const onShield = Boolean(recordForShield(event.target));
    const pan = event.button === 1 || (event.button === 0 && (panModeActive() || !onShield));
    suppressClick = pan && onShield;
    if (!pan) return;
    event.preventDefault();
    drag = {
      x: event.clientX,
      y: event.clientY,
      cameraX: state.camera.x,
      cameraY: state.camera.y,
      id: event.pointerId,
      moved: false,
    };
    plane.setPointerCapture(event.pointerId);
    document.body.dataset.grabbing = "true";
    clearHover();
  });

  plane.addEventListener("pointermove", (event) => {
    if (drag && event.pointerId === drag.id) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      userAdjustedCamera = true;
      canvas.style.transition = "";
      state.camera.x = drag.cameraX + dx;
      state.camera.y = drag.cameraY + dy;
      scheduleApplyCamera();
      return;
    }
    if (panModeActive()) return;
    const record = recordForShield(event.target);
    if (!record) {
      clearHover();
      lastHoverKey = "";
      return;
    }
    if (lastHoverKey && lastHoverKey !== record.id) clearHover();
    lastHoverKey = record.id;
    record.root.dataset.hover = "true";
    const point = pointInFrame(record, event.clientX, event.clientY);
    if (hoverFrame) window.cancelAnimationFrame(hoverFrame);
    hoverFrame = window.requestAnimationFrame(() => {
      hoverFrame = 0;
      postHit(record, { ...point, hover: true });
    });
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    document.body.dataset.grabbing = "false";
    saveCamera();
  };
  plane.addEventListener("pointerup", endDrag);
  plane.addEventListener("pointercancel", endDrag);
  plane.addEventListener("pointerleave", () => clearHover());

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let clickTimer;
  plane.addEventListener("click", (event) => {
    const record = recordForShield(event.target);
    if (!record || suppressClick || panModeActive()) return;
    const point = pointInFrame(record, event.clientX, event.clientY);
    const at = { x: event.clientX, y: event.clientY };
    // A double-click means zoom, so the note waits out the double-click window.
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      pendingClick = { key: record.id, ...at, time: Date.now() };
      postHit(record, point);
    }, 220);
  });

  plane.addEventListener("dblclick", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    clearTimeout(clickTimer);
    event.preventDefault();
    if (recordForShield(event.target)) toggleActual(event.clientX, event.clientY);
    else {
      userAdjustedCamera = true;
      fit();
    }
  });

  plane.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) return;
      const now = performance.now();
      const record = recordForShield(event.target);
      // In a device view a scroll over a screen scrolls that page. A pan already
      // under way keeps panning when it slides over a device.
      if (record && framedView() && now - panWheelAt > 220) {
        postToArtboard(record.itemId, record.device.id, {
          type: "scroll",
          dx: wheelDelta(event, "deltaX"),
          dy: wheelDelta(event, "deltaY"),
        });
        return;
      }
      panWheelAt = now;
      userAdjustedCamera = true;
      canvas.style.transition = "";
      state.camera.x -= wheelDelta(event, "deltaX");
      state.camera.y -= wheelDelta(event, "deltaY");
      scheduleApplyCamera();
      saveCamera();
    },
    { passive: false },
  );

  // Pinch (ctrl+wheel) and Cmd+scroll zoom the canvas wherever the pointer is: over
  // the bar, the panel or a gap, Chrome would otherwise zoom the whole window.
  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      zoomWithWheel(event.clientX, event.clientY, event);
    },
    { capture: true, passive: false },
  );
}

/* ------------------------------------------------------------ tabs/devices */

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

function setTab(id) {
  if (!state.tabs.some((tab) => tab.id === id) || id === state.activeTab) return;
  state.activeTab = id;
  renderTabs();
  relayout();
  userAdjustedCamera = loadCamera();
  if (userAdjustedCamera) applyCamera();
  else fit(false);
}

function renderDevices() {
  if (!deviceBar) return;
  const options = [{ id: "all", label: "All" }, ...DEVICES];
  deviceBar.replaceChildren(
    ...options.map((device) => {
      const button = element("button", {
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
  if (mode === state.deviceMode) return;
  state.deviceMode = mode;
  writeStorage(deviceStorageKey, mode);
  renderDevices();
  closeNoteWindow();
  relayout();
  userAdjustedCamera = false;
  fit(false);
}

/* ------------------------------------------------------------- artboards */

/** @param {string} itemId @param {string} deviceId @param {Record<string, unknown>} message */
function postToArtboard(itemId, deviceId, message) {
  const record = state.artboards.get(artboardKey(itemId, deviceId));
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
      ox: note.ox,
      oy: note.oy,
      state: note.prompt_id ? "sent" : "draft",
    }));
}

function postPins(itemId, deviceId) {
  const item = itemById(itemId);
  if (item) postToArtboard(itemId, deviceId, { type: "pins", pins: pinsFor(item, deviceId) });
}

function postAllPins() {
  for (const record of state.artboards.values()) postPins(record.itemId, record.device.id);
}

/* ------------------------------------------------------------------ notes */

/** @type {null | { key: string, x: number, y: number, time: number }} */
let pendingClick = null;
/** @type {Set<string>} */
const sendingPrompts = new Set();

function randomId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function boardNotes() {
  const entries = [];
  for (const item of state.items) {
    for (const note of item.notes || []) entries.push({ item, note });
  }
  return entries.sort((left, right) => left.note.number - right.note.number);
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

function nextNoteNumber() {
  return boardNotes().reduce((value, entry) => Math.max(value, Number(entry.note.number) || 0), 0) + 1;
}

// Pin numbers are one sequence across the board. An older board can carry a number
// twice; the later note takes a fresh number and every other note keeps its own, so
// "pin 3" still means what the agent was told.
function ensureUniqueNumbers() {
  const seen = new Set();
  const touched = new Set();
  let next = nextNoteNumber();
  const ordered = boardNotes().sort((left, right) =>
    String(left.note.at || "").localeCompare(String(right.note.at || "")),
  );
  for (const { item, note } of ordered) {
    const number = Number(note.number) || 0;
    if (number > 0 && !seen.has(number)) {
      seen.add(number);
      continue;
    }
    note.number = next;
    seen.add(next);
    next += 1;
    touched.add(item.id);
  }
  for (const itemId of touched) persistNotes(itemId, { immediate: true });
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
  else noteTimers.set(itemId, setTimeout(write, 400));
}

function removeNote(noteId) {
  const live = liveNote(noteId);
  if (!live) return;
  live.item.notes = (live.item.notes || []).filter((entry) => entry.id !== noteId);
  persistNotes(live.item.id, { immediate: true });
  postPins(live.item.id, noteDevice(live.note));
  renderChatPanel();
}

/** @param {any} item @param {any} payload @param {string} deviceId */
function addNote(item, payload, deviceId) {
  const note = {
    id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    number: nextNoteNumber(),
    label: String(payload.text || "").slice(0, 90),
    selector: String(payload.selector || ""),
    tag: String(payload.tag || ""),
    device: deviceId,
    text: "",
    x: Math.round(Number(payload.x) || 0),
    y: Math.round(Number(payload.y) || 0),
    ox: Math.round(Number(payload.ox) || 0),
    oy: Math.round(Number(payload.oy) || 0),
    at: new Date().toISOString(),
  };
  item.notes = [...(item.notes || []), note];
  postPins(item.id, deviceId);
  showNoteWindow(item, note, { fresh: true });
}

/**
 * Send notes, and an optional free message, to the agent as one batch.
 * @param {string[]} noteIds
 * @param {string} [message]
 * @returns {Promise<boolean>}
 */
function sendPrompts(noteIds, message = "") {
  if (state.ended) return Promise.resolve(false);
  const sent = [];
  /** @type {any[]} */
  const prompts = [];
  for (const noteId of noteIds) {
    const live = liveNote(noteId);
    if (!live || live.note.prompt_id) continue;
    const text = String(live.note.text || "").trim();
    if (!text) continue;
    const promptId = randomId();
    live.note.prompt_id = promptId;
    sendingPrompts.add(promptId);
    sent.push({ ...live, promptId });
    prompts.push({
      uid: randomId(),
      prompt_id: promptId,
      prompt: text,
      selector: live.note.selector,
      text: live.note.label,
      tag: "pin",
      item: { id: live.item.id, label: live.item.label },
      pin: { id: live.note.id, number: live.note.number, viewport: deviceById(noteDevice(live.note)).width },
    });
  }
  if (message) prompts.push({ uid: randomId(), prompt: message, tag: "message" });
  if (prompts.length === 0) return Promise.resolve(false);
  for (const entry of sent) postPins(entry.item.id, noteDevice(entry.note));
  renderChatPanel();
  return fetch(`/api/${encodeURIComponent(key)}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts, domSnapshot: "" }),
  })
    .then((response) => {
      if (!response.ok) throw new Error("not accepted");
      for (const entry of sent) sendingPrompts.delete(entry.promptId);
      for (const itemId of new Set(sent.map((entry) => entry.item.id))) persistNotes(itemId, { immediate: true });
      dockStatus.textContent = "";
      renderChatPanel();
      refreshBoard();
      return true;
    })
    .catch(() => {
      for (const entry of sent) {
        sendingPrompts.delete(entry.promptId);
        delete entry.note.prompt_id;
        postPins(entry.item.id, noteDevice(entry.note));
      }
      dockStatus.textContent = "Could not reach Easel. Your notes are still here.";
      renderChatPanel();
      return false;
    });
}

/* --------------------------------------------------------------- popover */

/** @type {any} */
let noteWindow = null;

function closeNoteWindow() {
  if (!noteWindow) return;
  const noteId = noteWindow.dataset.note || "";
  noteWindow.remove();
  noteWindow = null;
  const live = liveNote(noteId);
  if (!live) return;
  if (!live.note.prompt_id && !String(live.note.text || "").trim()) {
    removeNote(noteId);
    return;
  }
  // A note with words in it that is clicked away stays as a draft.
  persistNotes(live.item.id, { immediate: true });
  renderChatPanel();
}

function popoverPoint(item, note) {
  if (pendingClick && Date.now() - pendingClick.time < 4000) {
    const point = { x: pendingClick.x, y: pendingClick.y };
    pendingClick = null;
    return point;
  }
  const record = state.artboards.get(artboardKey(item.id, noteDevice(note)));
  if (!record) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const rect = record.iframe.getBoundingClientRect();
  const scale = rect.width / record.device.width || 1;
  return { x: rect.left + (Number(note.x) || 0) * scale, y: rect.top + (Number(note.y) || 0) * scale };
}

function sentState(note) {
  if (sendingPrompts.has(note.prompt_id)) return "Sending";
  const entry = state.chat.find((message) => message && message.prompt_id === note.prompt_id);
  if (!entry) return "Sent";
  if (entry.done_at) return "Answered";
  return entry.delivered_at || entry.receipt === "none" ? "Read" : "Not read yet";
}

/** @param {any} item @param {any} note @param {{ fresh?: boolean }} [options] */
function showNoteWindow(item, note, { fresh = false } = {}) {
  closeNoteWindow();
  const sent = Boolean(note.prompt_id);
  const saved = !fresh && (sent || Boolean(String(note.text || "").trim()));
  const pop = element("div", { class: "note-pop", "data-note": note.id, role: "dialog" });
  const head = element("div", { class: "note-pop-head" });
  head.append(
    element("span", { class: "note-num", text: String(note.number) }),
    element("span", { class: "note-where", text: designName(item, noteDevice(note)) }),
  );
  const close = element("button", { class: "icon-button", type: "button", text: "×", "aria-label": "Close" });
  close.addEventListener("click", () => closeNoteWindow());
  head.append(close);
  const textarea = element("textarea", { class: "note-input", rows: "3", placeholder: "What should change?" });
  textarea.value = note.text || "";
  textarea.readOnly = sent;
  const sendNow = () => {
    note.text = textarea.value;
    if (!String(note.text).trim()) {
      textarea.focus();
      return;
    }
    pop.remove();
    noteWindow = null;
    sendPrompts([note.id]);
  };
  textarea.addEventListener("input", () => {
    note.text = textarea.value;
    persistNotes(item.id);
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeNoteWindow();
    } else if (event.key === "Enter" && !event.shiftKey && !sent) {
      event.preventDefault();
      sendNow();
    }
  });
  const actions = element("div", { class: "note-pop-actions" });
  if (saved) {
    const remove = element("button", { class: "button button-quiet", type: "button", text: "Remove" });
    remove.addEventListener("click", () => {
      pop.remove();
      noteWindow = null;
      removeNote(note.id);
    });
    actions.append(remove);
  }
  actions.append(element("span", { class: "spacer" }));
  if (sent) {
    actions.append(element("span", { class: "note-state", text: sentState(note) }));
  } else {
    const queue = element("button", { class: "button", type: "button", text: "Queue" });
    queue.addEventListener("click", () => {
      note.text = textarea.value;
      closeNoteWindow();
    });
    const send = element("button", { class: "button button-primary", type: "button", text: "Send now" });
    send.addEventListener("click", sendNow);
    actions.append(queue, send);
  }
  pop.append(head, textarea, actions);
  document.body.append(pop);
  noteWindow = pop;
  const point = popoverPoint(item, note);
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const margin = 12;
  const right = window.innerWidth - panelWidth();
  let left = point.x + 14;
  if (left + width + margin > right) left = point.x - width - 14;
  left = clamp(left, margin, Math.max(margin, window.innerWidth - width - margin));
  let top = point.y + 14;
  if (top + height + margin > window.innerHeight) top = point.y - height - 14;
  top = clamp(top, barHeight() + margin, Math.max(barHeight() + margin, window.innerHeight - height - margin));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  if (!sent) textarea.focus();
  postToArtboard(item.id, noteDevice(note), { type: "focus", id: note.id });
  renderDrafts();
}

/* ------------------------------------------------------------ notes panel */

function entryStateText(entry) {
  if (entry.prompt_id && sendingPrompts.has(entry.prompt_id)) return "Sending";
  if (!entry.delivered_at && entry.receipt !== "none") return "Not read yet";
  return "";
}

function formatTime(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

function renderChatPanel() {
  const log = document.getElementById("chatLog");
  if (!log) return;
  const rows = [];
  let lastHeading = "";
  for (const entry of state.chat) {
    if (!entry) continue;
    if (entry.role === "agent") {
      const row = element("div", { class: "entry entry-agent", title: formatTime(entry.at) });
      const text = element("div", { class: "entry-text" });
      // Agent replies arrive as server-rendered markdown; user text is always escaped.
      if (entry.html) text.innerHTML = String(entry.html);
      else text.textContent = String(entry.text || "");
      row.append(text);
      rows.push(row);
      continue;
    }
    const matched = noteByPromptId(entry.prompt_id);
    if (matched) {
      const heading = designName(matched.item, noteDevice(matched.note));
      if (heading !== lastHeading) {
        rows.push(element("h3", { class: "chat-group", text: heading }));
        lastHeading = heading;
      }
    }
    const row = element("div", { class: "entry", title: formatTime(entry.at) });
    if (matched) {
      row.dataset.note = matched.note.id;
      row.append(element("span", { class: "entry-number", text: String(matched.note.number) }));
      row.addEventListener("click", () => focusPin(matched.item, matched.note));
    }
    row.append(element("div", { class: "entry-text", text: String(entry.text || "") }));
    const quiet = entryStateText(entry);
    if (quiet) row.append(element("div", { class: "entry-state", text: quiet }));
    rows.push(row);
  }
  // A note in flight shows before the server has written it into the transcript.
  for (const promptId of sendingPrompts) {
    if (state.chat.some((entry) => entry && entry.prompt_id === promptId)) continue;
    const matched = noteByPromptId(promptId);
    if (!matched) continue;
    const row = element("div", { class: "entry", "data-note": matched.note.id });
    row.append(
      element("span", { class: "entry-number", text: String(matched.note.number) }),
      element("div", { class: "entry-text", text: String(matched.note.text || "") }),
      element("div", { class: "entry-state", text: "Sending" }),
    );
    rows.push(row);
  }
  if (rows.length === 0) {
    rows.push(element("p", { class: "chat-empty", text: "Click anything on a design to leave a note." }));
  }
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren(...rows);
  if (atBottom) log.scrollTop = log.scrollHeight;
  renderDrafts();
}

function draftsToSend() {
  return boardNotes().filter(({ note }) => !note.prompt_id && String(note.text || "").trim());
}

function renderDrafts() {
  const container = document.getElementById("chatDrafts");
  if (!container) return;
  const focused = /** @type {any} */ (document.activeElement);
  const focusedNote = focused?.closest?.(".draft")?.dataset.note || "";
  const open = noteWindow?.dataset.note || "";
  const drafts = draftsToSend().filter(({ note }) => note.id !== open);
  container.replaceChildren(
    ...drafts.map(({ item, note }) => {
      const draft = element("div", { class: "draft", "data-note": note.id });
      const name = element("div", { class: "draft-name" });
      name.append(
        element("span", { class: "entry-number", text: String(note.number) }),
        element("span", { text: designName(item, noteDevice(note)) }),
      );
      const tools = element("span", { class: "draft-tools" });
      const sendOne = element("button", {
        class: "icon-button",
        type: "button",
        text: "↑",
        title: "Send this note now",
        "aria-label": "Send this note now",
      });
      sendOne.addEventListener("click", () => sendPrompts([note.id]));
      const remove = element("button", {
        class: "icon-button",
        type: "button",
        text: "×",
        title: "Remove",
        "aria-label": "Remove",
      });
      remove.addEventListener("click", () => removeNote(note.id));
      tools.append(sendOne, remove);
      name.append(tools);
      name.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest("button")) return;
        focusPin(item, note);
      });
      const input = element("textarea", { class: "draft-input", rows: "1" });
      input.value = note.text || "";
      const fitHeight = () => {
        input.style.height = "auto";
        input.style.height = `${input.scrollHeight + 2}px`;
      };
      window.requestAnimationFrame(fitHeight);
      input.addEventListener("input", () => {
        fitHeight();
        note.text = input.value;
        persistNotes(item.id);
        updateSendButton();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          sendPrompts([note.id]);
        }
      });
      draft.append(name, input);
      return draft;
    }),
  );
  if (focusedNote) {
    const field = /** @type {any} */ (container.querySelector(`[data-note="${CSS.escape(focusedNote)}"] textarea`));
    if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }
  updateSendButton();
}

function updateSendButton() {
  const count = draftsToSend().length + (composerInput.value.trim() ? 1 : 0);
  sendButton.textContent = count > 1 ? `Send ${count}` : "Send";
  sendButton.disabled = state.ended || count === 0;
}

function sendAll() {
  const message = composerInput.value.trim();
  const ids = draftsToSend().map(({ note }) => note.id);
  if (!message && ids.length === 0) return;
  sendButton.disabled = true;
  sendPrompts(ids, message).then((ok) => {
    if (ok) {
      composerInput.value = "";
      autosize();
    }
    updateSendButton();
  });
}

function autosize() {
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(200, composerInput.scrollHeight + 2)}px`;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let flashTimer;
function flashEntry(noteId) {
  const row = /** @type {any} */ (
    document.getElementById("chatLog")?.querySelector(`[data-note="${CSS.escape(noteId)}"]`)
  );
  if (!row) return;
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  row.dataset.flash = "true";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    delete row.dataset.flash;
  }, 1400);
}

/** From the panel: bring the pin to the middle of the screen at 100%. */
function focusPin(item, note) {
  if (!item || !note) return;
  if (item.tab !== state.activeTab) setTab(item.tab);
  const deviceId = noteDevice(note);
  if (!visibleDevices().some((device) => device.id === deviceId)) setDeviceMode("all");
  const board = boardByKey(artboardKey(item.id, deviceId));
  if (!board) return;
  userAdjustedCamera = true;
  const area = availableArea();
  const target = framedView()
    ? {
        x: board.pad.side + Math.min(Number(note.x) || 0, board.screenWidth),
        y: board.pad.top + board.screenHeight / 3,
      }
    : { x: Number(note.x) || 0, y: Number(note.y) || 0 };
  setCamera(
    {
      zoom: 1,
      x: Math.round(area.width / 2 - (board.x + target.x)),
      y: Math.round(area.height / 2 - (board.y + target.y)),
    },
    true,
  );
  postToArtboard(item.id, deviceId, { type: "focus", id: note.id, reveal: true });
}

function setPresence(value) {
  const next = value || "waiting";
  presence.dataset.state = next;
  presence.title =
    next === "listening"
      ? "The agent is listening"
      : next === "working"
        ? "The agent is working"
        : "Nobody is listening";
}

function markEnded() {
  state.ended = true;
  endedBanner.hidden = false;
  composerInput.disabled = true;
  sendButton.disabled = true;
}

function setChatCollapsed(collapsed) {
  const chat = document.getElementById("chat");
  const open = document.getElementById("chatOpen");
  if (!chat) return;
  chat.classList.toggle("collapsed", collapsed);
  document.body.dataset.panel = collapsed ? "closed" : "open";
  if (open) open.hidden = !collapsed;
  writeStorage(panelStorageKey, collapsed ? "closed" : "open");
}

/* ------------------------------------------------------------------ tune */

let tuneItemId = "";
let tuneDeviceId = "";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let tuneSaveTimer;

function tuneCss(item, spec, values = item.tune) {
  /** @type {Record<string, string>} */
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
  for (const device of DEVICES) postTune(itemId, device.id);
}

function openTune(itemId, deviceId) {
  const item = itemById(itemId);
  if (!item) return;
  item.tune = item.tune || {};
  tuneItemId = itemId;
  tuneDeviceId = deviceId;
  for (const control of tuneSpecFor(itemId)) {
    if (item.tune[control.id] === undefined || item.tune[control.id] === "")
      item.tune[control.id] = control.value ?? "";
  }
  const panel = document.getElementById("tune");
  if (panel) panel.hidden = false;
  renderTune();
  if (tuneSpecFor(itemId).length === 0) postToArtboard(itemId, deviceId, { type: "tune-spec" });
}

function closeTune() {
  const panel = document.getElementById("tune");
  if (panel) panel.hidden = true;
  tuneItemId = "";
}

function renderTune() {
  const item = itemById(tuneItemId);
  if (!item) return;
  const sub = document.getElementById("tuneSub");
  if (sub) sub.textContent = designName(item, tuneDeviceId);
  const body = document.getElementById("tuneBody");
  if (!body) return;
  const spec = tuneSpecFor(tuneItemId);
  if (spec.length === 0) {
    body.replaceChildren(element("p", { class: "tune-empty", text: "Reading the page's CSS custom properties…" }));
  } else {
    const nodes = [];
    const grouped = spec.some((control) => control.group);
    let lastGroup = "";
    for (const control of spec) {
      const group = control.group || "";
      if (grouped && group !== lastGroup) nodes.push(element("div", { class: "tune-group-name", text: group }));
      lastGroup = group;
      nodes.push(createTuneControl(item, control));
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
    item.tune[control.id] = raw;
    valueLabel.textContent = String(raw);
    postTuneAll(item.id);
    clearTimeout(tuneSaveTimer);
    tuneSaveTimer = setTimeout(() => flushTune(item), 350);
  };
  if (control.type === "color") {
    const input = element("input", { type: "color" });
    input.value = item.tune[control.id] || "#000000";
    input.addEventListener("input", () => apply(input.value));
    wrapper.append(input);
  } else if (control.type === "select") {
    const select = element("select", {});
    for (const option of control.options || [])
      select.append(element("option", { value: option.value, text: option.label }));
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

function renderVersions(item, spec) {
  const container = document.getElementById("tuneVersions");
  if (!container) return;
  const rows = (item.versions || []).map((version) => {
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
      item.tune = { ...version.values };
      postTuneAll(item.id);
      flushTune(item);
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
  flushTune(item);
  renderTune();
}

function copyTune() {
  const item = itemById(tuneItemId);
  if (!item) return;
  const lines = tuneSpecFor(item.id)
    .filter((control) => item.tune[control.id] !== undefined && item.tune[control.id] !== "")
    .map((control) => {
      const value =
        control.type === "number" && control.unit ? `${item.tune[control.id]}${control.unit}` : item.tune[control.id];
      return `- ${control.label}: ${value}  (${control.css})`;
    });
  const text =
    item.tuneInstruction ||
    (lines.length > 0
      ? `Bake these tune values into ${item.file} as CSS custom properties:\n${lines.join("\n")}`
      : `No tune values set for ${item.file}.`);
  const sub = document.getElementById("tuneSub");
  const done = () => {
    if (sub) sub.textContent = "Copied";
    setTimeout(() => {
      if (sub && sub.textContent === "Copied") sub.textContent = designName(item, tuneDeviceId);
    }, 1600);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
  else done();
}

/* ------------------------------------------------------------ server sync */

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
      if (payload?.type === "agent-reply") refreshBoard();
      if (payload?.type === "chat-sync") {
        if (Array.isArray(payload.data?.chat)) state.chat = payload.data.chat;
        renderChatPanel();
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

function itemsSignature(items) {
  return items
    .map((item) => `${item.id}|${item.file}|${item.tab}|${item.caption || ""}|${item.title || ""}|${item.status || ""}`)
    .join("\n");
}

function refreshBoard() {
  fetch(`/api/boards/${encodeURIComponent(key)}`, { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (!payload || !Array.isArray(payload.items)) return;
      const before = itemsSignature(state.items);
      const local = new Map(state.items.map((item) => [item.id, item]));
      const editing = noteWindow?.dataset.note || "";
      state.items = payload.items.map((item) => {
        const mine = local.get(item.id);
        if (!mine) return item;
        // Notes still being written here win over the server's older copy.
        const keepNotes =
          noteTimers.has(item.id) || Boolean(editing && (mine.notes || []).some((note) => note.id === editing));
        return { ...item, notes: keepNotes ? mine.notes : item.notes, tune: mine.tune || item.tune };
      });
      const previousTabs = state.tabs.map((tab) => tab.id).join(",");
      state.tabs = payload.tabs || state.tabs;
      if (Array.isArray(payload.chat)) state.chat = payload.chat;
      if (!state.tabs.some((tab) => tab.id === state.activeTab)) state.activeTab = state.tabs[0]?.id || "";
      if (state.tabs.map((tab) => tab.id).join(",") !== previousTabs) renderTabs();
      if (itemsSignature(state.items) !== before) scheduleLayout();
      ensureUniqueNumbers();
      renderChatPanel();
      postAllPins();
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
  const record = state.artboards.get(artboardKey(itemId, deviceId));
  if (!record || event.source !== record.iframe.contentWindow) return;
  if (data.type === "zoom-wheel") {
    const rect = record.iframe.getBoundingClientRect();
    const scale = rect.width / record.device.width || 1;
    zoomWithWheel(rect.left + (Number(data.x) || 0) * scale, rect.top + (Number(data.y) || 0) * scale, {
      deltaY: Number(data.deltaY) || 0,
      deltaMode: Number(data.deltaMode) || 0,
    });
    return;
  }
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
    const live = liveNote(String(data.id || ""));
    if (live) {
      showNoteWindow(live.item, live.note);
      flashEntry(live.note.id);
    }
    return;
  }
  if (data.type === "size") {
    // A page that keeps growing as it is measured would drag the whole plane with it.
    const height = clamp(Math.round(Number(data.height) || 0), 0, 30000);
    const id = artboardKey(itemId, deviceId);
    if (height > 0 && height !== state.heights.get(id)) {
      state.heights.set(id, height);
      saveHeights();
      if (!framedView()) scheduleLayout();
    }
    return;
  }
  if (data.type === "tune-spec") {
    const controls = Array.isArray(data.controls) ? data.controls : [];
    if (controls.length === 0) return;
    state.autoSpecs.set(itemId, controls);
    const item = itemById(itemId);
    if (item) {
      item.tune = item.tune || {};
      for (const control of controls) {
        if (item.tune[control.id] === undefined || item.tune[control.id] === "")
          item.tune[control.id] = control.value ?? "";
      }
    }
    if (tuneItemId === itemId) renderTune();
  }
}

/* ------------------------------------------------------------------ wire */

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
    if (event.key === "0") {
      userAdjustedCamera = true;
      fit();
    } else zoomBy(event.key === "-" ? 1 / 1.25 : 1.25);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || isTextTarget(event.target)) return;
  if (event.key === "0") {
    userAdjustedCamera = true;
    fit();
  } else if (event.key === "1") actualSize();
  else if (event.key === "+" || event.key === "=") zoomBy(1.25);
  else if (event.key === "-") zoomBy(1 / 1.25);
  else if (event.key === "Escape") {
    closeNoteWindow();
    closeTune();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.key === "Meta" && metaHeld) {
    metaHeld = false;
    updatePanMode();
  }
  if (event.code === "Space" && spaceHeld) {
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

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    relayout();
    if (!userAdjustedCamera) fit(false);
  }, 150);
});

document.getElementById("tuneClose")?.addEventListener("click", closeTune);
document.getElementById("tuneSave")?.addEventListener("click", saveTuneVersion);
document.getElementById("tuneCopy")?.addEventListener("click", copyTune);
document.getElementById("tuneReset")?.addEventListener("click", resetTune);
document.getElementById("zoomIn")?.addEventListener("click", () => zoomBy(1.25));
document.getElementById("zoomOut")?.addEventListener("click", () => zoomBy(1 / 1.25));
document.getElementById("fit")?.addEventListener("click", () => {
  userAdjustedCamera = true;
  fit();
});
document.getElementById("actual")?.addEventListener("click", () => actualSize());
sendButton?.addEventListener("click", sendAll);
document.getElementById("chatToggle")?.addEventListener("click", () => {
  setChatCollapsed(true);
  if (!userAdjustedCamera) fit(false);
});
document.getElementById("chatOpen")?.addEventListener("click", () => {
  setChatCollapsed(false);
  if (!userAdjustedCamera) fit(false);
});
composerInput?.addEventListener("input", () => {
  autosize();
  updateSendButton();
});
composerInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendAll();
  }
});

state.activeTab = state.tabs[0]?.id || "";
setChatCollapsed(readStorage(panelStorageKey) === "closed");
setPresence("waiting");
renderTabs();
renderDevices();
relayout();
userAdjustedCamera = loadCamera();
if (userAdjustedCamera) applyCamera();
else fit(false);
ensureUniqueNumbers();
renderChatPanel();
bindNavigation();
if (state.ended) markEnded();
connectLiveEvents();
setInterval(refreshBoard, 5000);
