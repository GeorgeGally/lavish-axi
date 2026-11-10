import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

// A project board's source watcher. A repository can hold tens of thousands of files
// (vendored models, caches, build output), and a recursive file watcher opens one
// descriptor per file on macOS, which once took the whole Liesel server down. So this
// watches directories only, never files, never a folder that is dependency, cache, log or
// build output, never anything git ignores, and never more than a fixed number of them.

/** Directory names that are never source, at any depth. */
const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".liesel",
  "node_modules",
  "bower_components",
  ".pnpm-store",
  ".yarn",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".astro",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vercel",
  ".netlify",
  ".angular",
  ".expo",
  ".gradle",
  ".terraform",
  ".bundle",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "dist",
  "build",
  "coverage",
  "out",
  "target",
  "tmp",
  "temp",
  "log",
  "logs",
  "storage",
  "vendor",
  "Pods",
  "DerivedData",
]);

/** Paths below the project root that are generated output, not source. */
const IGNORED_ROOT_PATHS = ["public/assets", "public/packs", "public/packs-test", "public/build", "public/vite"];

export const PROJECT_WATCH_MAX_DIRS = 1000;
const GIT_LIST_TIMEOUT_MS = 15_000;
const GIT_LIST_MAX_BUFFER = 64 * 1024 * 1024;
const WALK_MAX_ENTRIES = 50_000;

/**
 * Whether a path relative to the project root is never watched.
 * @param {string} relative
 */
export function isIgnoredProjectPath(relative) {
  const parts = String(relative || "")
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts.some((part) => IGNORED_DIR_NAMES.has(part))) return true;
  const joined = parts.join("/");
  return IGNORED_ROOT_PATHS.some((prefix) => joined === prefix || joined.startsWith(`${prefix}/`));
}

/**
 * The files git would show for a repository: tracked plus untracked-but-not-ignored, so
 * everything a `.gitignore` names is left out. Null when the root is not a git work tree.
 * @param {string} root
 * @returns {Promise<string[] | null>}
 */
function gitListedFiles(root) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { timeout: GIT_LIST_TIMEOUT_MS, maxBuffer: GIT_LIST_MAX_BUFFER, windowsHide: true },
      (error, stdout) => resolve(error ? null : String(stdout).split("\0").filter(Boolean)),
    );
  });
}

/**
 * A breadth-first walk for a folder that is not a git repository, bounded in directories
 * and in entries read, skipping ignored and symlinked directories.
 * @param {string} root
 * @param {number} maxDirs
 */
async function walkDirs(root, maxDirs) {
  const dirs = [""];
  let entries = 0;
  let truncated = false;
  for (let index = 0; index < dirs.length; index += 1) {
    const relative = dirs[index];
    let listing;
    try {
      listing = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of listing) {
      entries += 1;
      if (entries > WALK_MAX_ENTRIES) return { dirs, truncated: true };
      if (!entry.isDirectory()) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (isIgnoredProjectPath(child)) continue;
      if (dirs.length >= maxDirs) {
        truncated = true;
        continue;
      }
      dirs.push(child);
    }
  }
  return { dirs, truncated };
}

/**
 * The project's source directories, relative to the root (the root itself is ""),
 * shallowest first, at most `maxDirs` of them.
 * @param {string} root
 * @param {{ maxDirs?: number }} [options]
 * @returns {Promise<{ dirs: string[], total: number, truncated: boolean, source: "git" | "walk" }>}
 */
export async function projectSourceDirs(root, { maxDirs = PROJECT_WATCH_MAX_DIRS } = {}) {
  const files = await gitListedFiles(root);
  if (!files) {
    const walked = await walkDirs(root, maxDirs);
    return { dirs: walked.dirs, total: walked.dirs.length, truncated: walked.truncated, source: "walk" };
  }
  /** @type {Set<string>} */
  const all = new Set([""]);
  for (const file of files) {
    if (isIgnoredProjectPath(file)) continue;
    let dir = path.posix.dirname(file);
    while (dir !== "." && !all.has(dir)) {
      all.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  const depth = (/** @type {string} */ dir) => (dir ? dir.split("/").length : 0);
  const sorted = [...all].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  return { dirs: sorted.slice(0, maxDirs), total: sorted.length, truncated: sorted.length > maxDirs, source: "git" };
}

/**
 * Watches a project's source directories and calls `onChange` with the changed path,
 * relative to the root. Setup runs after the caller returns and never throws: a failure
 * is reported through `onLog` and leaves this one project unwatched.
 * @param {string} root
 * @param {{
 *   onChange: (relative: string) => void,
 *   onLog?: (message: string) => void,
 *   maxDirs?: number,
 * }} options
 */
export function watchProjectTree(root, { onChange, onLog = () => {}, maxDirs = PROJECT_WATCH_MAX_DIRS }) {
  /** @type {import("node:fs").FSWatcher[]} */
  const watchers = [];
  let closed = false;
  /** @type {(value: { dirs: number, total: number, truncated: boolean }) => void} */
  let settle = () => {};
  /** @type {Promise<{ dirs: number, total: number, truncated: boolean }>} */
  const ready = new Promise((resolve) => {
    settle = resolve;
  });

  /** @param {string} dir */
  function watchDir(dir) {
    let watcher;
    try {
      watcher = watch(path.join(root, dir), { persistent: false }, (_event, name) => {
        if (closed) return;
        const relative = name ? (dir ? `${dir}/${name}` : String(name)) : dir;
        if (isIgnoredProjectPath(relative)) return;
        onChange(relative);
      });
    } catch {
      return false;
    }
    // A removed directory or a revoked permission ends that one watch, nothing else.
    watcher.on("error", () => {
      watcher.close();
      const index = watchers.indexOf(watcher);
      if (index !== -1) watchers.splice(index, 1);
    });
    watchers.push(watcher);
    return true;
  }

  const start = async () => {
    const found = await projectSourceDirs(root, { maxDirs });
    if (closed) return { dirs: 0, total: found.total, truncated: found.truncated };
    if (found.truncated) {
      onLog(
        `project watch capped root=${root} watching=${found.dirs.length} of ${found.source === "git" ? found.total : "more"} source folders`,
      );
    }
    for (const dir of found.dirs) {
      if (closed) break;
      watchDir(dir);
    }
    return { dirs: watchers.length, total: found.total, truncated: found.truncated };
  };

  setImmediate(() => {
    start().then(settle, (error) => {
      onLog(`project watch failed root=${root}: ${error instanceof Error ? error.message : error}`);
      settle({ dirs: 0, total: 0, truncated: false });
    });
  });

  return {
    ready,
    watchedCount: () => watchers.length,
    async close() {
      closed = true;
      for (const watcher of watchers.splice(0)) watcher.close();
    },
  };
}
