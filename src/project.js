import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

import { AsyncMutex } from "./async-mutex.js";

/** @type {typeof import("node:child_process").spawn} */
const crossSpawn = createRequire(import.meta.url)("cross-spawn");

/**
 * A project board reviews a real repository: its board lives in `<repo>/.liesel/`, the
 * agent works in the repo root, and live items show the project's own running dev server
 * through a localhost proxy that adds the board SDK to every page it serves.
 *
 * Nothing in this file runs code from the repository until the user presses Start: the
 * dev server is detected by reading `package.json`, and the git exclude is written with
 * plain file reads, never a git command that could honour repo configuration.
 */

export const PROJECT_BOARD_DIR_NAME = ".liesel";
export const PROJECT_CONFIG_FILE = "projects.json";
export const DEV_OUTPUT_KEEP = 64 * 1024;
const MAX_DEV_COMMAND = 2000;
const MAX_PAGE = 500;
const MAX_PROXIED_HTML = 32 * 1024 * 1024;

/** @param {string} root */
export function projectBoardDir(root) {
  return path.join(root, PROJECT_BOARD_DIR_NAME);
}

/**
 * The repository root a board directory belongs to, or null for an ordinary board.
 * @param {string} dir
 */
export function projectRootForBoardDir(dir) {
  return path.basename(String(dir || "")) === PROJECT_BOARD_DIR_NAME ? path.dirname(dir) : null;
}

/**
 * The folder an Open project form names: an existing directory, absolute or under `~/`,
 * resolved through realpath. The filesystem root and the home folder are refused.
 * @param {unknown} input
 * @param {{ home?: string }} [options]
 * @returns {Promise<string>}
 */
export async function resolveProjectFolder(input, { home = homedir() } = {}) {
  const raw = String(input || "").trim();
  if (!raw) throw new ProjectError("Choose a project folder");
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) throw new ProjectError("Give the project folder as a full path, such as ~/code/shop");
  let folder;
  try {
    folder = await realpath(path.resolve(expanded));
  } catch {
    throw new ProjectError("That folder does not exist");
  }
  if (!(await stat(folder)).isDirectory()) throw new ProjectError("That path is a file, not a folder");
  const realHome = await realpath(home).catch(() => path.resolve(home));
  if (path.parse(folder).root === folder || folder === realHome) {
    throw new ProjectError("Choose the project's own folder, not the home folder or the disk");
  }
  return folder;
}

export class ProjectError extends Error {
  code = "VALIDATION_ERROR";
  statusCode = 400;

  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ProjectError";
  }
}

/**
 * The repository's `info/exclude` file, found by reading `.git` only. A worktree's
 * `.git` file points at its own git dir, whose `commondir` names the shared one.
 * @param {string} root
 * @returns {Promise<string | null>}
 */
export async function gitExcludeFile(root) {
  const dotGit = path.join(root, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (!info) return null;
  let gitDir = dotGit;
  if (info.isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8").catch(() => ""));
    if (!pointer) return null;
    gitDir = path.resolve(root, pointer[1].trim());
    const common = (await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
    if (common) gitDir = path.resolve(gitDir, common);
  } else if (!info.isDirectory()) {
    return null;
  }
  if (!(await stat(gitDir).catch(() => null))?.isDirectory()) return null;
  return path.join(gitDir, "info", "exclude");
}

/**
 * Keep the board folder out of git without touching the project's `.gitignore`.
 * @param {string} root
 * @returns {Promise<{ file: string | null, added: boolean }>}
 */
export async function ensureGitExclude(root) {
  const file = await gitExcludeFile(root);
  if (!file) return { file: null, added: false };
  const current = await readFile(file, "utf8").catch(() => "");
  const entry = `/${PROJECT_BOARD_DIR_NAME}/`;
  const listed = current
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) =>
      [entry, `${PROJECT_BOARD_DIR_NAME}/`, PROJECT_BOARD_DIR_NAME, `/${PROJECT_BOARD_DIR_NAME}`].includes(line),
    );
  if (listed) return { file, added: false };
  await mkdir(path.dirname(file), { recursive: true });
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await appendFile(file, `${prefix}# Liesel review board\n${entry}\n`, "utf8");
  return { file, added: true };
}

/**
 * A GitHub repository URL the Open project form accepts: `https://github.com/owner/repo`
 * (with or without `.git`, a trailing slash, or a `/tree/...` tail) or `github.com/owner/repo`.
 * @param {unknown} input
 * @returns {{ owner: string, repo: string, url: string } | null}
 */
export function parseGithubRepoUrl(input) {
  const raw = String(input || "").trim();
  const match =
    /^(?:https:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/(?:tree|blob)\/[^\s]*)?\/?$/i.exec(
      raw,
    );
  if (!match) return null;
  const [, owner, repo] = match;
  if (repo === "." || repo === "..") return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

/**
 * Clone a GitHub repository into `<parent>/<repo>`, or reuse that folder when it already
 * holds a clone. git runs from an argv array; no shell sees the URL.
 * @param {string} input
 * @param {{ parent?: string, execFileFn?: typeof execFile, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ root: string, cloned: boolean }>}
 */
export async function cloneGithubRepo(
  input,
  { parent = path.join(homedir(), "Liesel"), execFileFn = execFile, env = process.env } = {},
) {
  const parsed = parseGithubRepoUrl(input);
  if (!parsed) throw new ProjectError("Paste a GitHub repository URL, such as https://github.com/owner/repo");
  await mkdir(parent, { recursive: true });
  const target = path.join(parent, parsed.repo);
  const existing = await stat(target).catch(() => null);
  if (existing) {
    if (existing.isDirectory() && (await stat(path.join(target, ".git")).catch(() => null))) {
      return { root: await realpath(target), cloned: false };
    }
    throw new ProjectError(`${target} already exists and is not a clone`);
  }
  await new Promise((resolve, reject) => {
    execFileFn(
      "git",
      ["clone", "--", parsed.url, target],
      { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve(undefined);
          return;
        }
        const detail = String(stderr || error.message)
          .trim()
          .split("\n")
          .pop();
        reject(new ProjectError(`git clone failed: ${detail || "unknown error"}`));
      },
    );
  });
  return { root: await realpath(target), cloned: true };
}

const FRAMEWORKS = [
  { dep: "next", name: "Next.js", port: 3000 },
  { dep: "nuxt", name: "Nuxt", port: 3000 },
  { dep: "astro", name: "Astro", port: 4321 },
  { dep: "@sveltejs/kit", name: "SvelteKit", port: 5173 },
  { dep: "@remix-run/dev", name: "Remix", port: 5173 },
  { dep: "gatsby", name: "Gatsby", port: 8000 },
  { dep: "react-scripts", name: "Create React App", port: 3000 },
  { dep: "@angular/cli", name: "Angular", port: 4200 },
  { dep: "vite", name: "Vite", port: 5173 },
];

/**
 * What would start this project's dev server, read from its files only.
 * @param {string} root
 * @returns {Promise<{ command: string, port: number, framework: string, script: string, packageManager: string } | null>}
 */
export async function detectDevServer(root) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
  const script = ["dev", "start", "serve"].find((name) => typeof scripts[name] === "string" && scripts[name].trim());
  if (!script) return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const framework = FRAMEWORKS.find((entry) => Object.hasOwn(deps, entry.dep)) || null;
  const explicitPort = /(?:--port[ =]|-p\s+)(\d{2,5})\b/.exec(String(scripts[script]))?.[1];
  const exists = async (name) => Boolean(await stat(path.join(root, name)).catch(() => null));
  const packageManager = (await exists("pnpm-lock.yaml"))
    ? "pnpm"
    : (await exists("yarn.lock"))
      ? "yarn"
      : (await exists("bun.lockb")) || (await exists("bun.lock"))
        ? "bun"
        : "npm";
  return {
    command: `${packageManager} run ${script}`,
    port: explicitPort ? Number(explicitPort) : framework?.port || 3000,
    framework: framework?.name || "",
    script,
    packageManager,
  };
}

/**
 * Why `detectDevServer` found nothing, in words the board can show in a frame.
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function devServerDetectIssue(root) {
  let text;
  try {
    text = await readFile(path.join(root, "package.json"), "utf8");
  } catch {
    return "This folder has no package.json. Type the command that serves it, or the port of a server you run yourself, in Settings.";
  }
  try {
    JSON.parse(text);
  } catch {
    return "Its package.json could not be read as JSON.";
  }
  return "Its package.json has no dev, start or serve script. Type the command that serves it in Settings.";
}

/**
 * The port a dev server announced in its own output (`Local: http://localhost:5173/`).
 * @param {string} text
 * @returns {number}
 */
export function devServerPortFromOutput(text) {
  // eslint-disable-next-line no-control-regex
  const plain = String(text || "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  const match = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})\b/i.exec(plain);
  const port = match ? Number(match[1]) : 0;
  return port > 0 && port < 65536 ? port : 0;
}

/**
 * A live item's page: a URL path on the dev server, such as `/`, `/store` or `/products/x?ref=1`.
 * @param {unknown} value
 * @returns {string} the path, or "" when it is not one
 */
export function normalizeLivePage(value) {
  let raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      raw = parsed.pathname + parsed.search + parsed.hash;
    } catch {
      return "";
    }
  }
  if (!raw.startsWith("/")) raw = `/${raw}`;
  // eslint-disable-next-line no-control-regex
  if (raw.startsWith("//") || raw.length > MAX_PAGE || /[\s\u0000-\u001f\\]/.test(raw)) return "";
  return raw;
}

/**
 * Validates the dev server settings the board sent. The command is the user's own (or
 * the detected one they accepted); it runs when the board opens and on Start or Restart.
 * @param {unknown} value
 * @param {{ reservedPorts?: number[] }} [options]
 * @returns {{ config: { command: string, port: number } } | { error: string }}
 */
export function validateDevConfig(value, { reservedPorts = [] } = {}) {
  const source = /** @type {any} */ (value && typeof value === "object" ? value : {});
  const command = String(source.command || "").trim();
  if (command.length > MAX_DEV_COMMAND) return { error: "That command is too long" };
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000]/.test(command)) return { error: "The command must be one line" };
  const portInput = String(source.port ?? "").trim();
  const port = portInput ? Number(portInput) : 0;
  if (portInput && (!Number.isInteger(port) || port < 1 || port > 65535))
    return { error: "The port must be a number from 1 to 65535" };
  if (port && reservedPorts.includes(port)) return { error: `Port ${port} is Liesel's own; use the dev server's port` };
  if (!command && !port) return { error: "Give the dev server command, its port, or both" };
  return { config: { command, port } };
}

/**
 * Per-project dev server settings on this machine, keyed by the board's canonical
 * board.json path. Never stored in the repository: a cloned repo must not be able to
 * bring a command that runs when someone opens it.
 * @param {string} stateRoot
 */
export function createProjectConfigStore(stateRoot) {
  const file = path.join(stateRoot, PROJECT_CONFIG_FILE);
  const lock = new AsyncMutex();
  /** @returns {Promise<Record<string, any>>} */
  async function readAll() {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {
    file,
    /**
     * @param {string} boardFile
     * @returns {Promise<{ command: string, port: number, proxyPort: number } | null>}
     */
    async get(boardFile) {
      const entry = (await readAll())[boardFile];
      if (!entry || typeof entry !== "object") return null;
      return {
        command: String(entry.command || ""),
        port: Number(entry.port) || 0,
        proxyPort: Number(entry.proxy_port) || 0,
      };
    },
    /**
     * Merges `patch` into the stored settings; `null` forgets the project.
     * @param {string} boardFile
     * @param {{ command?: string, port?: number, proxyPort?: number } | null} patch
     */
    async update(boardFile, patch) {
      return lock.runExclusive(async () => {
        const all = await readAll();
        if (patch) {
          const current = all[boardFile] && typeof all[boardFile] === "object" ? all[boardFile] : {};
          const next = { ...current, updated_at: new Date().toISOString() };
          if (patch.command !== undefined) next.command = patch.command;
          if (patch.port !== undefined) next.port = patch.port;
          if (patch.proxyPort !== undefined) next.proxy_port = patch.proxyPort;
          all[boardFile] = next;
        } else {
          delete all[boardFile];
        }
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
      });
    },
  };
}

/**
 * One project's dev server process. `start` runs the command in the repo root through
 * the user's shell, in its own process group so Stop takes its children with it.
 * @param {{
 *   cwd: string,
 *   env?: NodeJS.ProcessEnv,
 *   onChange?: () => void,
 *   spawnFn?: typeof import("node:child_process").spawn,
 *   platform?: string,
 * }} options
 */
export function createDevServer({
  cwd,
  env = process.env,
  onChange = () => {},
  spawnFn = crossSpawn,
  platform = process.platform,
}) {
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  const state = {
    status: /** @type {"stopped" | "starting" | "running" | "exited" | "failed"} */ ("stopped"),
    command: "",
    port: 0,
    detectedPort: 0,
    output: "",
    error: "",
    started_at: "",
    pid: 0,
  };
  const kill = (signal) => {
    if (!child?.pid) return;
    try {
      if (platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };
  /** @type {Array<() => void>} */
  let closeWaiters = [];
  return {
    /** @param {{ command: string, port: number }} config */
    start(config) {
      if (child) return this.view();
      if (!config.command) {
        state.status = "failed";
        state.error = "No command to start; type the dev server command first";
        onChange();
        return this.view();
      }
      state.status = "starting";
      state.command = config.command;
      state.port = config.port || 0;
      state.detectedPort = 0;
      state.output = "";
      state.error = "";
      state.started_at = new Date().toISOString();
      const childEnv = {
        ...env,
        // A dev server must not open a browser window of its own.
        BROWSER: "none",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        ...(config.port ? { PORT: String(config.port) } : {}),
      };
      try {
        child =
          platform === "win32"
            ? spawnFn(config.command, [], {
                cwd,
                env: childEnv,
                shell: true,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
              })
            : spawnFn("/bin/sh", ["-c", config.command], {
                cwd,
                env: childEnv,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
              });
      } catch (error) {
        child = null;
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        onChange();
        return this.view();
      }
      state.pid = child.pid || 0;
      const keep = (chunk) => {
        state.output = (state.output + chunk).slice(-DEV_OUTPUT_KEEP);
        if (!state.detectedPort) {
          const port = devServerPortFromOutput(state.output);
          if (port) {
            state.detectedPort = port;
            state.status = "running";
          }
        }
        onChange();
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      const current = child;
      child.on("error", (error) => {
        if (child !== current) return;
        state.error = error.message;
      });
      child.on("close", (code, signal) => {
        if (child !== current) return;
        child = null;
        state.pid = 0;
        const waiters = closeWaiters;
        closeWaiters = [];
        for (const resolve of waiters) resolve();
        if (state.status !== "stopped") {
          state.status = code === 0 || signal === "SIGTERM" ? "exited" : "failed";
          if (!state.error && state.status === "failed") state.error = `Exited with ${code ?? signal}`;
        }
        onChange();
      });
      onChange();
      return this.view();
    },
    stop() {
      if (!child) {
        if (state.status !== "stopped") {
          state.status = "stopped";
          onChange();
        }
        return this.view();
      }
      state.status = "stopped";
      kill("SIGTERM");
      const doomed = child;
      const hard = setTimeout(() => {
        if (doomed.exitCode === null && doomed.signalCode === null) kill("SIGKILL");
      }, 3000);
      hard.unref?.();
      onChange();
      return this.view();
    },
    /**
     * Stops a running server, waits for its process group to go, and starts it again.
     * @param {{ command: string, port: number }} config
     */
    async restart(config) {
      if (child) {
        const gone = new Promise((resolve) => closeWaiters.push(() => resolve(undefined)));
        this.stop();
        await gone;
      }
      return this.start(config);
    },
    /** The port the server printed wins: a busy default makes Vite and others move on. */
    port() {
      return child ? state.detectedPort || state.port || 0 : 0;
    },
    running() {
      return Boolean(child);
    },
    /** Marks a server that answered as running even before it printed a URL. */
    markAnswering() {
      if (child && state.status === "starting") {
        state.status = "running";
        onChange();
      }
    },
    view() {
      return {
        status: state.status,
        command: state.command,
        port: state.detectedPort || state.port || 0,
        // eslint-disable-next-line no-control-regex
        output: state.output.slice(-8000).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""),
        error: state.error,
        last_line: lastOutputLine(state.output),
        started_at: state.started_at,
        running: Boolean(child),
      };
    },
  };
}

/**
 * The last thing a dev server printed, which is usually why it stopped.
 * @param {string} output
 */
function lastOutputLine(output) {
  // eslint-disable-next-line no-control-regex
  const plain = String(output || "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  const lines = plain.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line) return line.slice(0, 240);
  }
  return "";
}

/**
 * Inject the board SDK into one HTML page served through the live proxy.
 * @param {string} html
 * @param {string} src
 */
export function injectLiveSdk(html, src) {
  const tag = `<script src="${src}" data-liesel-live></script>`;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i, `${tag}</body>`);
  return `${html}\n${tag}`;
}

/** @param {string} value */
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] || char,
  );
}

/**
 * The page a live frame shows when there is no dev server to show. A `busy` page (the
 * server is starting) says so calmly and looks again every two seconds, so the frame
 * turns into the real page as soon as the server answers.
 * @param {{ title: string, message: string, sdkSrc: string, busy?: boolean }} options
 */
export function liveFallbackHtml({ title, message, sdkSrc, busy = false }) {
  const refresh = busy ? '<meta http-equiv="refresh" content="2">' : "";
  const mark = busy ? '<span class="busy" aria-hidden="true"></span>' : "";
  return injectLiveSdk(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${escapeHtml(title)}</title><style>html,body{margin:0}body{background:#f4f4f2;color:#16181d;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}main{box-sizing:border-box;min-height:100vh;display:grid;place-content:center;justify-items:center;gap:12px;max-width:min(760px,86vw);margin:0 auto;padding:32px;text-align:center}h1{font-size:clamp(26px,2.4vw,40px);line-height:1.25;font-weight:600;letter-spacing:-0.01em;margin:0}p{margin:0;color:#6b717c;font-size:clamp(17px,1.5vw,24px);overflow-wrap:anywhere}.busy{width:clamp(30px,2.6vw,44px);height:clamp(30px,2.6vw,44px);margin-bottom:12px;border-radius:50%;border:2px solid #dcdcd8;border-top-color:#16181d;animation:spin 900ms linear infinite}@keyframes spin{to{transform:rotate(1turn)}}@media (prefers-reduced-motion:reduce){.busy{animation-duration:2.4s}}</style></head><body><main data-liesel-placeholder${busy ? ' data-busy="true"' : ""}>${mark}<h1>${escapeHtml(title)}</h1>${message ? `<p>${escapeHtml(message)}</p>` : ""}</main></body></html>`,
    sdkSrc,
  );
}

/**
 * A localhost-only reverse proxy for one project's dev server. It listens on its own
 * loopback port, so the project's pages keep their absolute URLs and their own origin,
 * which is never Liesel's. It forwards only to `localhost:<port>` and rewrites Host,
 * Origin and Referer so the dev server sees its own address. Every HTML page gets the
 * board SDK appended; WebSocket upgrades (hot reload) pass straight through.
 * @param {{
 *   upstreamPort: () => number,
 *   sdkSrc: string,
 *   reservedPorts?: () => number[],
 *   onAnswer?: () => void,
 *   statusMessage?: () => { title: string, message: string, busy?: boolean },
 * }} options
 */
export function createLiveProxy({
  upstreamPort,
  sdkSrc,
  reservedPorts = () => [],
  onAnswer = () => {},
  statusMessage,
}) {
  let origin = "";
  let ownPort = 0;
  /** @type {Set<import("node:stream").Duplex>} */
  const sockets = new Set();

  const hostAllowed = (host) => {
    const value = String(host || "").toLowerCase();
    return value === `127.0.0.1:${ownPort}` || value === `localhost:${ownPort}`;
  };
  const target = () => {
    const port = Number(upstreamPort()) || 0;
    if (!port || port === ownPort || reservedPorts().includes(port)) return 0;
    return port;
  };
  const rewriteHeaders = (headers, port) => {
    const upstreamOrigin = `http://localhost:${port}`;
    /** @type {Record<string, any>} */
    const next = { ...headers, host: `localhost:${port}`, "accept-encoding": "identity" };
    for (const name of ["origin", "referer"]) {
      const value = next[name];
      if (typeof value !== "string") continue;
      try {
        const parsed = new URL(value);
        if (hostAllowed(parsed.host))
          next[name] = `${upstreamOrigin}${name === "origin" ? "" : parsed.pathname + parsed.search}`;
      } catch {
        // leave it
      }
    }
    return next;
  };
  const fallback = (res, status, title, message, busy = false) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const html = liveFallbackHtml({ title, message, sdkSrc, busy });
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  };

  const server = createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    const port = target();
    if (!port) {
      const status = statusMessage?.() || {
        title: "No dev server",
        message: "Start the project's dev server from the board.",
      };
      fallback(res, 503, status.title, status.message, Boolean(status.busy));
      return;
    }
    const upstream = httpRequest(
      {
        host: "localhost",
        port,
        method: req.method,
        path: req.url,
        headers: rewriteHeaders(req.headers, port),
      },
      (response) => {
        onAnswer();
        /** @type {Record<string, any>} */
        const headers = { ...response.headers };
        if (typeof headers.location === "string") {
          headers.location = headers.location.replace(
            /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i,
            (whole, upstreamPortText) => (Number(upstreamPortText) === port ? origin : whole),
          );
        }
        const type = String(headers["content-type"] || "");
        const isHtml = /^text\/html\b/i.test(type) && req.method !== "HEAD" && response.statusCode !== 304;
        // A design frame must load: framing and script policy are the board's call here.
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        delete headers["content-security-policy-report-only"];
        if (!isHtml) {
          res.writeHead(response.statusCode || 502, headers);
          response.pipe(res);
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_PROXIED_HTML) {
            response.destroy();
            fallback(res, 502, "Page too large", "The dev server sent a page over 32 MB.");
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (res.headersSent || size > MAX_PROXIED_HTML) return;
          const html = injectLiveSdk(Buffer.concat(chunks).toString("utf8"), sdkSrc);
          delete headers["content-length"];
          delete headers["transfer-encoding"];
          delete headers["content-encoding"];
          headers["cache-control"] = "no-store";
          headers["content-length"] = String(Buffer.byteLength(html));
          res.writeHead(response.statusCode || 200, headers);
          res.end(html);
        });
        response.on("error", () => res.destroy());
      },
    );
    upstream.on("error", () => {
      const status = statusMessage?.() || {
        title: "Dev server not answering",
        message: `Nothing answered at localhost:${port}.`,
      };
      fallback(res, 502, status.title, status.message, Boolean(status.busy));
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    const port = target();
    if (!hostAllowed(req.headers.host) || !port) {
      socket.destroy();
      return;
    }
    const upstream = netConnect({ host: "localhost", port, autoSelectFamily: true }, () => {
      const headers = rewriteHeaders(req.headers, port);
      delete headers["accept-encoding"];
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      upstream.destroy();
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", close);
    socket.on("error", close);
    upstream.on("close", () => socket.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    /**
     * Listens on `preferredPort` when it is free, so saved history snapshots keep their
     * asset links across restarts, and on any free port otherwise.
     * @param {number} [preferredPort]
     * @returns {Promise<string>} the proxy's origin
     */
    async listen(preferredPort = 0) {
      if (preferredPort > 0) {
        try {
          return await this.listenOn(preferredPort);
        } catch {
          // taken; any port will do
        }
      }
      return this.listenOn(0);
    },
    /** @param {number} port */
    listenOn(port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port }, () => {
          server.off("error", reject);
          server.on("error", () => {});
          const address = server.address();
          ownPort = typeof address === "object" && address ? address.port : 0;
          origin = `http://127.0.0.1:${ownPort}`;
          resolve(origin);
        });
      });
    },
    origin: () => origin,
    port: () => ownPort,
    close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
