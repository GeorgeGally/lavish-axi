/* global CSS, document, window, location, Element, HTMLElement, requestAnimationFrame, cancelAnimationFrame, IntersectionObserver */

const bootstrap = JSON.parse(document.getElementById("liesel-board")?.textContent || "{}");
const key = String(bootstrap.key || "");
const cameraStorageKey = `liesel:camera2:${key}`;
const deviceStorageKey = `liesel:device:${key}`;
const heightStorageKey = `liesel:heights:${key}`;
const panelStorageKey = `liesel:panel:${key}`;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;
// Pinch arrives as ctrl+wheel. Zoom is exp(-delta * k): continuous, no steps.
const PINCH_SPEED = 0.016;
const CAPTION_PX = 15;
const LABEL_PX = 13;

// Every artboard renders at a real device viewport, in real CSS pixels: the camera is
// the only scale on the board, so a point on screen maps into a page by one division.
const DEVICES = [
  { id: "ultrawide", label: "Ultrawide", width: 3440, height: 1440 },
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
  { id: "ipad", label: "iPad", width: 834, height: 1194 },
  { id: "phone", label: "Phone", width: 390, height: 844 },
];
// Bezel thickness of the CSS device frames, in board pixels. `below` is room for the
// desktop stand, which hangs under the frame.
const FRAME = {
  ultrawide: { top: 24, side: 24, bottom: 48, below: 80 },
  desktop: { top: 20, side: 20, bottom: 44, below: 70 },
  ipad: { top: 26, side: 26, bottom: 26, below: 0 },
  // A phone page starts below the status bar, so the island sits in the bezel.
  phone: { top: 54, side: 14, bottom: 14, below: 0 },
};
const MEMBER_GAP = { all: 200, ultrawide: 200, desktop: 140, ipad: 100, phone: 72 };
// Only the All view shows more than one device, so this gap sets the air between the
// 1440, 834 and 390 screens there, at the same breathing room as the space between items.
const DEVICE_GAP = MEMBER_GAP.all;
// The formats that are on, remembered per board. An ultrawide artboard is as wide as the
// other three together, so it stays off until it is switched on. Boards saved before each
// format had a switch hold only that ultrawide choice, which still counts.
const formatsStorageKey = `liesel:formats:${key}`;
const ultrawideStorageKey = `liesel:ultrawide:${key}`;
const annotateHintStorageKey = `liesel:gesture-hint:${key}`;

const initialFormats = loadFormats();

const state = {
  tabs: Array.isArray(bootstrap.tabs) ? bootstrap.tabs : [],
  items: Array.isArray(bootstrap.items) ? bootstrap.items : [],
  /** @type {Array<{ a: string, b: string, locked?: boolean }>} */
  pairs: Array.isArray(bootstrap.pairs) ? bootstrap.pairs : [],
  chat: Array.isArray(bootstrap.chat) ? bootstrap.chat : [],
  ended: Boolean(bootstrap.ended),
  activeTab: "",
  deviceMode: loadDeviceMode(initialFormats),
  formats: initialFormats,
  camera: { x: 0, y: 0, zoom: 1 },
  /** @type {Map<string, any>} */
  artboards: new Map(),
  /** @type {Map<string, any>} */
  explains: new Map(),
  /** @type {Map<string, any>} */
  choices: new Map(),
  /** @type {Map<string, any>} */
  placeholders: new Map(),
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

/** @returns {Set<string>} */
function loadFormats() {
  let saved = [];
  try {
    saved = JSON.parse(readStorage(formatsStorageKey) || "[]");
  } catch {
    saved = [];
  }
  const known = DEVICES.map((device) => device.id).filter((id) => Array.isArray(saved) && saved.includes(id));
  if (known.length > 0) return new Set(known);
  const ultrawide = readStorage(ultrawideStorageKey) === "on";
  return new Set(DEVICES.map((device) => device.id).filter((id) => ultrawide || id !== "ultrawide"));
}

/** @param {Set<string>} formats */
function loadDeviceMode(formats) {
  const stored = String(readStorage(deviceStorageKey) || "");
  return formats.has(stored) ? stored : "all";
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
    // A compared build's frame is gone once its history closes; only items are kept.
    const kept = [...state.heights].filter(([id]) => !id.includes("~"));
    writeStorage(heightStorageKey, JSON.stringify(Object.fromEntries(kept)));
  }, 600);
}

function visibleDevices() {
  if (state.deviceMode !== "all") return DEVICES.filter((device) => device.id === state.deviceMode);
  return enabledFormats();
}

function enabledFormats() {
  return DEVICES.filter((device) => state.formats.has(device.id));
}

function deviceById(id) {
  return DEVICES.find((device) => device.id === id) || DEVICES.find((device) => device.id === "desktop") || DEVICES[0];
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

function fileStem(item) {
  return String(item.file || "").replace(/\.html?$/i, "");
}

// The words a derived file adds to its parent's name: "02-why-card-type-a" grown from
// "02-why-card-today" reads "Type A".
function derivedLabel(item, parent) {
  const own = fileStem(item).split(/[-_ ]+/);
  const theirs = fileStem(parent).split(/[-_ ]+/);
  let shared = 0;
  while (shared < own.length && shared < theirs.length && own[shared].toLowerCase() === theirs[shared].toLowerCase())
    shared += 1;
  const rest = own.slice(shared).map((word) => (word.length <= 2 ? word.toUpperCase() : word));
  return capitalize(rest.join(" ")) || item.label;
}

/**
 * The version a new, unpaired file grew from: its `liesel-parent` meta, or else the
 * paired version with the same NN prefix whose name it shares most of (today first).
 */
function parentOf(item, pairedItems) {
  if (item.parent) {
    const wanted = item.parent.toLowerCase();
    const named = state.items.find((entry) => fileStem(entry).toLowerCase() === wanted || entry.id === wanted);
    if (named && named.id !== item.id) return named;
  }
  const number = /^(\d+)[-_ ]/.exec(fileStem(item));
  if (!number) return null;
  let best = null;
  let bestScore = -1;
  for (const candidate of pairedItems) {
    if (!candidate.pair || !fileStem(candidate).startsWith(number[0])) continue;
    const a = fileStem(item).toLowerCase();
    const b = fileStem(candidate).toLowerCase();
    let score = 0;
    while (score < a.length && a[score] === b[score]) score += 1;
    if (candidate.pair.role === "today") score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** The board item a reply's marker names, by id or file name. */
function resolveItemId(raw) {
  const wanted = String(raw || "").toLowerCase();
  const found = activeItems().find(
    (item) => item.id.toLowerCase() === wanted || fileStem(item).toLowerCase() === wanted,
  );
  return found ? found.id : "";
}

// Agent replies carry `pending` (and `pending_cancel`) item ids, parsed from their
// [[pending: <item>]] markers by the server. Each one is a version on its way; a new
// file grown from that item, created after the reply, takes its place.
const PENDING_SLACK_MS = 60 * 1000;
function pendingFor(parentId, grown) {
  /** @type {any[]} */
  let open = [];
  /** @type {any[]} */
  const users = [];
  for (const entry of state.chat) {
    if (!entry) continue;
    if (entry.role !== "agent") {
      users.push(entry);
      continue;
    }
    if ((entry.pending_cancel || []).some((raw) => resolveItemId(raw) === parentId)) open = [];
    for (const raw of entry.pending || []) {
      if (resolveItemId(raw) !== parentId) continue;
      const asked =
        [...users].reverse().find((user) => noteByPromptId(user.prompt_id)?.item.id === parentId) || users.at(-1);
      open.push({ at: Date.parse(String(entry.at || "")) || 0, note: String(asked?.text || "") });
    }
  }
  const unused = grown.map((item) => Number(item.created) || Number(item.mtime) || 0).sort((a, b) => a - b);
  return open
    .filter((pending) => {
      const index = unused.findIndex((created) => created >= pending.at - PENDING_SLACK_MS);
      if (index < 0) return true;
      unused.splice(index, 1);
      return false;
    })
    .map((pending, index) => ({
      id: `pending:${parentId}:${index}`,
      label: "New version coming",
      placeholder: true,
      note: pending.note,
    }));
}

function buildGroups() {
  /** @type {any[]} */
  const groups = [];
  /** @type {Map<string, any>} */
  const byKey = new Map();
  const items = activeItems();
  const paired = items.filter((item) => item.pair);
  /** @type {Map<string, any[]>} */
  const children = new Map();
  // A duplicate stands beside the design it was made from, so it is placed after.
  const copies = items.filter((item) => isCopyOnTab(item, items));
  for (const item of items) {
    if (copies.includes(item)) continue;
    if (!item.pair) {
      const parent = parentOf(item, paired);
      if (parent) {
        if (!children.has(parent.id)) children.set(parent.id, []);
        children.get(parent.id)?.push(item);
        continue;
      }
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
  // Oldest first, so a version that has just arrived lands at the end of the row, where
  // its holder stood.
  for (const list of children.values()) list.sort((a, b) => (Number(a.created) || 0) - (Number(b.created) || 0));
  // A child whose parent is not on the board (archived, or itself a child) stands alone.
  const parentIds = new Set(groups.flatMap((group) => group.members.map((member) => member.item.id)));
  for (const [parentId, list] of children) {
    if (parentIds.has(parentId)) continue;
    for (const item of list) groups.push({ key: `item:${item.id}`, members: [{ item }], single: true });
  }
  for (const group of groups) {
    const rank = (member) => (member.item.pair?.role === "today" ? "0" : `1${member.item.pair?.variant || ""}`);
    group.members.sort((left, right) => rank(left).localeCompare(rank(right)));
    for (const member of group.members) {
      member.label = memberLabel(member.item, group);
      // Versions grown from this one sit in a row under it.
      member.children = (children.get(member.item.id) || []).map((item) => ({
        item,
        label: derivedLabel(item, member.item),
        children: [],
      }));
      // Then a holder for each new version the agent said is on its way.
      for (const pending of pendingFor(member.item.id, children.get(member.item.id) || [])) {
        member.children.push({ item: pending, label: "New version coming", children: [] });
      }
    }
    group.compared = group.members.length > 1 || group.members.some((member) => member.children.length > 0);
    const everyone = [...group.members, ...group.members.flatMap((member) => member.children)];
    if (group.single) {
      const item = group.members[0].item;
      group.title = item.title || item.label;
      group.lines = item.caption ? [{ label: "", text: captionBody(item.caption) }] : [];
      for (const child of group.members[0].children) {
        if (child.item.caption) group.lines.push({ label: child.label, text: captionBody(child.item.caption) });
      }
    } else {
      const titled = group.members.map((member) => member.item.title).find(Boolean);
      const fromCaption = group.members.map((member) => captionTitle(member.item.caption)).find(Boolean);
      group.title = titled || fromCaption || capitalize(group.name);
      group.lines = everyone
        .filter((member) => member.item.caption)
        .map((member) => ({ label: member.label, text: captionBody(member.item.caption) }));
    }
    group.changes = everyone
      .filter((member) => member.item.changed)
      .map((member) => ({ label: member.label, text: capitalize(member.item.changed) }));
  }
  insertCopies(groups, copies);
  insertCompare(groups);
  return groups;
}

/** A duplicate whose design is on the same tab: it is laid out beside that design. */
function isCopyOnTab(item, items) {
  return Boolean(item.copyOf) && items.some((entry) => entry.id === item.copyOf);
}

/**
 * Each duplicate takes the place right after the design it was made from (after that
 * design's earlier copies), in whichever row holds it, so the two read side by side.
 */
function insertCopies(groups, copies) {
  const pending = [...copies].sort((a, b) => (Number(a.created) || 0) - (Number(b.created) || 0));
  for (let pass = 0; pass < 3 && pending.length > 0; pass += 1) {
    for (const item of [...pending]) {
      const found = locateMember(groups, item.copyOf);
      if (!found) continue;
      const { list, index } = found;
      let at = index + 1;
      while (at < list.length && list[at].item.copyOf === item.copyOf) at += 1;
      if (!list[index].label) list[index].label = "Original";
      list.splice(at, 0, { item, label: item.label, children: [] });
      pending.splice(pending.indexOf(item), 1);
    }
  }
  // A copy of a copy whose chain could not be placed stands alone.
  for (const item of pending)
    groups.push({
      key: `item:${item.id}`,
      members: [{ item, label: item.label, children: [] }],
      single: true,
      title: item.label,
      lines: [],
      changes: [],
    });
}

function locateMember(groups, itemId) {
  for (const group of groups) {
    for (const list of [group.members, ...group.members.map((member) => member.children)]) {
      const index = list.findIndex((member) => member.item.id === itemId);
      if (index >= 0) return { list, index };
    }
  }
  return null;
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
  const title = element("h2", { class: "explain-title", text: group.title });
  // A design on its own is headed by its label: click (or tap) the name to rename it.
  const named = group.single ? group.members[0].item : null;
  if (named && !named.title && !named.placeholder && !named.compareOf && named.label === group.title) {
    title.dataset.rename = named.id;
    title.dataset.tap = "";
    title.title = "Click to rename";
    title.addEventListener("click", (event) => {
      event.stopPropagation();
      startRename(named.id, title);
    });
  }
  inner.append(title);
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
  // What the latest edit changed, from each file's `liesel-changed` meta.
  for (const change of group.changes || []) {
    const row = element("p", { class: "explain-changed" });
    row.append(
      element("b", { text: change.label && group.compared ? `What changed in ${change.label}.` : "What changed." }),
      " ",
      change.text,
    );
    inner.append(row);
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

// A frame taller than the GPU's largest texture once zoomed blanks the whole canvas in
// headed Chrome, so a frame never grows past what 100% on this screen can draw. Mirrors
// maxFrameHeight in src/board-geometry.js, where the rule is tested.
const MAX_LAYER_PX = 16384;
function maxFrameHeight() {
  const ratio = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 1 ? window.devicePixelRatio : 1;
  return Math.floor(MAX_LAYER_PX / ratio);
}

function contentHeight(itemId, device) {
  return Math.min(state.heights.get(artboardKey(itemId, device.id)) || device.height, maxFrameHeight());
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
  // The label row also carries a compared design's Accept / Keep today button, so it
  // never depends on how tall the artboards are.
  // A phone is too narrow for name and button on one line: there the button wraps
  // onto a second line above the frame.
  const narrow = devices.length === 1 && devices[0].id === "phone";
  const labelReserve = Math.ceil(labelMax * (narrow ? 5.4 : 3));
  const placed = [];
  const bandGap = Math.max(memberGap, labelReserve);
  /** Lay versions side by side from `x0`; each keeps its own artboards in a row. */
  const band = (list, x0) => {
    let x = x0;
    let contentH = 0;
    const members = [];
    for (const member of list) {
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
    return { members, width: x - memberGap, contentH };
  };
  for (const group of groups) {
    const first = band(group.members, 0);
    const bands = [first];
    for (const member of first.members) {
      if (member.children.length > 0) bands.push(band(member.children, member.x));
    }
    let offset = 0;
    for (const entry of bands) {
      entry.offset = offset;
      offset += labelReserve + entry.contentH + bandGap;
    }
    const bodyH = offset - bandGap;
    const width = Math.max(...bands.map((entry) => entry.width));
    const members = bands.flatMap((entry) => entry.members.map((member) => ({ ...member, band: entry })));
    const captionH = captionMax > 0 ? explainHeight(group, width, captionMax) : 0;
    placed.push({ ...group, members, width, captionH, height: captionH + bodyH, x: 0, y: 0 });
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
      for (const member of group.members) {
        const top = cursorY + captionH + member.band.offset + labelReserve;
        for (const board of member.boards) {
          board.x = cursorX + member.x + board.x;
          board.y = top;
        }
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

/* ------------------------------------------------------------ live pages */

// A project board's live items show the project's running dev server through Liesel's
// loopback proxy, on an origin of its own (never this page's). The frame's name tells
// the SDK the proxy added which item and device it is.
/** @type {{ root: string, name: string, proxy: string, config: { command: string, port: number } | null, dev: any, issue?: string, user_stopped?: boolean, mode?: "dev" | "static" | "reused", port?: number, busy?: boolean, gave_up?: boolean } | null} */
let project = bootstrap.project && typeof bootstrap.project === "object" ? bootstrap.project : null;

/** The URL path a live frame shows now; it can navigate away from the item's own page. */
function livePageOf(itemId, deviceId) {
  const record = state.artboards.get(artboardKey(itemId, deviceId));
  return String(record?.page || itemById(itemId)?.page || "/");
}

/** What a prompt says about its item: a live page adds the path it was written on. */
function itemRef(item, note = null) {
  const page = item?.page ? String(note?.page || item.page) : "";
  return { id: item.id, label: item.label, ...(page ? { page } : {}) };
}

function itemUrl(item, deviceId) {
  if (item.page) return project?.proxy ? `${project.proxy}${item.page}` : "about:blank";
  const url = `/board/${encodeURIComponent(key)}/item/${encodeURIComponent(item.id)}/index.html?device=${encodeURIComponent(deviceId)}`;
  // The token is the file's own content, so a frame never keeps a page the file no
  // longer is - not even through a cache that ignores the server's no-store.
  const token = contentToken(item);
  return token ? `${url}&r=${encodeURIComponent(token)}` : url;
}

/** What an item's frames are keyed by: its bytes when the board knows them. */
function contentToken(item) {
  return String(item?.hash || (Number(item?.mtime) ? String(item.mtime) : ""));
}

function createArtboard(item, device) {
  const id = artboardKey(item.id, device.id);
  const root = element("div", { class: "artboard", "data-key": id, "data-device": device.id });
  const screen = element("div", { class: "screen" });
  const iframe = element("iframe", {
    title: `${item.label} at ${device.width}`,
    // A live page runs on the proxy's own origin, so it keeps its storage and cookies;
    // a file item stays opaque because it is served from this page's origin.
    sandbox: item.page
      ? "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
      : "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
    ...(item.page ? { name: `liesel:${item.id}:${device.id}` } : {}),
  });
  iframe.style.width = `${device.width}px`;
  // A page loads in one screen of its device, and only then grows to its content:
  // scripts that size things from the window height at load would otherwise read the
  // grown frame and grow the page again.
  iframe.style.height = `${device.height}px`;
  iframe.addEventListener("load", () => {
    const loaded = state.artboards.get(id);
    if (loaded) {
      loaded.loaded = true;
      iframe.style.height = loaded.screen.style.height || `${device.height}px`;
    }
    postPins(item.id, device.id);
    postTune(item.id, device.id);
    postElementTune(item.id, device.id);
    postImageDrops(item.id, device.id);
  });
  const shield = element("div", { class: "shield", "data-key": id });
  screen.append(iframe, shield);
  const gutter = element("div", { class: "pin-gutter" });
  root.append(screen, gutter);
  const label = element("div", { class: "artboard-label" });
  const name = element("span", { class: "name" });
  const width = element("span", { class: "width" });
  const updated = element("span", { class: "updated", text: "Updated just now" });
  updated.hidden = true;
  const tune = element("button", { class: "tune-toggle", type: "button", text: "Tune" });
  tune.addEventListener("click", (event) => {
    event.stopPropagation();
    openTune(item.id, device.id);
  });
  const actions = itemActions(item);
  label.append(name, updated, width, actions, tune);
  label.addEventListener("click", () => {
    pickedItem = item.id;
    renderHistoryToggle();
  });
  if (item.copyOf) {
    name.title = "Double-click to rename";
    name.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      startRename(item.id);
    });
  }
  canvas.append(root, label);
  // Every frame loads up front: the layout needs each page's real height.
  iframe.src = itemUrl(item, device.id);
  const record = {
    id,
    itemId: item.id,
    device,
    root,
    screen,
    iframe,
    shield,
    gutter,
    label,
    name,
    width,
    updated,
    actions,
    loaded: false,
  };
  state.artboards.set(id, record);
  return record;
}

function render() {
  const layout = state.layout;
  const framed = framedView();
  const seen = new Set();
  const seenGroups = new Set();
  const seenPlaceholders = new Set();
  const seenCompares = new Set();
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
    // A heading being renamed keeps its field until Enter, Escape or a click away, and
    // an unchanged explanation keeps its nodes, so a click on the name is never lost to
    // a render between press and release.
    const signature = JSON.stringify([
      group.title,
      group.lines,
      group.changes,
      group.compared,
      group.single ? group.members[0].item.id : "",
      group.single ? group.members[0].item.label : "",
    ]);
    if (!(group.single && renaming === group.members[0].item.id) && explain.dataset.signature !== signature) {
      explain.dataset.signature = signature;
      explain.replaceChildren(explainContent(group));
    }
    explain.style.left = `${group.x}px`;
    explain.style.top = `${group.y}px`;
    explain.style.width = `${group.width}px`;
    explain.style.height = `${group.captionH}px`;
    for (const member of group.members) {
      if (member.item.placeholder) {
        member.boards.forEach((board, index) => {
          seenPlaceholders.add(board.key);
          renderPlaceholder(board, index === 0, framed, layout);
        });
        continue;
      }
      if (member.item.compareOf) {
        member.boards.forEach((board, index) => {
          seenCompares.add(board.key);
          renderCompare(board, index === 0, member, framed, layout);
        });
        continue;
      }
      member.boards.forEach((board, index) => {
        seen.add(board.key);
        const record = state.artboards.get(board.key) || createArtboard(board.item, board.device);
        record.root.hidden = false;
        record.label.hidden = false;
        record.root.dataset.framed = String(framed);
        record.pad = board.pad;
        record.screenHeight = board.screenHeight;
        renderGutterPins(record);
        record.root.style.left = `${board.x}px`;
        record.root.style.top = `${board.y}px`;
        record.root.style.width = `${board.width}px`;
        record.root.style.height = `${board.height}px`;
        record.screen.style.position = "absolute";
        record.screen.style.left = `${board.pad.side}px`;
        record.screen.style.top = `${board.pad.top}px`;
        record.screen.style.width = `${board.screenWidth}px`;
        record.screen.style.height = `${board.screenHeight}px`;
        record.iframe.style.height = `${record.loaded ? board.screenHeight : Math.min(board.screenHeight, board.device.height)}px`;
        record.label.style.left = `${board.x}px`;
        record.label.style.top = `${board.y - layout.labelReserve}px`;
        record.label.style.width = `${board.width}px`;
        record.label.style.height = `${layout.labelReserve}px`;
        if (renaming !== member.item.id || index !== 0) record.name.textContent = index === 0 ? member.label : "";
        record.actions.hidden = index !== 0;
        syncFinal(record, member.item);
        record.label.dataset.picked = String(index === 0 && pickedItem === member.item.id);
        if (index === 0) renderBuilds(record, member.item);
        else record.buildsEl?.remove();
        record.updated.hidden = !(index === 0 && updatedItems.has(member.item.id));
        if (updatedItems.has(member.item.id)) record.root.dataset.updated = "true";
        else delete record.root.dataset.updated;
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
    if (!group.compared) continue;
    for (const member of group.members) {
      if (member.item.placeholder || member.item.compareOf) continue;
      seenChoices.add(member.item.id);
      let choice = state.choices.get(member.item.id);
      if (!choice) {
        choice = element("div", { class: "choice", "data-item": member.item.id });
        state.choices.set(member.item.id, choice);
      }
      // Beside the version's name, at the top left of its first artboard.
      const record = state.artboards.get(member.boards[0]?.key);
      if (record && choice.parentElement !== record.label) record.label.insertBefore(choice, record.updated);
      renderChoice(choice, group, member);
    }
  }
  for (const [id, choice] of state.choices) {
    if (seenChoices.has(id)) continue;
    choice.remove();
    state.choices.delete(id);
  }
  for (const [id, holder] of state.placeholders) {
    if (seenPlaceholders.has(id)) continue;
    holder.root.remove();
    holder.label.remove();
    state.placeholders.delete(id);
  }
  for (const [id, explain] of state.explains) {
    if (seenGroups.has(id)) continue;
    explain.remove();
    state.explains.delete(id);
  }
  for (const [id, frame] of compareFrames) {
    if (seenCompares.has(id)) continue;
    frame.root.remove();
    frame.label.remove();
    compareFrames.delete(id);
    state.heights.delete(id);
  }
  positionHistory();
  renderHistoryToggle();
  emptyElement.hidden = layout.groups.length > 0;
}

/**
 * One item, one line: a dot per build of its file and a labelled tick when the build
 * named itself. Clicking one shows that build as it was, and offers to carry on from it
 * rather than growing a new object every round.
 */
function renderBuilds(record, item) {
  const builds = item.builds || [];
  if (!record.buildsEl) {
    record.buildsEl = element("div", { class: "builds" });
    record.label.append(record.buildsEl);
  }
  if (builds.length === 0) {
    record.buildsEl.replaceChildren();
    return;
  }
  const toggle = element("button", { class: "history-toggle", type: "button", text: "History" });
  toggle.hidden = builds.length < 2;
  toggle.setAttribute("aria-expanded", String(historyItem === item.id));
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (historyItem === item.id) closeBuildPreview();
    else openHistory(item.id);
  });
  record.buildsEl.replaceChildren(
    ...builds.map((build, index) => {
      const node = element("button", {
        class: "build",
        type: "button",
        title: build.label || build.at || "",
        "aria-label": build.label || `Build ${index + 1}`,
      });
      node.dataset.major = String(Boolean(build.label));
      if (index === builds.length - 1) node.dataset.current = "true";
      if (build.label) node.append(element("span", { class: "build-name", text: build.label }));
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        openHistory(item.id, build.hash);
      });
      return node;
    }),
  );
}

/* --------------------------------------------------------------- duplicates */

// A duplicate is its own file and item, made from one design so the reviewer can change
// it and compare: it stands beside that design and is locked to it, so the two scroll
// together. Only a duplicate can be renamed here or deleted (with Undo).
/** The item being renamed, whose name holds an input until Enter or Escape. */
let renaming = "";

/** Every design locked to this one, directly or through another (a copy of a copy). */
function lockedPartners(itemId) {
  const seen = new Set([itemId]);
  const queue = [itemId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const pair of state.pairs) {
      if (!pair || pair.locked === false) continue;
      const other = pair.a === current ? pair.b : pair.b === current ? pair.a : "";
      if (!other || seen.has(other) || !itemById(other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  seen.delete(itemId);
  return [...seen];
}

// A frame the board just scrolled to follow its partner reports that scroll back; for a
// moment its reports are echoes, not the reviewer, and are not passed on again.
const SCROLL_ECHO_MS = 250;
/** @type {Map<string, number>} */
const scrollFollowedAt = new Map();
/** Where each frame was last scrolled by the reviewer, so a locked frame that loads joins it. */
/** @type {Map<string, { x: number, y: number, at: number }>} */
const lastScroll = new Map();

function syncLockedScroll(itemId, deviceId, x, y) {
  const now = performance.now();
  if (now - (scrollFollowedAt.get(artboardKey(itemId, deviceId)) || 0) < SCROLL_ECHO_MS) return;
  lastScroll.set(artboardKey(itemId, deviceId), { x, y, at: now });
  for (const partner of lockedPartners(itemId)) {
    scrollFollowedAt.set(artboardKey(partner, deviceId), now);
    postToArtboard(partner, deviceId, { type: "scroll-to", x, y });
  }
}

/** A frame that has just loaded takes the place its locked group is scrolled to. */
function joinLockedScroll(itemId, deviceId) {
  const partners = lockedPartners(itemId);
  if (partners.length === 0) return;
  const at = [itemId, ...partners]
    .map((id) => lastScroll.get(artboardKey(id, deviceId)))
    .filter(Boolean)
    .sort((a, b) => (b?.at || 0) - (a?.at || 0))[0];
  if (!at) return;
  scrollFollowedAt.set(artboardKey(itemId, deviceId), performance.now());
  postToArtboard(itemId, deviceId, { type: "scroll-to", x: at.x, y: at.y });
}

/** The quiet buttons on a design's label: Duplicate, and Rename and Delete on a copy. */
function itemActions(item) {
  const actions = element("span", { class: "item-actions" });
  const button = (text, title, run, reveal = false) => {
    const node = element("button", { class: "item-action", type: "button", text, title });
    if (reveal) node.dataset.reveal = "";
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      run();
    });
    return node;
  };
  // One design per tab can be chosen as the final; its button says so and takes it back.
  // "Final" stays short so the label row fits beside a narrow screen's width.
  const final = button("Final", "Choose as final", () => toggleFinal(item.id));
  final.classList.add("item-final");
  final.setAttribute("aria-label", "Choose as final");
  final.setAttribute("aria-pressed", "false");
  actions.append(final);
  // A live page is the running app, not a file to copy.
  if (!item.page) actions.append(button("Duplicate", "Duplicate this design (⌘D)", () => duplicateDesign(item.id)));
  if (item.copyOf) {
    actions.append(
      button("Rename", "Rename this copy", () => startRename(item.id), true),
      button("Delete", "Delete this copy", () => deleteCopy(item.id), true),
    );
  }
  return actions;
}

function boardPost(route, body) {
  return fetch(`/api/boards/${encodeURIComponent(key)}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) =>
    response
      .json()
      .catch(() => ({}))
      .then((payload) => (response.ok ? payload : Promise.reject(new Error(payload?.error || "not accepted")))),
  );
}

/** One short message at the foot of the board, with at most one action. */
function showBoardToast(text, detail, actionLabel = "", action = null) {
  hideDropToast();
  const toast = element("div", { class: "drop-toast", id: "dropToast", role: "status" });
  toast.append(element("span", { class: "drop-toast-text", text }));
  if (detail) toast.append(element("span", { class: "drop-toast-file", text: detail }));
  if (actionLabel && action) {
    const undo = element("button", { class: "drop-toast-undo", type: "button", text: actionLabel });
    undo.addEventListener("click", () => {
      hideDropToast();
      action();
    });
    toast.append(undo);
  }
  document.body.append(toast);
  dropToastTimer = window.setTimeout(hideDropToast, 10000);
}

function adoptItem(item, pairs) {
  if (!item?.id) return;
  state.items = [...state.items.filter((entry) => entry.id !== item.id), item];
  if (Array.isArray(pairs)) state.pairs = pairs;
  pickedItem = item.id;
  relayout();
  // A board the reviewer has not moved refits, so the design and its copy both show.
  if (!userAdjustedCamera) fit(false);
}

let duplicating = false;
function duplicateDesign(itemId) {
  const source = itemById(itemId);
  if (!source || source.page || state.ended || duplicating) return;
  duplicating = true;
  boardPost("duplicate", { item: source.id })
    .then((payload) => {
      adoptItem(payload.item, payload.pairs);
      showBoardToast(`Duplicated as ${payload.item.label}`, payload.item.file, "Rename", () =>
        startRename(payload.item.id),
      );
    })
    .catch((error) => {
      dockStatus.textContent = `Could not duplicate ${source.label}: ${error.message}`;
    })
    .finally(() => {
      duplicating = false;
    });
}

function deleteCopy(itemId) {
  const item = itemById(itemId);
  if (!item?.copyOf || state.ended) return;
  boardPost("delete", { item: item.id })
    .then((payload) => {
      state.items = state.items.filter((entry) => entry.id !== item.id);
      if (Array.isArray(payload.pairs)) state.pairs = payload.pairs;
      if (pickedItem === item.id) pickedItem = item.copyOf;
      relayout();
      showBoardToast(`Deleted ${item.label}`, item.file, "Undo", () => restoreCopy(payload.token, item));
    })
    .catch((error) => {
      dockStatus.textContent = `Could not delete ${item.label}: ${error.message}`;
    });
}

function restoreCopy(token, item) {
  boardPost("restore", { token })
    .then((payload) => adoptItem(payload.item, payload.pairs))
    .catch((error) => {
      dockStatus.textContent = `Could not bring back ${item.label}: ${error.message}`;
    });
}

/** Rename a copy in place: its name becomes an input, Enter keeps it, Escape does not. */
/**
 * Rename a design in place: a copy from its label row, any design on its own from its
 * heading. Enter or a click away saves the label in board.json (the file keeps its
 * name), Escape keeps the old one.
 * @param {string} itemId @param {HTMLElement} [host] where the name shows, when not the copy's label
 */
function startRename(itemId, host) {
  const item = itemById(itemId);
  const record = host
    ? null
    : [...state.artboards.values()].find(
        (entry) => entry.itemId === itemId && !entry.root.hidden && !entry.actions.hidden,
      );
  const target = host || (item?.copyOf ? record?.name : null);
  if (!item || !target || state.ended || renaming === item.id) return;
  renaming = item.id;
  const input = element("input", {
    class: "rename-input",
    type: "text",
    "aria-label": item.copyOf ? "Name of this copy" : "Name of this design",
  });
  input.value = item.label;
  input.size = Math.max(8, item.label.length + 2);
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    renaming = "";
    // The heading held a field: rebuild it on the next render whatever the name is.
    const explain = target.closest(".explain");
    if (explain instanceof HTMLElement) delete explain.dataset.signature;
    const label = input.value.trim().slice(0, 120);
    if (keep && label && label !== item.label) {
      item.label = label;
      boardPost("place", { items: [{ id: item.id, label }] }).catch(() => {
        dockStatus.textContent = "Could not save that name.";
      });
    }
    relayout();
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") finish(false);
  });
  input.addEventListener("input", () => {
    input.size = Math.max(8, input.value.length + 2);
  });
  input.addEventListener("blur", () => finish(true));
  for (const type of ["click", "dblclick", "pointerdown"]) {
    input.addEventListener(type, (event) => event.stopPropagation());
  }
  target.replaceChildren(input);
  input.focus();
  input.select();
}

/** The top bar's Duplicate is for the design picked by its label. */
function pickedDesign() {
  return activeItems().find((item) => item.id === pickedItem) || null;
}

function renderDuplicateToggle() {
  const toggle = document.getElementById("duplicateToggle");
  if (!toggle) return;
  const item = pickedDesign();
  toggle.hidden = !item || Boolean(item.page) || state.ended;
  if (item) toggle.title = `Duplicate ${item.label} (⌘D)`;
}

document.getElementById("duplicateToggle")?.addEventListener("click", () => {
  const item = pickedDesign();
  if (item) duplicateDesign(item.id);
});

/* ----------------------------------------------------------------- history */

// An item's history is its line of builds, opened as a strip of thumbnails: oldest
// first and the file as it is now last, each with its time and the notes that led to
// it. Picking one lays that build out on the board beside the current version, at the
// same device widths, as a frame the board never answers: no pins, notes or tune.
let historyItem = "";
// The design last picked by its label; the top bar's History opens this one.
let pickedItem = "";
/** @type {{ itemId: string, hash: string } | null} */
let compare = null;
/** @type {Map<string, any>} */
const compareFrames = new Map();
/** @type {Map<string, Set<string>>} */
const thumbsReady = new Map();
// A build is seen on the board's next read of its file, so a reply sent just after the
// write can carry an earlier time than the build it answers.
const BUILD_SEEN_SLACK_MS = 30 * 1000;

function compareId(itemId, hash) {
  return `${itemId}~${hash}`;
}

/** A saved build sits under its own folder, so its relative links reach the item's files. */
function buildUrl(itemId, hash, deviceId) {
  return `/board/${encodeURIComponent(key)}/item/${encodeURIComponent(itemId)}/build/${encodeURIComponent(hash)}/?device=${encodeURIComponent(deviceId)}`;
}

/** Builds oldest first, with the one the file is now at the end. */
function historyBuilds(item) {
  const builds = [...(item?.builds || [])];
  const index = builds.findIndex((build) => build.hash === item.hash);
  if (index >= 0) builds.push(...builds.splice(index, 1));
  return builds;
}

/**
 * What led to a build: the notes on this item answered by the first reply after the
 * change, or else what was said about this item since the build before it.
 */
function buildNotes(item, builds, index) {
  if (index === 0) return [];
  const at = Date.parse(String(builds[index].at || ""));
  if (!Number.isFinite(at)) return [];
  const from = Date.parse(String(builds[index - 1].at || "")) || 0;
  const reply = state.chat.find(
    (entry) => entry?.role === "agent" && (Date.parse(String(entry.at || "")) || 0) >= at - BUILD_SEEN_SLACK_MS,
  );
  const answered = reply
    ? threadsOfReply(reply)
        .map(threadSubject)
        .filter((subject) => subject?.kind === "note" && subject.item.id === item.id)
        .map((subject) => String(subject.note.text || ""))
    : [];
  const said =
    answered.length > 0
      ? answered
      : state.chat
          .filter((entry) => {
            if (!entry || entry.role === "agent") return false;
            const sent = Date.parse(String(entry.at || "")) || 0;
            if (sent <= from || sent > at) return false;
            const thread = threadOfEntry(entry);
            return thread === `item:${item.id}` || liveNote(thread)?.item.id === item.id;
          })
          .map((entry) => String(entry.text || ""));
  return [...new Set(said.map((text) => text.trim()).filter(Boolean))];
}

/** Ask the server for one build's thumbnail, taking it if it has none yet. */
function requestThumb(itemId, hash) {
  return fetch(`/api/boards/${encodeURIComponent(key)}/thumbs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item: itemId, hash }),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      const ready = thumbsReady.get(itemId) || new Set();
      for (const done of Array.isArray(payload?.thumbs) ? payload.thumbs : []) ready.add(String(done));
      thumbsReady.set(itemId, ready);
      if (historyItem === itemId) renderHistory();
    })
    .catch(() => {});
}

/**
 * One build at a time, newest first, so each card fills as soon as its picture exists:
 * a single request for them all answers only when the slowest capture is done.
 */
async function requestHistoryThumbs(itemId, builds) {
  for (const build of [...builds].reverse()) {
    if (historyItem !== itemId) return;
    await requestThumb(itemId, build.hash);
  }
}

function openHistory(itemId, hash = "") {
  const item = itemById(itemId);
  if (!item) return;
  historyItem = itemId;
  pickedItem = itemId;
  const current = historyBuilds(item).at(-1);
  setCompare(hash && hash !== current?.hash ? { itemId, hash } : null);
  requestHistoryThumbs(itemId, historyBuilds(item));
}

/** Close the history strip and any build laid out beside its item. */
function closeBuildPreview() {
  if (!historyItem && !compare) return;
  historyItem = "";
  compare = null;
  document.getElementById("history")?.remove();
  if (state.layout) relayout();
  renderHistoryToggle();
}

/** The design the top bar's History is for: the picked one, else the first on this tab. */
function historyTarget() {
  const items = activeItems();
  return items.find((item) => item.id === pickedItem) || items[0];
}

function renderHistoryToggle() {
  const toggle = document.getElementById("historyToggle");
  if (!toggle) return;
  const item = historyTarget();
  toggle.hidden = !item || historyBuilds(item).length < 2;
  toggle.setAttribute("aria-pressed", String(Boolean(historyItem)));
  toggle.title = item ? `History of ${designName(item, "")}` : "History";
  renderDuplicateToggle();
}

document.getElementById("historyToggle")?.addEventListener("click", () => {
  if (historyItem) return closeBuildPreview();
  const item = historyTarget();
  if (item) openHistory(item.id);
});

// Answered notes parked in the gutter can be hidden; open notes always stay on the design.
const oldNotesStorageKey = `liesel:old-notes:${key}`;
let showOldNotes = readStorage(oldNotesStorageKey) !== "off";

// The switch lives in Settings, beside the format switches.
function renderOldNotesToggle() {
  document.body.classList.toggle("old-notes-hidden", !showOldNotes);
  const toggle = /** @type {HTMLInputElement | null} */ (document.getElementById("oldNotesSetting"));
  if (toggle) toggle.checked = showOldNotes;
}

document.getElementById("oldNotesSetting")?.addEventListener("change", (event) => {
  showOldNotes = /** @type {HTMLInputElement} */ (event.currentTarget).checked;
  writeStorage(oldNotesStorageKey, showOldNotes ? "on" : "off");
  renderOldNotesToggle();
  flashSettingsSaved();
});
renderOldNotesToggle();

function setCompare(next) {
  const itemId = next?.itemId || compare?.itemId || "";
  compare = next;
  relayout();
  renderHistory();
  if (!itemId) return;
  const ids = new Set([itemId, next ? compareId(next.itemId, next.hash) : ""]);
  focusBoards(eachBoard().filter((board) => ids.has(board.item.id)));
}

/** The strip keeps clear of the panel, except where the panel is a sheet over the board. */
function positionHistory() {
  const panel = document.getElementById("history");
  if (!panel) return;
  const right = panelWidth();
  panel.style.right = `${right > window.innerWidth * 0.6 ? 0 : right}px`;
}

function renderHistory() {
  const item = itemById(historyItem);
  const builds = historyBuilds(item);
  let panel = document.getElementById("history");
  if (!item || builds.length === 0) {
    panel?.remove();
    historyItem = "";
    return;
  }
  const ready = thumbsReady.get(item.id) || new Set();
  const signature = JSON.stringify([
    item.id,
    builds.map((build) => [build.hash, ready.has(build.hash)]),
    compare?.hash || "",
    state.chat.length,
    designName(item, ""),
  ]);
  if (!panel) {
    panel = element("section", { class: "history", id: "history", "aria-label": `History of ${item.label}` });
    document.body.append(panel);
  }
  positionHistory();
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  const previous = panel.querySelector(".history-list");
  const scrolled = previous && panel.dataset.item === item.id ? previous.scrollLeft : null;
  panel.dataset.item = item.id;
  const head = element("div", { class: "history-head" });
  head.append(element("h2", { class: "history-title", text: designName(item, "") }));
  const close = element("button", { class: "icon-button", type: "button", text: "×", "aria-label": "Close history" });
  close.addEventListener("click", closeBuildPreview);
  head.append(close);
  const list = element("ol", { class: "history-list" });
  builds.forEach((build, index) => {
    const current = index === builds.length - 1;
    const shown = compare?.itemId === item.id ? compare.hash === build.hash : current;
    const tile = element("button", { class: "history-tile", type: "button", "aria-pressed": String(shown) });
    if (current) tile.dataset.current = "true";
    const thumb = element("span", { class: "history-thumb" });
    if (ready.has(build.hash)) {
      thumb.append(
        element("img", {
          src: `/board/${encodeURIComponent(key)}/item/${encodeURIComponent(item.id)}/thumb/${encodeURIComponent(build.hash)}`,
          alt: "",
        }),
      );
    }
    const time = formatTime(build.at);
    const notes = buildNotes(item, builds, index);
    const said = notes.join(" · ") || build.label || (index === 0 ? "First version" : "");
    tile.append(thumb, element("span", { class: "history-time", text: current ? `${time} · Now` : time }));
    if (said) tile.append(element("span", { class: "history-notes", text: said, title: said }));
    tile.addEventListener("click", () => setCompare(current ? null : { itemId: item.id, hash: build.hash }));
    const row = element("li");
    row.append(tile);
    list.append(row);
  });
  panel.replaceChildren(head, list);
  list.scrollLeft = scrolled ?? list.scrollWidth;
}

/** Lay the compared build out as one more version, just before its item. */
function insertCompare(groups) {
  if (!compare) return;
  const item = itemById(compare.itemId);
  const build = (item?.builds || []).find((entry) => entry.hash === compare?.hash);
  if (!item || !build) {
    compare = null;
    return;
  }
  const entry = {
    item: {
      id: compareId(item.id, build.hash),
      compareOf: item.id,
      build,
      label: item.label,
      file: item.file,
      tab: item.tab,
    },
    label: build.label || formatTime(build.at),
    children: [],
  };
  for (const group of groups) {
    for (const list of [group.members, ...group.members.map((member) => member.children)]) {
      const index = list.findIndex((member) => member.item.id === item.id);
      if (index < 0) continue;
      list.splice(index, 0, entry);
      return;
    }
  }
}

function renderCompare(board, first, member, framed, layout) {
  let frame = compareFrames.get(board.key);
  if (!frame) {
    const root = element("div", { class: "artboard compare-frame", "data-device": board.device.id });
    const screen = element("div", { class: "screen" });
    const iframe = element("iframe", {
      title: `${member.item.label} as it was at ${board.device.width}`,
      sandbox: "allow-scripts",
      tabindex: "-1",
    });
    iframe.style.width = `${board.device.width}px`;
    iframe.style.height = `${board.device.height}px`;
    screen.append(iframe);
    root.append(screen);
    const label = element("div", { class: "artboard-label" });
    const name = element("span", { class: "name" });
    const width = element("span", { class: "width" });
    const actions = element("span", { class: "compare-actions" });
    const carry = element("button", { class: "compare-button", type: "button", text: "Continue from here" });
    carry.addEventListener("click", (event) => {
      event.stopPropagation();
      continueFromBuild(itemById(member.item.compareOf), member.item.build);
    });
    const close = element("button", { class: "compare-button", type: "button", text: "Close" });
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      setCompare(null);
    });
    actions.append(carry, close);
    label.append(name, width, actions);
    canvas.append(root, label);
    frame = { key: board.key, itemId: member.item.compareOf, device: board.device, root, screen, iframe, label };
    frame.name = name;
    frame.width = width;
    frame.actions = actions;
    frame.loaded = false;
    const record = frame;
    // The page cannot be touched, but in a device view it still scrolls under the wheel.
    root.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey || event.metaKey || !framedView()) return;
        event.preventDefault();
        event.stopPropagation();
        record.iframe.contentWindow?.postMessage(
          {
            channel: "liesel",
            item: record.itemId,
            device: record.device.id,
            type: "scroll",
            dx: wheelDelta(event, "deltaX"),
            dy: wheelDelta(event, "deltaY"),
          },
          "*",
        );
      },
      { passive: false },
    );
    iframe.addEventListener("load", () => {
      record.loaded = true;
      iframe.style.height = screen.style.height || `${board.device.height}px`;
    });
    iframe.src = buildUrl(member.item.compareOf, member.item.build.hash, board.device.id);
    compareFrames.set(board.key, frame);
  }
  frame.root.dataset.framed = String(framed);
  Object.assign(frame.root.style, {
    left: `${board.x}px`,
    top: `${board.y}px`,
    width: `${board.width}px`,
    height: `${board.height}px`,
  });
  Object.assign(frame.screen.style, {
    position: "absolute",
    left: `${board.pad.side}px`,
    top: `${board.pad.top}px`,
    width: `${board.screenWidth}px`,
    height: `${board.screenHeight}px`,
  });
  frame.iframe.style.height = `${frame.loaded ? board.screenHeight : Math.min(board.screenHeight, board.device.height)}px`;
  Object.assign(frame.label.style, {
    left: `${board.x}px`,
    top: `${board.y - layout.labelReserve}px`,
    width: `${board.width}px`,
    height: `${layout.labelReserve}px`,
  });
  frame.name.textContent = first ? member.label : "";
  frame.actions.hidden = !first;
  frame.width.textContent = framed && member.label ? "" : String(board.device.width);
}

/** A compared build sizes itself and asks for its stylesheets like a live frame. */
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.channel !== "liesel") return;
  const frame = [...compareFrames.values()].find((entry) => entry.iframe.contentWindow === event.source);
  if (!frame) return;
  if (data.type === "stylesheet") sendStylesheet(frame, frame.itemId, String(data.href || ""));
  if (data.type !== "size") return;
  const height = clamp(Math.round(Number(data.height) || 0), 0, maxFrameHeight());
  if (height > 0 && height !== state.heights.get(frame.key)) {
    state.heights.set(frame.key, height);
    if (!framedView()) scheduleLayout();
  }
});

/** Hand the agent a saved build to carry on from, instead of growing a new object. */
function continueFromBuild(item, build) {
  if (!item || !build) return;
  sendItemNote(
    item,
    [
      `Continue ${item.label} (${item.file}) from the build saved at ${build.at || "an earlier round"}`,
      build.label ? `(${build.label})` : "",
      `— its snapshot is .liesel-builds/${item.id}/${build.hash}.html in the board folder.`,
      "Build the next version from that, not from a fresh page.",
    ]
      .filter(Boolean)
      .join(" "),
    "",
    "build",
  );
  closeBuildPreview();
}

// The board keeps at most this many notes on an item.
const MAX_PARKED_PINS = 300;

/** A parked pin's side and its gap from the frame, in board units at the current zoom. */
function parkedPinMetrics() {
  // It keeps a pin's on-screen size until the zoom would push it past the gutter
  // between frames, so it never reaches a neighbouring design.
  const gutter = MEMBER_GAP[state.deviceMode] || MEMBER_GAP.all;
  const zoom = state.camera.zoom || 1;
  return {
    size: Math.min(gutter * 0.5, Math.max(24, 24 / zoom)),
    gap: Math.min(gutter * 0.12, Math.max(4, 8 / zoom)),
  };
}

/**
 * An answered note leaves the artwork: its pin sits in the board gutter just left of
 * the frame, at the height its anchor has in the frame's window now, still findable
 * and still opening its thread, but never on the design. The frame reports those
 * heights; a framed device that has scrolled an anchor out of view parks nothing for
 * it, and pins that would land on one another stack downward instead.
 */
function renderGutterPins(record) {
  if (!record.gutter) return;
  const pad = record.pad || { side: 0, top: 0 };
  const screenHeight = record.screenHeight || Infinity;
  const { size, gap } = parkedPinMetrics();
  const parked = (record.parked || [])
    .map((pin) => ({ id: String(pin?.id || ""), number: pin?.number, y: Number(pin?.y) }))
    .filter((pin) => pin.id && Number.isFinite(pin.y) && pin.y >= 0 && pin.y <= screenHeight)
    .sort((a, b) => a.y - b.y);
  const seen = new Set();
  let nextFree = -Infinity;
  for (const entry of parked) {
    const live = liveNote(entry.id);
    if (!live) continue;
    seen.add(entry.id);
    /** @type {HTMLElement | null} */
    let pin = record.gutter.querySelector(`[data-note="${CSS.escape(entry.id)}"]`);
    if (!pin) {
      pin = element("button", { class: "gutter-pin", type: "button" });
      pin.dataset.note = entry.id;
      pin.addEventListener("click", () => {
        const current = liveNote(entry.id);
        if (current) showNoteWindow(current.item, current.note);
        flashEntry(entry.id);
      });
      record.gutter.append(pin);
    }
    const center = Math.max(pad.top + entry.y, nextFree);
    nextFree = center + size + gap / 2;
    pin.textContent = String(entry.number ?? live.note.number);
    pin.setAttribute("aria-label", `Note ${entry.number ?? live.note.number}, answered`);
    pin.style.top = `${Math.round(center)}px`;
    pin.style.left = `${-Math.round(size + gap)}px`;
    pin.style.minWidth = `${size}px`;
    pin.style.height = `${size}px`;
    pin.style.marginTop = `${-size / 2}px`;
    pin.style.fontSize = `${size / 2}px`;
    pin.style.borderWidth = `${size / 12}px`;
  }
  for (const node of Array.from(record.gutter.children)) {
    if (!(node instanceof HTMLElement) || !seen.has(node.dataset.note || "")) node.remove();
  }
}

function renderAllGutterPins() {
  for (const record of state.artboards.values()) renderGutterPins(record);
}

/** A device-sized holder where a version the agent is making will appear. */
function renderPlaceholder(board, first, framed, layout) {
  let holder = state.placeholders.get(board.key);
  if (!holder) {
    const root = element("div", { class: "pending-version", "data-device": board.device.id });
    const body = element("div", { class: "pending-body" });
    body.append(
      element("span", { class: "pending-loader", "aria-hidden": "true" }),
      element("p", { class: "pending-title", text: "New version coming" }),
      element("p", { class: "pending-note" }),
    );
    root.append(body);
    const label = element("div", { class: "artboard-label" });
    label.append(element("span", { class: "name" }), element("span", { class: "width" }));
    canvas.append(root, label);
    holder = { root, label };
    state.placeholders.set(board.key, holder);
  }
  const note = holder.root.querySelector(".pending-note");
  if (note) {
    note.textContent = board.item.note;
    note.hidden = !board.item.note;
  }
  holder.root.dataset.framed = String(framed);
  Object.assign(holder.root.style, {
    left: `${board.x}px`,
    top: `${board.y}px`,
    width: `${board.width}px`,
    height: `${board.height}px`,
  });
  Object.assign(holder.label.style, {
    left: `${board.x}px`,
    top: `${board.y - layout.labelReserve}px`,
    width: `${board.width}px`,
    height: `${layout.labelReserve}px`,
  });
  const [name, width] = holder.label.children;
  name.textContent = first ? "New version" : "";
  width.textContent = framed ? "" : String(board.device.width);
}

/* ----------------------------------------------------------- live updates */

// The board re-reads itself every couple of seconds; an item whose file changed on
// disk reloads in place (camera untouched) and is marked "Updated just now" until it
// has been on screen long enough to be seen. What this browser has seen is kept per
// board, so an edit made while the board was closed is still marked on the next visit.
const seenStorageKey = `liesel:seen:${key}`;
/** @type {Map<string, string>} */
const knownStamps = new Map();
/** @type {Set<string>} */
const updatedItems = new Set();
/** @type {Map<string, number>} */
const viewedFor = new Map();

function loadSeen() {
  try {
    return JSON.parse(readStorage(seenStorageKey) || "{}") || {};
  } catch {
    return {};
  }
}

function markSeen(itemId, stamp) {
  const seen = loadSeen();
  seen[itemId] = stamp;
  writeStorage(seenStorageKey, JSON.stringify(seen));
}

function reloadItem(item) {
  for (const record of state.artboards.values()) {
    if (record.itemId !== item.id) continue;
    record.loaded = false;
    record.iframe.style.height = `${record.device.height}px`;
    record.iframe.src = itemUrl(item, record.device.id);
  }
}

function setUpdated(itemId, on) {
  if (on) updatedItems.add(itemId);
  else updatedItems.delete(itemId);
  viewedFor.delete(itemId);
}

/** @param {boolean} initial */
function noticeFileChanges(initial) {
  const seen = loadSeen();
  const marked = updatedItems.size;
  for (const item of state.items) {
    const stamp = contentToken(item);
    if (!stamp) continue;
    const before = knownStamps.get(item.id);
    knownStamps.set(item.id, stamp);
    if (initial) {
      if (seen[item.id] === undefined) markSeen(item.id, stamp);
      else if (stamp !== String(seen[item.id])) setUpdated(item.id, true);
      continue;
    }
    if (before === undefined) {
      // A frame whose file only just appeared would otherwise keep the page it loaded
      // when the file was missing.
      reloadItem(item);
      setUpdated(item.id, true);
      continue;
    }
    if (stamp !== before) {
      reloadItem(item);
      setUpdated(item.id, true);
      if ((item.builds || []).length > 1) requestThumb(item.id, String(item.hash || ""));
    }
  }
  if (updatedItems.size !== marked && state.layout) render();
  if (historyItem) renderHistory();
}

// An update counts as seen once one of its artboards has been on screen, at a size you
// can read, for a couple of seconds.
function checkViewed() {
  if (updatedItems.size === 0) return;
  const area = { left: 0, top: barHeight(), right: window.innerWidth - panelWidth(), bottom: window.innerHeight };
  for (const itemId of [...updatedItems]) {
    let visible = false;
    for (const record of state.artboards.values()) {
      if (record.itemId !== itemId || record.root.hidden) continue;
      const rect = record.screen.getBoundingClientRect();
      const onScreen =
        rect.right > area.left && rect.left < area.right && rect.bottom > area.top && rect.top < area.bottom;
      if (onScreen && rect.width >= 120) visible = true;
    }
    if (!visible || document.hidden) {
      viewedFor.delete(itemId);
      continue;
    }
    const since = viewedFor.get(itemId) || Date.now();
    viewedFor.set(itemId, since);
    if (Date.now() - since < 2500) continue;
    const item = itemById(itemId);
    if (item) markSeen(itemId, contentToken(item));
    setUpdated(itemId, false);
    if (state.layout) render();
  }
}

/** Frame one version on screen, from a link in the panel. */
function focusItem(itemId) {
  const boards = eachBoard().filter((board) => board.item.id === itemId);
  if (boards.length === 0) {
    if (state.deviceMode === "all") return undefined;
    setDeviceMode("all");
    return focusItem(itemId);
  }
  focusBoards(boards);
  return undefined;
}

/** Frame a set of artboards on screen, above the history strip when it is open. */
function focusBoards(boards) {
  if (boards.length === 0) return;
  userAdjustedCamera = true;
  const left = Math.min(...boards.map((board) => board.x));
  // The label row above the frames carries the name and the compared build's buttons.
  const top = Math.min(...boards.map((board) => board.y)) - (state.layout?.labelReserve || 0);
  const right = Math.max(...boards.map((board) => board.x + board.width));
  const bottom = Math.max(...boards.map((board) => board.y + board.height));
  const strip = document.getElementById("history")?.getBoundingClientRect().height || 0;
  const area = { ...availableArea() };
  area.height = Math.max(200, area.height - strip);
  const zoom = clamp(
    Math.min(1, (area.width - 96) / (right - left), (area.height - 96) / Math.min(bottom - top, area.height * 3)),
    MIN_ZOOM,
    1,
  );
  setCamera({ zoom, x: (area.width - (right - left) * zoom) / 2 - left * zoom, y: 48 - top * zoom }, true);
}

// A reply is linked to the versions whose files changed between the previous reply
// and shortly after this one: that is what the agent just did. Links are kept per
// reply in this browser, so a later edit does not move an old reply's link.
const linkStorageKey = `liesel:links:${key}`;
function replyLinks(entry, previousAt) {
  let stored;
  try {
    stored = JSON.parse(readStorage(linkStorageKey) || "{}") || {};
  } catch {
    stored = {};
  }
  const id = String(entry.at || "");
  if (Array.isArray(stored[id])) return stored[id].filter((itemId) => itemById(itemId));
  const at = Date.parse(id);
  if (!Number.isFinite(at)) return [];
  // The first reply looks back to the first note the reviewer sent, not to the files the
  // board started with.
  const firstUser = state.chat.find((other) => other.role === "user");
  const from = Date.parse(String(previousAt || firstUser?.at || "")) || at;
  const links = state.items
    .filter((item) => Number(item.mtime) > from && Number(item.mtime) <= at + 2 * 60 * 1000)
    .map((item) => item.id);
  // Settle the links once the grace window after the reply has passed.
  if (Date.now() > at + 2 * 60 * 1000) {
    stored[id] = links;
    writeStorage(linkStorageKey, JSON.stringify(stored));
  }
  return links;
}

/* ------------------------------------------------------------------- final */

// The reviewer picks one design per tab as the final. It is the item's `status: "final"`
// in board.json, the others on that tab go back to "open", and the agent hears of every
// pick or take-back at once, as an ordinary prompt, so it reaches poll and the notify hook.
const FINAL = "final";
/** Statuses saved here and not yet confirmed: a board refresh that left before them keeps them. */
/** @type {Map<string, string>} */
const pendingStatus = new Map();

/** The tab's chosen design, if any. @param {string} tab */
function finalOf(tab) {
  return state.items.find((item) => item.tab === tab && item.status === FINAL) || null;
}

/** @param {any} item */
function finalRef(item) {
  return `${item.label} (item ${item.id}${item.file ? `, ${item.file}` : ""})`;
}

/** Choose this design as its tab's final, or take it back when it already is. @param {string} itemId */
function toggleFinal(itemId) {
  const item = itemById(itemId);
  if (!item || state.ended) return;
  const previous = finalOf(item.tab);
  setFinal(item.tab, previous?.id === item.id ? "" : item.id, previous?.id || "");
}

/**
 * Make `itemId` (or nothing) the final of `tab`: saved, shown, told to the agent, and
 * offered back with Undo.
 * @param {string} tab @param {string} itemId @param {string} previousId
 */
function setFinal(tab, itemId, previousId) {
  if (state.ended || itemId === previousId) return;
  const changes = [];
  for (const other of state.items) {
    if (other.tab !== tab) continue;
    const next = other.id === itemId ? FINAL : other.status === FINAL ? "open" : other.status;
    if (other.status !== next) {
      other.status = next;
      changes.push({ id: other.id, status: next });
    }
  }
  if (changes.length > 0) {
    for (const change of changes) pendingStatus.set(change.id, change.status);
    const settle = () => {
      for (const change of changes) if (pendingStatus.get(change.id) === change.status) pendingStatus.delete(change.id);
    };
    boardPost("place", { items: changes })
      .then(settle)
      .catch(() => {
        settle();
        dockStatus.textContent = "Could not save the final design.";
      });
  }
  const chosen = itemById(itemId);
  const previous = itemById(previousId);
  const message = chosen
    ? `Chosen as final: ${finalRef(chosen)}${previous ? `, replacing ${finalRef(previous)}` : ""}`
    : `No longer final: ${previous ? finalRef(previous) : "the design"}. No design on this tab is chosen as final now.`;
  const about = chosen || previous;
  if (about) sendPrompts([], message, [], { thread: `item:${about.id}`, item: about });
  render();
  showBoardToast(chosen ? "Chosen as final" : "No final design", chosen ? chosen.label : "", "Undo", () =>
    setFinal(tab, previousId, itemId),
  );
}

/** A design's final button and how it stands among its tab. @param {any} record @param {any} item */
function syncFinal(record, item) {
  const final = finalOf(item.tab);
  const chosen = final?.id === item.id;
  const button = record.actions.querySelector(".item-final");
  if (button) {
    button.textContent = chosen ? "✓ Final" : "Final";
    button.title = chosen ? "Chosen as final · click to take it back" : "Choose as final";
    button.setAttribute("aria-label", chosen ? "Chosen as final; take it back" : "Choose as final");
    button.setAttribute("aria-pressed", String(chosen));
    button.disabled = Boolean(state.ended);
  }
  const standing = final ? (chosen ? "chosen" : "other") : "";
  for (const node of [record.root, record.label]) {
    if (standing) node.dataset.final = standing;
    else delete node.dataset.final;
  }
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
    const undo = element("button", { class: "button button-quiet choice-undo", type: "button", text: "Take back" });
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
    if (other.item.placeholder) continue;
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
  sendPrompts([], message, [], { thread: `item:${item.id}`, item });
  render();
}

/* ------------------------------------------------------------------ camera */

let userAdjustedCamera = false;
let movingTimer = 0;

// Camera coordinates are relative to the plane, which starts under the bar.
let parkedZoom = 0;
function applyCamera() {
  const { x, y, zoom } = state.camera;
  canvas.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  canvas.style.setProperty("--zoom", String(zoom));
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  if (editTagFrame) syncEditTag();
  // Parked pins are sized for the zoom, so a new zoom re-spaces them.
  if (zoom !== parkedZoom) {
    parkedZoom = zoom;
    renderAllGutterPins();
  }
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

let spaceHeld = false;
// Cmd toggles notes and Option toggles the controls selector: a lone press and release
// turns its mode on, the next one off, and the two never run together. A modifier used
// in a chord (Cmd+C, Cmd+scroll, Option+drag), joined by any other modifier at any point
// (Cmd-Shift-3, whose 3 macOS swallows), held too long, or let go in another app or a
// hidden tab flips nothing.
// Held past a tap, alone, either key switches its mode only while it is held: from View
// or the other mode to its own, from its own back to View, so a reviewer can drop one note,
// pick one element, or reach the page's buttons for a moment. Letting go puts the mode
// back, and a shortcut, a scroll, another modifier or a lost release ends the hold at once.
/** @type {"" | "annotate" | "tune" | "move"} */
let armedMode = "";
const TAP_MAX_MS = 350;
/** @type {Record<"Meta" | "Alt", { down: boolean, chord: boolean, at: number, timer: number }>} */
const modifierTaps = {
  Meta: { down: false, chord: false, at: 0, timer: 0 },
  Alt: { down: false, chord: false, at: 0, timer: 0 },
};
/** The mode a held key switched from, to put back on release. */
/** @type {null | { name: "Meta" | "Alt", restore: "" | "annotate" | "tune" | "move" }} */
let heldMode = null;
/** Whether the frames let an Option click through, as they must in a View held by Option. */
let passOption = false;
let lastHoverKey = "";
let hoverFrame = 0;
let panWheelAt = 0;
/** Where the pointer last rested on screen, over the board or inside a design. */
/** @type {null | { x: number, y: number }} */
let lastPointer = null;

// Five gestures own the pointer over a design, one at a time: Space held pans, the
// controls selector (Option) tunes, notes (Cmd) annotate, Move (from the pill) drags an
// element, and with none of them the click belongs to the page. The shield is the only
// surface the board has over a frame, so every armed gesture raises it, and none can
// leak into another.
function gestureMode() {
  if (spaceHeld) return "hand";
  return armedMode;
}

function panModeActive() {
  return gestureMode() === "hand";
}

function annotateArmed() {
  return gestureMode() === "annotate";
}

function tuneArmed() {
  return gestureMode() === "tune";
}

function moveArmed() {
  return gestureMode() === "move";
}

function updateGestureMode() {
  const mode = gestureMode();
  document.body.dataset.gesture = mode;
  document.body.dataset.pan = String(mode === "hand");
  document.body.dataset.notes = String(armedMode === "annotate");
  document.body.dataset.controls = String(armedMode === "tune");
  if (mode === "annotate" || mode === "tune" || mode === "move") hoverUnderPointer();
  else clearHover();
}

/** @type {Record<"annotate" | "tune" | "move", { text: string, view: "chat" | "controls" }>} */
const MODE_STATE = {
  annotate: {
    text: "Chat",
    view: "chat",
  },
  tune: {
    text: "Edit",
    view: "controls",
  },
  // A move is an element change like an Edit one, so it is sent from Controls.
  move: {
    text: "Move",
    view: "controls",
  },
};

/** Every mode, in black under the top bar: the one that is on is white, the others dulled. */
function renderModeState() {
  const badge = document.getElementById("modeState");
  if (!badge) return;
  badge.dataset.mode = armedMode;
  for (const word of badge.children) {
    const on = /** @type {any} */ (word).dataset.mode === armedMode;
    if (on) word.setAttribute("aria-current", "true");
    else word.removeAttribute("aria-current");
    word.setAttribute("aria-pressed", String(on));
  }
}

// Each word in the pill switches to its mode, the same way a tap of its key does.
document.getElementById("modeState")?.addEventListener("click", (event) => {
  const word = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest?.("button[data-mode]"));
  if (!word) return;
  const mode = /** @type {"" | "annotate" | "tune" | "move"} */ (word.dataset.mode ?? "");
  heldMode = null;
  setArmedMode(mode);
  syncPassOption();
});

/**
 * @param {"" | "annotate" | "tune" | "move"} mode turning one mode on turns the others off
 * @param {boolean} [side] bring up the mode's sidebar tab; a hold leaves the tab alone
 */
function setArmedMode(mode, side = true) {
  if (armedMode === mode) return;
  armedMode = mode;
  updateGestureMode();
  renderModeState();
  syncPassOption();
  if (!mode || !side) return;
  // The tab the mode works in comes up, but a closed sidebar stays closed: opening it would
  // slide the board out from under the pointer just as the reviewer goes to click.
  showSideView(MODE_STATE[mode].view, false);
  document.querySelector(".annotate-hint")?.remove();
}

/**
 * A modifier held through a click, a scroll or another key was a chord, not a tap. A click
 * is what a hold is for, so it keeps a held mode; anything else ends it.
 * @param {"key" | "pointer"} [via]
 */
function noteChord(via = "key") {
  for (const tap of Object.values(modifierTaps)) {
    if (!tap.down) continue;
    tap.chord = true;
    window.clearTimeout(tap.timer);
  }
  if (via !== "pointer") endHeldMode();
}

/** @param {"Meta" | "Alt"} name */
function modeOfKey(name) {
  return name === "Meta" ? "annotate" : "tune";
}

/** A lone key still down past a tap switches its mode until it is let go. @param {"Meta" | "Alt"} name */
function startHeldMode(name) {
  const tap = modifierTaps[name];
  if (!tap.down || tap.chord || heldMode) return;
  const mode = modeOfKey(name);
  heldMode = { name, restore: armedMode };
  setArmedMode(armedMode === mode ? "" : mode, false);
}

/** Put back the mode a hold switched from. */
function endHeldMode() {
  if (!heldMode) return;
  const { restore } = heldMode;
  heldMode = null;
  setArmedMode(restore, false);
  syncPassOption();
}

/** An Option click must reach the page only in a View that Option itself is holding. */
function syncPassOption() {
  const next = heldMode?.name === "Alt" && armedMode === "";
  if (next === passOption) return;
  passOption = next;
  for (const record of state.artboards.values())
    postToArtboard(record.itemId, record.device.id, { type: "pass-option", on: passOption });
}

/**
 * @param {"Meta" | "Alt"} name
 * @param {boolean} [joined] another modifier (Shift, Ctrl, Cmd or Option) was already held
 * @param {number} [at] when the key went down, on this document's clock
 */
function modifierPressed(name, joined = false, at = performance.now()) {
  const tap = modifierTaps[name];
  if (tap.down) return;
  // Option during a Move drag frees it from snapping; it never switches the mode.
  if (name === "Alt") setMoveFree(true);
  // Cmd and Option pressed together, or either with Space held or mid-drag, is a chord.
  const others = joined || spaceHeld || Boolean(moveDrag) || Object.values(modifierTaps).some((other) => other.down);
  noteChord();
  tap.down = true;
  tap.chord = others;
  tap.at = at;
  if (others) return;
  // Timed from the key's own press, so a frame slow to report it does not stretch the wait.
  const wait = Math.max(0, TAP_MAX_MS - (performance.now() - at));
  tap.timer = window.setTimeout(() => startHeldMode(name), wait);
}

/**
 * @param {"Meta" | "Alt"} name
 * @param {boolean} [lost] the release happened somewhere else, so it toggles nothing
 * @param {boolean} [joined] another modifier was still held at the release
 * @param {number} [at] when the key came up, on this document's clock
 */
function modifierReleased(name, lost = false, joined = false, at = performance.now()) {
  const tap = modifierTaps[name];
  if (name === "Alt") setMoveFree(false);
  // A tap is timed by the keys' own timestamps, never by when the board heard them: a busy
  // focused design can hold a keyup back for hundreds of ms before reporting it.
  const lone = tap.down && !tap.chord && !lost && !joined && at - tap.at <= TAP_MAX_MS;
  tap.down = false;
  tap.chord = false;
  window.clearTimeout(tap.timer);
  if (heldMode?.name === name) {
    // A busy frame can report a quick tap's release after the hold began: still a tap.
    if (!lone) {
      endHeldMode();
      return;
    }
    // The hold already switched to the mode the tap asks for; keep it and bring up its tab.
    heldMode = null;
    syncPassOption();
    if (armedMode) showSideView(MODE_STATE[armedMode].view, false);
    return;
  }
  if (!lone) return;
  const mode = modeOfKey(name);
  setArmedMode(armedMode === mode ? "" : mode);
}

/** Outline what sits under a resting pointer the moment a mode turns on, with no move needed. */
function hoverUnderPointer() {
  if (!lastPointer) return;
  const record = recordForShield(document.elementFromPoint(lastPointer.x, lastPointer.y));
  if (!record) return;
  if (lastHoverKey && lastHoverKey !== record.id) clearHover();
  lastHoverKey = record.id;
  record.root.dataset.hover = "true";
  postHit(record, { ...pointInFrame(record, lastPointer.x, lastPointer.y), hover: true });
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

/** A field that takes typed text, unlike a slider, swatch or select. */
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  const type = String(target.getAttribute("type") || "text").toLowerCase();
  return !["range", "color", "checkbox", "radio", "button"].includes(type);
}

function recordForShield(target) {
  if (!(target instanceof Element)) return null;
  const shield = target.closest(".shield");
  return shield ? state.artboards.get(shield.getAttribute("data-key") || "") || null : null;
}

/** The artboard a pointer target sits in, shield or the page itself, without arming. */
function recordForTarget(target) {
  if (!(target instanceof Element)) return null;
  const root = target.closest(".artboard");
  return root ? state.artboards.get(root.getAttribute("data-key") || "") || null : null;
}

/**
 * The first cursor entry into any design teaches the gestures, once per board: with
 * notes off the frames belong to their pages, so this is the only moment the board can
 * say why a click no longer drops a note.
 */
function hintAnnotateOnce(target) {
  if (readStorage(annotateHintStorageKey)) return;
  if (armedMode || !recordForTarget(target)) return;
  writeStorage(annotateHintStorageKey, "seen");
  const hint = element("div", {
    class: "annotate-hint",
    text: "Tap ⌘ for notes · tap ⌥ to pick an element for Controls · hold either to switch just while held · hold Space to pan",
  });
  document.body.append(hint);
  window.requestAnimationFrame(() => {
    hint.dataset.shown = "true";
  });
  window.setTimeout(() => {
    delete hint.dataset.shown;
    window.setTimeout(() => hint.remove(), 400);
  }, 4200);
}

/** A screen point inside an artboard's own viewport: one division by the zoom. */
function pointInFrame(record, clientX, clientY) {
  const rect = record.iframe.getBoundingClientRect();
  const scale = rect.width / record.device.width || state.camera.zoom;
  return { x: Math.round((clientX - rect.left) / scale), y: Math.round((clientY - rect.top) / scale) };
}

function postHit(record, payload) {
  const tune = payload.hover && tuneArmed() ? { tune: true, depth: tuneDepth } : {};
  const move = payload.hover && moveArmed() ? { move: true } : {};
  postToArtboard(record.itemId, record.device.id, { type: "hit", ...payload, ...tune, ...move });
}

/** Moving the pointer to something else starts the selector back at what is under it. */
function notePointerForDepth(x, y) {
  if (tuneDepthAt && Math.hypot(x - tuneDepthAt.x, y - tuneDepthAt.y) < 6) return;
  tuneDepthAt = { x, y };
  tuneDepth = 0;
}

function clearHover() {
  if (!lastHoverKey) return;
  const record = state.artboards.get(lastHoverKey);
  if (record) {
    postHit(record, { hover: true, x: -1, y: -1 });
    delete record.root.dataset.hover;
  }
}

/*
 * Touch: on a phone or tablet the shield stays up over every frame (see board.css), so
 * no page can swallow a drag. One finger drags the board and glides on when let go,
 * two fingers pinch to zoom around their midpoint, and a tap that never moved still
 * drops a note or picks an element for Controls.
 */
const TOUCH_GLIDE_DECAY = 0.996; // per millisecond
const TOUCH_GLIDE_MIN = 0.02; // px per millisecond
const TOUCH_TAP_SLOP = 8;

function bindNavigation() {
  /** @type {null | { x: number, y: number, cameraX: number, cameraY: number, id: number, moved: boolean, touch?: boolean }} */
  let drag = null;
  let suppressClick = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let clickTimer;
  /** A note dropped where a click or tap landed on a design. @param {any} record @param {number} x @param {number} y */
  const noteAt = (record, x, y) => {
    const point = pointInFrame(record, x, y);
    // A double-click means zoom, so the note waits out the double-click window.
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      pendingClick = { key: record.id, x, y, time: Date.now() };
      postHit(record, point);
    }, 220);
  };
  /** @type {Map<number, { x: number, y: number }>} every finger on the plane */
  const touches = new Map();
  /** @type {null | { distance: number, zoom: number, worldX: number, worldY: number }} */
  let pinch = null;
  /** @type {{ x: number, y: number, t: number }[]} the last moments of a one-finger drag */
  let samples = [];
  let glide = 0;

  const stopGlide = () => {
    if (glide) window.cancelAnimationFrame(glide);
    glide = 0;
  };

  /** @param {number} vx @param {number} vy px per millisecond */
  const glideFrom = (vx, vy) => {
    stopGlide();
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(now - last, 32);
      last = now;
      state.camera.x += vx * dt;
      state.camera.y += vy * dt;
      const decay = Math.pow(TOUCH_GLIDE_DECAY, dt);
      vx *= decay;
      vy *= decay;
      scheduleApplyCamera();
      if (Math.hypot(vx, vy) > TOUCH_GLIDE_MIN) glide = window.requestAnimationFrame(step);
      else {
        glide = 0;
        saveCamera();
      }
    };
    glide = window.requestAnimationFrame(step);
  };

  /** @param {{ x: number, y: number }} point @param {number} id */
  const startTouchDrag = (point, id) => {
    drag = { x: point.x, y: point.y, cameraX: state.camera.x, cameraY: state.camera.y, id, moved: false, touch: true };
    samples = [{ x: point.x, y: point.y, t: performance.now() }];
  };

  const startPinch = () => {
    const [a, b] = [...touches.values()];
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2 - barHeight();
    pinch = {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: state.camera.zoom,
      worldX: (midX - state.camera.x) / state.camera.zoom,
      worldY: (midY - state.camera.y) / state.camera.zoom,
    };
    drag = null;
    suppressClick = true;
  };

  plane.addEventListener("pointerdown", (event) => {
    if (event.metaKey || event.altKey) noteChord("pointer");
    if (event.target instanceof Element && event.target.closest("button")) return;
    // A press that pans is kept from moving focus, so a name being edited is saved here.
    const editing = document.activeElement;
    if (editing instanceof HTMLElement && editing.classList.contains("rename-input")) editing.blur();
    if (event.pointerType === "touch") {
      stopGlide();
      event.preventDefault();
      // A touch is captured by what it landed on already, so a tap on a design still
      // clicks that design's shield.
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      userAdjustedCamera = true;
      canvas.style.transition = "";
      clearHover();
      if (touches.size === 2) startPinch();
      else if (touches.size === 1) {
        suppressClick = false;
        startTouchDrag({ x: event.clientX, y: event.clientY }, event.pointerId);
      }
      return;
    }
    // A design's name takes its own click rather than starting a pan.
    if (event.target instanceof Element && event.target.closest("[data-tap]")) return;
    const record = recordForShield(event.target);
    // Tune owns the press: the panel opens on the point under the pointer, and the
    // click that follows is consumed so it can never turn into a note.
    if (record && tuneArmed() && event.button === 0) {
      event.preventDefault();
      suppressClick = true;
      openTargetTune(record, pointInFrame(record, event.clientX, event.clientY));
      return;
    }
    // Move owns the press too: it grabs the element under the pointer and the drag moves it.
    if (record && moveArmed() && event.button === 0) {
      event.preventDefault();
      suppressClick = true;
      clearHover();
      plane.setPointerCapture(event.pointerId);
      document.body.dataset.grabbing = "true";
      startMove(record, event);
      return;
    }
    const onShield = Boolean(record);
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
    if (touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch && touches.size >= 2) {
        const [a, b] = [...touches.values()];
        const zoom = clamp((pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance, MIN_ZOOM, MAX_ZOOM);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2 - barHeight();
        state.camera = { zoom, x: midX - pinch.worldX * zoom, y: midY - pinch.worldY * zoom };
        scheduleApplyCamera();
        return;
      }
      if (drag?.touch && event.pointerId === drag.id) {
        samples.push({ x: event.clientX, y: event.clientY, t: performance.now() });
        if (samples.length > 6) samples.shift();
      }
    }
    if (moveDrag && event.pointerId === moveDrag.pointerId) {
      dragMove(event.clientX, event.clientY, event.altKey);
      return;
    }
    if (drag && event.pointerId === drag.id) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < (drag.touch ? TOUCH_TAP_SLOP : 3)) return;
      if (drag.touch) suppressClick = true;
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
    if (touches.has(event.pointerId)) {
      touches.delete(event.pointerId);
      const ended = drag && drag.id === event.pointerId ? drag : null;
      if (pinch) {
        if (touches.size < 2) pinch = null;
        // The finger still down carries on as a drag, from where it is now.
        const [rest] = [...touches.entries()];
        if (rest) startTouchDrag(rest[1], rest[0]);
        else drag = null;
        saveCamera();
        return;
      }
      drag = null;
      if (!ended) return;
      if (!ended.moved) {
        // A tap: Controls picks what is under it, notes drop a note there. Neither
        // waits for a click, which a touch browser may never send.
        const record = recordForShield(event.target);
        // Something on the board that answers a tap, such as a design's name.
        const tappable = event.target instanceof Element ? event.target.closest("[data-tap]") : null;
        if (!record && tappable instanceof HTMLElement && event.type === "pointerup") {
          suppressClick = true;
          tappable.click();
          return;
        }
        if (!record || event.type !== "pointerup" || panModeActive()) return;
        suppressClick = true;
        if (tuneArmed()) openTargetTune(record, pointInFrame(record, event.clientX, event.clientY));
        else if (annotateArmed()) noteAt(record, event.clientX, event.clientY);
        return;
      }
      const now = performance.now();
      const recent = samples.filter((sample) => now - sample.t < 120);
      const first = recent[0];
      const last = recent[recent.length - 1];
      const span = first && last ? last.t - first.t : 0;
      if (span > 0 && event.type === "pointerup") glideFrom((last.x - first.x) / span, (last.y - first.y) / span);
      else saveCamera();
      return;
    }
    if (moveDrag && event.pointerId === moveDrag.pointerId) {
      document.body.dataset.grabbing = "false";
      endMove(event.type === "pointerup");
      return;
    }
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    document.body.dataset.grabbing = "false";
    saveCamera();
  };
  plane.addEventListener("pointerup", endDrag);
  plane.addEventListener("pointercancel", endDrag);
  plane.addEventListener("pointerleave", () => clearHover());

  plane.addEventListener("click", (event) => {
    const record = recordForShield(event.target);
    if (!record || suppressClick || panModeActive() || !annotateArmed()) return;
    noteAt(record, event.clientX, event.clientY);
  });

  // While a gesture owns the pointer, the browser's own right-click menu is not one of
  // the four: on a Mac a Ctrl-click arrives here as a right click.
  plane.addEventListener("contextmenu", (event) => {
    if (gestureMode() === "") return;
    event.preventDefault();
  });

  plane.addEventListener("dblclick", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    clearTimeout(clickTimer);
    // A drag or a tune click is not a zoom, and swallowing the double-click keeps the
    // four gestures exclusive.
    if (gestureMode() === "hand" || gestureMode() === "tune" || gestureMode() === "move") return;
    event.preventDefault();
    if (annotateArmed() && recordForShield(event.target)) toggleActual(event.clientX, event.clientY);
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
      if (event.metaKey || event.altKey) noteChord();
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

// Settings: one switch per screen format, remembered per board. The last format on is
// locked, so the board always has something to show.
function renderFormatSwitches() {
  for (const toggle of document.querySelectorAll("[data-format]")) {
    const input = /** @type {HTMLInputElement} */ (toggle);
    input.checked = state.formats.has(input.dataset.format || "");
    input.disabled = input.checked && state.formats.size === 1;
    input.title = input.disabled ? "At least one format stays on" : "";
  }
}

/** @param {string} id @param {boolean} on */
function setFormat(id, on) {
  if (on === state.formats.has(id) || (!on && state.formats.size === 1)) {
    renderFormatSwitches();
    return;
  }
  flashSettingsSaved();
  if (on) state.formats.add(id);
  else state.formats.delete(id);
  writeStorage(formatsStorageKey, JSON.stringify([...state.formats]));
  if (!on && state.deviceMode === id) {
    setDeviceMode("all");
    return;
  }
  renderDevices();
  if (state.deviceMode !== "all") return;
  relayout();
  userAdjustedCamera = false;
  fit(false);
}

function renderDevices() {
  renderFormatSwitches();
  if (!deviceBar) return;
  const options = [{ id: "all", label: "All" }, ...enabledFormats()];
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
  if (message.type === "style" || message.type === "element-tune") sendFontLinks(itemId, deviceId, message);
  record.iframe.contentWindow.postMessage({ channel: "liesel", item: itemId, device: deviceId, ...message }, "*");
}

/** A note whose thread carries the agent's answer: its Done stamp. */
function answeredNote(note) {
  const entry = state.chat.find((message) => message && message.prompt_id === note.prompt_id);
  return Boolean(entry && entry.done_at);
}

/** The agent has taken this note and not answered it yet. */
function workingNote(note) {
  if (!note.prompt_id) return false;
  const entry = state.chat.find((message) => message && message.prompt_id === note.prompt_id);
  return Boolean(entry && entry.delivered_at && !entry.done_at);
}

/** Sent and not answered yet, taken or not: its number shows a turning ring. */
function awaitingReply(note) {
  if (!note.prompt_id) return false;
  if (sendingPrompts.has(note.prompt_id)) return true;
  const entry = state.chat.find((message) => message && message.prompt_id === note.prompt_id);
  return Boolean(entry && !entry.done_at);
}

/** @param {any} note @returns {"draft" | "sent" | "working" | "done"} */
function pinState(note) {
  if (!note.prompt_id) return "draft";
  if (answeredNote(note)) return "done";
  return workingNote(note) ? "working" : "sent";
}

function pinsFor(item, deviceId) {
  const page = item.page ? livePageOf(item.id, deviceId) : "";
  return (item.notes || [])
    .filter((note) => noteDevice(note) === deviceId && (!page || (note.page || item.page) === page))
    .map((note) => ({
      id: note.id,
      number: note.number,
      selector: note.selector,
      x: note.x,
      y: note.y,
      ox: note.ox,
      oy: note.oy,
      state: pinState(note),
      waiting: awaitingReply(note),
    }));
}

function postPins(itemId, deviceId) {
  const item = itemById(itemId);
  if (item) postToArtboard(itemId, deviceId, { type: "pins", pins: pinsFor(item, deviceId) });
}

function postAllPins() {
  for (const record of state.artboards.values()) postPins(record.itemId, record.device.id);
}

/* ----------------------------------------------------------------- images */

// Pasted or dropped images ride the session's existing attachment store: the board
// page uploads the raw bytes (same-origin, magic-byte checked server side) and a
// prompt names them by id, so the agent receives a local file path with the note.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
// The server takes four images per prompt by default.
const MAX_PROMPT_IMAGES = 4;
/** @type {Map<string, Set<Promise<unknown>>>} */
const uploads = new Map();
/** @type {Array<{ id: string, name?: string }>} */
let composerImages = [];

function attachmentUrl(id) {
  return `/api/${encodeURIComponent(key)}/attachments/${encodeURIComponent(id)}`;
}

/** @param {DataTransfer | null} transfer */
function imageFiles(transfer) {
  if (!transfer) return [];
  const files = [];
  for (const entry of Array.from(transfer.items || [])) {
    if (entry.kind !== "file") continue;
    const file = entry.getAsFile();
    if (file && IMAGE_TYPES.has(file.type)) files.push(file);
  }
  if (files.length === 0) {
    for (const file of Array.from(transfer.files || [])) if (IMAGE_TYPES.has(file.type)) files.push(file);
  }
  return files;
}

/** @param {File} file @returns {Promise<{ id: string, name?: string }>} */
function uploadImage(file) {
  return fetch(`/api/${encodeURIComponent(key)}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  }).then(async (response) => {
    if (!response.ok) {
      const reason = response.status === 413 ? "That image is too large." : "That image could not be added.";
      throw new Error(reason);
    }
    const payload = await response.json();
    const id = String(payload?.attachment?.id || "");
    if (!id) throw new Error("That image could not be added.");
    return file.name && file.name !== "image.png" ? { id, name: file.name.slice(0, 120) } : { id };
  });
}

/**
 * Upload images for one owner (a note id, or "composer") and add them to its list as
 * they land. Sending waits for whatever is still uploading.
 * @param {string} owner
 * @param {File[]} files
 * @param {(ref: { id: string, name?: string }) => void} add
 */
function addImages(owner, files, add) {
  for (const file of files) {
    const task = uploadImage(file)
      .then(add)
      .catch((error) => {
        dockStatus.textContent = error.message;
      })
      .finally(() => {
        uploads.get(owner)?.delete(task);
      });
    if (!uploads.has(owner)) uploads.set(owner, new Set());
    uploads.get(owner)?.add(task);
  }
}

function pendingUploads(owners) {
  const tasks = [];
  for (const owner of owners) tasks.push(...(uploads.get(owner) || []));
  return Promise.all(tasks);
}

/**
 * Paste (Cmd+V) and drop images onto a field.
 * @param {HTMLElement} target
 * @param {(files: File[]) => void} onImages
 */
function acceptImages(target, onImages) {
  target.addEventListener("paste", (event) => {
    const files = imageFiles(event.clipboardData);
    if (files.length === 0) return;
    // A screenshot paste carries only the image; keep any real text that came with it.
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!text.trim() || files.some((file) => file.name && text.includes(file.name))) event.preventDefault();
    onImages(files);
  });
  target.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    target.dataset.dropping = "true";
  });
  target.addEventListener("dragleave", () => {
    delete target.dataset.dropping;
  });
  target.addEventListener("drop", (event) => {
    delete target.dataset.dropping;
    const files = imageFiles(event.dataTransfer);
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    if (files.length > 0) onImages(files);
    else dockStatus.textContent = "Only PNG, JPEG and WebP images can be added.";
  });
}

/**
 * @param {Array<{ id: string }>} list
 * @param {((id: string) => void) | null} onRemove
 */
function thumbStrip(list, onRemove) {
  const strip = element("div", { class: "thumbs" });
  for (const ref of list || []) {
    const thumb = element("span", { class: "thumb" });
    thumb.append(element("img", { src: attachmentUrl(ref.id), alt: "", loading: "lazy" }));
    if (onRemove) {
      const remove = element("button", {
        class: "thumb-remove",
        type: "button",
        text: "×",
        "aria-label": "Remove image",
      });
      remove.addEventListener("click", () => onRemove(ref.id));
      thumb.append(remove);
    }
    strip.append(thumb);
  }
  return strip;
}

function renderComposerImages() {
  const holder = document.getElementById("composerImages");
  if (!holder) return;
  holder.replaceChildren(
    thumbStrip(composerImages, (id) => {
      composerImages = composerImages.filter((ref) => ref.id !== id);
      renderComposerImages();
      updateSendButton();
    }),
  );
  holder.hidden = composerImages.length === 0;
}

/* ------------------------------------------------------------ image drops */

// A file dropped onto a picture in a design replaces it. The frame finds the element,
// the board uploads the bytes the same way a pasted note does, and the file is copied
// into the board folder so the swap survives a reload.

function dropUrl(file) {
  const name = String(file || "")
    .split("/")
    .pop();
  return `/board/${encodeURIComponent(key)}/drop/${encodeURIComponent(name)}`;
}

function postImageDrops(itemId, deviceId) {
  const item = itemById(itemId);
  if (!item) return;
  const drops = (item.imageDrops || []).map((drop) => ({
    selector: drop.selector,
    kind: drop.kind,
    src: dropUrl(drop.file),
  }));
  postToArtboard(itemId, deviceId, { type: "image-drops", drops });
}

function postAllImageDrops(itemId) {
  for (const device of DEVICES) postImageDrops(itemId, device.id);
}

/** @type {any} */
let dropToastTimer;

function hideDropToast() {
  clearTimeout(dropToastTimer);
  document.getElementById("dropToast")?.remove();
}

/**
 * The changed image, in the words the agent needs to carry it into the build: which
 * item, which selector, what it replaced, and the file now standing in for it.
 */
function imageDropPrompt(item, drop) {
  const old = String(drop.oldSource || "");
  const replaced = old.startsWith("data:")
    ? "the original inline image"
    : old.length > 80
      ? `${old.slice(0, 80)}…`
      : old;
  return [
    `Replace the image at ${drop.selector} in ${item.label} (${item.file}) with ${drop.file}.`,
    replaced ? `It replaced ${replaced}.` : "",
    `The file is in the board folder, and board.json records it on item ${item.id}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function sendItemNote(item, text, selector, tag = "image") {
  if (state.ended) return;
  fetch(`/api/${encodeURIComponent(key)}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompts: [
        {
          uid: randomId(),
          prompt_id: randomId(),
          prompt: text,
          tag,
          thread: `item:${item.id}`,
          selector: selector || "",
          item: itemRef(item),
        },
      ],
      domSnapshot: "",
    }),
  })
    .then((response) => {
      if (!response.ok) throw new Error("not accepted");
      refreshBoard();
    })
    .catch(() => {
      dockStatus.textContent = "Could not reach Liesel. The image is still swapped.";
    });
}

function showDropToast(item, drop) {
  hideDropToast();
  const toast = element("div", { class: "drop-toast", id: "dropToast", role: "status" });
  toast.append(
    element("span", { class: "drop-toast-text", text: `Replaced ${drop.selector}` }),
    element("span", {
      class: "drop-toast-file",
      text: String(drop.file || "")
        .split("/")
        .pop(),
    }),
  );
  const undo = element("button", { class: "drop-toast-undo", type: "button", text: "Undo" });
  undo.addEventListener("click", () => undoImageDrop(item.id, drop.selector));
  toast.append(undo);
  document.body.append(toast);
  dropToastTimer = window.setTimeout(hideDropToast, 10000);
}

function undoImageDrop(itemId, selector) {
  fetch(`/api/boards/${encodeURIComponent(key)}/image-drop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item: itemId, selector, undo: true }),
  })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error("not accepted"))))
    .then((payload) => {
      const live = itemById(itemId);
      if (live && payload?.imageDrops) live.imageDrops = payload.imageDrops;
      postAllImageDrops(itemId);
      hideDropToast();
      if (live)
        sendItemNote(live, `Put the original image back at ${selector} in ${live.file}; the drop is undone.`, selector);
    })
    .catch(() => {
      dockStatus.textContent = "Could not undo that image drop.";
    });
}

/** @param {any} record @param {any} data */
function dropImageOn(record, data) {
  const item = itemById(record.itemId);
  const selector = String(data.selector || "");
  const file = data.file;
  if (!item || !selector || state.ended) return;
  if (!(file instanceof File) || !IMAGE_TYPES.has(file.type)) {
    dockStatus.textContent = "Only PNG, JPEG and WebP images can replace one.";
    return;
  }
  const kind = data.kind === "background" ? "background" : "img";
  uploadImage(file)
    .then(({ id }) =>
      fetch(`/api/boards/${encodeURIComponent(key)}/image-drop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          item: item.id,
          selector,
          kind,
          oldSource: String(data.oldSource || ""),
          attachment: id,
        }),
      }).then((response) => (response.ok ? response.json() : Promise.reject(new Error("not accepted")))),
    )
    .then((payload) => {
      const live = itemById(item.id);
      const drop = payload?.drop;
      if (!live || !drop) return;
      live.imageDrops = payload.imageDrops || live.imageDrops || [];
      postAllImageDrops(live.id);
      showDropToast(live, drop);
      sendItemNote(live, imageDropPrompt(live, drop), drop.selector);
    })
    .catch(() => {
      dockStatus.textContent = "That image could not replace the one on the design.";
    });
}

// A file dropped anywhere else on the board must never navigate the page away.
/** @param {DragEvent} event */
function refuseStrayFileDrop(event) {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
}
window.addEventListener("dragover", refuseStrayFileDrop);
window.addEventListener("drop", refuseStrayFileDrop);

// HTML files dropped on the board (outside a design) are copied into the board folder and
// appear as new items, so a board can be filled without an agent or the CLI.
/** @param {unknown[]} list */
function addHtmlFiles(list) {
  const files = /** @type {File[]} */ (
    list.filter((file) => file instanceof File && /\.html?$/i.test(file.name))
  ).slice(0, 50);
  if (files.length === 0 || state.ended) return;
  dockStatus.textContent = files.length === 1 ? `Adding ${files[0].name}…` : `Adding ${files.length} designs…`;
  Promise.all(
    files.map((file) =>
      file.text().then((html) =>
        fetch(`/api/boards/${encodeURIComponent(key)}/files`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: file.name, html }),
        }).then((response) => (response.ok ? response.json() : Promise.reject(new Error("not accepted")))),
      ),
    ),
  )
    .then((added) => {
      const names = added.map((entry) => entry?.item?.file).filter(Boolean);
      dockStatus.textContent = names.length === 1 ? `Added ${names[0]}.` : `Added ${names.length} designs.`;
      refreshBoard();
    })
    .catch(() => {
      dockStatus.textContent = "That file could not be added to the board.";
      refreshBoard();
    });
}
window.addEventListener("drop", (event) => addHtmlFiles(Array.from(event.dataTransfer?.files || [])));
window.addEventListener("dragenter", (event) => {
  if (event.dataTransfer?.types.includes("Files")) document.body.dataset.dragging = "true";
});
window.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) delete document.body.dataset.dragging;
});
window.addEventListener("drop", () => {
  delete document.body.dataset.dragging;
});

/* ------------------------------------------------------------------ notes */

/** @type {null | { key: string, x: number, y: number, time: number }} */
let pendingClick = null;
/** @type {Set<string>} */
const sendingPrompts = new Set();
/** @type {Set<string>} note ids whose send is waiting on an upload or picture */
const preparingNotes = new Set();

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
  // A live page notes the URL path it was written on: the frame can navigate.
  if (item.page) note.page = livePageOf(item.id, deviceId);
  const excerpt = String(payload.excerpt || "").slice(0, 120);
  if (excerpt) note.excerpt = excerpt;
  const heading = String(payload.heading || "").slice(0, 120);
  if (heading) note.heading = heading;
  const box = payload.box;
  if (box && ["x", "y", "w", "h"].every((name) => Number.isFinite(Number(box[name])))) {
    note.box = { x: Number(box.x), y: Number(box.y), w: Number(box.w), h: Number(box.h) };
  }
  item.notes = [...(item.notes || []), note];
  postPins(item.id, deviceId);
  showNoteWindow(item, note, { fresh: true });
  requestCrop(item, note);
}

// A picture of the pinned spot goes to the agent with the note. It is taken as soon as
// the pin lands, so it is ready by the time the note is written.
/** @type {Map<string, Promise<void>>} */
const crops = new Map();
const CROP_WAIT_MS = 4000;
const CROP_NAME = /^pin-\d+-crop\.png$/;

function requestCrop(item, note) {
  if (!note.box || crops.has(note.id)) return;
  const done = fetch(`/api/boards/${encodeURIComponent(key)}/crop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      item: item.id,
      device: noteDevice(note),
      box: note.box,
      ...(note.page ? { page: note.page } : {}),
    }),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      const id = String(payload?.attachment?.id || "");
      const live = liveNote(note.id);
      if (!id || !live) return;
      live.note.crop = { id };
      if (!live.note.prompt_id) persistNotes(live.item.id);
    })
    .catch(() => {});
  crops.set(note.id, done);
}

/** Wait a little for pictures still being taken; a slow one never holds a note back. */
function pendingCrops(noteIds) {
  const waiting = noteIds.map((id) => crops.get(id)).filter(Boolean);
  if (waiting.length === 0) return Promise.resolve();
  return Promise.race([Promise.all(waiting), new Promise((resolve) => setTimeout(resolve, CROP_WAIT_MS))]).then(
    () => {},
  );
}

/**
 * Send notes, and an optional free message, to the agent as one batch.
 * @param {string[]} noteIds
 * @param {string} [message]
 * @returns {Promise<boolean>}
 */
/**
 * @param {string[]} noteIds
 * @param {string} [message]
 * @param {Array<{ id: string, name?: string }>} [images]
 * @param {{ thread?: string, item?: any }} [context] the thread a message belongs to
 */
function sendPrompts(noteIds, message = "", images = [], context = {}) {
  if (state.ended) return Promise.resolve(false);
  const fromComposer = images === composerImages;
  const owners = fromComposer ? [...noteIds, "composer"] : noteIds;
  const uploading = owners.some((owner) => (uploads.get(owner)?.size || 0) > 0);
  if (uploading) dockStatus.textContent = "Adding images…";
  // The note shows as sending at once, while its images and picture finish.
  for (const id of noteIds) preparingNotes.add(id);
  renderChatPanel();
  return Promise.all([uploading ? pendingUploads(owners) : null, pendingCrops(noteIds)]).then(() => {
    for (const id of noteIds) preparingNotes.delete(id);
    return sendPromptsNow(noteIds, message, fromComposer ? composerImages : images, context);
  });
}

function sendPromptsNow(noteIds, message, images, context = {}) {
  const sent = [];
  /** @type {any[]} */
  const prompts = [];
  for (const noteId of noteIds) {
    const live = liveNote(noteId);
    if (!live || live.note.prompt_id) continue;
    const text = String(live.note.text || "").trim();
    const attached = Array.isArray(live.note.attachments) ? live.note.attachments : [];
    if (!text && attached.length === 0) continue;
    // The picture of the spot rides along while the prompt has room for it.
    const crop = live.note.crop?.id ? [{ id: live.note.crop.id, name: `pin-${live.note.number}-crop.png` }] : [];
    const withCrop = attached.length < MAX_PROMPT_IMAGES ? [...attached, ...crop] : attached;
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
      // Each note is a conversation thread; replies and edits name it too.
      thread: live.note.id,
      item: itemRef(live.item, live.note),
      pin: {
        id: live.note.id,
        number: live.note.number,
        viewport: deviceById(noteDevice(live.note)).width,
        ...(live.note.excerpt ? { excerpt: live.note.excerpt } : {}),
        ...(live.note.heading ? { heading: live.note.heading } : {}),
      },
      ...(withCrop.length > 0 ? { attachments: withCrop } : {}),
    });
  }
  if (message || images.length > 0) {
    prompts.push({
      uid: randomId(),
      prompt: message,
      tag: "message",
      ...(context.thread ? { thread: context.thread } : {}),
      ...(context.item ? { item: itemRef(context.item) } : {}),
      ...(images.length > 0 ? { attachments: images } : {}),
    });
  }
  if (prompts.length === 0) return Promise.resolve(false);
  for (const entry of sent) postPins(entry.item.id, noteDevice(entry.note));
  showSideView("chat");
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
      dockStatus.textContent = "Could not reach Liesel. Your notes are still here.";
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
  const empty = !String(live.note.text || "").trim() && !(live.note.attachments || []).length;
  if (!live.note.prompt_id && empty && !(uploads.get(noteId)?.size || 0)) {
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
  if (!entry || !entry.delivered_at) return "Sent";
  // Applied means the design itself changed after the agent read the note. A reply on
  // its own is an answer, not a fix, and must not read as one.
  if (entry.done_at) {
    const delivered = Date.parse(String(entry.delivered_at));
    const changed = Number(liveNote(note.id)?.item?.mtime) || 0;
    if (Number.isFinite(delivered) && changed > delivered) return "Applied";
  }
  return "Received";
}

/** What delete does, in the words the reviewer needs before agreeing to it. */
const DELETE_NOTE_CONSEQUENCE =
  "Deleting removes the instruction from the board. It never reverts the change it asked for.";

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
    if (!String(note.text).trim() && !(note.attachments || []).length && !(uploads.get(note.id)?.size || 0)) {
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
    // Deleting asks once, in place: a sent note is also withdrawn from the agent, and
    // it never undoes the change the note asked for.
    const remove = element("button", { class: "button button-quiet", type: "button", text: "Delete note" });
    remove.addEventListener("click", () => {
      const sure = element("button", { class: "button button-danger", type: "button", text: "Delete" });
      sure.addEventListener("click", () => {
        closeNoteWindow();
        deleteNote(note.id);
      });
      const keep = element("button", { class: "button button-quiet", type: "button", text: "Keep it" });
      keep.addEventListener("click", () => showNoteWindow(item, note));
      actions.replaceChildren(
        element("span", { class: "note-ask", text: `Delete note ${note.number}?` }),
        element("span", { class: "note-ask-consequence", text: DELETE_NOTE_CONSEQUENCE }),
        element("span", { class: "spacer" }),
        keep,
        sure,
      );
    });
    actions.append(remove);
  }
  actions.append(element("span", { class: "spacer" }));
  if (sent) {
    // A sent note is changed or added to in its thread, where the agent's answer sits.
    const group = element("div", { class: "note-pop-group" });
    group.append(element("span", { class: "note-state", text: sentState(note) }));
    const more = element("button", { class: "button", type: "button", text: "Add more" });
    more.addEventListener("click", () => {
      closeNoteWindow();
      openThreadComposer(note.id, "reply");
    });
    const edit = element("button", { class: "button", type: "button", text: "Edit note" });
    edit.addEventListener("click", () => {
      closeNoteWindow();
      openThreadComposer(note.id, "edit");
    });
    group.append(more, edit);
    actions.append(group);
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
  const images = element("div", { class: "note-images" });
  const drawImages = () => {
    images.replaceChildren(
      thumbStrip(
        note.attachments || [],
        sent
          ? null
          : (id) => {
              note.attachments = (note.attachments || []).filter((ref) => ref.id !== id);
              persistNotes(item.id);
              drawImages();
            },
      ),
    );
    images.hidden = (note.attachments || []).length === 0;
  };
  drawImages();
  if (!sent) {
    acceptImages(pop, (files) =>
      addImages(note.id, files, (ref) => {
        note.attachments = [...(note.attachments || []), ref];
        persistNotes(item.id);
        drawImages();
      }),
    );
  }
  pop.append(head, textarea, images, actions);
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

function formatTime(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

let laidOutPending = "";

// The panel is a conversation, one thread per note (and per design for Accept / Keep
// today), with everything else in a general thread. A reviewer's entry names its thread;
// an agent reply joins the threads it names (`--thread`) or else those of the notes it
// settled, which carry its own time as `done_at`.
const AGENT_NAME = String(bootstrap.agentName || "Agent");
const readStorageKey = `liesel:read:${key}`;
/** @type {{ id: string, mode: "reply" | "edit", field: HTMLTextAreaElement } | null} */
let threadComposer = null;
let confirmingDelete = "";
/** @type {Map<string, string>} */
const threadTitles = new Map();

function threadOfEntry(entry) {
  if (entry.thread) return String(entry.thread);
  const matched = noteByPromptId(entry.prompt_id);
  return matched ? matched.note.id : "";
}

function threadsOfReply(entry) {
  const named = Array.isArray(entry.threads) ? entry.threads.map(String) : [];
  if (named.length > 0) return named;
  const settled = new Set();
  for (const other of state.chat) {
    if (other && other.role !== "agent" && other.done_at && other.done_at === entry.at)
      settled.add(threadOfEntry(other));
  }
  return settled.size > 0 ? [...settled] : [""];
}

/** What a thread is about: a note, a design, or a note since deleted. */
function threadSubject(id) {
  if (!id) return null;
  const live = liveNote(id);
  if (live) return { kind: "note", item: live.item, note: live.note };
  if (id.startsWith("item:")) {
    const item = itemById(id.slice(5));
    if (item) return { kind: "item", item };
  }
  return { kind: "gone" };
}

/** Versions a reply names, by file name or by the name the board shows. */
function mentionedItems(text) {
  const plain = String(text || "")
    .toLowerCase()
    .replace(/[·\-_]+/g, " ")
    .replace(/\s+/g, " ");
  const found = [];
  for (const item of activeItems()) {
    const names = [fileStem(item), item.id, designName(item, "")].map((name) =>
      String(name || "")
        .toLowerCase()
        .replace(/[·\-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (names.some((name) => name.length >= 4 && plain.includes(name))) found.push(item.id);
  }
  return found;
}

function agentEntries() {
  return state.chat.filter((entry) => entry && entry.role === "agent");
}

function unreadCount() {
  const seen = Number(readStorage(readStorageKey) || 0);
  return Math.max(0, agentEntries().length - seen);
}

function renderUnread() {
  const open = document.getElementById("chatOpen");
  if (!open) return;
  const collapsed = document.getElementById("chat")?.classList.contains("collapsed");
  const hidden = collapsed || sideView !== "chat";
  if (!hidden) writeStorage(readStorageKey, String(agentEntries().length));
  const count = hidden ? unreadCount() : 0;
  open.replaceChildren(document.createTextNode("Notes"));
  if (collapsed && count > 0) open.append(element("span", { class: "unread", text: String(count) }));
  open.setAttribute("aria-label", collapsed && count > 0 ? `Notes, ${count} new` : "Notes");
  const tab = document.getElementById("sideTabChat");
  if (tab) {
    tab.replaceChildren(document.createTextNode("Chat"));
    if (count > 0 && !collapsed) tab.append(element("span", { class: "unread", text: String(count) }));
    tab.setAttribute("aria-label", count > 0 && !collapsed ? `Chat, ${count} new` : "Chat");
  }
}

function renderChatPanel() {
  // A reply that announces or cancels a coming version moves the holders on the board.
  const pending = pendingSignature(state.chat);
  if (pending !== laidOutPending) {
    laidOutPending = pending;
    if (state.layout) scheduleLayout();
  }
  renderUnread();
  const log = document.getElementById("chatLog");
  if (!log) return;
  /** @type {Map<string, { id: string, entries: any[], last: string }>} */
  const threads = new Map();
  const add = (id, entry) => {
    let thread = threads.get(id);
    if (!thread) {
      thread = { id, entries: [], last: "" };
      threads.set(id, thread);
    }
    thread.entries.push(entry);
    thread.last = String(entry.at || thread.last);
  };
  /** @type {Map<any, string>} */
  const previousReply = new Map();
  let lastReplyAt = "";
  for (const entry of state.chat) {
    if (!entry) continue;
    if (entry.role === "agent") {
      previousReply.set(entry, lastReplyAt);
      lastReplyAt = String(entry.at || "");
      for (const id of threadsOfReply(entry)) add(id, entry);
    } else {
      add(threadOfEntry(entry), entry);
    }
  }
  // A note in flight shows before the server has written it into the transcript.
  for (const noteId of preparingNotes) {
    const live = liveNote(noteId);
    if (!live || live.note.prompt_id) continue;
    add(noteId, { role: "user", text: live.note.text, at: new Date().toISOString(), preparing: true });
  }
  for (const promptId of sendingPrompts) {
    if (state.chat.some((entry) => entry && entry.prompt_id === promptId)) continue;
    const matched = noteByPromptId(promptId);
    if (!matched) continue;
    add(matched.note.id, {
      role: "user",
      text: matched.note.text,
      prompt_id: promptId,
      at: new Date().toISOString(),
    });
  }
  const ordered = [...threads.values()].sort((left, right) => left.last.localeCompare(right.last));
  const rows = ordered.map((thread) => renderThread(thread, previousReply));
  if (rows.length === 0) {
    rows.push(element("p", { class: "chat-empty", text: "Tap ⌘ for notes · tap ⌥ to pick an element for Controls" }));
  }
  const focused = threadComposer && document.activeElement === threadComposer.field;
  const selection =
    focused && threadComposer ? [threadComposer.field.selectionStart, threadComposer.field.selectionEnd] : null;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren(...rows);
  if (focused && threadComposer && selection) {
    threadComposer.field.focus({ preventScroll: true });
    threadComposer.field.setSelectionRange(selection[0], selection[1]);
  }
  if (atBottom && !focused) log.scrollTop = log.scrollHeight;
  renderDrafts();
}

function renderThread(thread, previousReply) {
  const section = element("section", { class: "thread", "data-thread": thread.id });
  const subject = threadSubject(thread.id);
  if (subject) section.append(threadHead(thread.id, subject));
  for (const entry of thread.entries) {
    section.append(entry.role === "agent" ? agentBubble(entry, previousReply.get(entry) || "") : userBubble(entry));
  }
  const last = thread.entries.at(-1);
  if (last && last.role !== "agent" && !state.ended) section.append(replyingLine(last));
  if (subject && subject.kind !== "gone" && !state.ended) section.append(threadFoot(thread.id, subject));
  return section;
}

function threadHead(id, subject) {
  const head = element("button", { class: "thread-head", type: "button" });
  if (subject.kind === "note") {
    const crop = subject.note.crop?.id;
    if (crop) head.append(element("img", { class: "thread-thumb", src: attachmentUrl(crop), alt: "" }));
    const number = element("span", { class: "thread-number", text: String(subject.note.number) });
    if (awaitingReply(subject.note)) number.classList.add("is-working");
    head.append(number);
    const title = designName(subject.item, noteDevice(subject.note));
    threadTitles.set(id, `${subject.note.number} · ${title}`);
    head.append(element("span", { class: "thread-title", text: title }));
    // Where this note stands, in the same words the note's popover uses.
    if (subject.note.prompt_id) {
      head.append(element("span", { class: "thread-state", text: sentState(subject.note) }));
    }
    head.addEventListener("click", () => focusPin(subject.item, subject.note));
  } else if (subject.kind === "item") {
    const title = designName(subject.item, "");
    threadTitles.set(id, title);
    head.append(element("span", { class: "thread-title", text: title }));
    head.addEventListener("click", () => focusItem(subject.item.id));
  } else {
    head.disabled = true;
    head.append(element("span", { class: "thread-title", text: `${threadTitles.get(id) || "A note"} (deleted)` }));
  }
  return head;
}

const FOLLOWUP_LABELS = { edit: "Edited the note", deleted: "Deleted the note" };

function userBubble(entry) {
  const bubble = element("div", { class: "bubble bubble-user", title: formatTime(entry.at) });
  const matched = noteByPromptId(entry.prompt_id);
  if (matched && !entry.followup) bubble.dataset.note = matched.note.id;
  const label = FOLLOWUP_LABELS[entry.followup];
  if (label) bubble.append(element("span", { class: "bubble-label", text: label }));
  if (entry.text && entry.followup !== "deleted") {
    bubble.append(element("div", { class: "entry-text", text: String(entry.text) }));
  }
  const added = Array.isArray(entry.attachments)
    ? entry.attachments.filter((ref) => !CROP_NAME.test(String(ref?.name || "")))
    : [];
  if (added.length > 0) {
    const strip = thumbStrip(added, null);
    strip.classList.add("entry-thumbs");
    bubble.append(strip);
  }
  if (entry.preparing || (entry.prompt_id && sendingPrompts.has(entry.prompt_id))) {
    bubble.append(element("div", { class: "entry-state", text: "Sending" }));
  }
  return bubble;
}

function agentBubble(entry, previousAt) {
  const bubble = element("div", { class: "bubble bubble-agent", title: formatTime(entry.at) });
  const text = element("div", { class: "entry-text" });
  // Agent replies arrive as server-rendered markdown; user text is always escaped.
  if (entry.html) text.innerHTML = String(entry.html);
  else text.textContent = String(entry.text || "");
  bubble.append(text);
  const links = [...new Set([...replyLinks(entry, previousAt), ...mentionedItems(entry.text)])];
  if (links.length > 0) {
    const list = element("div", { class: "entry-links" });
    for (const itemId of links) {
      const item = itemById(itemId);
      if (!item) continue;
      const link = element("button", { class: "entry-link", type: "button", text: `${designName(item, "")} ↗` });
      link.addEventListener("click", () => focusItem(itemId));
      list.append(link);
    }
    bubble.append(list);
  }
  return bubble;
}

function replyingLine(entry) {
  const heard =
    Boolean(entry.delivered_at) || presence.dataset.state === "listening" || presence.dataset.state === "working";
  const line = element("div", { class: "replying", "data-active": String(heard) });
  line.append(
    document.createTextNode(heard ? `${AGENT_NAME} is replying` : `Sent. ${AGENT_NAME} will see it when back`),
  );
  if (heard) line.append(element("span", { class: "replying-dots", "aria-hidden": "true" }));
  return line;
}

function threadFoot(id, subject) {
  if (threadComposer?.id === id) return threadEditor(id, subject);
  const foot = element("div", { class: "thread-foot" });
  const note = subject.kind === "note" ? subject.note : null;
  if (note && confirmingDelete === id) {
    const sure = element("button", { class: "thread-action danger", type: "button", text: "Delete" });
    sure.addEventListener("click", () => deleteNote(note.id));
    const keep = element("button", { class: "thread-action", type: "button", text: "Keep it" });
    keep.addEventListener("click", () => {
      confirmingDelete = "";
      renderChatPanel();
    });
    foot.append(
      element("span", { class: "thread-ask", text: `Delete note ${note.number}?` }),
      element("span", { class: "note-ask-consequence", text: DELETE_NOTE_CONSEQUENCE }),
      sure,
      keep,
    );
    return foot;
  }
  const action = (text, run) => {
    const button = element("button", { class: "thread-action", type: "button", text });
    button.addEventListener("click", run);
    foot.append(button);
  };
  action("Reply", () => openThreadComposer(id, "reply"));
  if (note && note.prompt_id) {
    action("Edit note", () => openThreadComposer(id, "edit"));
    action("Delete note", () => {
      confirmingDelete = id;
      renderChatPanel();
    });
  }
  return foot;
}

function openThreadComposer(id, mode) {
  const subject = threadSubject(id);
  if (!subject || subject.kind === "gone") return;
  confirmingDelete = "";
  const field = /** @type {HTMLTextAreaElement} */ (
    element("textarea", {
      class: "thread-input",
      rows: "2",
      placeholder: mode === "edit" ? "Correct the note" : "Reply, or add to the note",
    })
  );
  if (mode === "edit" && subject.kind === "note") field.value = String(subject.note.text || "");
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeThreadComposer();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitThreadComposer();
    }
  });
  threadComposer = { id, mode, field };
  setChatCollapsed(false);
  renderChatPanel();
  const thread = document.getElementById("chatLog")?.querySelector(`[data-thread="${CSS.escape(id)}"]`);
  thread?.scrollIntoView({ block: "nearest" });
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
}

function closeThreadComposer() {
  threadComposer = null;
  renderChatPanel();
}

function threadEditor(id, subject) {
  const box = element("div", { class: "thread-editor" });
  if (!threadComposer) return box;
  const { mode, field } = threadComposer;
  const cancel = element("button", { class: "thread-action", type: "button", text: "Cancel" });
  cancel.addEventListener("click", closeThreadComposer);
  const send = element("button", {
    class: "button button-primary button-small",
    type: "button",
    text: mode === "edit" ? "Save edit" : "Send",
  });
  send.addEventListener("click", submitThreadComposer);
  const row = element("div", { class: "thread-editor-actions" });
  row.append(cancel, send);
  if (mode === "edit" && subject.kind === "note") {
    box.append(element("span", { class: "bubble-label", text: `Editing note ${subject.note.number}` }));
  }
  box.append(field, row);
  return box;
}

function submitThreadComposer() {
  if (!threadComposer || state.ended) return;
  const { id, mode, field } = threadComposer;
  const text = field.value.trim();
  if (!text) {
    field.focus();
    return;
  }
  const subject = threadSubject(id);
  if (mode === "edit" && subject?.kind === "note") {
    if (text === String(subject.note.text || "").trim()) {
      closeThreadComposer();
      return;
    }
    subject.note.text = text;
    persistNotes(subject.item.id, { immediate: true });
  }
  threadComposer = null;
  sendFollowup(id, mode, text);
}

/** Delete a note; one the agent already has is withdrawn in its thread. */
function deleteNote(noteId) {
  const live = liveNote(noteId);
  confirmingDelete = "";
  if (threadComposer?.id === noteId) threadComposer = null;
  if (!live) return;
  if (live.note.prompt_id) {
    sendFollowup(noteId, "deleted", `Note ${live.note.number} is withdrawn: please ignore it.`);
  }
  removeNote(noteId);
}

/**
 * A reviewer's words in a thread: a reply, an edit of the note, or its withdrawal. It
 * reaches poll as a prompt carrying the thread id, and the note it follows up.
 */
function sendFollowup(threadId, followup, text) {
  const subject = threadSubject(threadId);
  /** @type {any} */
  const prompt = { uid: randomId(), prompt_id: randomId(), prompt: text, tag: "message", thread: threadId, followup };
  if (subject && subject.kind !== "gone") {
    prompt.item = itemRef(subject.item, subject.kind === "note" ? subject.note : null);
  }
  if (subject?.kind === "note") {
    const note = subject.note;
    prompt.tag = "pin";
    prompt.selector = note.selector;
    prompt.text = note.label;
    prompt.pin = {
      id: note.id,
      number: note.number,
      viewport: deviceById(noteDevice(note)).width,
      ...(note.excerpt ? { excerpt: note.excerpt } : {}),
      ...(note.heading ? { heading: note.heading } : {}),
    };
  }
  showSideView("chat");
  renderChatPanel();
  return fetch(`/api/${encodeURIComponent(key)}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts: [prompt], domSnapshot: "" }),
  })
    .then((response) => {
      if (!response.ok) throw new Error("not accepted");
      dockStatus.textContent = "";
      refreshBoard();
      return true;
    })
    .catch(() => {
      dockStatus.textContent = "Could not reach Liesel. Try again.";
      return false;
    });
}

function draftsToSend() {
  return boardNotes().filter(
    ({ note }) => !note.prompt_id && (String(note.text || "").trim() || (note.attachments || []).length > 0),
  );
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
      acceptImages(input, (files) =>
        addImages(note.id, files, (ref) => {
          note.attachments = [...(note.attachments || []), ref];
          persistNotes(item.id);
          renderDrafts();
        }),
      );
      draft.append(name, input);
      if ((note.attachments || []).length > 0) {
        draft.append(
          thumbStrip(note.attachments, (id) => {
            note.attachments = (note.attachments || []).filter((ref) => ref.id !== id);
            persistNotes(item.id);
            renderDrafts();
          }),
        );
      }
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
  const count = draftsToSend().length + (composerInput.value.trim() || composerImages.length > 0 ? 1 : 0);
  sendButton.textContent = count > 1 ? `Send ${count}` : "Send";
  sendButton.disabled = state.ended || count === 0;
}

function sendAll() {
  const message = composerInput.value.trim();
  const ids = draftsToSend().map(({ note }) => note.id);
  if (!message && ids.length === 0 && composerImages.length === 0 && !(uploads.get("composer")?.size || 0)) return;
  sendButton.disabled = true;
  sendPrompts(ids, message, composerImages).then((ok) => {
    if (ok) {
      composerInput.value = "";
      composerImages = [];
      renderComposerImages();
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

/** @type {"chat" | "controls"} */
let sideView = "chat";
/* Edit's tag over the edited element: see syncEditTag. */
const EDIT_OUTLINE_HOLD_MS = 1500;
/** What the tag shows, for the element it was set for. */
const editTag = { for: "", selector: "", property: "", hover: false, flash: false };
/** @type {null | { itemId: string, deviceId: string }} the frame that shows the tag */
let editTagFrame = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let editFlashTimer;

/**
 * The sidebar shows one of its tabs: Chat or Controls. Showing one opens a closed
 * sidebar, so a controls-selector click or a send is never answered out of sight.
 * @param {"chat" | "controls"} view
 * @param {boolean} [reveal] false picks the tab and leaves a closed sidebar closed
 */
function showSideView(view, reveal = true) {
  const chat = document.getElementById("chat");
  sideView = view === "controls" ? view : "chat";
  syncEditTag();
  if (chat) chat.dataset.view = sideView;
  const panes = {
    chat: document.getElementById("chatPane"),
    controls: document.getElementById("tune"),
  };
  const tabs = {
    chat: document.getElementById("sideTabChat"),
    controls: document.getElementById("sideTabControls"),
  };
  for (const name of /** @type {const} */ (["chat", "controls"])) {
    const on = name === sideView;
    if (panes[name]) panes[name].hidden = !on;
    if (tabs[name]) {
      tabs[name].setAttribute("aria-selected", String(on));
      tabs[name].tabIndex = on ? 0 : -1;
    }
  }
  if (reveal && chat?.classList.contains("collapsed")) {
    setChatCollapsed(false);
    if (!userAdjustedCamera) fit(false);
  }
  renderUnread();
}

function toggleSideView() {
  showSideView(sideView === "chat" ? "controls" : "chat");
}

/* ---------------------------------------------------------------- settings */

// Settings opens from the gear in the top bar as a full page over the board: the format
// and old-notes switches, the project's dev server and the agent picker, all saved as they change. Its address is the board's with
// #settings, so a reload keeps it open and the browser's Back returns to the board. It closes
// on Escape, Back to board, or the gear.
const settingsPanel = document.getElementById("settings");
const settingsToggle = document.getElementById("settingsToggle");
const SETTINGS_HASH = "#settings";
/** Did opening Settings add a history entry, so closing it should step back over it? */
let settingsPushed = false;

function settingsOpen() {
  return Boolean(settingsPanel && !settingsPanel.hidden);
}

/** @param {boolean} open */
function setSettingsOpen(open) {
  if (!settingsPanel || open === settingsOpen()) return;
  settingsPanel.hidden = !open;
  settingsToggle?.setAttribute("aria-expanded", String(open));
  if (open) {
    if (location.hash !== SETTINGS_HASH) {
      window.history.pushState(window.history.state, "", SETTINGS_HASH);
      settingsPushed = true;
    }
    settingsPanel.scrollTop = 0;
    renderFormatSwitches();
    loadRunner();
    loadProject();
    document.getElementById("settingsClose")?.focus({ preventScroll: true });
  } else {
    if (location.hash === SETTINGS_HASH) {
      if (settingsPushed) window.history.back();
      else window.history.replaceState(window.history.state, "", location.pathname + location.search);
    }
    settingsPushed = false;
    settingsToggle?.focus({ preventScroll: true });
  }
}

// Settings save as they change; a quiet "Saved" in the top bar says each one landed.
let settingsSavedTimer = 0;
function flashSettingsSaved(text = "Saved") {
  const status = document.getElementById("settingsSaved");
  if (!status) return;
  status.textContent = text;
  status.dataset.shown = "true";
  window.clearTimeout(settingsSavedTimer);
  settingsSavedTimer = window.setTimeout(() => {
    status.dataset.shown = "false";
  }, 1800);
}

window.addEventListener("popstate", () => {
  const wanted = location.hash === SETTINGS_HASH;
  if (wanted === settingsOpen()) return;
  settingsPushed = false;
  setSettingsOpen(wanted);
});

/* ---------------------------------------------------------------- agent runner */

// The agent settings: which agent CLI answers this board's notes (src/board-runner.js), and the
// state and output of its latest run. The form is filled once per load, never from a live
// event, so a half-typed command is not overwritten by a run that finishes meanwhile.
const runnerState = {
  /** @type {any} */
  view: null,
  formFilled: false,
  /** Whether the output was scrolled to its end before the latest chunk arrived. */
  pinnedToEnd: true,
};

function runnerElements() {
  return {
    select: /** @type {HTMLSelectElement | null} */ (document.getElementById("agentSelect")),
    command: /** @type {HTMLInputElement | null} */ (document.getElementById("agentCommand")),
    commandField: document.getElementById("agentCommandField"),
    cwd: /** @type {HTMLInputElement | null} */ (document.getElementById("agentCwd")),
    cwdField: document.getElementById("agentCwdField"),
    saveStatus: document.getElementById("agentSaveStatus"),
    run: document.getElementById("agentRun"),
    runState: document.getElementById("agentRunState"),
    runError: document.getElementById("agentRunError"),
    output: document.getElementById("agentOutput"),
    stop: /** @type {HTMLButtonElement | null} */ (document.getElementById("agentStop")),
    retry: /** @type {HTMLButtonElement | null} */ (document.getElementById("agentRetry")),
    line: document.getElementById("runnerLine"),
    dot: document.getElementById("settingsDot"),
  };
}

function loadRunner() {
  return fetch(`/api/boards/${encodeURIComponent(key)}/runner`)
    .then((response) => (response.ok ? response.json() : null))
    .then((view) => {
      if (!view) return;
      runnerState.view = view;
      if (!runnerState.formFilled) fillRunnerForm();
      renderRunner();
    })
    .catch(() => {});
}

function fillRunnerForm() {
  const view = runnerState.view;
  const els = runnerElements();
  if (!view || !els.select || !els.cwd || !els.command) return;
  runnerState.formFilled = true;
  const options = [{ id: "off", label: "Off: an agent polls this board itself" }, ...(view.agents || [])];
  els.select.replaceChildren(...options.map((agent) => element("option", { value: agent.id, text: agent.label })));
  els.select.value = view.config?.agent || "off";
  els.command.value = view.config?.command || "";
  els.cwd.value = view.config?.cwd || view.default_cwd || "";
  syncRunnerFields();
}

function syncRunnerFields() {
  const els = runnerElements();
  if (!els.select) return;
  const agent = els.select.value;
  if (els.commandField) els.commandField.hidden = agent !== "custom";
  if (els.cwdField) els.cwdField.hidden = agent === "off";
}

function runnerNoteCount(count) {
  return `${count} note${count === 1 ? "" : "s"}`;
}

function renderRunner() {
  const view = runnerState.view;
  const els = runnerElements();
  const run = view?.run || null;
  const waiting = Number(view?.pending_prompts) || 0;
  const configured = Boolean(view?.config);
  if (els.run) els.run.hidden = !run && !(configured && waiting > 0);
  if (els.runState) {
    els.runState.dataset.state = run?.status || "idle";
    els.runState.textContent = !run
      ? `${runnerNoteCount(waiting)} waiting`
      : run.status === "running"
        ? `${run.label} is working on ${runnerNoteCount(run.notes)}${run.queued ? ", more waiting" : ""}`
        : run.status === "finished"
          ? `${run.label} finished at ${formatTime(run.ended_at)}`
          : `${run.label} failed at ${formatTime(run.ended_at)}`;
  }
  if (els.runError) {
    els.runError.hidden = run?.status !== "failed";
    els.runError.textContent =
      run?.status === "failed"
        ? `${run.error}.${waiting > 0 ? ` ${runnerNoteCount(waiting)} still waiting.` : ""}`
        : "";
  }
  if (els.stop) els.stop.hidden = run?.status !== "running";
  if (els.retry) {
    els.retry.hidden = !configured || run?.status === "running" || waiting === 0;
    els.retry.textContent = run?.status === "failed" ? "Run again" : `Run ${runnerNoteCount(waiting)}`;
  }
  if (els.output) {
    const text = run?.output || "";
    if (els.output.textContent !== text) {
      els.output.textContent = text;
      if (runnerState.pinnedToEnd) els.output.scrollTop = els.output.scrollHeight;
    }
    els.output.hidden = !text;
  }
  if (els.dot) {
    els.dot.hidden = run?.status !== "running" && run?.status !== "failed";
    els.dot.dataset.state = run?.status || "";
  }
  if (els.line) {
    const show = run?.status === "running" || run?.status === "failed";
    els.line.hidden = !show;
    els.line.dataset.state = run?.status || "";
    els.line.replaceChildren(
      ...(!show
        ? []
        : [
            element("span", {
              class: "runner-line-text",
              text:
                run.status === "running"
                  ? `${run.label} is working on ${runnerNoteCount(run.notes)}`
                  : `${run.label} failed: ${run.error}`,
            }),
            element("span", { class: "runner-line-link", text: "Output" }),
          ]),
    );
  }
}

/** Saves the agent choice as it changes; a custom agent waits until it has a command. */
function saveRunner(event) {
  event?.preventDefault();
  const els = runnerElements();
  if (!els.select) return;
  const agent = els.select.value;
  if (agent === "custom" && !els.command?.value.trim()) {
    if (els.saveStatus) els.saveStatus.textContent = "";
    return;
  }
  fetch(`/api/boards/${encodeURIComponent(key)}/runner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, command: els.command?.value || "", cwd: els.cwd?.value || "" }),
  })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || "Could not save");
      runnerState.view = body;
      if (els.cwd && body.config?.cwd) els.cwd.value = body.config.cwd;
      if (els.saveStatus) els.saveStatus.textContent = "";
      flashSettingsSaved(
        body.config
          ? `Saved. Notes go to ${els.select?.selectedOptions[0]?.textContent || "the agent"}`
          : "Saved. Notes wait for an agent that polls",
      );
      renderRunner();
    })
    .catch((error) => {
      if (els.saveStatus) els.saveStatus.textContent = error instanceof Error ? error.message : String(error);
    });
}

function runnerAction(action) {
  fetch(`/api/boards/${encodeURIComponent(key)}/runner/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => {});
}

/** @param {any} data */
function onRunnerEvent(data) {
  if (!runnerState.view) runnerState.view = { agents: [], config: null, run: null, pending_prompts: 0 };
  runnerState.view.run = data?.run || null;
  if (typeof data?.pending_prompts === "number") runnerState.view.pending_prompts = data.pending_prompts;
  renderRunner();
}

function setChatCollapsed(collapsed) {
  const chat = document.getElementById("chat");
  const open = document.getElementById("chatOpen");
  if (!chat) return;
  chat.classList.toggle("collapsed", collapsed);
  document.body.dataset.panel = collapsed ? "closed" : "open";
  if (open) open.hidden = !collapsed;
  writeStorage(panelStorageKey, collapsed ? "closed" : "open");
  renderUnread();
}

/* ------------------------------------------------------------------ tune */

let tuneItemId = "";
let tuneDeviceId = "";
/**
 * What a controls-selector click last landed on: its selectors, its own controls and their live values.
 * Inherited groups are the elements it sits in that set something it inherits, nearest first.
 * @typedef {{ selector: string, label: string, controls: any[], values: Record<string, string> }} InheritedGroup
 * @type {null | { itemId: string, deviceId: string, selector?: string, sectionSelector?: string, label?: string, sectionLabel?: string, parentSelector?: string, parentLabel?: string, controls?: any[], values?: Record<string, string>, inherited?: InheritedGroup[], crumbs?: { selector: string, label: string }[], like?: null | { selector: string, count: number }, scope?: "one" | "all", sizes?: "all" | "one", error?: string, pending?: boolean }}
 */
let tuneTarget = null;
/**
 * The breadcrumb of the element a selector click picked, kept while Up, Down or a
 * crumb moves the selection along it, so Down can walk back to that element.
 * @type {{ selector: string, label: string }[]}
 */
let tuneOrigin = [];
/** Inherited groups the reviewer opened, by selector; every group starts collapsed. */
const tuneOpenGroups = new Set();
/** How many steps above the element under the pointer the controls selector picks. */
let tuneDepth = 0;
/** @type {null | { x: number, y: number }} */
let tuneDepthAt = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let tuneSaveTimer;
let tuneCleanup = [];

function tuneCss(item, spec, values = item.tune) {
  /** @type {Record<string, string>} */
  const css = {};
  for (const control of spec) {
    const raw = values?.[control.id];
    if (raw === undefined || raw === "") continue;
    css[control.css] =
      (control.type === "number" || control.type === "timeline") && control.unit
        ? `${raw}${control.unit}`
        : String(raw);
  }
  return css;
}

function tuneSpecFor(itemId) {
  const item = itemById(itemId);
  if (item && Array.isArray(item.tuneSpec) && item.tuneSpec.length > 0) return item.tuneSpec;
  return state.autoSpecs.get(itemId) || [];
}

// Tune undo: one step per finished change, so a slider drag is one step however
// many values it passed through. A change opens with the values before it and
// closes when the pointer lets go, the control commits, or input goes quiet.
let tuneUndo = [];
let tuneRedo = [];
/** @type {null | { itemId: string, before: Record<string, any>, element?: { deviceId: string, selector: string, css: string[], before: Record<string, string> } }} */
let tuneEdit = null;
let tuneEditTimer;
let tuneEditHeld = false;

function beginTuneEdit(item) {
  if (!tuneEdit || tuneEdit.itemId !== item.id) {
    endTuneEdit();
    tuneEdit = { itemId: item.id, before: { ...item.tune } };
  }
  clearTimeout(tuneEditTimer);
  tuneEditTimer = setTimeout(endTuneEdit, 800);
}

/**
 * An element change opens like a design one, but remembers one selector's properties
 * (one, or every side an "all sides" slider writes): their saved overrides before, so
 * undo can put them back (or take the overrides off) as one step.
 * @param {string} itemId @param {string} deviceId @param {string} selector @param {string[]} css
 */
function beginElementEdit(itemId, deviceId, selector, css) {
  const same =
    tuneEdit &&
    tuneEdit.element &&
    tuneEdit.itemId === itemId &&
    tuneEdit.element.selector === selector &&
    tuneEdit.element.css.join("\n") === css.join("\n");
  if (!same) {
    endTuneEdit();
    /** @type {Record<string, string>} */
    const before = {};
    for (const property of css) before[property] = savedElementValue(itemId, selector, property);
    tuneEdit = { itemId, before: {}, element: { deviceId, selector, css, before } };
  }
  clearTimeout(tuneEditTimer);
  tuneEditTimer = setTimeout(endTuneEdit, 800);
}

/** @param {string} itemId @param {string} selector @param {string} css */
function savedElementValue(itemId, selector, css) {
  return String(itemById(itemId)?.elementTune?.[selector]?.[css] ?? "");
}

function endTuneEdit() {
  // An open option list is one change, however long the reviewer browses it.
  if (tuneEditHeld) return;
  clearTimeout(tuneEditTimer);
  const edit = tuneEdit;
  tuneEdit = null;
  const item = edit && itemById(edit.itemId);
  if (!edit || !item) return;
  if (edit.element) {
    const { deviceId, selector, css, before } = edit.element;
    const changes = css
      .map((property) => ({
        selector,
        css: property,
        before: before[property] ?? "",
        after: savedElementValue(edit.itemId, selector, property),
      }))
      .filter((change) => change.after !== change.before);
    if (changes.length === 0) return;
    tuneUndo.push({ itemId: edit.itemId, deviceId, changes });
    tuneRedo = [];
    return;
  }
  if (JSON.stringify(edit.before) === JSON.stringify(item.tune)) return;
  tuneUndo.push({ itemId: edit.itemId, before: edit.before, after: { ...item.tune } });
  tuneRedo = [];
}

/** Undo (-1) or redo (1) one tune change, live in the frames and saved. */
function stepTune(direction) {
  endTuneEdit();
  const step = (direction < 0 ? tuneUndo : tuneRedo).pop();
  if (!step) return;
  (direction < 0 ? tuneRedo : tuneUndo).push(step);
  const item = itemById(step.itemId);
  if (!item) return;
  if (step.changes) {
    applyElementChanges(step.itemId, step.deviceId, step.changes, direction < 0 ? "before" : "after");
    return;
  }
  clearTimeout(tuneSaveTimer);
  item.tune = { ...(direction < 0 ? step.before : step.after) };
  postTuneAll(item.id);
  flushTune(item);
  if (tuneItemId === item.id) renderTune();
}

window.addEventListener("pointerup", () => setTimeout(endTuneEdit), true);

function postTune(itemId, deviceId) {
  const item = itemById(itemId);
  const spec = tuneSpecFor(itemId);
  if (!item || spec.length === 0) return;
  postToArtboard(itemId, deviceId, { type: "tune", values: tuneCss(item, spec) });
}

function postTuneAll(itemId) {
  for (const device of DEVICES) postTune(itemId, device.id);
}

/*
 * Element tunes apply at every size by default. One kept for a single size is saved
 * under "@<device> <selector>" and reaches only that device's frame, over the shared one.
 */
/** @param {string} selector @param {string} deviceId */
function sizeKey(selector, deviceId) {
  return `@${deviceId} ${selector}`;
}

/** @param {string} key @returns {{ deviceId: string, selector: string }} */
function parseTuneKey(key) {
  const match = /^@([a-z0-9-]+) (.+)$/.exec(key);
  return match ? { deviceId: match[1], selector: match[2] } : { deviceId: "", selector: key };
}

/** What one device frame shows of an item's element tunes: shared ones, then its own. */
function elementTuneFor(itemId, deviceId) {
  const saved = itemById(itemId)?.elementTune || {};
  /** @type {Record<string, Record<string, string>>} */
  const values = {};
  for (const [key, css] of Object.entries(saved)) {
    if (!parseTuneKey(key).deviceId) values[key] = { ...css };
  }
  for (const [key, css] of Object.entries(saved)) {
    const parsed = parseTuneKey(key);
    if (parsed.deviceId === deviceId) values[parsed.selector] = { ...(values[parsed.selector] || {}), ...css };
  }
  return values;
}

function postElementTune(itemId, deviceId) {
  const values = elementTuneFor(itemId, deviceId);
  if (Object.keys(values).length > 0) postToArtboard(itemId, deviceId, { type: "element-tune", values });
  // A reloaded frame draws the tag again.
  if (editTagFrame?.itemId === itemId && editTagFrame.deviceId === deviceId) syncEditTag();
}

/**
 * Show one selector's property as saved in every device frame of the item at once:
 * a frame with its own value for that size keeps it, the rest take the shared one.
 * @param {string} itemId @param {string} selector @param {string} css
 */
function refreshElementStyle(itemId, selector, css) {
  for (const device of DEVICES) {
    const value = elementTuneFor(itemId, device.id)[selector]?.[css] || "";
    postToArtboard(itemId, device.id, { type: "style", selector, css, value });
  }
}

/** Devices with their own value for a selector's property. @param {string} itemId @param {string} selector @param {string} css */
function sizesWithOwnValue(itemId, selector, css) {
  const saved = itemById(itemId)?.elementTune || {};
  return DEVICES.filter((device) => saved[sizeKey(selector, device.id)]?.[css]);
}

/** A width range for one device, as the media query an agent would write for it. @param {string} deviceId */
function sizeMedia(deviceId) {
  const sorted = [...DEVICES].sort((a, b) => a.width - b.width);
  const index = sorted.findIndex((device) => device.id === deviceId);
  if (index < 0) return "";
  const low = index > 0 ? sorted[index - 1].width + 1 : 0;
  const high = index < sorted.length - 1 ? sorted[index].width : 0;
  const parts = [];
  if (low) parts.push(`(min-width: ${low}px)`);
  if (high) parts.push(`(max-width: ${high}px)`);
  return `@media ${parts.join(" and ")}`;
}

function openTune(itemId, deviceId) {
  const item = itemById(itemId);
  if (!item) return;
  item.tune = item.tune || {};
  tuneTarget = null;
  tuneItemId = itemId;
  tuneDeviceId = deviceId;
  for (const control of tuneSpecFor(itemId)) {
    if (item.tune[control.id] === undefined || item.tune[control.id] === "")
      item.tune[control.id] = control.value ?? "";
  }
  showTuneLoaded(true);
  showSideView("controls");
  markTuneSent(false);
  renderTune();
  if (tuneSpecFor(itemId).length === 0) postToArtboard(itemId, deviceId, { type: "tune-spec" });
}

function closeTune() {
  endTuneEdit();
  for (const cleanup of tuneCleanup) cleanup();
  tuneCleanup = [];
  // Closing the panel keeps what was tuned on the item and drops the preview-only
  // changes: the frame returns to the file plus its saved element tunes.
  if (tuneTarget) {
    outlineInFrame("");
    outlineGroupInFrame("");
    postToArtboard(tuneTarget.itemId, tuneTarget.deviceId, { type: "style-reset" });
    postElementTune(tuneTarget.itemId, tuneTarget.deviceId);
  }
  showTuneLoaded(false);
  tuneItemId = "";
  tuneTarget = null;
  syncEditTag();
}

/** Controls shows what is being tuned, or how to start when nothing is. */
function showTuneLoaded(loaded) {
  const idle = document.getElementById("tuneIdle");
  const panel = document.getElementById("tuneLoaded");
  if (idle) idle.hidden = loaded;
  if (panel) panel.hidden = !loaded;
}

/**
 * Ask the clicked frame what sits under the point, then show only that element's
 * properties. The panel reads back a moment later, in onArtboardMessage.
 */
function openTargetTune(record, point) {
  tuneTarget = { itemId: record.itemId, deviceId: record.device.id, pending: true };
  tuneOrigin = [];
  tuneItemId = record.itemId;
  tuneDeviceId = record.device.id;
  showTuneLoaded(true);
  showSideView("controls");
  markTuneSent(false);
  renderTune();
  postToArtboard(record.itemId, record.device.id, {
    type: "tune-target",
    x: point.x,
    y: point.y,
    depth: tuneDepth,
  });
}

/** Tune another element of the same design: a breadcrumb, or a step up or down. @param {string} selector */
function selectTuneElement(selector) {
  if (!tuneTarget || tuneTarget.pending || !selector || selector === tuneTarget.selector) return;
  const { itemId, deviceId } = tuneTarget;
  endTuneEdit();
  outlineInFrame("");
  tuneTarget = { itemId, deviceId, pending: true };
  renderTune();
  postToArtboard(itemId, deviceId, { type: "tune-element", selector });
}

/*
 * Move: a drag over a design moves the element under the pointer by a CSS translate,
 * saved and undone like any other element change, so the file itself stays as it was
 * and History keeps the original. When the drag ends, the moved element loads into
 * Controls, where Send hands the move to the agent as a tune note.
 */
/** @typedef {{ left: number, top: number, right: number, bottom: number }} MoveBox */
/** @type {null | { record: any, pointerId: number, x: number, y: number, scale: number, dx: number, dy: number, moved: boolean, picked: boolean, released: boolean, selector: string, base: string[], box: MoveBox | null, targets: MoveBox[], scroll: { x: number, y: number }, pointer: { x: number, y: number }, free: boolean }} */
let moveDrag = null;

/** How close, in screen px at any zoom, an edge or centre must come before it snaps. */
const MOVE_SNAP_PX = 6;
/** The grid a move falls back to, in the design's own CSS px. */
const MOVE_GRID = 8;

/** @param {any} record @param {PointerEvent} event */
function startMove(record, event) {
  const rect = record.iframe.getBoundingClientRect();
  moveDrag = {
    record,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    scale: rect.width / record.device.width || state.camera.zoom,
    dx: 0,
    dy: 0,
    moved: false,
    picked: false,
    released: false,
    selector: "",
    base: [],
    box: null,
    targets: [],
    scroll: { x: 0, y: 0 },
    pointer: { x: event.clientX, y: event.clientY },
    free: event.altKey,
  };
  postToArtboard(record.itemId, record.device.id, {
    type: "move-pick",
    ...pointInFrame(record, event.clientX, event.clientY),
  });
}

/** The frame says what the press grabbed and where it already sits. @param {any} record @param {any} data */
function onMovePicked(record, data) {
  const drag = moveDrag;
  if (!drag || drag.picked || drag.record !== record) return;
  drag.picked = true;
  drag.selector = String(data.selector || "");
  drag.base = splitCssList(String(data.translate || ""));
  drag.box = moveBox(data.box);
  drag.targets = Array.isArray(data.targets) ? data.targets.map(moveBox).filter((box) => box !== null) : [];
  drag.scroll = { x: Number(data.scroll?.x) || 0, y: Number(data.scroll?.y) || 0 };
  if (!drag.selector) {
    moveDrag = null;
    return;
  }
  if (!drag.moved) return;
  snapMove(drag);
  if (drag.released) finishMove(drag);
  else previewMove(drag);
}

/** @param {any} value @returns {MoveBox | null} */
function moveBox(value) {
  const box = {
    left: Number(value?.left),
    top: Number(value?.top),
    right: Number(value?.right),
    bottom: Number(value?.bottom),
  };
  return Object.values(box).every(Number.isFinite) ? box : null;
}

/**
 * @param {number} clientX @param {number} clientY
 * @param {boolean} free Option held: the drag follows the pointer with no snapping
 */
function dragMove(clientX, clientY, free) {
  const drag = moveDrag;
  if (!drag || drag.released) return;
  drag.pointer = { x: clientX, y: clientY };
  drag.free = free;
  if (!drag.moved && Math.hypot(clientX - drag.x, clientY - drag.y) < 3) return;
  drag.moved = true;
  if (!drag.picked) return;
  snapMove(drag);
  previewMove(drag);
}

/** Option pressed or let go mid-drag snaps or frees the element where it is. @param {boolean} free */
function setMoveFree(free) {
  const drag = moveDrag;
  if (!drag || drag.free === free) return;
  dragMove(drag.pointer.x, drag.pointer.y, free);
}

/**
 * Where the drag puts the element: under the pointer, pulled onto a nearby edge or
 * centre (or else the grid) when one is within a few screen px, unless Option is held.
 * @param {NonNullable<typeof moveDrag>} drag
 */
function snapMove(drag) {
  const rawX = (drag.pointer.x - drag.x) / drag.scale;
  const rawY = (drag.pointer.y - drag.y) / drag.scale;
  const snapped =
    drag.free || !drag.box
      ? null
      : moveSnap(drag.box, drag.targets, drag.scroll, rawX, rawY, MOVE_SNAP_PX / drag.scale);
  drag.dx = snapped ? snapped.dx : rawX;
  drag.dy = snapped ? snapped.dy : rawY;
  drawMoveGuides(drag, snapped ? snapped.guides : []);
}

/**
 * Figma-style snapping on each axis: the moved box's start, centre and end against every
 * target's, the nearest within `reach` winning; with none near, its start lands on the grid.
 * @param {MoveBox} box where the element sat when grabbed, in frame px
 * @param {MoveBox[]} targets
 * @param {{ x: number, y: number }} scroll the frame's scroll, so the grid is the page's
 * @param {number} rawX @param {number} rawY the pointer's drag, in frame px
 * @param {number} reach
 */
function moveSnap(box, targets, scroll, rawX, rawY, reach) {
  /** @type {{ axis: "x" | "y", at: number, from: number, to: number }[]} */
  const guides = [];
  /** @param {"x" | "y"} axis @param {number} raw */
  const axis = (axis, raw) => {
    const [start, end] = axis === "x" ? [box.left, box.right] : [box.top, box.bottom];
    const lines = [start, (start + end) / 2, end];
    let best = { gap: reach + 1e-6, shift: 0, at: 0, hits: /** @type {MoveBox[]} */ ([]) };
    for (const target of targets) {
      const [from, to] = axis === "x" ? [target.left, target.right] : [target.top, target.bottom];
      for (const line of [from, (from + to) / 2, to]) {
        for (const own of lines) {
          const shift = line - (own + raw);
          const gap = Math.abs(shift);
          if (gap < best.gap - 0.01) best = { gap, shift, at: line, hits: [target] };
          else if (Math.abs(gap - best.gap) <= 0.01 && Math.abs(line - best.at) <= 0.01) best.hits.push(target);
        }
      }
    }
    if (best.hits.length) {
      const moved = raw + best.shift;
      // The guide runs across the moved box and every box it lines up with.
      const span = best.hits;
      const cross = axis === "x" ? [box.top + rawY, box.bottom + rawY] : [box.left + rawX, box.right + rawX];
      const from = Math.min(cross[0], ...span.map((hit) => (axis === "x" ? hit.top : hit.left)));
      const to = Math.max(cross[1], ...span.map((hit) => (axis === "x" ? hit.bottom : hit.right)));
      guides.push({ axis, at: best.at, from, to });
      return moved;
    }
    const offset = axis === "x" ? scroll.x : scroll.y;
    const page = start + raw + offset;
    const onGrid = Math.round(page / MOVE_GRID) * MOVE_GRID;
    return Math.abs(onGrid - page) <= reach ? raw + onGrid - page : raw;
  };
  const dx = axis("x", rawX);
  const dy = axis("y", rawY);
  return { dx, dy, guides };
}

/**
 * Thin lines over the board where the moved element lines up, shown only while it snaps.
 * @param {NonNullable<typeof moveDrag>} drag
 * @param {{ axis: "x" | "y", at: number, from: number, to: number }[]} guides in frame px
 */
function drawMoveGuides(drag, guides) {
  let layer = document.getElementById("moveGuides");
  if (!guides.length) {
    layer?.replaceChildren();
    return;
  }
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "moveGuides";
    layer.className = "move-guides";
    layer.setAttribute("aria-hidden", "true");
    document.body.append(layer);
  }
  const rect = drag.record.iframe.getBoundingClientRect();
  const scale = rect.width / drag.record.device.width || drag.scale;
  layer.replaceChildren(
    ...guides.map((guide) => {
      const line = document.createElement("div");
      line.className = `move-guide move-guide-${guide.axis}`;
      const at = (guide.axis === "x" ? rect.left : rect.top) + guide.at * scale;
      const from = (guide.axis === "x" ? rect.top : rect.left) + guide.from * scale;
      const length = Math.max(0, (guide.to - guide.from) * scale);
      if (guide.axis === "x") Object.assign(line.style, { left: `${at}px`, top: `${from}px`, height: `${length}px` });
      else Object.assign(line.style, { top: `${at}px`, left: `${from}px`, width: `${length}px` });
      return line;
    }),
  );
}

/** @param {boolean} keep a release keeps the move, a cancelled pointer takes it back */
function endMove(keep) {
  const drag = moveDrag;
  if (!drag) return;
  document.getElementById("moveGuides")?.replaceChildren();
  if (!keep || !drag.moved) {
    moveDrag = null;
    if (drag.picked && drag.moved) refreshElementStyle(drag.record.itemId, drag.selector, "translate");
    return;
  }
  drag.released = true;
  // A frame slow to say what was grabbed finishes the move when it answers.
  if (drag.picked) finishMove(drag);
}

/** @param {NonNullable<typeof moveDrag>} drag */
function previewMove(drag) {
  const { itemId, device } = drag.record;
  postToArtboard(itemId, device.id, {
    type: "style",
    selector: drag.selector,
    css: "translate",
    value: movedTranslate(drag),
  });
}

/** @param {NonNullable<typeof moveDrag>} drag */
function finishMove(drag) {
  moveDrag = null;
  document.getElementById("moveGuides")?.replaceChildren();
  const { record, selector } = drag;
  const itemId = record.itemId;
  const deviceId = record.device.id;
  const after = movedTranslate(drag);
  const before = savedElementValue(itemId, selector, "translate");
  if (after === before) return;
  endTuneEdit();
  persistElementTune({ itemId, selector, css: "translate", value: after });
  refreshElementStyle(itemId, selector, "translate");
  tuneUndo.push({ itemId, deviceId, changes: [{ selector, css: "translate", before, after }] });
  tuneRedo = [];
  openSelectorTune(record, selector);
}

/** The translate a drag ends on: where the element sat, plus how far it was dragged. @param {NonNullable<typeof moveDrag>} drag */
function movedTranslate(drag) {
  const [x = "0px", y = "0px", ...rest] = drag.base;
  return [offsetCss(x, drag.dx), offsetCss(y, drag.dy), ...rest].join(" ");
}

/** @param {string} value a translate component @param {number} delta px */
function offsetCss(value, delta) {
  const step = Math.round(delta);
  const px = /^(-?[\d.]+)px$/.exec(value);
  if (px) return `${Math.round(Number(px[1])) + step}px`;
  const summed = /^calc\((.+) \+ (-?\d+)px\)$/.exec(value);
  if (summed) {
    const total = Number(summed[2]) + step;
    return total ? `calc(${summed[1]} + ${total}px)` : summed[1];
  }
  return step ? `calc(${value} + ${step}px)` : value;
}

/** A computed list split on its top-level spaces, so a calc() stays whole. @param {string} value */
function splitCssList(value) {
  if (!value || value === "none") return [];
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of value.trim()) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === " " && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else current += char;
  }
  if (current) parts.push(current);
  return parts;
}

/** Load one element of a frame into Controls by its selector. @param {any} record @param {string} selector */
function openSelectorTune(record, selector) {
  outlineInFrame("");
  tuneTarget = { itemId: record.itemId, deviceId: record.device.id, pending: true };
  tuneOrigin = [];
  tuneItemId = record.itemId;
  tuneDeviceId = record.device.id;
  showTuneLoaded(true);
  showSideView("controls");
  markTuneSent(false);
  renderTune();
  postToArtboard(record.itemId, record.device.id, { type: "tune-element", selector });
}

/**
 * Up (-1 toward the page) or down (1 back toward the clicked element). With the
 * selector on it moves what a click would pick; otherwise it moves the tuned element.
 * @param {number} direction
 */
function stepTuneSelection(direction) {
  if (tuneArmed()) {
    tuneDepth = Math.max(0, tuneDepth - direction);
    hoverUnderPointer();
    return true;
  }
  if (!tuneTarget || tuneTarget.pending || sideView !== "controls") return false;
  const crumbs = tuneOrigin.length > 0 ? tuneOrigin : tuneTarget.crumbs || [];
  const index = crumbs.findIndex((crumb) => crumb.selector === tuneTarget?.selector);
  const next = crumbs[index + direction];
  if (index < 0 || !next) return true;
  selectTuneElement(next.selector);
  return true;
}

/*
 * Edit's tag: the frame draws a small black label over the element Controls holds,
 * naming it and the property being changed. Its thin outline shows only while the
 * pointer is on the controls and for a moment after a change, then fades.
 */

/** How large the board draws a frame: a frame pixel is this many screen pixels. @param {string} itemId @param {string} deviceId */
function frameScale(itemId, deviceId) {
  const record = state.artboards.get(artboardKey(itemId, deviceId));
  if (!record) return state.camera.zoom;
  return record.iframe.getBoundingClientRect().width / record.device.width || state.camera.zoom;
}

/** Send the tag to the tuned frame, or take it down when nothing is being edited. */
function syncEditTag() {
  const target = tuneTarget && !tuneTarget.pending && !tuneTarget.error && sideView === "controls" ? tuneTarget : null;
  if (target && editTag.for !== `${target.itemId}\n${target.deviceId}\n${target.selector}`) {
    editTag.for = `${target.itemId}\n${target.deviceId}\n${target.selector}`;
    editTag.selector = "";
    editTag.property = "";
  }
  const at = target ? { itemId: target.itemId, deviceId: target.deviceId } : null;
  if (editTagFrame && (!at || editTagFrame.itemId !== at.itemId || editTagFrame.deviceId !== at.deviceId))
    postToArtboard(editTagFrame.itemId, editTagFrame.deviceId, { type: "edit-label", selector: "" });
  editTagFrame = at;
  if (!target || !at) {
    editTag.for = "";
    return;
  }
  postToArtboard(at.itemId, at.deviceId, {
    type: "edit-label",
    selector: editTag.selector || target.selector || "",
    property: editTag.property,
    outline: editTag.hover || editTag.flash,
    scale: frameScale(at.itemId, at.deviceId),
  });
}

/** The pointer is on a control: the tag names its property. @param {string} selector @param {string} property */
function pointEditTag(selector, property) {
  editTag.selector = selector;
  editTag.property = property;
  syncEditTag();
}

/** A value changed: the tag names it and the outline shows for a moment. @param {string} selector @param {string} property */
function flashEditTag(selector, property) {
  editTag.selector = selector;
  editTag.property = property;
  editTag.flash = true;
  clearTimeout(editFlashTimer);
  editFlashTimer = setTimeout(() => {
    editTag.flash = false;
    syncEditTag();
  }, EDIT_OUTLINE_HOLD_MS);
  syncEditTag();
}

/** Outline one element in the tuned frame, or clear the outline. @param {string} selector */
function outlineInFrame(selector) {
  if (!tuneTarget) return;
  postToArtboard(tuneTarget.itemId, tuneTarget.deviceId, { type: "outline", selector });
}

/** @param {"element" | "section"} [scope] */
function targetSelector(scope) {
  if (!tuneTarget) return "";
  if (scope === "section") return tuneTarget.sectionSelector || "";
  // "All like this" tunes every element in the same spot, under one shared selector.
  if (tuneTarget.scope === "all" && tuneTarget.like) return tuneTarget.like.selector;
  return tuneTarget.selector || "";
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let groupOutlineTimer;
/** Outline every element "All like this" reaches, for a moment or until cleared. @param {string} selector */
function outlineGroupInFrame(selector, hold = 0) {
  if (!tuneTarget) return;
  clearTimeout(groupOutlineTimer);
  const { itemId, deviceId } = tuneTarget;
  postToArtboard(itemId, deviceId, { type: "outline-all", selector });
  if (selector && hold > 0)
    groupOutlineTimer = setTimeout(() => postToArtboard(itemId, deviceId, { type: "outline-all", selector: "" }), hold);
}

/** Switch between tuning this element and every element like it. @param {"one" | "all"} scope */
function setTuneScope(scope) {
  if (!tuneTarget || !tuneTarget.like || tuneTarget.scope === scope) return;
  endTuneEdit();
  tuneTarget.scope = scope;
  syncTargetValues(tuneTarget);
  markTuneDirty();
  renderTune();
  outlineGroupInFrame(scope === "all" ? tuneTarget.like.selector : "", 1500);
}

/** "This one" or "All like this (N)", when the element has siblings like it. */
function renderTuneScope() {
  if (!tuneTarget || !tuneTarget.like) return null;
  const like = tuneTarget.like;
  const row = element("div", { class: "tune-scope", role: "radiogroup", "aria-label": "What to tune" });
  for (const [scope, text] of /** @type {const} */ ([
    ["one", "This one"],
    ["all", `All like this (${like.count})`],
  ])) {
    const on = tuneTarget.scope === scope;
    const button = element("button", { class: "tune-scope-option", type: "button", role: "radio", text });
    button.setAttribute("aria-checked", String(on));
    button.addEventListener("click", () => setTuneScope(scope));
    if (scope === "all") {
      button.addEventListener("pointerenter", () => outlineGroupInFrame(like.selector));
      button.addEventListener("pointerleave", () => outlineGroupInFrame(""));
    }
    row.append(button);
  }
  // One element tuned on its own goes back to what its siblings share.
  if (tuneTarget.scope === "one") {
    const match = element("button", {
      class: "tune-link tune-match",
      type: "button",
      text: "Match the others",
      title: "Take this element's own changes off so it looks like the rest",
    });
    match.addEventListener("click", matchSiblings);
    row.append(match);
    syncMatchSiblings(match);
  }
  return row;
}

/** "Match the others" shows only while this element has changes of its own. */
function syncMatchSiblings(match = document.querySelector(".tune-match")) {
  if (!(match instanceof HTMLElement) || !tuneTarget) return;
  match.hidden = !Object.keys(itemById(tuneTarget.itemId)?.elementTune || {}).some(
    (key) => parseTuneKey(key).selector === tuneTarget?.selector,
  );
}

/** "All sizes" or "<Device> only": where a change shows. */
function renderSizeScope() {
  if (!tuneTarget) return null;
  const device = DEVICES.find((entry) => entry.id === tuneTarget?.deviceId);
  if (!device) return null;
  const row = element("div", { class: "tune-scope", role: "radiogroup", "aria-label": "Which sizes" });
  for (const [sizes, text] of /** @type {const} */ ([
    ["all", "All sizes"],
    ["one", `${device.label} only`],
  ])) {
    const button = element("button", { class: "tune-scope-option", type: "button", role: "radio", text });
    button.setAttribute("aria-checked", String((tuneTarget.sizes || "all") === sizes));
    button.addEventListener("click", () => {
      if (!tuneTarget || (tuneTarget.sizes || "all") === sizes) return;
      endTuneEdit();
      tuneTarget.sizes = sizes;
      syncTargetValues(tuneTarget);
      renderTune();
    });
    row.append(button);
  }
  return row;
}

/**
 * Under a control whose value is kept separately for some sizes: which ones, so a
 * shared change that does not show there is never a surprise.
 * @param {string} selector @param {any} control
 */
function renderSizeNote(selector, control) {
  if (!tuneTarget) return null;
  const sizes = sizesWithOwnValue(tuneTarget.itemId, selector, control.css);
  if (sizes.length === 0) return null;
  return element("p", {
    class: "tune-note",
    text: `Own value on ${sizes.map((device) => device.label).join(", ")}`,
  });
}

/** Take off the tuned element's own overrides, as one undoable step. */
function matchSiblings() {
  if (!tuneTarget || !tuneTarget.selector) return;
  endTuneEdit();
  const { itemId, deviceId, selector } = tuneTarget;
  const saved = itemById(itemId)?.elementTune || {};
  const changes = Object.entries(saved)
    .filter(([key]) => parseTuneKey(key).selector === selector)
    .flatMap(([key, css]) =>
      Object.entries(css).map(([property, before]) => ({
        selector: key,
        css: property,
        before: String(before),
        after: "",
      })),
    );
  if (changes.length === 0) return;
  tuneUndo.push({ itemId, deviceId, changes });
  tuneRedo = [];
  applyElementChanges(itemId, deviceId, changes, "after");
}

/**
 * Under a box's text control: the text inside that sets this property itself and so
 * will not follow, with a jump to it.
 * @param {any} control
 */
function renderOverrides(control) {
  const overrides = control.overrides;
  if (!overrides || !Array.isArray(overrides.items) || overrides.items.length === 0) return null;
  const note = element("p", { class: "tune-note" });
  note.append(document.createTextNode("Set separately on "));
  overrides.items.forEach((entry, index) => {
    if (index > 0) note.append(document.createTextNode(", "));
    const jump = element("button", {
      class: "tune-note-jump",
      type: "button",
      text: String(entry.label || entry.selector),
      title: "Tune that element",
    });
    jump.addEventListener("click", () => selectTuneElement(String(entry.selector)));
    jump.addEventListener("pointerenter", () => outlineInFrame(String(entry.selector)));
    jump.addEventListener("pointerleave", () => outlineInFrame(""));
    note.append(jump);
  });
  const more = Number(overrides.total) - overrides.items.length;
  if (more > 0) note.append(document.createTextNode(` and ${more} more`));
  return note;
}

/**
 * One control changed in the panel: the element it belongs to (the tuned one, its
 * section, or an element it inherits from) changes live, is saved, and can be undone.
 * @param {any} control @param {string} raw @param {string} [selector] defaults to the control's own scope
 * @param {Record<string, string>} [values] where the panel keeps this control's value
 */
function applyTargetValue(control, raw, selector = targetSelector(control.scope), values) {
  if (!tuneTarget || !selector) return;
  const into = values || (tuneTarget.values = tuneTarget.values || {});
  into[control.id] = String(raw);
  applyTargetWrites([{ css: control.css, value: tuneValue(control, raw) }], selector);
}

/**
 * Several properties of one selector changed by one control, as one undo step: an
 * "all sides" slider, or a linked pair of sides.
 * @param {{ css: string, value: string }[]} writes @param {string} selector
 */
function applyTargetWrites(writes, selector) {
  if (!tuneTarget || !selector) return;
  const { itemId, deviceId } = tuneTarget;
  // Every size by default; "This size only" keeps the value to the frame it was picked in.
  const key = tuneTarget.sizes === "one" ? sizeKey(selector, deviceId) : selector;
  beginElementEdit(
    itemId,
    deviceId,
    key,
    writes.map((write) => write.css),
  );
  for (const write of writes) persistElementTune({ itemId, selector: key, css: write.css, value: write.value });
  for (const write of writes) refreshElementStyle(itemId, selector, write.css);
  if (writes[0]) flashEditTag(selector, writes[0].css);
}

/*
 * Padding, Margin and Radius keep one "all sides" slider. Its link toggle opens the
 * sides: linked pairs (left and right, top and bottom) first, then each side on its
 * own. Radius opens straight to its four corners. Every side writes its own longhand
 * to the tuned element only; the all-sides slider writes the shorthand and takes the
 * sides' own values off, so it really sets every side.
 */
/** @type {Map<string, "all" | "pairs" | "each">} the opened state per element and control */
const tuneBoxModes = new Map();

/** @param {any} control */
function boxModeKey(control) {
  return `${tuneTarget?.selector || ""}\n${control.id}`;
}

/** The panel's value of each side, in the control's own order. @param {any} control */
function sideValues(control) {
  const values = tuneTarget?.values || {};
  return control.sides.map((side) => String(values[side.id] ?? side.value ?? ""));
}

/** How a box control opens when the reviewer has not chosen: as far as its values differ. @param {any} control */
function boxMode(control) {
  const chosen = tuneBoxModes.get(boxModeKey(control));
  if (chosen) return chosen;
  const [top, right, bottom, left] = sideValues(control);
  if (top === right && right === bottom && bottom === left) return "all";
  const corners = control.sides[0]?.side?.includes("-");
  return !corners && top === bottom && left === right ? "pairs" : "each";
}

/** @param {any} control @param {string} name */
function sideNamed(control, name) {
  return control.sides.find((side) => side.side === name);
}

/**
 * Write a box control's sides. The all-sides slider takes each side's own value off,
 * except a size-only value over a shared side, which it has to cover explicitly.
 * @param {any} control @param {any[]} sides @param {string} raw @param {boolean} all
 */
function applyBoxValue(control, sides, raw, all) {
  if (!tuneTarget) return;
  const selector = targetSelector(control.scope);
  const values = (tuneTarget.values = tuneTarget.values || {});
  const saved = itemById(tuneTarget.itemId)?.elementTune?.[selector] || {};
  const sizeOnly = tuneTarget.sizes === "one";
  for (const side of sides) values[side.id] = String(raw);
  if (all) values[control.id] = String(raw);
  const writes = all
    ? [
        { css: control.css, value: tuneValue(control, raw) },
        ...sides.map((side) => ({
          css: side.css,
          value: sizeOnly && saved[side.css] ? tuneValue(side, raw) : "",
        })),
      ]
    : sides.map((side) => ({ css: side.css, value: tuneValue(side, raw) }));
  applyTargetWrites(writes, selector);
}

/** Show a value on a rendered slider without firing its input. @param {HTMLElement} node @param {string} raw */
function showSliderValue(node, raw) {
  const input = /** @type {HTMLInputElement | null} */ (node.querySelector('input[type="range"]'));
  const label = node.querySelector(".tune-control-value");
  if (label) label.textContent = raw;
  if (!input) return;
  input.value = raw;
  const low = Number(input.min) || 0;
  const high = Number(input.max) || 100;
  const percent = ((Number(input.value) - low) / (high - low || 1)) * 100;
  input.style.setProperty("--fill", `${Math.max(0, Math.min(100, percent))}%`);
}

const LINK_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.6l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.4l-1 1A2.5 2.5 0 014.5 8.9l1-1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/**
 * Padding, Margin or Radius: the all-sides slider with a link toggle on its label row,
 * and, opened, the sides under it.
 * @param {any} control
 */
function renderBoxControl(control) {
  const values = (tuneTarget && tuneTarget.values) || {};
  const node = createTuneControl({ id: "target", tune: values }, control, (raw) => {
    applyBoxValue(control, control.sides, raw, true);
    fill();
  });
  node.classList.add("tune-box");
  const corners = control.sides[0]?.side?.includes("-");
  const mode = boxMode(control);
  const open = mode !== "all";
  const toggle = element("button", {
    class: "tune-link",
    type: "button",
    "aria-pressed": String(open),
    "aria-label": open ? `${control.label}: one value for all sides` : `${control.label}: set sides separately`,
    title: open ? "One value for all sides" : corners ? "Set each corner" : "Set sides separately",
  });
  toggle.innerHTML = LINK_ICON;
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    tuneBoxModes.set(boxModeKey(control), open ? "all" : corners ? "each" : "pairs");
    renderTune();
  });
  const label = node.querySelector(".tune-control-label");
  const valueLabel = label?.querySelector(".tune-control-value");
  if (label && valueLabel) {
    const end = element("span", { class: "tune-control-end" });
    label.append(end);
    end.append(toggle, valueLabel);
  }
  const sides = element("div", { class: "tune-sides" });
  const syncAll = () => {
    const current = sideValues(control);
    const same = current.every((value) => value === current[0]);
    showSliderValue(node, same ? current[0] : String(values[control.id] ?? control.value ?? ""));
    if (!same && valueLabel) valueLabel.textContent = "Mixed";
  };
  function fill() {
    if (!open) return;
    /** @type {{ id: string, label: string, sides: any[] }[]} */
    const rows =
      mode === "pairs"
        ? [
            {
              id: `${control.id}-x`,
              label: "Left · right",
              sides: [sideNamed(control, "left"), sideNamed(control, "right")],
            },
            {
              id: `${control.id}-y`,
              label: "Top · bottom",
              sides: [sideNamed(control, "top"), sideNamed(control, "bottom")],
            },
          ]
        : control.sides.map((side) => ({ id: side.id, label: side.label, sides: [side] }));
    sides.replaceChildren(
      ...rows.map((row) => {
        const first = row.sides[0];
        const tune = { [row.id]: String(values[first.id] ?? first.value ?? "") };
        const sub = createTuneControl({ id: "target", tune }, { ...first, id: row.id, label: row.label }, (raw) => {
          applyBoxValue(control, row.sides, raw, false);
          syncAll();
        });
        sub.classList.add("tune-side");
        return sub;
      }),
    );
  }
  if (open) {
    if (!corners) {
      const switcher = element("div", {
        class: "tune-side-modes",
        role: "group",
        "aria-label": `${control.label} sides`,
      });
      for (const [value, text] of [
        ["pairs", "Pairs"],
        ["each", "Each side"],
      ]) {
        const button = element("button", { class: "tune-side-mode", type: "button", text });
        button.setAttribute("aria-pressed", String(mode === value));
        button.addEventListener("click", () => {
          tuneBoxModes.set(boxModeKey(control), /** @type {"pairs" | "each"} */ (value));
          renderTune();
        });
        switcher.append(button);
      }
      node.append(switcher);
    }
    node.append(sides);
    fill();
  }
  syncAll();
  return node;
}

/**
 * Put a set of element changes back (undo) or forward (redo, reset): live in every
 * frame, saved, and shown in the panel. An empty value takes the override off. A
 * change's selector is its saved key, so a size-only change stays size-only.
 * @param {string} itemId @param {string} deviceId
 * @param {{ selector: string, css: string, before: string, after: string }[]} changes
 * @param {"before" | "after"} side
 */
function applyElementChanges(itemId, deviceId, changes, side) {
  for (const change of changes) {
    persistElementTune({ itemId, selector: change.selector, css: change.css, value: change[side] });
    refreshElementStyle(itemId, parseTuneKey(change.selector).selector, change.css);
  }
  if (tuneTarget && tuneTarget.itemId === itemId && !tuneTarget.pending) {
    syncTargetValues(tuneTarget);
    markTuneDirty();
    renderTune();
  }
}

/** Element saves not yet sent, per item and selector, so tuning two elements at once loses neither. */
/** @type {Map<string, { itemId: string, selector: string, css: Record<string, string> }>} */
const elementTunePending = new Map();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let elementTuneTimer;

/**
 * What a controls-selector click tuned is saved on the item, per selector, so the panel can be
 * closed, the board reloaded and the design still looks the way it was tuned. The item's
 * copy changes at once, so undo and a re-picked element read it before the save lands.
 * @param {{ itemId: string, selector: string, css: string, value: string }} change
 */
function persistElementTune({ itemId, selector, css, value }) {
  if (!selector || !css) return;
  const item = itemById(itemId);
  if (item) {
    const tunes = { ...(item.elementTune || {}) };
    const props = { ...(tunes[selector] || {}) };
    if (value) props[css] = String(value);
    else delete props[css];
    if (Object.keys(props).length > 0) tunes[selector] = props;
    else delete tunes[selector];
    item.elementTune = tunes;
  }
  const id = `${itemId}\n${selector}`;
  const pending = elementTunePending.get(id) || { itemId, selector, css: {} };
  pending.css[css] = String(value);
  elementTunePending.set(id, pending);
  clearTimeout(elementTuneTimer);
  elementTuneTimer = setTimeout(() => {
    const batch = [...elementTunePending.values()];
    elementTunePending.clear();
    for (const entry of batch) {
      fetch(`/api/boards/${encodeURIComponent(key)}/tune`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item: entry.itemId, selector: entry.selector, element: entry.css }),
      }).catch(() => {});
    }
  }, 250);
}

/** A saved CSS value as the raw value its control holds: a number control drops its unit. */
function rawOfCss(control, css) {
  if ((control.type === "number" || control.type === "timeline") && control.unit) {
    const number = Number.parseFloat(css);
    return Number.isFinite(number) ? String(number) : String(control.value ?? "");
  }
  return css;
}

/**
 * The panel's values are the element's saved overrides where it has them, otherwise
 * what the file gives: a picked element shows the design as the reviewer left it.
 * @param {NonNullable<typeof tuneTarget>} target
 */
function syncTargetValues(target) {
  const saved = itemById(target.itemId)?.elementTune || {};
  /** @param {any} control @param {string} selector */
  const valueOf = (control, selector) => {
    const own = target.sizes === "one" ? saved[sizeKey(selector, target.deviceId)]?.[control.css] : "";
    const css = own || saved[selector]?.[control.css];
    return css ? rawOfCss(control, css) : String(control.value ?? "");
  };
  target.values = {};
  for (const control of target.controls || []) {
    const selector = targetSelector(control.scope);
    target.values[control.id] = valueOf(control, selector);
    // A side shows its own saved value, else the all-sides one saved over it, else the file's.
    for (const side of control.sides || []) {
      const own = target.sizes === "one" ? saved[sizeKey(selector, target.deviceId)] || {} : {};
      const shared = saved[selector] || {};
      const css = own[side.css] || own[control.css] || shared[side.css] || shared[control.css];
      target.values[side.id] = css ? rawOfCss(side, css) : String(side.value ?? "");
    }
  }
  for (const group of target.inherited || []) {
    group.values = {};
    for (const control of group.controls) group.values[control.id] = valueOf(control, group.selector);
  }
}

/** Every selector this panel tunes, the tuned element first. */
function panelSelectors() {
  if (!tuneTarget) return [];
  const selectors = [tuneTarget.selector || "", tuneTarget.like?.selector || "", tuneTarget.sectionSelector || ""];
  for (const group of tuneTarget.inherited || []) selectors.push(group.selector);
  return [...new Set(selectors.filter(Boolean))];
}

/** Reset takes off every override the panel shows, as one step Cmd-Z can bring back. */
function resetTargetTune() {
  if (!tuneTarget) return;
  endTuneEdit();
  const { itemId, deviceId } = tuneTarget;
  const saved = itemById(itemId)?.elementTune || {};
  const selectors = new Set(panelSelectors());
  const changes = [];
  for (const [key, css] of Object.entries(saved)) {
    if (!selectors.has(parseTuneKey(key).selector)) continue;
    for (const [property, before] of Object.entries(css)) {
      changes.push({ selector: key, css: property, before: String(before), after: "" });
    }
  }
  if (changes.length === 0) return;
  tuneUndo.push({ itemId, deviceId, changes });
  tuneRedo = [];
  applyElementChanges(itemId, deviceId, changes, "after");
}

/** Only what the reviewer changed, as CSS an agent can bake straight into the page. */
function copyTargetTune() {
  return tuneChanges()
    .map((change) => change.line)
    .join("\n");
}

/** A control's value as CSS: a number control carries its unit. */
function tuneValue(control, raw) {
  return (control.type === "number" || control.type === "timeline") && control.unit
    ? `${raw}${control.unit}`
    : String(raw);
}

/** The only properties that differ from what the file has, as CSS. */
function tuneChanges() {
  if (tuneTarget) {
    // What is saved for the selectors this panel shows, each in the rule it needs: a
    // base rule for every size, a media query for a size of its own.
    const saved = itemById(tuneTarget.itemId)?.elementTune || {};
    const selectors = new Set(panelSelectors());
    /** @type {Map<string, string>} the file's own value per selector and property, where the panel read it */
    const file = new Map();
    for (const control of tuneTarget.controls || []) {
      // An all-sides value matches the file only when the file's sides are all that value.
      const uneven = (control.sides || []).some((side) => String(side.value) !== String(control.value));
      if (!uneven)
        file.set(`${targetSelector(control.scope)}\n${control.css}`, tuneValue(control, control.value ?? ""));
      for (const side of control.sides || [])
        file.set(`${targetSelector(control.scope)}\n${side.css}`, tuneValue(side, side.value ?? ""));
    }
    for (const group of tuneTarget.inherited || [])
      for (const control of group.controls)
        file.set(`${group.selector}\n${control.css}`, tuneValue(control, control.value ?? ""));
    const changes = [];
    for (const [key, css] of Object.entries(saved)) {
      const { deviceId, selector } = parseTuneKey(key);
      if (!selectors.has(selector)) continue;
      for (const [property, value] of Object.entries(css)) {
        if (!deviceId && file.get(`${selector}\n${property}`) === String(value)) continue;
        const rule = `${selector} { ${property}: ${value}; }`;
        // A Google font picked here reaches the agent with the stylesheet that loads it.
        const font = property === "font-family" ? googleFontFor(String(value)) : null;
        const load = font ? `@import url("${googleFontHref(font)}");` : "";
        if (load && !changes.some((change) => change.line === load)) changes.push({ selector, line: load });
        changes.push({ selector, line: deviceId ? `${sizeMedia(deviceId)} { ${rule} }` : rule });
      }
    }
    return changes;
  }
  const item = itemById(tuneItemId);
  if (!item) return [];
  return tuneSpecFor(item.id)
    .filter(
      (control) =>
        item.tune[control.id] !== undefined &&
        item.tune[control.id] !== "" &&
        String(item.tune[control.id]) !== String(control.value ?? ""),
    )
    .map((control) => ({
      selector: ":root",
      line: `:root { ${control.css}: ${tuneValue(control, item.tune[control.id])}; }`,
    }));
}

/** After Send the panel says so; a further change makes it a Send again. */
function markTuneSent(sent) {
  const send = /** @type {any} */ (document.getElementById("tuneSend"));
  if (!send) return;
  if (send.dataset) send.dataset.sent = String(Boolean(sent));
  send.textContent = sent ? "Sent" : "Send";
  send.disabled = Boolean(sent);
}

/** Send is live only when there is something to send: the properties that differ. */
function syncTuneSend() {
  const send = /** @type {any} */ (document.getElementById("tuneSend"));
  if (!send || send.dataset?.sent === "true") return;
  const pending = Boolean(tuneTarget?.pending);
  send.disabled = pending || tuneChanges().length === 0;
  send.textContent = "Send";
}

function markTuneDirty() {
  syncMatchSiblings();
  const send = /** @type {any} */ (document.getElementById("tuneSend"));
  if (send?.dataset?.sent === "true") markTuneSent(false);
  syncTuneSend();
}

/**
 * The panel's primary action: hand only the properties that changed to the agent, as
 * a note on that design, in the same channel annotations use. Copy stays for anyone
 * who wants the CSS itself.
 */
function sendTune() {
  const itemId = tuneTarget ? tuneTarget.itemId : tuneItemId;
  const item = itemById(itemId);
  if (!item || state.ended) return;
  const changes = tuneChanges();
  if (changes.length === 0) return;
  if (!tuneTarget) flushTune(item);
  const where = tuneTarget
    ? `${item.label} (${item.file}), element ${tuneTarget.selector || ""}`
    : `${item.label} (${item.file})`;
  const prompt = `Tune ${where}. Only these differ from the file:\n${changes.map((change) => change.line).join("\n")}`;
  markTuneSent(true);
  fetch(`/api/${encodeURIComponent(key)}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompts: [
        {
          uid: randomId(),
          prompt_id: randomId(),
          prompt,
          tag: "tune",
          thread: `item:${item.id}`,
          selector: changes[0]?.selector || "",
          item: itemRef(item),
        },
      ],
      domSnapshot: "",
    }),
  })
    .then((response) => {
      if (!response.ok) throw new Error("not accepted");
      dockStatus.textContent = "";
      refreshBoard();
    })
    .catch(() => {
      markTuneSent(false);
      dockStatus.textContent = "Could not reach Liesel. Your values are still here.";
    });
}

function renderTargetTune() {
  const sub = document.getElementById("tuneSub");
  const body = document.getElementById("tuneBody");
  if (!body || !tuneTarget) return;
  if (sub) sub.textContent = "";
  const title = document.getElementById("tuneTitle");
  if (title) title.textContent = tuneTitleText(tuneTarget.label || "Tune");
  const crumbs = renderTuneCrumbs();
  const scope = tuneTarget.pending ? null : renderTuneScope();
  const sizes = tuneTarget.pending ? null : renderSizeScope();
  if (tuneTarget.pending) {
    body.replaceChildren(
      ...[crumbs, element("p", { class: "tune-empty", text: "Reading the element…" })].filter(Boolean),
    );
  } else {
    const controls = tuneTarget.controls || [];
    const groups = (tuneTarget.inherited || []).map(renderInheritedGroup);
    const own =
      controls.length === 0
        ? groups.length === 0
          ? [element("p", { class: "tune-empty", text: "Nothing here to tune." })]
          : []
        : controls.map((control) => {
            const node =
              Array.isArray(control.sides) && control.sides.length === 4
                ? renderBoxControl(control)
                : createTuneControl({ id: "target", tune: tuneTarget?.values || {} }, control, (raw) =>
                    applyTargetValue(control, raw),
                  );
            for (const note of [renderOverrides(control), renderSizeNote(targetSelector(control.scope), control)])
              if (note) node.append(note);
            node.addEventListener("pointerenter", () => pointEditTag(targetSelector(control.scope), control.css));
            return node;
          });
    if (tuneTarget.error) {
      body.replaceChildren(
        ...[
          crumbs,
          element("p", {
            class: "tune-empty",
            text: "This element has no selector that names only it, so nothing was tuned. Pick the element around it.",
          }),
        ].filter(Boolean),
      );
    } else body.replaceChildren(...[crumbs, scope, sizes, ...own, ...groups].filter(Boolean));
  }
  const save = /** @type {any} */ (document.getElementById("tuneSave"));
  if (save) save.hidden = true;
  const versions = document.getElementById("tuneVersions");
  if (versions) versions.replaceChildren();
  for (const id of ["tuneSave", "tuneCopy", "tuneReset"]) {
    const button = /** @type {any} */ (document.getElementById(id));
    if (button)
      button.disabled =
        tuneTarget.pending || ((tuneTarget.controls || []).length === 0 && (tuneTarget.inherited || []).length === 0);
  }
  syncTuneSend();
  syncEditTag();
}

/**
 * The path from the page down to the clicked element, like DevTools' breadcrumb: any
 * crumb tunes that element, and hovering one outlines it in the design.
 */
function renderTuneCrumbs() {
  if (!tuneTarget) return null;
  const crumbs = tuneOrigin.length > 0 ? tuneOrigin : tuneTarget.crumbs || [];
  if (crumbs.length === 0) return null;
  const nav = element("nav", { class: "tune-crumbs", "aria-label": "Pick an element this one sits in" });
  crumbs.forEach((crumb, index) => {
    if (index > 0) nav.append(element("span", { class: "tune-crumb-gap", "aria-hidden": "true", text: "›" }));
    const current = crumb.selector === tuneTarget?.selector;
    const button = element("button", {
      class: "tune-crumb",
      type: "button",
      text: crumb.label,
      title: current ? "Tuning this element" : `Tune ${crumb.label}`,
    });
    if (current) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => selectTuneElement(crumb.selector));
    button.addEventListener("pointerenter", () => outlineInFrame(crumb.selector));
    button.addEventListener("pointerleave", () => outlineInFrame(""));
    nav.append(button);
  });
  return nav;
}

/** A collapsed "Inherited from" group: only what that element sets and the tuned one takes. @param {InheritedGroup} group */
function renderInheritedGroup(group) {
  const details = element("details", { class: "tune-inherited" });
  details.open = tuneOpenGroups.has(group.selector);
  const summary = element("summary", { class: "tune-inherited-name" });
  summary.append(
    element("span", { text: "Inherited from " }),
    element("span", { class: "tune-inherited-from", text: group.label }),
  );
  summary.addEventListener("pointerenter", () => outlineInFrame(group.selector));
  summary.addEventListener("pointerleave", () => outlineInFrame(""));
  details.addEventListener("toggle", () => {
    if (details.open) tuneOpenGroups.add(group.selector);
    else tuneOpenGroups.delete(group.selector);
  });
  details.append(
    summary,
    ...group.controls.map((control) => {
      const node = createTuneControl({ id: "target", tune: group.values }, control, (raw) =>
        applyTargetValue(control, raw, group.selector, group.values),
      );
      const note = renderSizeNote(group.selector, control);
      if (note) node.append(note);
      node.addEventListener("pointerenter", () => pointEditTag(group.selector, control.css));
      return node;
    }),
  );
  return details;
}

/** Controls names what it tunes in one plain line: `H1 · The everyday collection`. */
function tuneTitleText(label) {
  return String(label || "")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderTune() {
  for (const cleanup of tuneCleanup) cleanup();
  tuneCleanup = [];
  const item = itemById(tuneItemId);
  if (!item) return;
  const save = /** @type {any} */ (document.getElementById("tuneSave"));
  const title = document.getElementById("tuneTitle");
  if (tuneTarget) {
    renderTargetTune();
    return;
  }
  if (save) save.hidden = false;
  if (title) title.textContent = tuneTitleText(`Design · ${designName(item, tuneDeviceId)}`);
  const sub = document.getElementById("tuneSub");
  if (sub) sub.textContent = "";
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
  syncTuneSend();
  renderVersions(item, spec);
}

/** Colour, inline: what it is now, colours worked out from it, sliders and a hex field. */
function createColourControl(label, initial, apply) {
  const { normalizeHex, hexToHsl, hslToHex, harmonySwatches } = /** @type {any} */ (window).LieselColour;
  let current = normalizeHex(initial) || "#000000";
  let hsl = hexToHsl(current);
  const root = element("div", { class: "tune-colour" });
  const head = element("div", { class: "tune-colour-head" });
  const chip = element("span", { class: "tune-swatch" });
  const hex = /** @type {any} */ (
    element("input", {
      type: "text",
      class: "tune-hex",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": `${label} hex`,
    })
  );
  head.append(chip, hex);

  const optionRow = () => {
    const row = element("div", { class: "tune-colour-options" });
    const options = Array.from({ length: 5 }, () => {
      const option = element("button", { class: "tune-colour-option", type: "button" });
      option.addEventListener("click", () => {
        const picked = option.dataset.hex;
        setColour(picked);
        apply(picked);
        endTuneEdit();
      });
      return option;
    });
    row.append(...options);
    return { row, options };
  };
  const hues = optionRow();
  const tones = optionRow();

  const slider = (name, max, unit, field) => {
    const row = element("label", { class: "tune-colour-slider" });
    const value = element("span", { class: "tune-control-value" });
    const title = element("span", { class: "tune-colour-slider-label" });
    title.append(element("span", { text: name }), value);
    const input = /** @type {any} */ (
      element("input", { type: "range", min: "0", max: String(max), step: "1", "aria-label": `${label} ${name}` })
    );
    input.addEventListener("input", () => {
      hsl = { ...hsl, [field]: Number(input.value) };
      current = hslToHex(hsl);
      paint();
      apply(current);
    });
    input.addEventListener("change", endTuneEdit);
    row.append(title, input);
    return {
      row,
      input,
      sync: () => ((input.value = String(hsl[field])), (value.textContent = `${hsl[field]}${unit}`)),
    };
  };
  const hue = slider("Hue", 360, "°", "h");
  const saturation = slider("Saturation", 100, "%", "s");
  const lightness = slider("Lightness", 100, "%", "l");

  // Black, white and greys have no hue of their own: keep the one on the sliders.
  function setColour(next, typing = false) {
    const parsed = hexToHsl(next);
    const flat = parsed.l === 0 || parsed.l === 100;
    hsl = { h: parsed.s === 0 ? hsl.h : parsed.h, s: flat ? hsl.s : parsed.s, l: parsed.l };
    current = next;
    paint(typing);
  }

  function paint(typing = false) {
    chip.style.background = current;
    if (!typing) hex.value = current;
    hex.removeAttribute("aria-invalid");
    for (const part of [hue, saturation, lightness]) part.sync();
    const { h, s, l } = hsl;
    saturation.input.style.setProperty(
      "--track",
      `linear-gradient(to right, ${hslToHex({ h, s: 0, l })}, ${hslToHex({ h, s: 100, l })})`,
    );
    lightness.input.style.setProperty("--track", `linear-gradient(to right, #000, ${hslToHex({ h, s, l: 50 })}, #fff)`);
    const swatches = harmonySwatches(hsl);
    const fill = (options, colours) =>
      options.forEach((option, index) => {
        option.dataset.hex = colours[index];
        option.style.background = colours[index];
        option.title = colours[index];
        option.setAttribute("aria-label", `Use ${colours[index]}`);
      });
    fill(hues.options, swatches.hues);
    fill(tones.options, swatches.tones);
  }

  hex.addEventListener("input", () => {
    const next = normalizeHex(hex.value);
    if (!next) {
      hex.setAttribute("aria-invalid", "true");
      return;
    }
    setColour(next, true);
    apply(next);
  });
  hex.addEventListener("change", () => {
    paint();
    endTuneEdit();
  });
  hex.addEventListener("keydown", (event) => {
    if (event.key === "Enter") hex.blur();
  });

  hue.input.classList.add("tune-colour-hue");
  root.append(head, hues.row, tones.row, hue.row, saturation.row, lightness.row);
  paint();
  return root;
}

function createTuneControl(item, control, onChange) {
  const wrapper = element("div", { class: "tune-control" });
  const valueLabel = element("span", { class: "tune-control-value", text: String(item.tune[control.id] ?? "") });
  const label = element("label", { class: "tune-control-label" });
  label.append(element("span", { text: control.label }), valueLabel);
  if (control.type === "color" || control.type === "font") valueLabel.hidden = true;
  if (control.type !== "spring" && control.type !== "pad") wrapper.append(label);
  const apply = (raw) => {
    // An element control opens its own undo step in applyTargetValue.
    if (!onChange) beginTuneEdit(item);
    item.tune[control.id] = raw;
    valueLabel.textContent = String(raw);
    if (onChange) {
      // After the change is saved, so Send sees it.
      onChange(raw);
      markTuneDirty();
      return;
    }
    markTuneDirty();
    postTuneAll(item.id);
    clearTimeout(tuneSaveTimer);
    tuneSaveTimer = setTimeout(() => flushTune(item), 350);
  };
  const dial = /** @type {any} */ (window).DialKit;
  if (control.type === "spring" && dial) {
    wrapper.classList.add("tune-spring");
    let spring;
    try {
      spring = JSON.parse(item.tune[control.id]);
    } catch {
      spring = {};
    }
    if (!spring || typeof spring !== "object" || Array.isArray(spring)) spring = {};
    spring = { type: "spring", stiffness: 180, damping: 20, mass: 1, ...spring };
    const host = element("div", { class: "dialkit-root", "data-theme": "light" });
    wrapper.append(host);
    const panelId = `liesel-${item.id}-${control.id}`;
    const kit = dial.createDialKit(control.label, { motion: spring }, { id: panelId });
    dial.DialStore.updateSpringMode(panelId, "motion", "advanced");
    let mounted;
    const props = () => ({
      panelId,
      path: "motion",
      label: control.label,
      spring,
      onChange: (next) => {
        spring = next;
        apply(JSON.stringify(next));
        mounted.update(props());
      },
    });
    mounted = dial.mountSpringControl(host, props());
    const preview = element("button", { class: "tune-preview", type: "button", text: "Play spring" });
    const dot = element("span", { class: "tune-preview-dot" });
    preview.append(dot);
    let animation = 0;
    preview.addEventListener("click", () => {
      cancelAnimationFrame(animation);
      const start = performance.now();
      let previous = start,
        x = 0,
        velocity = 0;
      const tick = (now) => {
        const dt = Math.min((now - previous) / 1000, 0.032);
        previous = now;
        velocity +=
          (((Number(spring.stiffness) || 180) * (1 - x) - (Number(spring.damping) || 20) * velocity) /
            (Number(spring.mass) || 1)) *
          dt;
        x += velocity * dt;
        dot.style.left = `${Math.max(5, Math.min(95, 10 + x * 75))}%`;
        if (now - start < 2500) animation = requestAnimationFrame(tick);
      };
      animation = requestAnimationFrame(tick);
    });
    wrapper.append(preview);
    tuneCleanup.push(() => {
      cancelAnimationFrame(animation);
      mounted.destroy();
      kit.destroy();
    });
  } else if (control.type === "easing" && dial) {
    const presets = {
      Ease: [0.25, 0.1, 0.25, 1],
      Linear: [0, 0, 1, 1],
      "Ease in": [0.42, 0, 1, 1],
      "Ease out": [0, 0, 0.58, 1],
      "Ease in out": [0.42, 0, 0.58, 1],
    };
    const match = String(item.tune[control.id]).match(/cubic-bezier\(([^)]+)\)/);
    let ease = match ? match[1].split(",").map(Number) : presets.Ease;
    if (ease.length !== 4 || ease.some((n) => !Number.isFinite(n))) ease = presets.Ease;
    const host = element("div", { class: "dialkit-root", "data-theme": "light" });
    const select = element("select", { "aria-label": `${control.label} preset` });
    select.append(element("option", { value: "", text: "Custom curve" }));
    for (const name of Object.keys(presets)) select.append(element("option", { value: name, text: name }));
    select.value = Object.keys(presets).find((name) => presets[name].every((part, i) => part === ease[i])) || "";
    wrapper.append(select, host);
    let mounted;
    const props = () => ({
      easing: { type: "easing", duration: 0.3, ease },
      onChange: (next) => {
        ease = next;
        select.value = "";
        apply(`cubic-bezier(${ease.join(", ")})`);
        mounted.update(props());
      },
    });
    mounted = dial.mountEasingVisualization(host, props());
    select.addEventListener("change", () => {
      if (presets[select.value]) {
        ease = presets[select.value];
        apply(`cubic-bezier(${ease.join(", ")})`);
        mounted.update(props());
      }
    });
    tuneCleanup.push(() => mounted.destroy());
  } else if (control.type === "pad" && dial) {
    let value;
    try {
      value = JSON.parse(item.tune[control.id]);
    } catch {
      value = {};
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
    value = { x: Number(value.x) || 0, y: Number(value.y) || 0 };
    const host = element("div", { class: "dialkit-root", "data-theme": "light" });
    wrapper.append(host);
    let mounted;
    const props = () => ({
      label: control.label,
      value,
      onChange: (next) => {
        value = next;
        apply(JSON.stringify(next));
        mounted.update(props());
      },
    });
    mounted = dial.mountDialPad(host, props());
    tuneCleanup.push(() => mounted.destroy());
  } else if (control.type === "timeline" && dial) {
    const from = Number(control.min ?? 0),
      to = Number(control.max ?? 100);
    const duration = Number(control.duration ?? 1);
    const timeline = dial.createDialTimeline(
      control.label,
      {
        duration,
        value: {
          at: 0,
          duration,
          from: { value: from },
          to: { value: to },
          transition: { type: "easing", duration, ease: [0, 0, 1, 1] },
        },
      },
      { autoplay: false },
    );
    const input = element("input", {
      type: "range",
      min: "0",
      max: String(duration),
      step: "0.01",
      "aria-label": `${control.label} playhead`,
    });
    const play = element("button", { class: "button", type: "button", text: "Play" });
    wrapper.append(input, play);
    const initialTime = Math.max(
      0,
      Math.min(duration, (duration * (Number(item.tune[control.id]) - from)) / (to - from || 1)),
    );
    timeline.seek(initialTime);
    input.value = String(initialTime);
    const unsubscribe = timeline.subscribe((values) => {
      input.value = String(values.time);
      play.textContent = values.playing ? "Pause" : "Play";
      const raw = Number(values.value.current.value.toFixed(4));
      apply(String(raw));
    }, false);
    input.addEventListener("input", () => timeline.seek(Number(input.value)));
    play.addEventListener("click", () => {
      if (timeline.values.playing) timeline.pause();
      else if (timeline.values.time >= duration) timeline.replay();
      else timeline.play();
    });
    tuneCleanup.push(() => {
      unsubscribe();
      timeline.destroy();
    });
  } else if (control.type === "color") {
    wrapper.append(createColourControl(control.label, item.tune[control.id], apply));
  } else if (control.type === "font") {
    wrapper.append(createFontControl(control, String(item.tune[control.id] ?? control.value ?? ""), apply));
  } else if (control.type === "select") {
    const select = element("select", {});
    for (const option of control.options || [])
      select.append(element("option", { value: option.value, text: option.label }));
    select.value = String(item.tune[control.id] ?? "");
    select.addEventListener("change", () => {
      apply(select.value);
      endTuneEdit();
    });
    bindTuneOptions(select, control.label, apply);
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
    const paint = () => {
      const low = Number(input.min) || 0;
      const high = Number(input.max) || 100;
      const percent = ((Number(input.value) - low) / (high - low || 1)) * 100;
      input.style.setProperty("--fill", `${Math.max(0, Math.min(100, percent))}%`);
    };
    input.addEventListener("input", paint);
    input.addEventListener("input", () => apply(input.value));
    input.addEventListener("change", endTuneEdit);
    paint();
    wrapper.append(input);
  }
  return wrapper;
}

/** @type {null | { select: HTMLSelectElement, close: (keep: boolean) => void }} */
let tuneOptions = null;

/**
 * A native select's popup says nothing until an option is committed, so the design
 * could not follow along. The select stays as the field and holds the value; its list
 * is ours, and every option reached shows live the way a slider does.
 * @param {HTMLSelectElement} select @param {string} label @param {(raw: string) => void} apply
 */
function bindTuneOptions(select, label, apply) {
  select.addEventListener("mousedown", (event) => {
    event.preventDefault();
    select.focus();
    if (tuneOptions?.select === select) tuneOptions.close(true);
    else openTuneOptions(select, label, apply);
  });
  select.addEventListener("keydown", (event) => {
    if (tuneOptions?.select === select || ![" ", "Enter", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    openTuneOptions(select, label, apply);
  });
  tuneCleanup.push(() => {
    if (tuneOptions?.select === select) tuneOptions.close(false);
  });
}

/** @param {HTMLSelectElement} select @param {string} label @param {(raw: string) => void} apply */
function openTuneOptions(select, label, apply) {
  tuneOptions?.close(true);
  const original = select.value;
  const values = [...select.options].map((option) => option.value);
  const menu = element("div", { class: "tune-options", role: "listbox", "aria-label": label });
  let active = Math.max(0, values.indexOf(original));
  /** @param {number} index */
  const show = (index) => {
    active = index;
    rows.forEach((row, at) => row.setAttribute("aria-selected", String(at === index)));
    rows[index].scrollIntoView({ block: "nearest" });
    if (select.value === values[index]) return;
    select.value = values[index];
    apply(values[index]);
  };
  const rows = [...select.options].map((option, index) => {
    const row = element("button", { class: "tune-option", type: "button", role: "option", text: option.textContent });
    row.tabIndex = -1;
    row.addEventListener("pointermove", () => show(index));
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => {
      show(index);
      close(true);
    });
    return row;
  });
  menu.append(...rows);
  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    const last = rows.length - 1;
    const moves = {
      ArrowDown: Math.min(last, active + 1),
      ArrowUp: Math.max(0, active - 1),
      Home: 0,
      End: last,
    };
    if (event.key in moves) show(moves[event.key]);
    else if (event.key === "Enter" || event.key === " " || event.key === "Tab") close(true);
    else if (event.key === "Escape") close(false);
    else return;
    if (event.key !== "Tab") event.preventDefault();
    event.stopPropagation();
  };
  /** @param {Event} event */
  const onOutside = (event) => {
    const target = /** @type {Node} */ (event.target);
    if (!menu.contains(target) && target !== select) close(false);
  };
  const onBlur = () => close(false);
  /** @param {boolean} keep */
  function close(keep) {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("scroll", onOutside, true);
    window.removeEventListener("blur", onBlur);
    menu.remove();
    tuneOptions = null;
    if (!keep && select.value !== original) {
      select.value = original;
      apply(original);
    }
    tuneEditHeld = false;
    endTuneEdit();
  }
  document.body.append(menu);
  const field = select.getBoundingClientRect();
  const below = window.innerHeight - field.bottom - 12;
  const upward = menu.offsetHeight > below && field.top > below;
  menu.style.left = `${field.left}px`;
  menu.style.width = `${field.width}px`;
  menu.style.maxHeight = `${Math.max(120, (upward ? field.top : below + 8) - 12)}px`;
  menu.style.top = upward ? "" : `${field.bottom + 4}px`;
  menu.style.bottom = upward ? `${window.innerHeight - field.top + 4}px` : "";
  tuneEditHeld = true;
  tuneOptions = { select, close };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("scroll", onOutside, true);
  window.addEventListener("blur", onBlur);
  show(active);
}

/*
 * Font: one picker at page and element level. It lists the fonts the page already uses
 * and loads, stacks every machine has, and Google Fonts, each name set in its own face,
 * with a search field that also takes any stack typed in. Moving through the list shows
 * each font live in the design; a click keeps it, Escape or a click away puts it back.
 */
// The 300 most popular Latin families on Google Fonts (https://fonts.google.com/metadata/fonts):
// name|kind (s sans, r serif, d display, h handwriting, m mono)|weights for the css2 API.
const GOOGLE_FONTS = `Inter|s|100..900
Montserrat|s|100..900
Open Sans|s|300..800
Roboto|s|100..900
Google Sans|s|400..700
Lato|s|100;300;400;700;900
Oswald|s|200..700
Arimo|s|400..700
Mulish|s|200..1000
Playfair Display|r|400..900
Poppins|s|100;200;300;400;500;600;700;800;900
Quicksand|s|300..700
Raleway|s|100..900
Roboto Mono|m|100..700
Titillium Web|s|200;300;400;600;700;900
Barlow|s|100;200;300;400;500;600;700;800;900
IBM Plex Sans|s|100..700
Libre Franklin|s|100..900
Nunito|s|200..1000
Roboto Condensed|s|100..900
EB Garamond|r|400..800
Nunito Sans|s|200..1000
Rubik|s|300..900
DM Sans|s|100..1000
IBM Plex Mono|m|100;200;300;400;500;600;700
Karla|s|200..800
Manrope|s|200..800
Source Sans 3|s|200..900
Cabin|s|400..700
Anton|s|
Exo 2|s|100..900
Outfit|s|100..900
Public Sans|s|100..900
Oxygen|s|300;400;700
PT Serif|r|400;700
Ubuntu|s|300;400;500;700
Bitter|r|100..900
Kanit|s|100;200;300;400;500;600;700;800;900
Prompt|s|100;200;300;400;500;600;700;800;900
Roboto Slab|r|100..900
Slabo 27px|r|
Be Vietnam Pro|s|100;200;300;400;500;600;700;800;900
Newsreader|r|200..800
Lilita One|d|
Plus Jakarta Sans|s|200..800
Lexend Deca|s|100..900
Merriweather|r|300..900
ABeeZee|s|
Bricolage Grotesque|s|200..800
Figtree|s|300..900
Lora|r|400..700
Work Sans|s|100..900
Archivo|s|100..900
Bebas Neue|s|
Red Hat Display|s|300..900
Tajawal|s|200;300;400;500;700;800;900
Barlow Condensed|s|100;200;300;400;500;600;700;800;900
Black Ops One|d|
Inter Tight|s|100..900
JetBrains Mono|m|100..800
Titan One|d|
LINE Seed JP|s|100;400;700;800
PT Sans|s|400;700
Archivo Narrow|s|400..700
Jost|s|100..900
Saira|s|100..900
Archivo Black|s|
Fugaz One|d|
Sofia Sans|s|1..1000
Source Code Pro|m|200..900
Inconsolata|m|200..900
Sora|s|100..800
Space Grotesk|s|300..700
Epilogue|s|100..900
Golos Text|s|400..900
IBM Plex Sans Arabic|s|100;200;300;400;500;600;700
Indie Flower|h|
Share Tech|s|
Cormorant Garamond|r|300..700
Forum|d|
Mukta|s|200;300;400;500;600;700;800
Red Hat Text|s|300..700
Cormorant|r|300..700
Fira Sans|s|100;200;300;400;500;600;700;800;900
Marcellus|r|
Quattrocento Sans|s|400;700
Balsamiq Sans|d|400;700
Zeyada|h|
Audiowide|d|
Libre Baskerville|r|400..700
Monda|s|400..700
Sanchez|r|
Smooch Sans|s|100..900
Aleo|r|100..900
Heebo|s|100..900
Fira Sans Extra Condensed|s|100;200;300;400;500;600;700;800;900
Instrument Serif|r|
News Cycle|s|400;700
Share Tech Mono|m|
Handlee|h|
Prata|r|
Courgette|h|
Fraunces|r|100..900
League Gothic|s|
Merriweather Sans|s|300..800
Alegreya|r|400..900
Righteous|d|
Cardo|r|400;700
Dancing Script|h|400..700
Gothic A1|s|100;200;300;400;500;600;700;800;900
Averia Serif Libre|d|300;400;700
Geist|s|100..900
Cairo|s|200..1000
Google Sans Code|m|300..800
Arapey|r|
Biryani|s|200;300;400;600;700;800;900
Changa One|d|
Pinyon Script|h|
Rajdhani|s|300;400;500;600;700
Reenie Beanie|h|
Google Sans Flex|s|1..1000
Josefin Sans|s|100..700
PT Sans Caption|s|400;700
Assistant|s|200..800
Italianno|h|
Krub|s|200;300;400;500;600;700
Alfa Slab One|d|
Mitr|s|200;300;400;500;600;700
Unbounded|s|200..900
Caveat|h|400..700
Kaushan Script|h|
Palanquin|s|100;200;300;400;500;600;700
Aboreto|d|
Bowlby One SC|d|
Gelasio|r|400..700
Goldman|d|400;700
Lexend|s|100..900
Libre Caslon Display|r|
Orbitron|s|400..900
Rubik Mono One|s|
Schibsted Grotesk|s|400..900
Covered By Your Grace|h|
Fjalla One|s|
Merienda|h|300..900
Ramabhadra|s|
Roboto Serif|r|100..900
Anonymous Pro|m|400;700
Carlito|s|400;700
Exo|s|100..900
Familjen Grotesk|s|400..700
Special Gothic Expanded One|s|
STIX Two Text|r|400..700
Urbanist|s|100..900
Hanken Grotesk|s|100..900
Instrument Sans|s|400..700
Tiro Devanagari Hindi|r|
Zen Kaku Gothic Antique|s|300;400;500;700;900
Alumni Sans|s|100..900
Courier Prime|m|400;700
Hind Siliguri|s|300;400;500;600;700
Six Caps|s|
Varela|s|
Bodoni Moda|r|400..900
DM Serif Display|r|
Funnel Sans|s|300..800
Wix Madefor Display|s|400..800
Lobster Two|d|400;700
Source Serif 4|r|200..900
Crimson Pro|r|200..900
Geo|s|
Nanum Gothic|s|400;700;800
Cuprum|s|400..700
Gabarito|d|400..900
Lobster|d|
Anek Latin|s|100..800
Big Shoulders|d|100..900
Domine|r|400..700
Roboto Flex|s|100..1000
Alef|s|400;700
Cinzel|r|400..900
Jura|s|300..700
Dosis|s|200..800
Fredoka|s|300..700
Ultra|r|
Alegreya Sans|s|100;300;400;500;700;800;900
Norican|h|
Questrial|s|
Geist Mono|m|100..900
Satisfy|h|
Bree Serif|r|
Chivo Mono|m|100..900
M PLUS Rounded 1c|s|100;300;400;500;700;800;900
Sedgwick Ave Display|h|
Andika|s|400;700
Anek Telugu|s|100..800
IBM Plex Sans Condensed|s|100;200;300;400;500;600;700
Limelight|d|
Marcellus SC|r|
Shadows Into Light Two|h|
Zilla Slab|r|300;400;500;600;700
Anuphan|s|100..700
Hind|s|300;400;500;600;700
Tinos|r|400;700
Ysabeau Office|s|1..1000
Mali|h|200;300;400;500;600;700
Pacifico|h|
Crimson Text|r|400;600;700
Lexend Giga|s|100..900
Barlow Semi Condensed|s|100;200;300;400;500;600;700;800;900
DM Mono|m|300;400;500
Fredericka the Great|d|
Rozha One|r|
Russo One|s|
Arvo|r|400;700
Encode Sans|s|100..900
Overpass|s|100..900
Kantumruy Pro|s|100..700
Karma|r|300;400;500;600;700
Kreon|r|300..700
Teko|s|300..700
Cantata One|r|
Comfortaa|d|300..700
Oleo Script Swash Caps|d|400;700
Red Hat Mono|m|300..700
Chakra Petch|s|300;400;500;600;700
Khand|s|300;400;500;600;700
Schoolbell|h|
Fragment Mono|m|
Frank Ruhl Libre|r|300..900
Great Vibes|h|
Kodchasan|s|200;300;400;500;600;700
Numans|s|
PT Sans Narrow|s|400;700
Sacramento|h|
Arbutus Slab|r|
Bungee|d|
David Libre|r|400;500;700
Asul|r|400;700
Candal|s|
Mandali|s|
Mansalva|h|
Martian Mono|m|100..800
Zen Kaku Gothic New|s|300;400;500;700;900
Faustina|r|300..800
Geologica|s|100..900
Hepta Slab|r|1..900
Abel|s|
Gotu|s|
Petrona|r|100..900
Varela Round|s|
Klee One|h|400;600
Onest|s|100..900
Sancreek|d|
Sigmar One|d|
Sometype Mono|m|400..700
M PLUS 1p|s|100;300;400;500;700;800;900
Mrs Saint Delafield|h|
Sofia Sans Semi Condensed|s|1..1000
Almendra|r|400;700
Calistoga|d|
Gravitas One|d|
Kalam|h|300;400;700
Maven Pro|s|400..900
Sarabun|s|100;200;300;400;500;600;700;800
Space Mono|m|400;700
Almarai|s|300;400;700;800
Dela Gothic One|d|
Palanquin Dark|s|400;500;600;700
Seaweed Script|d|
Shadows Into Light|h|
Zen Antique Soft|r|
Baloo 2|d|400..800
DynaPuff|d|400..700
Fira Code|m|300..700
Albert Sans|s|100..900
Asap|s|100..900
Abril Fatface|d|
Cinzel Decorative|d|400;700;900
Fondamento|h|
Hi Melody|h|
Just Another Hand|h|
Rubik Dirt|d|
Kablammo|d|
Lustria|r|
Saira Condensed|s|100;200;300;400;500;600;700;800;900
Cactus Classical Serif|r|
Luckiest Guy|d|
Syne|s|400..800
Agbalumo|d|
Hammersmith One|s|
Play|s|400;700
Playfair Display SC|r|400;700;900
Baskervville|r|400..700
Permanent Marker|h|
Spline Sans|s|300..700
Halant|r|300;400;500;600;700
IBM Plex Serif|r|100;200;300;400;500;600;700
Overlock|d|400;700;900
Sofia Sans Condensed|s|1..1000
Dongle|s|300;400;700`
  .split("\n")
  .map((line) => {
    const [name, kind, weights] = line.split("|");
    return { name, kind, weights };
  });
/** @type {Record<string, string>} */
const GOOGLE_GENERIC = { s: "sans-serif", r: "serif", d: "sans-serif", h: "cursive", m: "monospace" };
const GOOGLE_FONT_BY_NAME = new Map(GOOGLE_FONTS.map((font) => [font.name.toLowerCase(), font]));

/** The first family a stack names, unquoted. @param {string} stack */
function fontName(stack) {
  return (
    String(stack || "")
      .split(",")[0]
      .replace(/["']/g, "")
      .trim() || "Font"
  );
}

/** The Google font a stack starts with, if it is one. @param {string} stack */
function googleFontFor(stack) {
  return GOOGLE_FONT_BY_NAME.get(fontName(stack).toLowerCase()) || null;
}

/** @param {{ name: string, kind: string, weights: string }} font */
function googleFontStack(font) {
  return `"${font.name}", ${GOOGLE_GENERIC[font.kind] || "sans-serif"}`;
}

/** Google Fonts' stylesheet for a family; with `text`, only the letters a preview needs. @param {{ name: string, weights: string }} font @param {string} [text] */
function googleFontHref(font, text = "") {
  const family = encodeURIComponent(font.name).replace(/%20/g, "+");
  const axis = font.weights ? `:wght@${font.weights}` : "";
  const only = text ? `&text=${encodeURIComponent(text)}` : "";
  return `https://fonts.googleapis.com/css2?family=${family}${axis}&display=swap${only}`;
}

const previewedFonts = new Set();
/** Load just enough of a Google font for the picker to set its name in it. @param {{ name: string, weights: string }} font */
function previewGoogleFont(font) {
  if (previewedFonts.has(font.name)) return;
  previewedFonts.add(font.name);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = googleFontHref({ name: font.name, weights: "" }, font.name);
  document.head.append(link);
}

/**
 * A design shows a Google font only once it loads it: before a font-family reaches a
 * frame, the frame is handed that font's stylesheet.
 * @param {string} itemId @param {string} deviceId @param {any} message
 */
function sendFontLinks(itemId, deviceId, message) {
  /** @type {string[]} */
  const stacks = [];
  if (message.type === "style" && message.css === "font-family") stacks.push(String(message.value || ""));
  if (message.type === "element-tune" && message.values && typeof message.values === "object") {
    for (const css of Object.values(message.values))
      if (css && css["font-family"]) stacks.push(String(css["font-family"]));
  }
  for (const stack of stacks) {
    const font = googleFontFor(stack);
    if (font) postToArtboard(itemId, deviceId, { type: "font-link", href: googleFontHref(font), family: font.name });
  }
}

/** @param {any} control @param {string} value @param {(raw: string) => void} apply */
function createFontControl(control, value, apply) {
  const field = element("button", { class: "tune-font-field", type: "button", "aria-haspopup": "listbox" });
  /** @param {string} stack */
  const show = (stack) => {
    field.textContent = fontName(stack);
    field.style.fontFamily = stack;
    const font = googleFontFor(stack);
    if (font) previewGoogleFont(font);
  };
  show(value);
  let current = value;
  field.addEventListener("click", () => {
    if (fontPicker?.field === field) {
      fontPicker.close(true);
      return;
    }
    openFontPicker(
      field,
      control,
      current,
      (raw) => {
        show(raw);
        apply(raw);
      },
      (kept) => {
        current = kept;
        show(kept);
      },
    );
  });
  tuneCleanup.push(() => {
    if (fontPicker?.field === field) fontPicker.close(false);
  });
  return field;
}

/** @type {null | { field: HTMLElement, close: (keep: boolean) => void }} */
let fontPicker = null;

/**
 * @param {HTMLElement} field @param {any} control @param {string} original
 * @param {(raw: string) => void} apply @param {(kept: string) => void} done
 */
function openFontPicker(field, control, original, apply, done) {
  fontPicker?.close(true);
  tuneOptions?.close(true);
  const options = Array.isArray(control.options) ? control.options : [];
  /** @type {{ value: string, label: string, group: string, google?: any }[]} */
  const all = [
    ...options.filter((option) => option.group !== "system").map((option) => ({ ...option, group: "page" })),
    ...options.filter((option) => option.group === "system"),
    ...GOOGLE_FONTS.filter((font) => !options.some((option) => fontName(option.value) === font.name)).map((font) => ({
      value: googleFontStack(font),
      label: font.name,
      group: "google",
      google: font,
    })),
  ];
  const GROUPS = /** @type {Record<string, string>} */ ({
    page: "On this page",
    system: "System",
    google: "Google Fonts",
  });
  const menu = element("div", { class: "tune-fonts", role: "dialog", "aria-label": `${control.label} picker` });
  const search = /** @type {HTMLInputElement} */ (
    element("input", {
      class: "tune-fonts-search",
      type: "search",
      placeholder: "Search fonts, or type a font stack",
      "aria-label": "Search fonts",
      spellcheck: "false",
      autocomplete: "off",
    })
  );
  const list = element("div", { class: "tune-fonts-list", role: "listbox", "aria-label": control.label });
  menu.append(search, list);
  /** @type {{ row: HTMLElement, value: string }[]} */
  let rows = [];
  let active = -1;
  let live = original;
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const font = GOOGLE_FONT_BY_NAME.get(String(/** @type {HTMLElement} */ (entry.target).dataset.google));
        if (font) previewGoogleFont(font);
        seen.unobserve(entry.target);
      }
    },
    { root: list, rootMargin: "120px 0px" },
  );
  /** @param {number} index @param {boolean} [scroll] */
  const point = (index, scroll = true) => {
    active = index;
    rows.forEach((entry, at) => entry.row.setAttribute("aria-selected", String(at === index)));
    const entry = rows[index];
    if (!entry) return;
    if (scroll) entry.row.scrollIntoView({ block: "nearest" });
    if (entry.value === live) return;
    live = entry.value;
    apply(entry.value);
  };
  const render = () => {
    const query = search.value.trim();
    const needle = query.toLowerCase();
    const found = needle ? all.filter((option) => option.label.toLowerCase().includes(needle)) : all;
    /** @type {HTMLElement[]} */
    const nodes = [];
    rows = [];
    // Anything typed is a stack of its own, for a font the lists do not have.
    if (query && !found.some((option) => option.label.toLowerCase() === needle)) {
      nodes.push(element("div", { class: "tune-fonts-group", text: "Use as typed" }));
      const row = fontRow(query, query);
      nodes.push(row);
      rows.push({ row, value: query });
    }
    let group = "";
    for (const option of found) {
      if (option.group !== group) {
        group = option.group;
        nodes.push(element("div", { class: "tune-fonts-group", text: GROUPS[group] || group }));
      }
      const row = fontRow(option.label, option.value);
      if (option.google) {
        row.dataset.google = option.google.name.toLowerCase();
        seen.observe(row);
      }
      nodes.push(row);
      rows.push({ row, value: option.value });
    }
    if (rows.length === 0) nodes.push(element("p", { class: "tune-fonts-empty", text: "No font by that name." }));
    list.replaceChildren(...nodes);
    active = rows.findIndex((entry) => entry.value === live);
    rows.forEach((entry, at) => entry.row.setAttribute("aria-selected", String(at === active)));
    rows[active]?.row.scrollIntoView({ block: "nearest" });
  };
  /** @param {string} label @param {string} value */
  function fontRow(label, value) {
    const row = element("button", { class: "tune-font-option", type: "button", role: "option", text: label });
    row.tabIndex = -1;
    row.style.fontFamily = value;
    row.addEventListener("pointermove", () => {
      const index = rows.findIndex((entry) => entry.row === row);
      if (index !== active) point(index, false);
    });
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => {
      point(rows.findIndex((entry) => entry.row === row));
      close(true);
    });
    return row;
  }
  search.addEventListener("input", render);
  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    const last = rows.length - 1;
    if (event.key === "ArrowDown") point(Math.min(last, active + 1));
    else if (event.key === "ArrowUp") point(Math.max(0, active - 1));
    else if (event.key === "Enter") {
      if (active < 0 && rows.length > 0) point(0);
      close(true);
    } else if (event.key === "Escape") close(false);
    else if (event.key === "Tab") close(true);
    else return;
    if (event.key !== "Tab") event.preventDefault();
    event.stopPropagation();
  };
  /** @param {Event} event */
  const onOutside = (event) => {
    const target = /** @type {Node} */ (event.target);
    if (!menu.contains(target) && target !== field) close(false);
  };
  const onBlur = () => close(false);
  /** @param {boolean} keep */
  function close(keep) {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("blur", onBlur);
    seen.disconnect();
    menu.remove();
    fontPicker = null;
    if (!keep && live !== original) {
      live = original;
      apply(original);
    }
    done(live);
    tuneEditHeld = false;
    endTuneEdit();
    field.focus();
  }
  document.body.append(menu);
  const at = field.getBoundingClientRect();
  const below = window.innerHeight - at.bottom - 12;
  const upward = below < 320 && at.top > below;
  menu.style.left = `${at.left}px`;
  menu.style.width = `${Math.max(at.width, 240)}px`;
  menu.style.maxHeight = `${Math.min(420, Math.max(160, (upward ? at.top : below + 8) - 12))}px`;
  menu.style.top = upward ? "" : `${at.bottom + 4}px`;
  menu.style.bottom = upward ? `${window.innerHeight - at.top + 4}px` : "";
  tuneEditHeld = true;
  fontPicker = { field, close };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("blur", onBlur);
  render();
  search.focus();
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
        { channel: "liesel", item: item.id, type: "tune", values: tuneCss(item, spec, version.values) },
        "*",
      );
    });
    thumb.append(frame);
    button.append(thumb, element("span", { class: "version-label", text: version.label }));
    button.setAttribute("aria-current", String(JSON.stringify(version.values) === JSON.stringify(item.tune)));
    button.addEventListener("click", () => {
      const current = itemById(item.id);
      if (!current) return;
      clearTimeout(tuneSaveTimer);
      current.tune = { ...version.values };
      postTuneAll(current.id);
      flushTune(current);
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
        const current = itemById(item.id);
        if (!current) return;
        if (payload?.versions) current.versions = payload.versions;
        renderVersions(current, tuneSpecFor(current.id));
      })
      .catch(() => {}),
  );
}

function resetTune() {
  if (tuneTarget) {
    resetTargetTune();
    return;
  }
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
  // Only values the reviewer moved away from the page's own are worth handing back.
  const lines = tuneSpecFor(item.id)
    .filter(
      (control) =>
        item.tune[control.id] !== undefined &&
        item.tune[control.id] !== "" &&
        String(item.tune[control.id]) !== String(control.value ?? ""),
    )
    .map((control) => {
      const value =
        (control.type === "number" || control.type === "timeline") && control.unit
          ? `${item.tune[control.id]}${control.unit}`
          : item.tune[control.id];
      return `- ${control.label}: ${value}  (${control.css})`;
    });
  const target = tuneTarget ? copyTargetTune() : "";
  const text = tuneTarget
    ? target || `No changes to ${tuneTarget.label || "this element"}.`
    : lines.length > 0
      ? `Bake these tune values into ${item.file} as CSS custom properties:\n${lines.join("\n")}`
      : `No tune values set for ${item.file}.`;
  const sub = document.getElementById("tuneSub");
  const done = () => {
    if (sub) sub.textContent = "Copied";
    setTimeout(() => {
      if (sub && sub.textContent === "Copied") sub.textContent = "";
    }, 1600);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
  else done();
}

/* --------------------------------------------------------- project boards */

// A project board gets its server going by itself as it opens (unless the user stopped it).
// Its state shows only in the frames, and only when something is wrong; Settings, under
// Advanced, holds Start, Stop, Restart, the command and the port. The top bar's Pages opens
// the page picker, which chooses the board's live pages.
/** @type {Set<string>} items whose next settled render should be saved as a history round */
const liveSnapshotWanted = new Set();
/** @type {Map<string, number>} pending "did the page update?" checks, by artboard */
const liveStaleChecks = new Map();

function isProjectBoard() {
  return Boolean(project);
}

function liveItems() {
  return state.items.filter((item) => item.page);
}

function reloadLiveFrames() {
  for (const item of liveItems()) reloadItem(item);
}

function onProjectEvent(view) {
  if (!view || typeof view !== "object") return;
  const before = project;
  project = view;
  // A frame showing "starting" or "no dev server" comes back to the real page, and a frame
  // whose server went away, or never could start, shows why.
  const changed =
    before?.dev?.status !== project.dev?.status ||
    (before?.issue || "") !== (project.issue || "") ||
    before?.proxy !== project.proxy ||
    before?.mode !== project.mode ||
    Boolean(before?.busy) !== Boolean(project.busy) ||
    Boolean(before?.gave_up) !== Boolean(project.gave_up) ||
    before?.port !== project.port;
  if (before && changed) reloadLiveFrames();
  renderProjectBar();
  if (pagesOpen() && projectReady() && !pagesPicker.siteRead) void loadPickerPages();
  if (pagesOpen()) queuePreviews();
}

/** Is the project's server up, so its pages can be read and previewed? */
function projectReady() {
  if (!project || project.busy || project.user_stopped || project.gave_up) return false;
  if (project.mode === "static" || project.mode === "reused") return true;
  return project.dev?.status === "running" && Boolean(project.port);
}

function onProjectSource() {
  for (const item of liveItems()) liveSnapshotWanted.add(item.id);
  for (const record of state.artboards.values()) {
    const item = itemById(record.itemId);
    if (!item?.page) continue;
    postToArtboard(record.itemId, record.device.id, { type: "source-changed" });
  }
}

/** The live frame answered "nothing changed after the save": the board reloads it. */
function onLiveStale(itemId, deviceId) {
  const id = artboardKey(itemId, deviceId);
  if (liveStaleChecks.has(id)) return;
  const record = state.artboards.get(id);
  const item = itemById(itemId);
  if (!record || !item?.page) return;
  liveStaleChecks.set(id, Date.now());
  window.setTimeout(() => liveStaleChecks.delete(id), 1500);
  record.loaded = false;
  // The frame reloads the path it was on, not only the item's own page.
  const page = record.page || item.page;
  record.iframe.src = project?.proxy ? `${project.proxy}${page}` : "about:blank";
}

function onLiveSnapshot(itemId, data) {
  const item = itemById(itemId);
  if (!item?.page) return;
  const html = typeof data.html === "string" ? data.html : "";
  const wanted = liveSnapshotWanted.has(itemId) || (item.builds || []).length === 0;
  if (!html || !wanted) return;
  liveSnapshotWanted.delete(itemId);
  fetch(`/api/boards/${encodeURIComponent(key)}/live-snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item: itemId, html, page: String(data.page || item.page) }),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (payload?.recorded) refreshBoard();
    })
    .catch(() => {});
}

function projectRequest(route, body) {
  return fetch(`/api/boards/${encodeURIComponent(key)}/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload;
  });
}

let detectedDev = null;
function loadProject() {
  if (!isProjectBoard()) return Promise.resolve();
  return projectRequest("project")
    .then((payload) => {
      detectedDev = payload.detected || null;
      onProjectEvent(payload);
      fillProjectSettings();
    })
    .catch(() => {});
}

/** Opening the board starts its dev server, the same way Start does. */
function autoStartDevServer() {
  projectRequest("project/start", { auto: true })
    .then((payload) => {
      onProjectEvent(payload);
      fillProjectSettings();
    })
    .catch(() => {});
}

const DEV_STATUS_TEXT = {
  stopped: "Server off",
  starting: "Starting…",
  running: "Server on",
  exited: "Server exited",
  failed: "Server failed",
};

/** The server's state in words, for Settings, Advanced. */
function devStatusWords() {
  const dev = project?.dev || {};
  const status = String(dev.status || "stopped");
  const port = Number(project?.port || dev.port || 0);
  if (project?.user_stopped) return { state: "stopped", text: "Server off", hint: "" };
  if (project?.mode === "reused")
    return { state: "running", text: "Using a server already running", hint: `localhost:${port}` };
  if (project?.mode === "static")
    return { state: "running", text: "Serving the folder", hint: "No dev script, so Liesel serves its files itself." };
  if (project?.gave_up)
    return { state: "failed", text: "Server failed", hint: [dev.error, dev.last_line].filter(Boolean).join(" · ") };
  if (project?.busy || status === "starting") return { state: "starting", text: "Starting…", hint: dev.command || "" };
  if (status === "stopped" && project?.issue)
    return { state: "failed", text: "No way to run it found", hint: project.issue };
  if (status === "stopped" && project?.config?.port && !project?.config?.command)
    return { state: "running", text: "Server on", hint: `Showing localhost:${project.config.port}` };
  const hint =
    status === "failed"
      ? [dev.error, dev.last_line].filter(Boolean).join(" · ")
      : status === "running"
        ? `${dev.command || ""}${port ? `${dev.command ? " · " : ""}localhost:${port}` : ""}`
        : status === "exited"
          ? dev.last_line || ""
          : "";
  return { state: status, text: DEV_STATUS_TEXT[status] || status, hint };
}

function renderProjectBar() {
  const bar = document.getElementById("projectBar");
  if (!bar) return;
  bar.hidden = !isProjectBoard();
  if (!project) return;
  const dev = project.dev || {};
  const words = devStatusWords();
  const status = document.getElementById("devStatus");
  if (status) {
    status.dataset.state = words.state;
    status.textContent = words.text;
  }
  const hint = document.getElementById("devStatusHint");
  if (hint) hint.textContent = words.hint;
  // A server told to stop reads as stopped at once, while its process winds down.
  const active =
    !project.user_stopped &&
    ((Boolean(dev.running) && dev.status !== "stopped") || project.mode === "static" || project.mode === "reused");
  const show = (id, visible) => {
    const button = document.getElementById(id);
    if (button) button.hidden = !visible;
  };
  show("devRestart", active);
  show("devStop", active);
  show("devStart", !active && !project.busy);
  const output = document.getElementById("devOutput");
  if (output) output.textContent = String(dev.output || "");
  const box = document.getElementById("devOutputBox");
  if (box) box.hidden = !dev.output;
}

/** A long path keeps its start and its last folder, cut in the middle. */
function fillPath(target, value) {
  if (!target) return;
  const text = String(value || "");
  const cut = text.lastIndexOf("/", text.length - 2);
  const head = target.querySelector(".settings-path-head");
  const tail = target.querySelector(".settings-path-tail");
  if (head && tail) {
    head.textContent = cut > 0 ? text.slice(0, cut) : "";
    tail.textContent = cut > 0 ? text.slice(cut) : text;
  } else target.textContent = text;
  target.setAttribute("title", text);
}

function fillProjectSettings() {
  if (!project) return;
  fillPath(document.getElementById("projectRoot"), project.root || "");
  const command = /** @type {HTMLInputElement | null} */ (document.getElementById("devCommand"));
  const port = /** @type {HTMLInputElement | null} */ (document.getElementById("devPort"));
  if (command && document.activeElement !== command) {
    command.value = project.config?.command || "";
    command.placeholder = detectedDev?.command || "npm run dev";
  }
  if (port && document.activeElement !== port) {
    port.value = project.config?.port ? String(project.config.port) : "";
    port.placeholder = detectedDev?.port ? String(detectedDev.port) : "3000";
  }
  const hint = document.getElementById("devDetected");
  if (hint) {
    hint.textContent = detectedDev
      ? `Found ${detectedDev.framework ? `${detectedDev.framework}, ` : ""}the "${detectedDev.script}" script in package.json. It runs when the board opens.`
      : "No dev script in package.json, so Liesel serves the folder's HTML files itself. Type a command only if the project needs one.";
  }
  renderProjectBar();
}

function setProjectStatus(text) {
  const status = document.getElementById("projectStatus");
  if (status) status.textContent = text;
}

/** Saves the command and port as they change; a running server picks them up on Restart. */
function saveDevConfig(event) {
  event?.preventDefault();
  const command = /** @type {HTMLInputElement | null} */ (document.getElementById("devCommand"));
  const port = /** @type {HTMLInputElement | null} */ (document.getElementById("devPort"));
  const body = { command: command?.value.trim() || "", port: port?.value.trim() || "" };
  if (body.command === (project?.config?.command || "") && body.port === String(project?.config?.port || ""))
    return Promise.resolve(true);
  return projectRequest("project/dev", body)
    .then((payload) => {
      detectedDev = payload.detected || detectedDev;
      onProjectEvent(payload);
      fillProjectSettings();
      setProjectStatus("");
      flashSettingsSaved(payload.dev?.running ? "Saved. Restart to use it" : "Saved");
      return true;
    })
    .catch((failure) => {
      setProjectStatus(failure.message);
      return false;
    });
}

/** @param {"start" | "stop" | "restart"} action */
function devServerAction(action) {
  const button = document.getElementById(`dev${action[0].toUpperCase()}${action.slice(1)}`);
  if (button) /** @type {HTMLButtonElement} */ (button).disabled = true;
  projectRequest(`project/${action}`, {})
    .then((payload) => {
      onProjectEvent(payload);
      setProjectStatus("");
    })
    .catch((failure) => setProjectStatus(failure.message))
    .finally(() => {
      if (button) /** @type {HTMLButtonElement} */ (button).disabled = false;
    });
}

/* ------------------------------------------------------------ page picker */

// The page picker is a full page over the board, like Settings. It lists the project's
// pages (routes on disk, the running site's sitemap and links, and the board's own pages),
// each with a small live preview once the server is up. What is ticked when you press
// Show becomes the board's set of live pages; a page left out can be brought back with Undo.
const pagesPicker = {
  panel: document.getElementById("pagesPicker"),
  /** @type {Array<{ path: string, source: string, pattern?: string }>} */
  pages: [],
  /** @type {Map<string, boolean>} */
  checked: new Map(),
  skipped: /** @type {string[]} */ ([]),
  siteRead: false,
  loading: false,
  /** @type {Set<string>} paths whose preview has been asked for */
  previewed: new Set(),
  /** @type {IntersectionObserver | null} */
  observer: null,
  previewQueue: /** @type {HTMLElement[]} */ ([]),
  previewsLoading: 0,
};
const PAGES_HASH = "#pages";

function pagesOpen() {
  return Boolean(pagesPicker.panel && !pagesPicker.panel.hidden);
}

/** Is a full page (Settings or the page picker) over the board? */
function overlayOpen() {
  return settingsOpen() || pagesOpen();
}

function boardLivePages() {
  return liveItems().map((item) => String(item.page));
}

/** @param {boolean} open */
function setPagesOpen(open) {
  const panel = pagesPicker.panel;
  if (!panel || open === pagesOpen()) return;
  if (open && settingsOpen()) setSettingsOpen(false);
  panel.hidden = !open;
  document.getElementById("pagesToggle")?.setAttribute("aria-expanded", String(open));
  if (open) {
    panel.scrollTop = 0;
    pagesPicker.checked = new Map(boardLivePages().map((page) => [page, true]));
    pagesPicker.pages = boardLivePages().map((page) => ({ path: page, source: "board" }));
    pagesPicker.siteRead = false;
    pagesPicker.previewed.clear();
    const filter = /** @type {HTMLInputElement | null} */ (document.getElementById("pagesFilter"));
    if (filter) filter.value = "";
    setPagesError("");
    renderPickerRows();
    void loadPickerPages();
    document.getElementById("pagesApply")?.focus({ preventScroll: true });
  } else {
    pagesPicker.observer?.disconnect();
    pagesPicker.previewQueue = [];
    const rows = document.getElementById("pagesRows");
    if (rows) rows.textContent = "";
    if (location.hash === PAGES_HASH)
      window.history.replaceState(window.history.state, "", location.pathname + location.search);
    document.getElementById("pagesToggle")?.focus({ preventScroll: true });
  }
}

function setPagesError(text) {
  const error = document.getElementById("pagesError");
  if (error) error.textContent = text;
}

/** Reads the project's pages, keeping what has been ticked or added here. */
function loadPickerPages() {
  if (pagesPicker.loading) return Promise.resolve();
  pagesPicker.loading = true;
  return projectRequest("project/pages")
    .then((payload) => {
      if (!pagesOpen()) return;
      const known = new Map(pagesPicker.pages.map((page) => [page.path, page]));
      for (const page of Array.isArray(payload.pages) ? payload.pages : []) {
        if (typeof page?.path !== "string") continue;
        const mine = known.get(page.path);
        // A page added by hand keeps its place; the server's word on the rest wins.
        if (!mine || mine.source !== "typed") known.set(page.path, page);
      }
      pagesPicker.pages = [...known.values()].sort((a, b) =>
        a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path),
      );
      pagesPicker.skipped = Array.isArray(payload.skipped) ? payload.skipped.map(String) : [];
      pagesPicker.siteRead = Boolean(payload.site_read);
    })
    .catch((failure) => setPagesError(failure.message))
    .finally(() => {
      pagesPicker.loading = false;
      if (pagesOpen()) renderPickerRows();
    });
}

/** @param {string} page */
function pageTitle(page) {
  return page === "/" ? "Home" : decodeSafely(page);
}

/** @param {string} value */
function decodeSafely(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function filteredPickerPages() {
  const filter = /** @type {HTMLInputElement | null} */ (document.getElementById("pagesFilter"));
  const query = (filter?.value || "").trim().toLowerCase();
  if (!query) return pagesPicker.pages;
  return pagesPicker.pages.filter((page) => `${pageTitle(page.path)} ${page.path}`.toLowerCase().includes(query));
}

function renderPickerRows() {
  const rows = document.getElementById("pagesRows");
  if (!rows) return;
  pagesPicker.observer?.disconnect();
  pagesPicker.previewQueue = [];
  rows.textContent = "";
  const filter = document.getElementById("pagesFilter");
  if (filter) filter.hidden = pagesPicker.pages.length <= 12;
  const visible = filteredPickerPages();
  for (const page of visible) rows.append(pickerRow(page));
  const status = document.getElementById("pagesStatus");
  if (status) {
    status.hidden = visible.length > 0 && !pagesPicker.loading;
    status.textContent =
      pagesPicker.pages.length === 0
        ? pagesPicker.loading
          ? "Finding pages…"
          : "No pages found yet. Add one by its path below."
        : visible.length === 0
          ? "No page matches."
          : "Finding pages…";
  }
  const note = document.getElementById("pagesNote");
  if (note) {
    const skipped = pagesPicker.skipped;
    note.hidden = skipped.length === 0;
    note.textContent = skipped.length
      ? `Left out, because each needs a real value in its path: ${skipped.slice(0, 6).map(decodeSafely).join(", ")}${skipped.length > 6 ? ` and ${skipped.length - 6} more` : ""}.`
      : "";
  }
  renderPickerSummary();
  observePreviews();
}

/** @param {{ path: string, source: string, pattern?: string }} page */
function pickerRow(page) {
  const row = element("label", { class: "settings-row pages-row", "data-page": page.path });
  const box = /** @type {HTMLInputElement} */ (element("input", { type: "checkbox" }));
  box.checked = pagesPicker.checked.get(page.path) === true;
  box.addEventListener("change", () => {
    pagesPicker.checked.set(page.path, box.checked);
    renderPickerSummary();
  });
  const preview = element("span", { class: "pages-preview", "aria-hidden": "true" });
  const text = element("span", { class: "pages-row-text" });
  text.append(element("span", { class: "pages-row-title", text: pageTitle(page.path) }));
  if (page.pattern)
    text.append(element("span", { class: "pages-row-hint", text: `An example of ${decodeSafely(page.pattern)}` }));
  row.append(box, preview, text);
  return row;
}

function renderPickerSummary() {
  const all = /** @type {HTMLInputElement | null} */ (document.getElementById("pagesAll"));
  const total = pagesPicker.pages.length;
  const ticked = pagesPicker.pages.filter((page) => pagesPicker.checked.get(page.path)).length;
  if (all) {
    all.checked = total > 0 && ticked === total;
    all.indeterminate = ticked > 0 && ticked < total;
    all.disabled = total === 0;
  }
  const count = document.getElementById("pagesCount");
  if (count) count.textContent = total ? `${ticked} of ${total}` : "";
  const apply = /** @type {HTMLButtonElement | null} */ (document.getElementById("pagesApply"));
  if (apply) {
    apply.textContent = ticked === 0 ? "Show no pages" : ticked === 1 ? "Show 1 page" : `Show ${ticked} pages`;
  }
}

/** Previews load as their rows come into view, two at a time, once the server is up. */
function observePreviews() {
  const rows = document.getElementById("pagesRows");
  if (!rows || typeof IntersectionObserver !== "function") return;
  pagesPicker.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        pagesPicker.observer?.unobserve(entry.target);
        pagesPicker.previewQueue.push(/** @type {HTMLElement} */ (entry.target));
      }
      queuePreviews();
    },
    { root: pagesPicker.panel, rootMargin: "200px 0px" },
  );
  for (const row of rows.querySelectorAll(".pages-row")) pagesPicker.observer.observe(row);
}

function queuePreviews() {
  if (!projectReady() || !project?.proxy) return;
  while (pagesPicker.previewsLoading < 2 && pagesPicker.previewQueue.length > 0) {
    const row = /** @type {HTMLElement} */ (pagesPicker.previewQueue.shift());
    const page = row.dataset.page || "";
    const slot = row.querySelector(".pages-preview");
    if (!slot || !row.isConnected || slot.querySelector("iframe")) continue;
    pagesPicker.previewsLoading += 1;
    const frame = /** @type {HTMLIFrameElement} */ (
      element("iframe", {
        tabindex: "-1",
        title: "",
        loading: "lazy",
        scrolling: "no",
        sandbox: "allow-scripts allow-same-origin",
      })
    );
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pagesPicker.previewsLoading = Math.max(0, pagesPicker.previewsLoading - 1);
      slot.classList.add("loaded");
      queuePreviews();
    };
    frame.addEventListener("load", finish, { once: true });
    window.setTimeout(finish, 8000);
    frame.src = `${project.proxy}${page}`;
    slot.append(frame);
  }
}

/** @param {SubmitEvent} event */
function addPickerPage(event) {
  event.preventDefault();
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById("pagesAddInput"));
  let page = (input?.value || "").trim();
  if (!page) return;
  if (/^https?:\/\//i.test(page)) {
    try {
      const url = new URL(page);
      page = url.pathname + url.search;
    } catch {
      // checked below
    }
  }
  if (!page.startsWith("/")) page = `/${page}`;
  if (page.startsWith("//") || /\s/.test(page) || page.length > 500) {
    setPagesError("A page is a path on the site, such as /pricing.");
    return;
  }
  setPagesError("");
  if (!pagesPicker.pages.some((entry) => entry.path === page)) {
    pagesPicker.pages.push({ path: page, source: "typed" });
    pagesPicker.pages.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)));
  }
  pagesPicker.checked.set(page, true);
  if (input) input.value = "";
  renderPickerRows();
  pagesPicker.panel?.querySelector(`.pages-row[data-page="${CSS.escape(page)}"]`)?.scrollIntoView({ block: "nearest" });
}

let applyingPages = false;
function applyPickedPages() {
  if (applyingPages) return;
  const pages = pagesPicker.pages.filter((page) => pagesPicker.checked.get(page.path)).map((page) => page.path);
  const before = new Set(boardLivePages());
  if (pages.length === before.size && pages.every((page) => before.has(page))) {
    setPagesOpen(false);
    return;
  }
  applyingPages = true;
  const apply = /** @type {HTMLButtonElement | null} */ (document.getElementById("pagesApply"));
  if (apply) apply.disabled = true;
  projectRequest("pages/set", { pages, tab: state.activeTab })
    .then((payload) => {
      const removed = Array.isArray(payload.removed) ? payload.removed : [];
      const added = Array.isArray(payload.added) ? payload.added : [];
      for (const item of added) if (item?.id) liveSnapshotWanted.add(item.id);
      setPagesOpen(false);
      refreshBoard();
      if (removed.length > 0) {
        const text = removed.length === 1 ? `Removed ${pageTitle(removed[0].page)}` : `Removed ${removed.length} pages`;
        showBoardToast(text, added.length ? `Added ${added.length}` : "", "Undo", () => restorePages(removed));
      } else if (added.length > 0) {
        showBoardToast(added.length === 1 ? `Added ${pageTitle(added[0].page)}` : `Added ${added.length} pages`, "");
      }
    })
    .catch((failure) => setPagesError(failure.message))
    .finally(() => {
      applyingPages = false;
      if (apply) apply.disabled = false;
    });
}

/** @param {Array<{ token: string, page: string }>} removed */
async function restorePages(removed) {
  for (const entry of removed) {
    await boardPost("restore", { token: entry.token }).catch((error) => {
      dockStatus.textContent = `Could not bring back ${entry.page}: ${error.message}`;
    });
  }
  refreshBoard();
}

function setupPagesPicker() {
  document.getElementById("pagesToggle")?.addEventListener("click", () => setPagesOpen(!pagesOpen()));
  document.getElementById("pagesClose")?.addEventListener("click", () => setPagesOpen(false));
  document.getElementById("pagesApply")?.addEventListener("click", applyPickedPages);
  document.getElementById("pagesAddForm")?.addEventListener("submit", addPickerPage);
  document.getElementById("pagesFilter")?.addEventListener("input", renderPickerRows);
  document.getElementById("pagesAll")?.addEventListener("change", (event) => {
    const on = /** @type {HTMLInputElement} */ (event.currentTarget).checked;
    for (const page of pagesPicker.pages) pagesPicker.checked.set(page.path, on);
    for (const box of document.querySelectorAll("#pagesRows input[type=checkbox]"))
      /** @type {HTMLInputElement} */ (box).checked = on;
    renderPickerSummary();
  });
  // A project that was just opened asks which pages to show.
  if (location.hash === PAGES_HASH) setPagesOpen(true);
}

/* ------------------------------------------------------------ board name */

// Clicking the board's name in the top bar turns it into a field: Enter or leaving it
// saves, Escape puts the old name back. The board keeps its address.
function startBoardRename() {
  const button = document.getElementById("boardName");
  if (!button || state.ended || document.getElementById("boardNameInput")) return;
  const current = String(bootstrap.name || button.textContent || "");
  const input = /** @type {HTMLInputElement} */ (
    element("input", {
      class: "board-name-input",
      id: "boardNameInput",
      type: "text",
      maxlength: "120",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "Board name",
    })
  );
  input.value = current;
  input.style.width = `${Math.max(8, current.length + 2)}ch`;
  button.hidden = true;
  button.after(input);
  input.focus();
  input.select();
  let finished = false;
  /** @param {boolean} save */
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const name = input.value.replace(/\s+/g, " ").trim();
    input.remove();
    button.hidden = false;
    if (!save || !name || name === current) {
      button.focus({ preventScroll: true });
      return;
    }
    showBoardName(name);
    boardPost("name", { name })
      .then((payload) => showBoardName(String(payload.name || name)))
      .catch((error) => {
        showBoardName(current);
        showBoardToast("Could not rename the board", error.message);
      });
  };
  input.addEventListener("input", () => {
    input.style.width = `${Math.max(8, input.value.length + 2)}ch`;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

/** @param {string} name */
function showBoardName(name) {
  bootstrap.name = name;
  const button = document.getElementById("boardName");
  if (button) button.textContent = name;
  const settingsName = document.getElementById("settingsBoardName");
  if (settingsName) settingsName.textContent = name;
  document.title = `${name} · Liesel`;
}

document.getElementById("boardName")?.addEventListener("click", startBoardRename);

function setupProjectBoard() {
  if (!isProjectBoard()) return;
  for (const action of /** @type {const} */ (["start", "stop", "restart"])) {
    document
      .getElementById(`dev${action[0].toUpperCase()}${action.slice(1)}`)
      ?.addEventListener("click", () => devServerAction(action));
  }
  document.getElementById("projectForm")?.addEventListener("submit", (event) => void saveDevConfig(event));
  document.getElementById("devCommand")?.addEventListener("change", () => void saveDevConfig());
  document.getElementById("devPort")?.addEventListener("change", () => void saveDevConfig());
  const section = document.getElementById("projectPane");
  if (section) section.hidden = false;
  renderProjectBar();
  setupPagesPicker();
  void loadProject().then(autoStartDevServer);
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
      if (payload?.type === "runner") onRunnerEvent(payload.data);
      if (payload?.type === "agent-reply") refreshBoard();
      if (payload?.type === "project") onProjectEvent(payload.data);
      if (payload?.type === "project-source") onProjectSource();
      if (payload?.type === "chat-sync") {
        if (Array.isArray(payload.data?.chat)) state.chat = payload.data.chat;
        renderChatPanel();
        // A note sent or answered turns its pin's working ring on or off.
        postAllPins();
        // A note sent or answered changes how many wait for the agent.
        if (runnerState.view) loadRunner();
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
    .map(
      (item) =>
        `${item.id}|${item.file}|${item.page || ""}|${item.tab}|${item.copyOf || ""}|${item.copyOf ? item.label : ""}|${item.caption || ""}|${item.title || ""}|${item.changed || ""}|${item.parent || ""}|${item.status || ""}|${(item.builds || []).map((build) => build.hash).join(",")}`,
    )
    .join("\n");
}

function pendingSignature(chat) {
  return chat
    .filter((entry) => entry?.pending || entry?.pending_cancel)
    .map((entry) => `${entry.at}|${(entry.pending || []).join(",")}|${(entry.pending_cancel || []).join(",")}`)
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
        return {
          ...item,
          notes: keepNotes ? mine.notes : item.notes,
          tune: mine.tune || item.tune,
          status: pendingStatus.get(item.id) ?? item.status,
        };
      });
      const previousTabs = state.tabs.map((tab) => tab.id).join(",");
      state.tabs = payload.tabs || state.tabs;
      if (Array.isArray(payload.pairs)) state.pairs = payload.pairs;
      if (Array.isArray(payload.chat)) state.chat = payload.chat;
      if (!state.tabs.some((tab) => tab.id === state.activeTab)) state.activeTab = state.tabs[0]?.id || "";
      if (state.tabs.map((tab) => tab.id).join(",") !== previousTabs) renderTabs();
      if (itemsSignature(state.items) !== before) scheduleLayout();
      noticeFileChanges(false);
      ensureUniqueNumbers();
      renderChatPanel();
      postAllPins();
      renderAllGutterPins();
      if (payload.ended) markEnded();
      if (payload.project) onProjectEvent(payload.project);
    })
    .catch(() => {});
}

// A sandboxed item cannot read its own linked stylesheets, so it cannot pin their
// viewport units. The board reads the text for it - only a file under that item's
// own path on this origin - and hands it back.
/** @type {Map<string, Promise<string | null>>} */
const stylesheetTexts = new Map();
const STYLESHEET_MAX_CHARS = 8 * 1024 * 1024;
function sendStylesheet(record, itemId, href) {
  let url;
  try {
    url = new URL(href, location.href);
  } catch {
    return;
  }
  const base = `/board/${encodeURIComponent(key)}/item/${encodeURIComponent(itemId)}/`;
  const reply = (text) =>
    record.iframe.contentWindow?.postMessage(
      { channel: "liesel", item: itemId, device: record.device.id, type: "stylesheet", href, text },
      "*",
    );
  if (url.origin !== location.origin || !url.pathname.startsWith(base)) {
    reply(null);
    return;
  }
  const path = url.pathname + url.search;
  if (!stylesheetTexts.has(path)) {
    stylesheetTexts.set(
      path,
      fetch(path, { cache: "no-store" })
        .then((response) => (response.ok ? response.text() : null))
        .then((text) => (text !== null && text.length <= STYLESHEET_MAX_CHARS ? text : null))
        .catch(() => null),
    );
    // A later edit to the stylesheet is read afresh.
    window.setTimeout(() => stylesheetTexts.delete(path), 5000);
  }
  stylesheetTexts.get(path)?.then(reply);
}

/** @param {MessageEvent} event */
function onArtboardMessage(event) {
  const data = event.data;
  if (!data || data.channel !== "liesel") return;
  const itemId = String(data.item || "");
  const deviceId = String(data.device || "");
  const record = state.artboards.get(artboardKey(itemId, deviceId));
  if (!record || event.source !== record.iframe.contentWindow) return;
  // A live frame says which path it shows on every message; its pins follow that path.
  if (typeof data.page === "string" && data.page.startsWith("/") && itemById(itemId)?.page) {
    const page = data.page.slice(0, 500);
    if (record.page !== page) {
      record.page = page;
      postPins(itemId, deviceId);
      renderAllGutterPins();
    }
  }
  if (data.type === "live-stale") {
    onLiveStale(itemId, deviceId);
    return;
  }
  if (data.type === "dev-action" && itemById(itemId)?.page) {
    const action = String(data.action || "");
    if (action === "restart" || action === "start") devServerAction(action);
    else if (action === "settings") setSettingsOpen(true);
    return;
  }
  if (data.type === "live-snapshot") {
    onLiveSnapshot(itemId, data);
    return;
  }
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
    joinLockedScroll(itemId, deviceId);
    postPins(itemId, deviceId);
    postTune(itemId, deviceId);
    postElementTune(itemId, deviceId);
    postImageDrops(itemId, deviceId);
    return;
  }
  // The frame owns key events while it has focus, so it reports what is held: the four
  // gestures must arm no matter which document the reviewer last touched.
  if (data.type === "held") {
    if (data.blur === true) {
      // Focus that moved on to the board or another design keeps what is held, and
      // the keyup lands there; focus that left the window took the keys with it.
      window.setTimeout(() => {
        if (!document.hasFocus()) releaseHeldKeys();
      }, 0);
      return;
    }
    const space = Boolean(data.space);
    const joined = data.other === true;
    // The frame stamps the key event on the shared wall clock; read it on the board's own.
    const stamped = Number(data.at) - performance.timeOrigin;
    const at = Number.isFinite(stamped) ? Math.min(stamped, performance.now()) : performance.now();
    if ((space && !spaceHeld) || joined) noteChord();
    for (const [name, down] of /** @type {const} */ ([
      ["Meta", data.meta === true],
      ["Alt", data.alt === true],
    ])) {
      if (down && !modifierTaps[name].down) modifierPressed(name, joined, at);
      else if (!down && modifierTaps[name].down) modifierReleased(name, false, joined, at);
    }
    if (space === spaceHeld) return;
    spaceHeld = space;
    updateGestureMode();
    return;
  }
  if (data.type === "chord") {
    noteChord(data.via === "pointer" ? "pointer" : "key");
    return;
  }
  if (data.type === "mode-off") {
    setArmedMode("");
    return;
  }
  if (data.type === "scrolled") {
    syncLockedScroll(itemId, deviceId, Number(data.x) || 0, Number(data.y) || 0);
    return;
  }
  if (data.type === "key") {
    noteChord();
    boardKey(
      {
        key: String(data.key || ""),
        metaKey: data.metaKey === true,
        ctrlKey: data.ctrlKey === true,
        shiftKey: data.shiftKey === true,
      },
      () => {},
      itemId,
    );
    return;
  }
  if (data.type === "pointer") {
    // Only the position: the board reads modifiers from the keys themselves.
    const rect = record.iframe.getBoundingClientRect();
    const scale = rect.width / record.device.width || 1;
    lastPointer = { x: rect.left + (Number(data.x) || 0) * scale, y: rect.top + (Number(data.y) || 0) * scale };
    notePointerForDepth(lastPointer.x, lastPointer.y);
    return;
  }
  if (data.type === "parked") {
    record.parked = Array.isArray(data.pins) ? data.pins.slice(0, MAX_PARKED_PINS) : [];
    renderGutterPins(record);
    return;
  }
  if (data.type === "stylesheet") {
    sendStylesheet(record, itemId, String(data.href || ""));
    return;
  }
  if (data.type === "select") {
    const item = itemById(itemId);
    if (item && !state.ended) addNote(item, data, deviceId);
    return;
  }
  if (data.type === "image-drop") {
    dropImageOn(record, data);
    return;
  }
  if (data.type === "html-drop") {
    addHtmlFiles(Array.isArray(data.files) ? data.files : []);
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
    const height = clamp(Math.round(Number(data.height) || 0), 0, maxFrameHeight());
    const id = artboardKey(itemId, deviceId);
    if (height > 0 && height !== state.heights.get(id)) {
      state.heights.set(id, height);
      saveHeights();
      if (!framedView()) scheduleLayout();
    }
    return;
  }
  if (data.type === "tune-target") {
    if (tuneTarget && tuneTarget.pending) {
      const controls = Array.isArray(data.controls) ? data.controls : [];
      const inherited = (Array.isArray(data.inherited) ? data.inherited : [])
        .filter((group) => group && typeof group.selector === "string" && Array.isArray(group.controls))
        .map((group) => ({
          selector: String(group.selector),
          label: String(group.label || group.selector),
          controls: group.controls,
          values: {},
        }));
      const crumbs = (Array.isArray(data.crumbs) ? data.crumbs : [])
        .filter((crumb) => crumb && crumb.selector)
        .map((crumb) => ({ selector: String(crumb.selector), label: String(crumb.label || crumb.selector) }));
      const like =
        data.like && typeof data.like.selector === "string" && Number(data.like.count) > 1
          ? { selector: String(data.like.selector), count: Number(data.like.count) }
          : null;
      // A step along the clicked element's path keeps that path; anything else starts a new one.
      const selector = String(data.selector || "");
      if (!tuneOrigin.some((crumb) => crumb.selector === selector)) tuneOrigin = crumbs;
      tuneTarget = {
        itemId,
        deviceId,
        selector,
        sectionSelector: String(data.sectionSelector || ""),
        label: String(data.label || ""),
        sectionLabel: String(data.sectionLabel || ""),
        parentSelector: String(data.parentSelector || ""),
        parentLabel: String(data.parentLabel || ""),
        controls,
        values: {},
        inherited,
        crumbs,
        like,
        // A pick tunes the element picked, never its siblings: "All like this" is opt-in.
        scope: "one",
        sizes: "all",
        error: data.error ? String(data.error) : "",
      };
      syncTargetValues(tuneTarget);
      renderTune();
    }
    return;
  }
  if (data.type === "move-pick") {
    onMovePicked(record, data);
    return;
  }
  if (data.type === "tune-depth") {
    // The selector cannot climb past the page: keep Up and Down in step with what it shows.
    tuneDepth = Math.min(tuneDepth, Math.max(0, Number(data.depth) || 0));
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

/**
 * A camera or panel key, heard by the board itself or handed up by a focused design.
 * @param {{ key: string, metaKey: boolean, ctrlKey: boolean, shiftKey?: boolean }} event
 * @param {() => void} preventDefault
 */
function boardKey(event, preventDefault, fromItem = "") {
  // Cmd-D duplicates the picked design, or the focused one that handed the key up.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && /^d$/i.test(event.key)) {
    const target = pickedDesign() || (fromItem ? itemById(fromItem) : null);
    if (!target) return;
    preventDefault();
    duplicateDesign(target.id);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && /^z$/i.test(event.key)) {
    if (!tuneItemId) return;
    preventDefault();
    stepTune(event.shiftKey ? 1 : -1);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && ["+", "=", "-", "0"].includes(event.key)) {
    preventDefault();
    if (event.key === "0") {
      userAdjustedCamera = true;
      fit();
    } else zoomBy(event.key === "-" ? 1 / 1.25 : 1.25);
    return;
  }
  if (event.metaKey || event.ctrlKey) return;
  if (event.key === "Tab") {
    preventDefault();
    toggleSideView();
    return;
  }
  // Up or [ widens the controls selection to the element it sits in; Down or ] narrows
  // it back toward the clicked element.
  if (["ArrowUp", "ArrowDown", "[", "]"].includes(event.key)) {
    const up = event.key === "ArrowUp" || event.key === "[";
    if (stepTuneSelection(up ? -1 : 1)) preventDefault();
    return;
  }
  if (event.key === "0") {
    userAdjustedCamera = true;
    fit();
  } else if (event.key === "1") actualSize();
  else if (event.key === "+" || event.key === "=") zoomBy(1.25);
  else if (event.key === "-") zoomBy(1 / 1.25);
  // V is View: notes, the controls selector and Move all off, so a click reaches the page.
  else if (event.key === "v" && !event.shiftKey) setArmedMode("");
  else if (event.key === "Escape") {
    // Escape closes an open note or history first, then turns notes or the controls
    // selector off, and with neither on it closes the tuned element.
    if (settingsOpen()) setSettingsOpen(false);
    else if (noteWindow) closeNoteWindow();
    else if (historyItem || compare) closeBuildPreview();
    else if (armedMode) setArmedMode("");
    else closeTune();
  }
}

/** @param {KeyboardEvent} event is a modifier besides the Cmd or Option this event is about held? */
function otherModifierHeld(event) {
  return event.shiftKey || event.ctrlKey || (event.key === "Meta" ? event.altKey : event.metaKey);
}

/** Keys let go where the board could not hear them: another app took focus. */
function releaseHeldKeys() {
  modifierReleased("Meta", true);
  modifierReleased("Alt", true);
  if (!spaceHeld) return;
  spaceHeld = false;
  updateGestureMode();
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Meta" || event.key === "Alt") {
    // A tap of Cmd or Option on Settings never arms notes or controls on the board under it.
    if (overlayOpen()) return;
    modifierPressed(event.key, otherModifierHeld(event), event.timeStamp);
    return;
  }
  noteChord();
  if (event.code === "Space" && !isTextTarget(event.target)) {
    event.preventDefault();
    if (!spaceHeld) {
      spaceHeld = true;
      updateGestureMode();
    }
    return;
  }
  // The New menu is ordinary links: its keys are the browser's, and it closes itself on Escape.
  if (event.target instanceof Element && event.target.closest("#newMenu")) return;
  // Escape closes Settings or the page picker first, even from one of its fields.
  if (event.key === "Escape" && overlayOpen()) {
    event.preventDefault();
    if (pagesOpen()) setPagesOpen(false);
    else setSettingsOpen(false);
    return;
  }
  // Settings and the page picker are ordinary pages over the board: Tab moves between
  // their fields, keys type, and no board shortcut acts on the board hidden under them.
  if (overlayOpen()) return;
  // Tab switches the sidebar between Chat and Controls; in a text field it keeps its meaning.
  if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey && !isTypingTarget(event.target)) {
    boardKey(event, () => event.preventDefault());
    return;
  }
  if (event.altKey || (isTextTarget(event.target) && !event.metaKey && !event.ctrlKey)) return;
  // Cmd-D in a text field is the field's, never a duplicate.
  if (/^d$/i.test(event.key) && isTextTarget(event.target)) return;
  // Undo while typing belongs to the field being typed in.
  if (/^z$/i.test(event.key) && isTypingTarget(event.target)) return;
  boardKey(event, () => event.preventDefault());
});

window.addEventListener("keyup", (event) => {
  if (event.key === "Meta" || event.key === "Alt")
    modifierReleased(event.key, false, otherModifierHeld(event), event.timeStamp);
  if (event.code === "Space" && spaceHeld) {
    spaceHeld = false;
    updateGestureMode();
  }
});

window.addEventListener("blur", releaseHeldKeys);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseHeldKeys();
});

document.addEventListener(
  "pointermove",
  (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    notePointerForDepth(event.clientX, event.clientY);
  },
  { capture: true, passive: true },
);

document.addEventListener("pointerover", (event) => hintAnnotateOnce(event.target), true);

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    relayout();
    if (!userAdjustedCamera) fit(false);
  }, 150);
});

document.getElementById("sideTabChat")?.addEventListener("click", () => showSideView("chat"));
document.getElementById("sideTabControls")?.addEventListener("click", () => showSideView("controls"));
// The edited element's outline shows while the pointer is on the controls.
for (const [type, on] of /** @type {const} */ ([
  ["pointerenter", true],
  ["pointerleave", false],
])) {
  document.getElementById("tune")?.addEventListener(type, () => {
    editTag.hover = on;
    syncEditTag();
  });
}
settingsToggle?.addEventListener("click", () => setSettingsOpen(!settingsOpen()));
document.getElementById("settingsClose")?.addEventListener("click", () => setSettingsOpen(false));
document.getElementById("newMenu")?.addEventListener("toggle", (event) => {
  const open = /** @type {ToggleEvent} */ (event).newState === "open";
  document.getElementById("newToggle")?.setAttribute("aria-expanded", String(open));
});
for (const toggle of document.querySelectorAll("[data-format]")) {
  toggle.addEventListener("change", (event) => {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    setFormat(input.dataset.format || "", input.checked);
  });
}
document.getElementById("agentForm")?.addEventListener("submit", saveRunner);
document.getElementById("agentSelect")?.addEventListener("change", (event) => {
  syncRunnerFields();
  saveRunner(event);
});
document.getElementById("agentCommand")?.addEventListener("change", saveRunner);
document.getElementById("agentCwd")?.addEventListener("change", saveRunner);
document.getElementById("agentStop")?.addEventListener("click", () => runnerAction("stop"));
document.getElementById("agentRetry")?.addEventListener("click", () => runnerAction("run"));
document.getElementById("runnerLine")?.addEventListener("click", () => setSettingsOpen(true));
document.getElementById("agentOutput")?.addEventListener("scroll", (event) => {
  const output = /** @type {HTMLElement} */ (event.currentTarget);
  runnerState.pinnedToEnd = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
});
document.getElementById("tuneSave")?.addEventListener("click", saveTuneVersion);
document.getElementById("tuneCopy")?.addEventListener("click", copyTune);
document.getElementById("tuneSend")?.addEventListener("click", sendTune);
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
const chatFoot = document.querySelector(".chat-foot");
if (chatFoot instanceof HTMLElement) {
  acceptImages(chatFoot, (files) =>
    addImages("composer", files, (ref) => {
      composerImages = [...composerImages, ref];
      renderComposerImages();
      updateSendButton();
    }),
  );
}
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
noticeFileChanges(true);
setChatCollapsed(readStorage(panelStorageKey) === "closed");
setPresence("waiting");
renderModeState();
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
loadRunner();
setupProjectBoard();
if (location.hash === SETTINGS_HASH) setSettingsOpen(true);
setInterval(refreshBoard, 2000);
setInterval(checkViewed, 500);
