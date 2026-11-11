// Source-aware inspection for live project pages: which component rendered an element,
// and the source file and line it is written at. Only what a framework's development
// build already keeps on the element is read (React's fibre debug fields, Vue's
// component file, Svelte's dev location); nothing is fetched, so a production build or a
// page with no framework answers null and the board says "source unknown".
//
// The board SDK is a plain served script, so the server inlines every export here with
// `.toString()` (`serializeModuleHelpers`). A helper may use only its arguments and its
// sibling exports, and this module must export nothing but functions.

/**
 * What rendered `element`, nearest first: `{ framework, component, file, line?, column?,
 * owners? }`, where `owners` lists the components further up (each with where it is
 * used), or null when the page keeps no development source hints.
 * @param {any} element
 */
export function elementSourceOf(element) {
  let node = element;
  for (let depth = 0; node && depth < 40; depth++, node = node.parentElement) {
    try {
      const found = reactSourceOf(node) || vueSourceOf(node) || svelteSourceOf(node);
      if (found) return found;
    } catch {
      // A page that guards its own properties keeps its source to itself.
    }
  }
  return null;
}

/** The fibre React keeps on a DOM node it created. @param {any} node */
export function reactFiberOf(node) {
  if (!node || typeof node !== "object") return null;
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) return node[key] || null;
  }
  return null;
}

/** A component's display name, through memo and forwardRef wrappers. @param {any} type */
export function reactComponentName(type) {
  if (!type) return "";
  if (typeof type === "function") return String(type.displayName || type.name || "");
  if (typeof type === "object") {
    return String(type.displayName || reactComponentName(type.render) || reactComponentName(type.type) || "");
  }
  return "";
}

/**
 * Where a fibre was written: React 18 and earlier keep `_debugSource`; React 19 keeps the
 * JSX call's stack in `_debugStack` instead.
 * @param {any} fiber
 */
export function reactFiberLocation(fiber) {
  const source = fiber && fiber._debugSource;
  if (source && source.fileName) {
    const file = cleanSourcePath(source.fileName);
    if (!file) return null;
    const line = Number(source.lineNumber);
    const column = Number(source.columnNumber);
    return {
      file,
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      ...(Number.isInteger(column) && column > 0 ? { column } : {}),
    };
  }
  const stack = fiber && fiber._debugStack;
  if (stack) return stackLocation(typeof stack === "string" ? stack : stack.stack);
  return null;
}

/** @param {any} node */
export function reactSourceOf(node) {
  const fiber = reactFiberOf(node);
  // A development fibre always carries `_debugOwner` (null at the root); a production
  // build has no such field and its names are minified, so it says nothing.
  if (!fiber || !("_debugOwner" in fiber)) return null;
  /** @type {Array<{ component: string, file: string, line?: number, column?: number }>} */
  const entries = [];
  let written = fiber;
  let owner = fiber._debugOwner;
  for (let depth = 0; owner && depth < 30 && entries.length < 4; depth++) {
    const component = owner.type !== undefined ? reactComponentName(owner.type) : String(owner.name || "");
    const where = reactFiberLocation(written);
    // A library's own components (a router, a UI kit's primitive) are not where the
    // user edits: name the nearest component written in their own files.
    if (component && where && !isDependencyPath(where.file)) entries.push({ component, ...where });
    written = owner;
    owner = owner._debugOwner;
  }
  if (entries.length === 0) {
    // No location survives (a build without JSX source): the nearest component still helps.
    for (let up = fiber.return, depth = 0; up && depth < 60; up = up.return, depth++) {
      const component = typeof up.type === "string" ? "" : reactComponentName(up.type);
      if (component) return { framework: "react", component, file: "" };
    }
    return null;
  }
  const [first, ...rest] = entries;
  return { framework: "react", ...first, ...(rest.length > 0 ? { owners: rest } : {}) };
}

/** Vue 3 (`__vueParentComponent`) or Vue 2 (`__vue__`) dev builds name the SFC file. @param {any} node */
export function vueSourceOf(node) {
  const instance = node && (node.__vueParentComponent || node.__vue__);
  if (!instance) return null;
  const type = instance.type || instance.$options || {};
  const file = cleanSourcePath(String(type.__file || ""));
  const component = String(type.name || type.__name || fileStem(file) || "");
  if (!file && !component) return null;
  return { framework: "vue", component, file };
}

/** Svelte dev builds keep the element's location in `__svelte_meta`. @param {any} node */
export function svelteSourceOf(node) {
  const meta = node && node.__svelte_meta;
  const loc = meta && meta.loc;
  if (!loc || !loc.file) return null;
  const file = cleanSourcePath(String(loc.file));
  if (!file) return null;
  // Svelte 4 counts lines from 0; Svelte 5, which also records the parent, from 1.
  const raw = Number(loc.line);
  const line = Number.isInteger(raw) ? ("parent" in meta ? raw : raw + 1) : 0;
  return { framework: "svelte", component: fileStem(file), file, ...(line > 0 ? { line } : {}) };
}

/**
 * The first frame of a JSX call's stack that is the page's own code. A bundled chunk's
 * line is not the source's, so only a frame that names a source file is taken, and a
 * webpack module's line (counted in transformed code) is dropped.
 * @param {unknown} stack
 */
export function stackLocation(stack) {
  for (const raw of String(stack || "").split("\n")) {
    // Chrome: `at Name (url:line:col)` or `at url:line:col`; Firefox: `Name@url:line:col`.
    // A webpack module id has parentheses of its own, so the url starts after ` (`.
    const frame = raw.trim().replace(/\)$/, "");
    const match = /:(\d+):(\d+)$/.exec(frame);
    if (!match) continue;
    const head = frame.slice(0, match.index);
    const open = head.indexOf(" (");
    const url = /^at\s/.test(head)
      ? open >= 0
        ? head.slice(open + 2)
        : head.replace(/^at\s+/, "")
      : head.slice(head.indexOf("@") + 1);
    if (!url) continue;
    if (/react-stack-top-frame|react[-_]jsx|react-dom|\.vite\/deps\/|\/_next\/static\/|node_modules/.test(url))
      continue;
    const file = cleanSourcePath(url);
    if (!file || isDependencyPath(file) || !/\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/.test(file)) continue;
    if (/^webpack/.test(url)) return { file };
    return { file, line: Number(match[1]), column: Number(match[2]) };
  }
  return null;
}

/**
 * A source path as a person would write it: a dev server's URL or a bundler's module id
 * becomes the file path it names.
 * @param {unknown} value
 */
export function cleanSourcePath(value) {
  let text = String(value || "").trim();
  if (!text || text.length > 1000) return "";
  text = text.replace(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?/, "").replace(/^webpack:\/\/[^/]*\//, "");
  if (/^file:\/\//.test(text)) text = decodeURIComponent(text.replace(/^file:\/\//, ""));
  else if (/^https?:\/\//.test(text)) {
    try {
      text = decodeURIComponent(new URL(text).pathname);
    } catch {
      return "";
    }
    // Vite serves a file outside its root under /@fs/<absolute path>.
    text = text.startsWith("/@fs/") ? text.slice(4) : text.replace(/^\/+/, "");
  }
  text = text.replace(/[?#].*$/, "").replace(/^\.\//, "");
  return text;
}

/** @param {string} file */
export function isDependencyPath(file) {
  return /(?:^|\/)node_modules\/|^\(webpack\)|^next\/dist\//.test(String(file || ""));
}

/** `components/Hero.tsx` → `Hero`. @param {string} file */
export function fileStem(file) {
  const base = String(file || "")
    .split("/")
    .pop();
  return base ? base.replace(/\.[^.]+$/, "") : "";
}

/**
 * A reported source kept to its fixed shape and bounded, as notes and prompts store it.
 * `{ unknown: true }` is a live page's element with no source hints; anything else that
 * is not a source is null.
 * @param {unknown} value
 */
export function normalizeSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (raw.unknown === true) return { unknown: true };
  /** @param {any} entry */
  const place = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const component = String(entry.component || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const file = String(entry.file || "")
      // eslint-disable-next-line no-control-regex -- a path never carries control characters
      .replace(/[\u0000-\u001f]/g, "")
      .trim()
      .slice(0, 500);
    if (!component && !file) return null;
    const line = Number(entry.line);
    const column = Number(entry.column);
    return {
      component,
      file,
      ...(Number.isInteger(line) && line > 0 && line < 10_000_000 ? { line } : {}),
      ...(Number.isInteger(column) && column > 0 && column < 100_000 ? { column } : {}),
    };
  };
  const first = place(raw);
  if (!first) return null;
  const framework = ["react", "vue", "svelte"].includes(String(raw.framework)) ? String(raw.framework) : "";
  const owners = (Array.isArray(raw.owners) ? raw.owners : []).slice(0, 3).map(place).filter(Boolean);
  return { ...(framework ? { framework } : {}), ...first, ...(owners.length > 0 ? { owners } : {}) };
}

/**
 * The one-line name a person reads: `Button · components/Hero.tsx:42`. A path inside
 * `root` is shown relative to it; with no root, its last two segments.
 * @param {any} source
 * @param {string} [root]
 */
export function sourceLabel(source, root = "") {
  if (!source || typeof source !== "object" || source.unknown) return "source unknown";
  const component = String(source.component || "");
  let file = String(source.file || "");
  const base = String(root || "").replace(/\/+$/, "");
  if (file && base && file.startsWith(`${base}/`)) file = file.slice(base.length + 1);
  else if (file && !base && file.startsWith("/")) file = file.split("/").slice(-2).join("/");
  const line = Number(source.line);
  const where = file ? `${file}${Number.isInteger(line) && line > 0 ? `:${line}` : ""}` : "";
  if (!component && !where) return "source unknown";
  return [component, where || "source unknown"].filter(Boolean).join(" \u00b7 ");
}

/**
 * The label with the components further up, for an agent:
 * `Button · components/Button.tsx:12, used in Hero · components/Hero.tsx:42`.
 * @param {any} source
 * @param {string} [root]
 */
export function sourceText(source, root = "") {
  const owners = source && Array.isArray(source.owners) ? source.owners : [];
  return [sourceLabel(source, root), ...owners.map((owner) => `used in ${sourceLabel(owner, root)}`)].join(", ");
}
