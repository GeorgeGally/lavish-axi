import { readdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";

/**
 * The pages a project has, found the cheap way: its framework's routes read from the file
 * system (nothing from the repo runs), plus, once its dev server answers, the sitemap and
 * the links on its home page. A dynamic route (`/blog/[slug]`) is offered only with an
 * example the running site links to; without one it is skipped and counted.
 */

const WALK_IGNORED = new Set([
  "node_modules",
  ".git",
  ".liesel",
  ".liesel-trash",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".astro",
  ".turbo",
  ".cache",
  ".vercel",
  ".netlify",
  ".idea",
  ".vscode",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "tmp",
]);
const MAX_WALK_FILES = 6000;
const MAX_WALK_DEPTH = 10;
const MAX_PAGES = 400;
const MAX_SCAN_BYTES = 256 * 1024;
const ASSET_PATH =
  /\.(?:css|js|mjs|cjs|map|json|xml|txt|ico|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|webmanifest)$/i;

/**
 * Every file under `root` as a posix path relative to it, skipping build output,
 * dependencies and dot folders. Bounded, so a huge repo cannot stall the picker.
 * @param {string} root
 * @param {string} [start] a sub folder to walk instead of the whole tree
 * @returns {Promise<string[]>}
 */
async function walk(root, start = "") {
  /** @type {string[]} */
  const files = [];
  /** @param {string} relative @param {number} depth */
  const visit = async (relative, depth) => {
    if (files.length >= MAX_WALK_FILES || depth > MAX_WALK_DEPTH) return;
    const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_WALK_FILES) return;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (WALK_IGNORED.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".well-known")) continue;
        await visit(child, depth + 1);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  await visit(start, 0);
  return files;
}

/** @param {string} root @returns {Promise<Record<string, any> | null>} */
async function readPackage(root) {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, any> | null} pkg */
function dependencies(pkg) {
  return { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
}

/**
 * One route segment turned into the URL piece it serves, or a marker:
 * `null` drops the segment (a group or pathless layout), `false` hides the whole route
 * (private folders, parallel slots), and `{ dynamic }` is a parameter.
 * @typedef {string | null | false | { dynamic: string }} Segment
 */

/** @param {string} segment @returns {Segment} */
function bracketSegment(segment) {
  if (/^\(.*\)$/.test(segment)) return /^\(\.+\)/.test(segment) ? false : null;
  if (segment.startsWith("@") || segment.startsWith("_")) return false;
  const param = /^\[{1,2}(?:\.\.\.)?([^\]=]+)(?:=[^\]]+)?\]{1,2}$/.exec(segment);
  if (param) return { dynamic: param[1] };
  if (/[[\]]/.test(segment)) return false;
  return segment;
}

/**
 * A route made from its segments: its path, or its pattern when it has parameters.
 * @param {Segment[]} segments
 * @returns {{ path: string } | { pattern: string } | null}
 */
function routeFrom(segments) {
  /** @type {string[]} */
  const parts = [];
  let dynamic = false;
  for (const segment of segments) {
    if (segment === false) return null;
    if (segment === null || segment === "") continue;
    if (typeof segment === "object") {
      dynamic = true;
      parts.push(`:${segment.dynamic}`);
    } else parts.push(segment);
  }
  const joined = `/${parts.join("/")}`;
  return dynamic ? { pattern: joined } : { path: joined };
}

/** Next.js app router: every `page.*` under `app/` or `src/app/`. @param {string[]} files */
function nextAppRoutes(files) {
  const routes = [];
  for (const file of files) {
    const match = /^(?:src\/)?app\/(?:(.*)\/)?page\.(?:jsx?|tsx?|mdx?)$/.exec(file);
    if (!match) continue;
    routes.push(routeFrom((match[1] || "").split("/").filter(Boolean).map(bracketSegment)));
  }
  return routes;
}

/** Next.js pages router: files under `pages/` or `src/pages/`, without API routes. @param {string[]} files */
function nextPagesRoutes(files) {
  const routes = [];
  for (const file of files) {
    const match = /^(?:src\/)?pages\/(.+)\.(?:jsx?|tsx?|mdx?)$/.exec(file);
    if (!match) continue;
    const parts = match[1].split("/");
    if (parts[0] === "api" || ["404", "500", "_app", "_document", "_error"].includes(parts.join("/"))) continue;
    if (parts.at(-1) === "index") parts.pop();
    routes.push(routeFrom(parts.map(bracketSegment)));
  }
  return routes;
}

/** SvelteKit: every `+page.svelte` under `src/routes/`. @param {string[]} files */
function svelteKitRoutes(files) {
  const routes = [];
  for (const file of files) {
    const match = /^src\/routes\/(?:(.*)\/)?\+page(?:@[^.]*)?\.(?:svelte|md|svx)$/.exec(file);
    if (!match) continue;
    routes.push(routeFrom((match[1] || "").split("/").filter(Boolean).map(bracketSegment)));
  }
  return routes;
}

/** Astro: pages under `src/pages/`, without endpoints. @param {string[]} files */
function astroRoutes(files) {
  const routes = [];
  for (const file of files) {
    const match = /^src\/pages\/(.+)\.(?:astro|md|mdx|html)$/.exec(file);
    if (!match) continue;
    const parts = match[1].split("/");
    if (parts.at(-1) === "index") parts.pop();
    routes.push(routeFrom(parts.map(bracketSegment)));
  }
  return routes;
}

/** Nuxt: `.vue` files under `pages/` (Nuxt 3) or `app/pages/` (Nuxt 4). @param {string[]} files */
function nuxtRoutes(files) {
  const routes = [];
  for (const file of files) {
    const match = /^(?:app\/)?pages\/(.+)\.vue$/.exec(file);
    if (!match) continue;
    const parts = match[1].split("/");
    if (parts.at(-1) === "index") parts.pop();
    routes.push(routeFrom(parts.map(bracketSegment)));
  }
  return routes;
}

/**
 * Remix and React Router flat file routes: `app/routes/about.tsx`, `blog.$slug.tsx`,
 * `_index.tsx`, `_auth.login.tsx`, or a folder with a `route.tsx`. A file with no default
 * export is a resource route, not a page.
 * @param {string} root
 * @param {string[]} files
 */
async function flatFileRoutes(root, files) {
  const routes = [];
  for (const file of files) {
    const match =
      /^app\/routes\/([^/]+)\.(?:jsx?|tsx?|mdx?)$/.exec(file) ||
      /^app\/routes\/([^/]+)\/route\.(?:jsx?|tsx?|mdx?)$/.exec(file);
    if (!match) continue;
    if (!/\.mdx?$/.test(file)) {
      const source = await readFile(path.join(root, file), "utf8").catch(() => "");
      if (!/export\s+default\b/.test(source.slice(0, MAX_SCAN_BYTES))) continue;
    }
    /** @type {Segment[]} */
    const segments = [];
    // Dots split segments, except inside [escapes].
    for (const raw of match[1].match(/(?:\[[^\]]*\]|[^.])+/g) || []) {
      if (raw === "_index" || raw === "index") continue;
      if (/^\(.*\)$/.test(raw)) continue;
      if (raw.startsWith("_")) continue;
      const name = raw.replace(/_$/, "").replace(/\[([^\]]*)\]/g, "$1");
      if (name === "$") segments.push({ dynamic: "splat" });
      else if (name.startsWith("$")) segments.push({ dynamic: name.slice(1) });
      else segments.push(name);
    }
    routes.push(routeFrom(segments));
  }
  return routes;
}

/**
 * React Router's `app/routes.ts` config, read as text: `index(...)` and `route("path", ...)`.
 * @param {string} root
 */
async function routeConfigRoutes(root) {
  for (const name of ["app/routes.ts", "app/routes.js", "app/routes.tsx", "app/routes.jsx"]) {
    const source = await readFile(path.join(root, name), "utf8").catch(() => "");
    if (!source) continue;
    const routes = [];
    if (/\bindex\s*\(/.test(source)) routes.push({ path: "/" });
    for (const match of source.matchAll(/\broute\s*\(\s*["'`]([^"'`]*)["'`]/g)) {
      routes.push(
        routeFrom(match[1].split("/").map((part) => (part.startsWith(":") ? { dynamic: part.slice(1) } : part))),
      );
    }
    return { routes, flat: /\bflatRoutes\s*\(/.test(source) };
  }
  return null;
}

/**
 * A single-page app's client routes, read as text: `<Route path="/x">` and `path: "/x"`.
 * Only absolute paths count; a nested child's relative path cannot be placed for sure.
 * @param {string} root
 * @param {string[]} files
 */
async function clientRouterRoutes(root, files) {
  const routes = [];
  for (const file of files) {
    if (!/^(?:src|app)\/.+\.(?:jsx?|tsx?)$/.test(file)) continue;
    const source = (await readFile(path.join(root, file), "utf8").catch(() => "")).slice(0, MAX_SCAN_BYTES);
    if (!/react-router|wouter|@tanstack\/react-router/.test(source)) continue;
    for (const match of source.matchAll(/(?:<Route\b[^>]*?\bpath=|\bpath\s*:\s*)\{?\s*["'`](\/[^"'`]*)["'`]/g)) {
      const value = match[1];
      if (value.includes("*")) continue;
      routes.push(
        routeFrom(
          value.split("/").map((part) => (part.startsWith(":") ? { dynamic: part.slice(1).replace(/\?$/, "") } : part)),
        ),
      );
    }
  }
  return routes;
}

/**
 * Plain HTML pages: `about.html` is `/about.html`, `docs/index.html` is `/docs/`, and a
 * file in `public/` is served from the root.
 * @param {string[]} files
 * @param {{ publicOnly?: boolean }} [options]
 */
function htmlRoutes(files, { publicOnly = false } = {}) {
  const routes = [];
  for (const file of files) {
    if (!/\.html?$/i.test(file)) continue;
    const isPublic = file.startsWith("public/");
    if (publicOnly && !isPublic) continue;
    if (!isPublic && /^(?:src|test|tests|__tests__|e2e|fixtures|docs?\/api)\//.test(file)) continue;
    const served = (isPublic ? file.slice("public/".length) : file).split("/").map(encodeURIComponent).join("/");
    if (/(^|\/)index\.html?$/i.test(served)) routes.push({ path: `/${served.replace(/index\.html?$/i, "")}` });
    else routes.push({ path: `/${served}` });
  }
  return routes;
}

/**
 * The project's routes, read from its files.
 * @param {string} root
 * @returns {Promise<{ framework: string, routes: Array<{ path: string } | { pattern: string }> }>}
 */
export async function discoverRoutes(root) {
  const pkg = await readPackage(root);
  const deps = dependencies(pkg);
  const has = (name) => Object.hasOwn(deps, name);
  const files = await walk(root);
  /** @type {Array<{ path: string } | { pattern: string } | null>} */
  let routes;
  let framework;
  if (has("next")) {
    framework = "Next.js";
    routes = [...nextAppRoutes(files), ...nextPagesRoutes(files), ...htmlRoutes(files, { publicOnly: true })];
  } else if (has("nuxt")) {
    framework = "Nuxt";
    routes = [...nuxtRoutes(files), ...htmlRoutes(files, { publicOnly: true })];
  } else if (has("@sveltejs/kit")) {
    framework = "SvelteKit";
    routes = svelteKitRoutes(files);
  } else if (has("astro")) {
    framework = "Astro";
    routes = [...astroRoutes(files), ...htmlRoutes(files, { publicOnly: true })];
  } else if (has("@remix-run/dev") || has("@react-router/dev")) {
    framework = has("@react-router/dev") ? "React Router" : "Remix";
    const config = await routeConfigRoutes(root);
    routes = config ? config.routes : [];
    if (!config || config.flat) routes.push(...(await flatFileRoutes(root, files)));
  } else {
    framework = has("vite") ? "Vite" : pkg ? "" : "HTML";
    routes = [...htmlRoutes(files), ...(await clientRouterRoutes(root, files))];
  }
  return { framework, routes: /** @type {any} */ (routes.filter(Boolean)) };
}

/**
 * A matcher for a route pattern such as `/blog/:slug`.
 * @param {string} pattern
 */
export function patternMatcher(pattern) {
  const source = pattern
    .split("/")
    .map((part) => (part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  const regex = new RegExp(`^${source}/?$`);
  return (/** @type {string} */ value) => regex.test(value);
}

/**
 * The same-site page paths a page of HTML links to, without assets, API calls, the dev
 * server's own files, queries or fragments.
 * @param {string} html
 * @param {string} [from] the path the HTML was served at
 * @returns {string[]}
 */
export function pagesFromHtml(html, from = "/") {
  const found = new Set();
  const base = new URL(from, "http://page.local");
  for (const match of String(html || "").matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!href || /^(?:#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    const local = url.origin === base.origin || /^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    if (!local) continue;
    const page = cleanPage(url.pathname);
    if (page) found.add(page);
    if (found.size >= MAX_PAGES) break;
  }
  return [...found];
}

/**
 * The page paths a sitemap lists.
 * @param {string} xml
 * @returns {string[]}
 */
export function pagesFromSitemap(xml) {
  const found = new Set();
  for (const match of String(xml || "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      const page = cleanPage(new URL(match[1], "http://page.local").pathname);
      if (page) found.add(page);
    } catch {
      // not a URL
    }
    if (found.size >= MAX_PAGES) break;
  }
  return [...found];
}

/** @param {string} pathname */
function cleanPage(pathname) {
  const page = String(pathname || "");
  if (!page.startsWith("/") || page.startsWith("//") || page.length > 300) return "";
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\\]/.test(page)) return "";
  if (ASSET_PATH.test(page)) return "";
  if (/^\/(?:_next|@vite|@id|@fs|node_modules|api|_app|__)/.test(page)) return "";
  return page.replace(/\/{2,}$/, "/");
}

/**
 * One GET on the local dev server, bounded in time and size. Never throws.
 * @param {number} port
 * @param {string} page
 * @param {{ timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<{ status: number, type: string, body: string } | null>}
 */
export function fetchLocal(port, page, { timeoutMs = 2500, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(value);
    };
    const request = httpRequest(
      { host: "localhost", port, path: page, method: "GET", headers: { accept: "text/html,application/xml;q=0.9" } },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) return done(null);
          chunks.push(chunk);
        });
        response.on("end", () =>
          done({
            status: response.statusCode || 0,
            type: String(response.headers["content-type"] || ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", () => done(null));
      },
    );
    const timer = setTimeout(() => done(null), timeoutMs);
    request.on("error", () => done(null));
    request.end();
  });
}

/**
 * The pages the running site itself names: its sitemap, and the links on its home page.
 * @param {number} port
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function crawlDevServer(port, { timeoutMs = 2500 } = {}) {
  if (!port) return [];
  const [sitemap, home] = await Promise.all([
    fetchLocal(port, "/sitemap.xml", { timeoutMs }),
    fetchLocal(port, "/", { timeoutMs }),
  ]);
  const found = new Set();
  if (sitemap && sitemap.status === 200 && /<urlset|<sitemapindex/i.test(sitemap.body)) {
    for (const page of pagesFromSitemap(sitemap.body)) found.add(page);
  }
  if (home && home.status < 400 && /html/i.test(home.type)) {
    found.add("/");
    for (const page of pagesFromHtml(home.body, "/")) found.add(page);
  }
  return [...found];
}

/**
 * The picker's list: the routes on disk, the pages the site links to, and the pages
 * already on the board, each once, home first. A dynamic route takes the linked pages it
 * matches as its examples; one with none is left out and counted.
 * @param {{ routes?: Array<{ path: string } | { pattern: string }>, crawled?: string[], board?: string[] }} input
 * @returns {{ pages: Array<{ path: string, source: "board" | "files" | "site", pattern?: string }>, skipped: string[] }}
 */
export function mergePages({ routes = [], crawled = [], board = [] }) {
  /** @type {Map<string, { path: string, source: "board" | "files" | "site", pattern?: string }>} */
  const pages = new Map();
  const put = (page, source, pattern = "") => {
    if (!page || pages.has(page) || pages.size >= MAX_PAGES) return;
    pages.set(page, pattern ? { path: page, source, pattern } : { path: page, source });
  };
  for (const page of board) put(page, "board");
  const patterns = [];
  for (const route of routes) {
    if ("path" in route) put(route.path, "files");
    else patterns.push(route.pattern);
  }
  const skipped = [];
  for (const pattern of [...new Set(patterns)]) {
    const matches = patternMatcher(pattern);
    const examples = crawled.filter((page) => matches(page) && !pages.has(page)).slice(0, 3);
    if (examples.length === 0) {
      if (![...pages.keys()].some((page) => matches(page))) skipped.push(pattern);
      continue;
    }
    for (const example of examples) put(example, "site", pattern);
  }
  for (const page of crawled) put(page, "site");
  const sorted = [...pages.values()].sort((a, b) => {
    if (a.path === "/") return -1;
    if (b.path === "/") return 1;
    return a.path.localeCompare(b.path);
  });
  return { pages: sorted, skipped };
}
