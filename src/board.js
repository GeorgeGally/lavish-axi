import { createHash } from "node:crypto";
import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { BOARD_FILE_NAME } from "./brand.js";

export { BOARD_FILE_NAME };
export const BOARD_FORMAT_VERSION = 1;
const MAX_TABS = 24;
const MAX_ITEMS = 400;
const MAX_NOTES_PER_ITEM = 300;
const MAX_VERSIONS_PER_ITEM = 30;
const MAX_TUNE_CONTROLS = 24;
const MAX_ELEMENT_TUNES = 60;
const MAX_IMAGE_DROPS = 120;
const MAX_BUILDS = 60;
const MAX_NOTE_IMAGES = 8;

/**
 * A board is a directory holding one `board.json` and one HTML file per item. The
 * JSON carries only where things sit and what was said about them; it never holds
 * markup or a copy of an item's content.
 */
/** @typedef {{ id: string, label: string }} BoardTab */
/** @typedef {{ id: string, number: number, label: string, selector: string, tag: string, text: string, x: number, y: number, ox?: number, oy?: number, attachments?: Array<{ id: string, name?: string }>, prompt_id?: string, at?: string, device?: string, excerpt?: string, heading?: string, box?: { x: number, y: number, w: number, h: number }, crop?: { id: string } }} BoardNote */
/** @typedef {{ id: string, label: string, type: "number" | "color" | "select" | "spring" | "easing" | "pad" | "timeline", css: string, min?: number, max?: number, step?: number, duration?: number, unit?: string, options?: Array<{ value: string, label: string }>, value: string }} TuneControl */
/** @typedef {{ id: string, label: string, values: Record<string, string>, at: string }} TuneVersion */
/**
 * @typedef {{
 *   id: string, label: string, file: string, tab: string, x: number, y: number,
 *   w: number, h: number, status: string, notes: BoardNote[],
 *   tune: Record<string, string>, elementTune: Record<string, Record<string, string>>,
 *   imageDrops: Array<{ selector: string, kind: "img" | "background", oldSource: string, file: string }>,
 *   builds: Array<{ at: string, hash: string, label: string }>,
 *   versions: TuneVersion[], tuneSpec?: TuneControl[],
 * }} BoardItem
 */
/** @typedef {{ format: number, name: string, tabs: BoardTab[], items: BoardItem[], pairs: Array<{ a: string, b: string, locked: boolean }> }} Board */

export class BoardError extends Error {
  code = "VALIDATION_ERROR";
  statusCode = 400;

  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "BoardError";
  }
}

/** @param {string} dir */
export function boardFilePath(dir) {
  return path.join(dir, BOARD_FILE_NAME);
}

/**
 * The canonical board directory for a CLI argument: the directory itself, or the
 * `board.json` inside it. Keeps every command accepting either form.
 * @param {string} input
 * @returns {string}
 */
export function boardDirPath(input) {
  const absolute = path.resolve(String(input || "."));
  return path.basename(absolute) === BOARD_FILE_NAME ? path.dirname(absolute) : absolute;
}

/** @param {string} dir */
export function boardKey(dir) {
  return createHash("sha256")
    .update(path.resolve(boardFilePath(boardDirPath(dir))))
    .digest("hex")
    .slice(0, 24);
}

/**
 * @param {string} dir
 * @returns {Promise<Board>}
 */
export async function readBoard(dir) {
  const directory = await canonicalDir(dir);
  const file = boardFilePath(directory);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new BoardError(`No board.json in ${directory}`);
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BoardError(`${file} is not valid JSON`);
  }
  return normalizeBoard(parsed, path.basename(directory));
}

/**
 * @param {string} dir
 * @param {{ name?: string }} [options]
 * @returns {Promise<Board>}
 */
export async function readOrCreateBoard(dir, { name } = {}) {
  const directory = await canonicalDir(dir);
  try {
    await stat(boardFilePath(directory));
    return readBoard(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const board = normalizeBoard({ name: name || path.basename(directory) }, path.basename(directory));
  await writeBoard(directory, board);
  return board;
}

/**
 * @param {string} dir
 * @param {Board} board
 * @returns {Promise<Board>} the board as it was written
 */
export async function writeBoard(dir, board) {
  const directory = await canonicalDir(dir);
  const normalized = normalizeBoard(board, path.basename(directory));
  const file = boardFilePath(directory);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(temporary, file);
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} fallbackName
 * @returns {Board}
 */
export function normalizeBoard(value, fallbackName) {
  /** @type {any} */
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const name = text(source.name, 120) || fallbackName || "Board";
  const tabs = normalizeTabs(source.tabs);
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const items = normalizeItems(source.items, tabIds, tabs[0].id);
  const itemIds = new Set(items.map((item) => item.id));
  return {
    format: BOARD_FORMAT_VERSION,
    name,
    tabs,
    items,
    pairs: normalizePairs(source.pairs, itemIds),
  };
}

/** @param {unknown} value */
function normalizeTabs(value) {
  /** @type {BoardTab[]} */
  const tabs = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value.slice(0, MAX_TABS) : []) {
    if (!entry || typeof entry !== "object") continue;
    const label = text(entry.label, 60);
    const id = slug(entry.id || label, "tab");
    if (!label || seen.has(id)) continue;
    seen.add(id);
    tabs.push({ id, label });
  }
  return tabs.length > 0 ? tabs : [{ id: "main", label: "Main" }];
}

/**
 * @param {unknown} value
 * @param {Set<string>} tabIds
 * @param {string} fallbackTab
 */
function normalizeItems(value, tabIds, fallbackTab) {
  /** @type {BoardItem[]} */
  const items = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value.slice(0, MAX_ITEMS) : []) {
    if (!entry || typeof entry !== "object") continue;
    const file = text(entry.file, 400);
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) continue;
    const id = slug(entry.id || path.basename(file, path.extname(file)), "item");
    if (seen.has(id)) continue;
    seen.add(id);
    const tab = tabIds.has(String(entry.tab || "")) ? String(entry.tab) : fallbackTab;
    items.push({
      id,
      label: text(entry.label, 120) || id,
      file,
      tab,
      x: number(entry.x, 0, -100_000, 100_000),
      y: number(entry.y, 0, -100_000, 100_000),
      w: number(entry.w, 1440, 160, 4000),
      h: number(entry.h, 900, 120, 4000),
      status: text(entry.status, 40) || "open",
      notes: normalizeNotes(entry.notes),
      tune: normalizeTuneValues(entry.tune),
      // What an Option click tuned on one element: kept per selector so a reload shows
      // the design the reviewer tuned, not the one the file still holds.
      elementTune: normalizeElementTune(entry.elementTune),
      // An image dropped onto the design: which selector, what it replaced, and the
      // file in the board folder that holds the new bytes.
      imageDrops: normalizeImageDrops(entry.imageDrops),
      // One snapshot per build of the file: a dot for a change, a labelled tick when
      // the build names itself, so a round is a point on a line, not a new object.
      builds: normalizeBuilds(entry.builds),
      versions: normalizeVersions(entry.versions),
    });
  }
  return items;
}

/** @param {unknown} value */
function normalizeNotes(value) {
  /** @type {BoardNote[]} */
  const notes = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value.slice(0, MAX_NOTES_PER_ITEM) : []) {
    if (!entry || typeof entry !== "object") continue;
    const id = text(entry.id, 60);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    /** @type {BoardNote} */
    const note = {
      id,
      number: Math.trunc(number(entry.number, notes.length + 1, 1, 100_000)),
      label: text(entry.label, 120),
      selector: text(entry.selector, 500),
      tag: text(entry.tag, 40),
      text: text(entry.text, 4000),
      x: number(entry.x, 0, -100_000, 100_000),
      y: number(entry.y, 0, -100_000, 100_000),
    };
    const device = text(entry.device, 20);
    if (device) note.device = device;
    // Where inside its element the note was dropped, so the pin follows the element.
    if (Number.isFinite(Number(entry.ox)) && Number.isFinite(Number(entry.oy))) {
      note.ox = Math.round(number(entry.ox, 0, -10_000, 10_000));
      note.oy = Math.round(number(entry.oy, 0, -10_000, 10_000));
    }
    const promptId = text(entry.prompt_id, 80);
    if (promptId) note.prompt_id = promptId;
    // Images pasted into a note, by attachment id; the bytes live in the state dir.
    const attachments = (Array.isArray(entry.attachments) ? entry.attachments : [])
      .filter((ref) => ref && /^[0-9a-f]{64}\.(png|jpg|webp)$/.test(String(ref.id || "")))
      .slice(0, MAX_NOTE_IMAGES)
      .map((ref) => (ref.name ? { id: String(ref.id), name: text(ref.name, 120) } : { id: String(ref.id) }));
    if (attachments.length > 0) note.attachments = attachments;
    // What the pin points at, for the agent: the element's visible text, the heading of
    // its section, its box on the page, and a picture of that spot.
    const excerpt = text(entry.excerpt, 120);
    if (excerpt) note.excerpt = excerpt;
    const heading = text(entry.heading, 120);
    if (heading) note.heading = heading;
    const box = entry.box && typeof entry.box === "object" ? entry.box : null;
    if (box && ["x", "y", "w", "h"].every((name) => Number.isFinite(Number(box[name])))) {
      note.box = {
        x: Math.round(number(box.x, 0, 0, 200_000)),
        y: Math.round(number(box.y, 0, 0, 200_000)),
        w: Math.round(number(box.w, 0, 0, 200_000)),
        h: Math.round(number(box.h, 0, 0, 200_000)),
      };
    }
    const crop = entry.crop && typeof entry.crop === "object" ? String(entry.crop.id || "") : "";
    if (/^[0-9a-f]{64}\.(png|jpg|webp)$/.test(crop)) note.crop = { id: crop };
    const at = text(entry.at, 40);
    if (at) note.at = at;
    notes.push(note);
  }
  return notes;
}

/** @param {unknown} value */
function normalizeTuneValues(value) {
  /** @type {Record<string, string>} */
  const values = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return values;
  for (const [key, raw] of Object.entries(value).slice(0, MAX_TUNE_CONTROLS)) {
    const id = slug(key, "");
    if (!id) continue;
    const value = text(raw, 120);
    if (value) values[id] = value;
  }
  return values;
}

/** @param {unknown} value */
function normalizeBuilds(value) {
  /** @type {Array<{ at: string, hash: string, label: string }>} */
  const builds = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value.slice(-MAX_BUILDS) : []) {
    if (!entry || typeof entry !== "object") continue;
    const hash = text(entry.hash, 64);
    if (!/^[0-9a-f]{8,64}$/.test(hash) || seen.has(hash)) continue;
    seen.add(hash);
    builds.push({ at: text(entry.at, 40), hash, label: text(entry.label, 40) });
  }
  return builds;
}

/** @param {unknown} value */
function normalizeImageDrops(value) {
  /** @type {Array<{ selector: string, kind: "img" | "background", oldSource: string, file: string }>} */
  const drops = [];
  for (const entry of Array.isArray(value) ? value.slice(0, MAX_IMAGE_DROPS) : []) {
    if (!entry || typeof entry !== "object") continue;
    const selector = text(entry.selector, 500);
    const kind = entry.kind === "img" || entry.kind === "background" ? entry.kind : "";
    const file = text(entry.file, 200);
    if (!selector || !kind) continue;
    if (!/^assets\/drops\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(file)) continue;
    drops.push({ selector, kind, oldSource: text(entry.oldSource, 2000), file });
  }
  return drops;
}

/** @param {unknown} value */
function normalizeElementTune(value) {
  /** @type {Record<string, Record<string, string>>} */
  const tunes = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return tunes;
  for (const [selector, raw] of Object.entries(value).slice(0, MAX_ELEMENT_TUNES)) {
    const name = text(selector, 500);
    if (!name || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    /** @type {Record<string, string>} */
    const css = {};
    for (const [property, value] of Object.entries(raw).slice(0, 40)) {
      if (!/^[a-z][a-z-]{0,40}$/.test(String(property))) continue;
      const resolved = text(value, 120);
      if (resolved) css[String(property)] = resolved;
    }
    if (Object.keys(css).length > 0) tunes[name] = css;
  }
  return tunes;
}

/** @param {unknown} value */
function normalizeVersions(value) {
  /** @type {TuneVersion[]} */
  const versions = [];
  for (const entry of Array.isArray(value) ? value.slice(-MAX_VERSIONS_PER_ITEM) : []) {
    if (!entry || typeof entry !== "object") continue;
    const id = text(entry.id, 60);
    if (!id) continue;
    versions.push({
      id,
      label: text(entry.label, 60) || id,
      values: normalizeTuneValues(entry.values),
      at: text(entry.at, 40),
    });
  }
  return versions;
}

/**
 * @param {unknown} value
 * @param {Set<string>} itemIds
 */
function normalizePairs(value, itemIds) {
  /** @type {Array<{ a: string, b: string, locked: boolean }>} */
  const pairs = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object") continue;
    const a = String(entry.a || "");
    const b = String(entry.b || "");
    if (a === b || !itemIds.has(a) || !itemIds.has(b)) continue;
    pairs.push({ a, b, locked: entry.locked !== false });
  }
  return pairs;
}

/**
 * Add one item to a board and drop it in the first free slot of a grid, so an agent
 * can place a new variant without dragging anything.
 * @param {Board} board
 * @param {{ file: string, label?: string, tab?: string, w?: number, h?: number }} input
 */
export function addItem(board, { file, label, tab, w, h }) {
  const relativeFile = path.basename(String(file || ""));
  if (!relativeFile) throw new BoardError("An item needs an HTML file");
  const id = uniqueId(board, slug(path.basename(relativeFile, path.extname(relativeFile)), "item"));
  const tabId = board.tabs.some((entry) => entry.id === tab) ? String(tab) : board.tabs[0].id;
  const width = number(w, 1440, 160, 4000);
  const height = number(h, 900, 120, 4000);
  const slot = nextSlot(board, tabId);
  const item = {
    id,
    label: text(label, 120) || id,
    file: relativeFile,
    tab: tabId,
    x: slot.x,
    y: slot.y,
    w: width,
    h: height,
    status: "open",
    notes: [],
    tune: {},
    elementTune: {},
    imageDrops: [],
    builds: [],
    versions: [],
  };
  board.items.push(item);
  return item;
}

/**
 * @param {Board} board
 * @param {string} id
 * @param {{ x?: number, y?: number, w?: number, h?: number, tab?: string, label?: string, status?: string }} changes
 */
export function placeItem(board, id, changes) {
  const item = board.items.find((entry) => entry.id === id);
  if (!item) throw new BoardError(`Unknown board item: ${id}`);
  if (changes.x !== undefined) item.x = number(changes.x, item.x, -100_000, 100_000);
  if (changes.y !== undefined) item.y = number(changes.y, item.y, -100_000, 100_000);
  if (changes.w !== undefined) item.w = number(changes.w, item.w, 160, 4000);
  if (changes.h !== undefined) item.h = number(changes.h, item.h, 120, 4000);
  if (changes.tab !== undefined) {
    if (!board.tabs.some((entry) => entry.id === changes.tab)) {
      throw new BoardError(`Unknown board tab: ${changes.tab}`);
    }
    item.tab = String(changes.tab);
  }
  if (changes.label !== undefined) item.label = text(changes.label, 120) || item.label;
  if (changes.status !== undefined) item.status = text(changes.status, 40) || item.status;
  return item;
}

/**
 * @param {Board} board
 * @param {string} tabId
 */
function nextSlot(board, tabId) {
  const siblings = board.items.filter((item) => item.tab === tabId);
  const gap = 48;
  const left = siblings.length === 0 ? 0 : Math.min(...siblings.map((item) => item.x));
  const top = siblings.length === 0 ? 0 : Math.max(...siblings.map((item) => item.y + item.h + gap));
  return { x: left, y: top };
}

/**
 * @param {Board} board
 * @param {string} base
 */
function uniqueId(board, base) {
  const taken = new Set(board.items.map((item) => item.id));
  let candidate = base || "item";
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * One `<meta name="...">` value from a designer's file, entity-decoded.
 * @param {string} html
 * @param {string} name
 * @param {number} limit
 * @returns {string}
 */
function metaContent(html, name, limit) {
  const tag = new RegExp(`<meta[^>]+name=["']${name}["'][^>]*>`, "i").exec(String(html || ""));
  if (!tag) return "";
  const content = /content=(?:"([^"]*)"|'([^']*)')/i.exec(tag[0]);
  if (!content) return "";
  return text(decodeEntities(content[1] ?? content[2] ?? ""), limit);
}

/** @param {string} value */
function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * A designer's pair file carries its own caption: `<meta name="easel-caption" content="...">`.
 * @param {string} html
 * @returns {string}
 */
export function captionFromHtml(html) {
  return metaContent(html, "easel-caption", 400);
}

/**
 * What the board explains above a design, from the file's own metas: an optional
 * `easel-title`, `easel-explain` (falling back to `easel-caption`) for what this
 * version changes and why, `easel-changed` for what the latest edit changed, and
 * `easel-parent` naming the file a derived version grew from.
 * @param {string} html
 * @returns {{ title: string, explain: string, changed: string, parent: string }}
 */
export function explanationFromHtml(html) {
  return {
    title: metaContent(html, "easel-title", 120),
    explain: metaContent(html, "easel-explain", 600) || captionFromHtml(html),
    changed: metaContent(html, "easel-changed", 400),
    parent: metaContent(html, "easel-parent", 160).replace(/\.html?$/i, ""),
  };
}

/**
 * `NN-name-today.html` / `NN-name-proposed.html` form one before/after group; a
 * `-proposed-b` (or `-c`, ...) file is another proposal in the same group.
 * @param {string} file
 * @returns {{ key: string, name: string, role: "today" | "proposed", variant: string } | null}
 */
export function pairInfo(file) {
  const base = path.basename(String(file || ""), path.extname(String(file || "")));
  const match = /^(\d+)[-_ ]?(.+?)[-_ ](today|proposed)(?:[-_ ]?([a-z0-9]{1,3}))?$/i.exec(base);
  if (!match) return null;
  const role = match[3].toLowerCase() === "today" ? "today" : "proposed";
  const name = match[2].toLowerCase();
  return {
    key: `${match[1]}-${name}`,
    name: name.replace(/[-_]+/g, " "),
    role,
    variant: (match[4] || "").toLowerCase(),
  };
}

/**
 * Add any HTML file that appeared in the board folder since it was created, so a lab
 * writing new variants never needs the board recreated.
 * @param {string} dir
 * @param {Board} board
 * @returns {Promise<Board>} the board, saved only when it changed
 */
export async function scanBoardFiles(dir, board) {
  const directory = await canonicalDir(dir);
  const files = (await readdir(directory).catch(() => [])).filter((file) => /\.html?$/i.test(file));
  const known = new Set(board.items.map((item) => item.file));
  let changed = false;
  for (const file of files.sort()) {
    if (known.has(file)) continue;
    addItem(board, { file, label: file.replace(/\.html?$/i, "").replace(/[-_]+/g, " ") });
    changed = true;
  }
  if (!changed) return board;
  return writeBoard(directory, board);
}

/**
 * The tune panel's control list, declared by the item's own HTML:
 *
 *   <script type="application/easel-tune">
 *   [{"id":"radius","label":"Radius","type":"number","css":"--radius","min":0,"max":40,"step":1,"value":12,"unit":"px"}]
 *   </script>
 *
 * A declared control binds one CSS custom property; the panel writes the value.
 * @param {string} html
 * @returns {TuneControl[]}
 */
export function extractTuneSpec(html) {
  const match = /<script[^>]*type=["']application\/easel-tune["'][^>]*>([\s\S]*?)<\/script>/i.exec(String(html || ""));
  if (!match) return [];
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return [];
  }
  return normalizeTuneSpec(parsed);
}

/** @param {unknown} value @returns {TuneControl[]} */
export function normalizeTuneSpec(value) {
  /** @type {TuneControl[]} */
  const controls = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value.slice(0, MAX_TUNE_CONTROLS) : []) {
    if (!entry || typeof entry !== "object") continue;
    const id = slug(entry.id, "");
    const css = text(entry.css, 80);
    const type = ["color", "select", "spring", "easing", "pad", "timeline"].includes(entry.type)
      ? entry.type
      : "number";
    if (!id || seen.has(id) || !css.startsWith("--")) continue;
    seen.add(id);
    /** @type {TuneControl} */
    const raw = entry.value && typeof entry.value === "object" ? JSON.stringify(entry.value) : entry.value;
    const control = { id, label: text(entry.label, 60) || id, type, css, value: text(raw, 120) };
    if (type === "number" || type === "timeline") {
      control.min = number(entry.min, 0, -100_000, 100_000);
      control.max = number(entry.max, 100, control.min, 100_000);
      control.step = number(entry.step, 1, 0.01, 10_000);
      if (entry.unit !== undefined) control.unit = text(entry.unit, 8);
      if (type === "timeline") control.duration = number(entry.duration, 1, 0.01, 600);
    }
    if (type === "select") {
      control.options = (Array.isArray(entry.options) ? entry.options.slice(0, 40) : [])
        .map((option) =>
          typeof option === "string"
            ? { value: text(option, 60), label: text(option, 60) }
            : { value: text(option?.value, 60), label: text(option?.label, 60) || text(option?.value, 60) },
        )
        .filter((option) => option.value);
    }
    controls.push(control);
  }
  return controls;
}

/**
 * @param {Board} board
 * @param {string} itemId
 * @param {TuneControl[]} spec
 * @param {Record<string, string>} values
 * @returns {Record<string, string>}
 */
export function tuneCssValues(board, itemId, spec, values) {
  const item = board.items.find((entry) => entry.id === itemId);
  const merged = { ...(item?.tune || {}), ...(values || {}) };
  /** @type {Record<string, string>} */
  const css = {};
  for (const control of spec) {
    const value = merged[control.id];
    if (value === undefined) continue;
    css[control.css] =
      (control.type === "number" || control.type === "timeline") && control.unit ? `${value}${control.unit}` : value;
  }
  return css;
}

/**
 * The instruction the panel's Copy button hands to the agent, so the values a person
 * tuned land in the next version of the file instead of dying in a browser.
 * @param {BoardItem} item
 * @param {TuneControl[]} spec
 * @returns {string}
 */
export function tuneInstruction(item, spec) {
  const lines = spec
    .filter((control) => item.tune[control.id] !== undefined && item.tune[control.id] !== "")
    .map((control) => {
      const value =
        (control.type === "number" || control.type === "timeline") && control.unit
          ? `${item.tune[control.id]}${control.unit}`
          : item.tune[control.id];
      return `- ${control.label}: ${value}  (${control.css})`;
    });
  if (lines.length === 0) return `No tune values set for ${item.label} (${item.file}).`;
  return `Bake these tune values from the board into ${item.file}, then keep the declarations in its application/easel-tune block in step:\n${lines.join("\n")}`;
}

/**
 * Append the board item SDK to an item's HTML. Like the review SDK, this is the only
 * change serving makes to a saved file, so the item still opens standalone.
 * @param {string} html
 * @param {string} src
 */
export function injectBoardSdk(html, src) {
  const tag = `<script src="${src}"></script>`;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${tag}</body>`);
  return `${html}\n${tag}`;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * @param {unknown} value
 * @param {number} limit
 */
function text(value, limit) {
  return String(value ?? "")
    .trim()
    .slice(0, limit);
}

/**
 * @param {unknown} value
 * @param {string} fallback
 */
function slug(value, fallback) {
  const slugged = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slugged || fallback;
}

/** @param {string} dir */
async function canonicalDir(dir) {
  return realpath(path.resolve(boardDirPath(dir))).catch(() => path.resolve(boardDirPath(dir)));
}

/**
 * @param {Board} board
 * @param {string} input
 * @returns {string} the tab id to use
 */
export function ensureTab(board, input) {
  const label = String(input || "").trim();
  if (!label) return board.tabs[0].id;
  const wanted = slug(label, "");
  const existing = board.tabs.find(
    (tab) => tab.id === label || tab.id === wanted || tab.label.toLowerCase() === label.toLowerCase(),
  );
  if (existing) return existing.id;
  const id = wanted || "tab";
  board.tabs.push({ id, label: label.charAt(0).toUpperCase() + label.slice(1) });
  return id;
}

/**
 * @param {Board} board
 * @param {string} a
 * @param {string} b
 * @param {boolean} [locked]
 */
export function pairItems(board, a, b, locked = true) {
  if (a === b) throw new BoardError("A pair needs two different items");
  const known = new Set(board.items.map((item) => item.id));
  if (!known.has(a) || !known.has(b)) throw new BoardError(`Unknown board item in pair: ${a} / ${b}`);
  const existing = board.pairs.find((pair) => (pair.a === a && pair.b === b) || (pair.a === b && pair.b === a));
  if (!locked) {
    board.pairs = board.pairs.filter((pair) => pair !== existing);
    return null;
  }
  if (existing) {
    existing.locked = true;
    return existing;
  }
  const pair = { a, b, locked: true };
  board.pairs.push(pair);
  return pair;
}

/**
 * The board file to poll for a directory or `board.json` argument, and the argument
 * itself when it is neither. A plain HTML file never becomes a board.
 * @param {string} input
 * @returns {Promise<string>}
 */
export async function resolveBoardTarget(input) {
  const resolved = path.resolve(String(input || ""));
  const dir = boardDirPath(resolved);
  const file = boardFilePath(dir);
  const info = await stat(dir).catch(() => null);
  if (info?.isDirectory() && (await stat(file).catch(() => null))?.isFile()) return file;
  return resolved;
}
