import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { BoardError } from "./board.js";
import { PRODUCT_NAME } from "./brand.js";

/**
 * @typedef {object} HomeBoard
 * @property {string} key
 * @property {string} name
 * @property {string} folder the shortened folder, unique among the listed boards
 * @property {string} folderTitle the full folder path
 * @property {string} updatedAt ISO time of the last change
 * @property {number} agentReplies how many agent replies the board's chat holds
 * @property {{ kind: "image" | "frame", src: string } | null} preview
 * @property {boolean} [project] a project board: its folder is the repository
 */

/**
 * A path with the home folder written as `~`.
 * @param {string} dir
 * @param {string} [home]
 */
export function tildePath(dir, home = homedir()) {
  const normalized = dir.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalizedHome && normalized === normalizedHome) return "~";
  if (normalizedHome && normalized.startsWith(`${normalizedHome}/`)) {
    return `~/${normalized.slice(normalizedHome.length + 1)}`;
  }
  return normalized;
}

/**
 * Short folder names for a list of boards: the last two folders, grown one folder at a time
 * until no two boards share a label, so two boards with the same name are told apart.
 * @param {string[]} dirs
 * @param {string} [home]
 * @returns {string[]}
 */
export function folderLabels(dirs, home = homedir()) {
  const parts = dirs.map((dir) => tildePath(dir, home).split("/"));
  const depth = parts.map(() => 2);
  const label = (index) => {
    const segments = parts[index];
    if (segments.length <= 3 || depth[index] >= segments.length - 1) return segments.join("/");
    return `…/${segments.slice(-depth[index]).join("/")}`;
  };
  for (let round = 0; round < 64; round += 1) {
    const labels = parts.map((_, index) => label(index));
    /** @type {Map<string, number[]>} */
    const groups = new Map();
    labels.forEach((value, index) => groups.set(value, [...(groups.get(value) || []), index]));
    let grew = false;
    for (const indexes of groups.values()) {
      if (indexes.length < 2) continue;
      for (const index of indexes) {
        if (depth[index] < parts[index].length - 1) {
          depth[index] += 1;
          grew = true;
        }
      }
    }
    if (!grew) return labels;
  }
  return parts.map((_, index) => label(index));
}

/**
 * When something last changed, in plain words.
 * @param {string} iso
 * @param {number} [now]
 */
export function relativeTime(iso, now = Date.now()) {
  const at = Date.parse(String(iso || ""));
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, (now - at) / 1000);
  const plural = (count, unit) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  if (seconds < 45) return "Just now";
  if (seconds < 3600) return plural(Math.max(1, Math.round(seconds / 60)), "minute");
  if (seconds < 86_400) return plural(Math.floor(seconds / 3600), "hour");
  if (seconds < 2 * 86_400) return "Yesterday";
  if (seconds < 7 * 86_400) return plural(Math.floor(seconds / 86_400), "day");
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * One folder's subfolders, for the New board form's folder browser. Only names of folders
 * are returned (hidden ones left out), plus how many HTML files the folder itself holds.
 * With `nearest`, a folder that does not exist yet starts the browser at its nearest parent.
 * @param {unknown} input
 * @param {{ nearest?: boolean, home?: string }} [options]
 */
export async function listFolder(input, { nearest = false, home = homedir() } = {}) {
  let raw = String(input || "").trim();
  if (!raw) {
    const liesel = path.join(home, PRODUCT_NAME);
    raw = (await stat(liesel).catch(() => null))?.isDirectory() ? liesel : home;
  }
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) {
    throw new BoardError("Give the folder as a full path, such as ~/Liesel/my-board");
  }
  let folder = path.resolve(expanded);
  let info = await stat(folder).catch(() => null);
  while (nearest && !info && path.dirname(folder) !== folder) {
    folder = path.dirname(folder);
    info = await stat(folder).catch(() => null);
  }
  if (!info) throw new BoardError("That folder does not exist");
  if (!info.isDirectory()) throw new BoardError("That path is a file, not a folder");
  const real = await realpath(folder);
  const entries = await readdir(real, { withFileTypes: true }).catch(() => {
    throw new BoardError("Liesel cannot read that folder");
  });
  /** @type {string[]} */
  const names = [];
  let html = 0;
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile() && /\.html?$/i.test(entry.name)) html += 1;
    let isFolder = entry.isDirectory();
    if (!isFolder && entry.isSymbolicLink()) {
      isFolder = Boolean((await stat(path.join(real, entry.name)).catch(() => null))?.isDirectory());
    }
    if (isFolder) names.push(entry.name);
  }
  names.sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
  const parent = path.dirname(real);
  return {
    path: real,
    display: tildePath(real, home),
    parent: parent === real ? null : parent,
    html,
    folders: names.slice(0, 500).map((name) => ({ name, path: path.join(real, name) })),
  };
}

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char,
  );
}

const STYLE = `
:root{color-scheme:light;--bg:#ececea;--surface:#fbfbfa;--surface-strong:#fff;--sunken:#f3f3f1;--ink:#16181d;--ink-2:#3d424c;--ink-3:#6b717c;--ink-4:#9a9fa8;--line:#e2e2de;--line-strong:#cfcfca;--hover:rgba(22,24,29,.05);--select:#2563eb;--danger:#c2410c;--on-ink:#fff;
--thumb-shadow:0 0 0 1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.05),0 8px 24px rgba(0,0,0,.05);
--thumb-shadow-hover:0 0 0 1px rgba(0,0,0,.08),0 2px 4px rgba(0,0,0,.06),0 16px 40px rgba(0,0,0,.10);
--float:0 1px 2px rgba(22,24,29,.08),0 24px 64px rgba(22,24,29,.22);--outline:rgba(0,0,0,.1);--scrim:rgba(14,15,18,.36);
--font:Geist,Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--ease:cubic-bezier(.2,0,0,1)}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;--bg:#111214;--surface:#1a1b1e;--surface-strong:#202226;--sunken:#16171a;--ink:#ececea;--ink-2:#c9cbcf;--ink-3:#9a9fa8;--ink-4:#6b717c;--line:#2a2c31;--line-strong:#3a3d43;--hover:rgba(255,255,255,.06);--select:#60a5fa;--danger:#f97316;--on-ink:#111214;
--thumb-shadow:0 0 0 1px rgba(255,255,255,.07),0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.3);
--thumb-shadow-hover:0 0 0 1px rgba(255,255,255,.12),0 2px 4px rgba(0,0,0,.4),0 16px 40px rgba(0,0,0,.45);
--float:0 0 0 1px rgba(255,255,255,.08),0 24px 64px rgba(0,0,0,.6);--outline:rgba(255,255,255,.1);--scrim:rgba(0,0,0,.55)}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:15px/1.45 var(--font);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
button,input{font:inherit;color:inherit}
.wrap{width:min(1360px,100%);margin:0 auto;padding:0 40px}
.top{display:flex;align-items:center;gap:16px;min-height:56px;padding-top:40px}
h1{margin:0;font-size:28px;line-height:1.15;font-weight:650;letter-spacing:-.01em}
.actions{display:flex;align-items:center;gap:10px;margin-left:auto}
.button{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 16px;border-radius:10px;border:1px solid var(--line-strong);background:var(--surface-strong);color:var(--ink);font-size:14px;font-weight:550;white-space:nowrap;cursor:pointer;transition:background-color 120ms var(--ease),border-color 120ms var(--ease),transform 100ms var(--ease)}
.button:hover:not(:disabled){border-color:var(--ink-4)}
.button:active:not(:disabled){transform:scale(.96)}
.button:disabled{opacity:.5;cursor:default}
.button-primary{border-color:var(--ink);background:var(--ink);color:var(--on-ink)}
.button-primary:hover:not(:disabled){border-color:var(--ink-2);background:var(--ink-2)}
.button-quiet{border-color:transparent;background:transparent;color:var(--ink-3)}
.button-quiet:hover:not(:disabled){border-color:transparent;background:var(--hover);color:var(--ink)}
.button svg{flex:none}
:focus-visible{outline:2px solid var(--select);outline-offset:2px}
.boards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,296px),1fr));gap:40px 28px;margin:40px 0 0;padding:0 0 80px}
.board{position:relative;min-width:0}
.thumb{position:relative;aspect-ratio:16/10;overflow:hidden;border-radius:12px;background:var(--surface);box-shadow:var(--thumb-shadow);transition:box-shadow 180ms var(--ease),transform 180ms var(--ease)}
.thumb::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--outline);pointer-events:none}
.thumb iframe{position:absolute;top:0;left:0;width:1440px;height:900px;border:0;transform-origin:0 0;transform:scale(var(--s,.2));pointer-events:none;opacity:0;transition:opacity 240ms var(--ease);background:#fff}
.thumb iframe.loaded{opacity:1}
.thumb img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center}
.thumb-empty{display:grid;place-items:center;height:100%;color:var(--ink-4);font-size:14px}
.board:hover .thumb{box-shadow:var(--thumb-shadow-hover);transform:translateY(-2px)}
.board:has(a:focus-visible) .thumb{outline:2px solid var(--select);outline-offset:3px}
.board-title{display:flex;align-items:center;gap:10px;margin-top:16px}
.board-name{flex:1;min-width:0;margin:0;font-size:16px;line-height:1.35;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.board-name a{color:inherit;text-decoration:none}
.board-name a:focus-visible{outline:none}
.board-name a::after{content:"";position:absolute;inset:-8px;border-radius:16px}
.unread{flex:none;min-width:22px;height:22px;padding:0 8px;border-radius:11px;background:var(--ink);color:var(--on-ink);font-size:12px;font-weight:600;line-height:22px;text-align:center;font-variant-numeric:tabular-nums}
.unread[hidden]{display:none}
.board-meta{display:flex;align-items:baseline;gap:12px;margin:4px 0 0;color:var(--ink-3);font-size:13px}
.folder{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.board-meta time{flex:none;font-variant-numeric:tabular-nums}
.kind{flex:none;padding:0 8px;border-radius:999px;background:var(--hover);color:var(--ink-2);font-size:12px;font-weight:550;line-height:20px}
.empty{max-width:420px;margin:120px auto 0;padding-bottom:80px;text-align:center}
.empty h2{margin:0;font-size:20px;font-weight:600;text-wrap:balance}
.empty p{margin:8px 0 0;color:var(--ink-3);text-wrap:pretty}
dialog{width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 32px);margin:auto;padding:0;border:0;border-radius:18px;background:var(--surface);color:var(--ink);box-shadow:var(--float);overflow:auto}
dialog::backdrop{background:var(--scrim);backdrop-filter:blur(2px)}
dialog[open]{animation:sheet-in 200ms var(--ease)}
@keyframes sheet-in{from{opacity:0;transform:translateY(8px) scale(.98)}}
.sheet{padding:28px}
.sheet h2{margin:0;font-size:19px;font-weight:600}
form{display:grid;gap:20px;margin-top:24px}
label,.field-label{display:grid;gap:8px;font-size:13px;font-weight:550;color:var(--ink-2)}
input{width:100%;height:42px;padding:0 12px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface-strong);font-size:15px;font-weight:400;color:var(--ink)}
input::placeholder{color:var(--ink-4)}
input:focus{outline:2px solid var(--select);outline-offset:-1px;border-color:transparent}
.field{display:grid;gap:8px}
.folder-row{display:flex;gap:8px}
.folder-row input{flex:1;min-width:0}
.folder-row .button{height:42px}
.hint{margin:0;color:var(--ink-3);font-size:13px}
.browser{border-radius:12px;background:var(--sunken);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.browser[hidden]{display:none}
.browser-head{display:flex;align-items:center;gap:8px;padding:4px 12px 4px 4px;border-bottom:1px solid var(--line)}
.browser-up{display:grid;place-items:center;width:40px;height:40px;border:0;border-radius:8px;background:transparent;color:var(--ink-2);cursor:pointer}
.browser-up:hover:not(:disabled){background:var(--hover)}
.browser-up:disabled{opacity:.35;cursor:default}
.browser-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--ink-2)}
.browser-count{flex:none;font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.browser-list{max-height:240px;overflow:auto;margin:0;padding:4px;list-style:none}
.browser-list button{display:flex;align-items:center;gap:10px;width:100%;height:40px;padding:0 10px;border:0;border-radius:8px;background:transparent;font-size:14px;text-align:left;cursor:pointer}
.browser-list button:hover{background:var(--hover)}
.browser-list svg{flex:none;color:var(--ink-4)}
.browser-list span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.browser-note{padding:12px;color:var(--ink-3);font-size:13px}
.error{margin:0;color:var(--danger);font-size:13px}
.error:empty{display:none}
.sheet-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:12px}
@media (max-width:820px){.wrap{padding:0 24px}.top{padding-top:28px}.boards{gap:32px 20px;margin-top:32px}}
@media (max-width:520px){.wrap{padding:0 16px}.top{padding-top:20px}h1{font-size:24px}.boards{gap:28px;margin-top:24px}.sheet{padding:24px 20px}.empty{margin-top:72px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.board:hover .thumb{transform:none}}
`;

const FOLDER_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const UP_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
const PLUS_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

const SCRIPT = `(() => {
  const readSeen = (key) => { try { return Number(localStorage.getItem("liesel:read:" + key) || 0); } catch { return 0; } };
  for (const badge of document.querySelectorAll("[data-unread-key]")) {
    const count = Math.max(0, Number(badge.dataset.replies || 0) - readSeen(badge.dataset.unreadKey));
    if (count > 0) {
      badge.textContent = count + " new";
      badge.setAttribute("aria-label", count === 1 ? "1 new reply" : count + " new replies");
      badge.hidden = false;
    }
  }

  const frames = [...document.querySelectorAll(".thumb iframe[data-src]")];
  const fit = (thumb) => thumb.style.setProperty("--s", String(thumb.clientWidth / 1440));
  const sizer = "ResizeObserver" in window ? new ResizeObserver((entries) => entries.forEach((entry) => fit(entry.target))) : null;
  const load = (frame) => {
    if (frame.src) return;
    frame.addEventListener("load", () => frame.classList.add("loaded"), { once: true });
    frame.src = frame.dataset.src;
  };
  const watcher = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          watcher.unobserve(entry.target);
          load(entry.target);
        }
      }, { rootMargin: "300px 0px" })
    : null;
  for (const frame of frames) {
    const thumb = frame.parentElement;
    fit(thumb);
    sizer?.observe(thumb);
    if (watcher) watcher.observe(frame);
    else load(frame);
  }

  const slug = (value) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const titled = (value) => value.replace(/[-_]+/g, " ").replace(/\\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());

  // A folder browser over the same-origin folder list: one per dialog.
  const folderBrowser = (prefix, { input, error, onChoose }) => {
    const toggle = document.getElementById("browse" + prefix[0].toUpperCase() + prefix.slice(1));
    const pane = document.getElementById(prefix + "Browser");
    const pathLabel = document.getElementById(prefix + "BrowserPath");
    const count = document.getElementById(prefix + "BrowserCount");
    const list = document.getElementById(prefix + "BrowserList");
    const up = document.getElementById(prefix + "BrowserUp");
    let parent = null;
    const show = async (target, { nearest = false, choose = false } = {}) => {
      list.setAttribute("aria-busy", "true");
      try {
        const response = await fetch("/api/folder-list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: target, nearest }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "That folder could not be read.");
        parent = payload.parent;
        up.disabled = !parent;
        pathLabel.textContent = payload.display;
        pathLabel.title = payload.path;
        count.textContent = payload.html > 0 ? (payload.html === 1 ? "1 design" : payload.html + " designs") : "";
        list.replaceChildren();
        for (const entry of payload.folders) {
          const row = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.innerHTML = ${JSON.stringify(FOLDER_ICON)};
          const label = document.createElement("span");
          label.textContent = entry.name;
          button.append(label);
          button.addEventListener("click", () => show(entry.path, { choose: true }));
          row.append(button);
          list.append(row);
        }
        if (payload.folders.length === 0) {
          const note = document.createElement("li");
          note.className = "browser-note";
          note.textContent = "No folders inside.";
          list.append(note);
        }
        if (choose) {
          input.value = payload.display;
          onChoose?.(payload);
        }
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : String(failure);
      } finally {
        list.removeAttribute("aria-busy");
      }
    };
    toggle.addEventListener("click", () => {
      const opening = pane.hidden;
      pane.hidden = !opening;
      toggle.setAttribute("aria-expanded", String(opening));
      if (opening) show(/^https?:|github\\.com/i.test(input.value) ? "~" : input.value, { nearest: true });
    });
    up.addEventListener("click", () => { if (parent) show(parent, { choose: true }); });
  };

  const modal = (dialog, cancel, opener, focus, error) => {
    for (const button of document.querySelectorAll(opener)) {
      button.addEventListener("click", () => {
        error.textContent = "";
        dialog.showModal();
        focus.focus();
      });
    }
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  };

  // Open project: a repository folder on this machine, or a GitHub URL to clone.
  const projectDialog = document.getElementById("openProjectDialog");
  const projectForm = document.getElementById("openProject");
  const projectPath = projectForm.elements.namedItem("path");
  const projectError = document.getElementById("openProjectError");
  const projectSubmit = document.getElementById("openProjectSubmit");
  modal(projectDialog, document.getElementById("openProjectCancel"), "[data-open-project]", projectPath, projectError);
  folderBrowser("project", { input: projectPath, error: projectError });
  projectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    projectError.textContent = "";
    projectSubmit.disabled = true;
    projectSubmit.textContent = /github\\.com\\//i.test(projectPath.value) ? "Cloning…" : "Opening…";
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: projectPath.value }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.key) throw new Error(payload.error || "The project could not be opened.");
      location.href = "/board/" + encodeURIComponent(payload.key);
    } catch (failure) {
      projectError.textContent = failure instanceof Error ? failure.message : String(failure);
      projectSubmit.disabled = false;
      projectSubmit.textContent = "Open project";
    }
  });

  const dialog = document.getElementById("newBoardDialog");
  const form = document.getElementById("newBoard");
  const name = form.elements.namedItem("name");
  const folder = form.elements.namedItem("folder");
  const error = document.getElementById("newBoardError");
  const submit = document.getElementById("newBoardSubmit");
  let folderEdited = false;
  modal(dialog, document.getElementById("newBoardCancel"), "[data-open-new-board]", name, error);
  name.addEventListener("input", () => {
    if (!folderEdited) folder.value = "~/Liesel/" + slug(name.value);
  });
  folder.addEventListener("input", () => { folderEdited = true; });
  folderBrowser("folder", {
    input: folder,
    error,
    onChoose: (payload) => {
      folderEdited = true;
      if (!name.value.trim()) name.value = titled(payload.display.split("/").pop() || "");
    },
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      const response = await fetch("/api/board-folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder: folder.value, name: name.value }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.key) throw new Error(payload.error || "The board could not be made.");
      location.href = "/board/" + encodeURIComponent(payload.key);
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      submit.disabled = false;
    }
  });

  // A board's New menu links here with #new-board or #open-project: the same dialog opens,
  // and closing it without going anywhere returns to that board.
  const intent = { "#new-board": [dialog, "[data-open-new-board]"], "#open-project": [projectDialog, "[data-open-project]"] }[location.hash];
  if (intent) {
    history.replaceState(history.state, "", location.pathname + location.search);
    let fromBoard = false;
    try {
      const from = new URL(document.referrer);
      fromBoard = from.origin === location.origin && from.pathname.startsWith("/board/") && history.length > 1;
    } catch {}
    document.querySelector(intent[1])?.click();
    if (fromBoard) intent[0].addEventListener("close", () => history.back(), { once: true });
  }
})();`;

/** The folder browser under a folder field; `prefix` names its ids. @param {string} prefix */
function browserMarkup(prefix) {
  return `<div class="browser" id="${prefix}Browser" hidden><div class="browser-head"><button class="browser-up" id="${prefix}BrowserUp" type="button" aria-label="Up one folder" title="Up one folder">${UP_ICON}</button><span class="browser-path" id="${prefix}BrowserPath"></span><span class="browser-count" id="${prefix}BrowserCount"></span></div><ul class="browser-list" id="${prefix}BrowserList" aria-label="Folders"></ul></div>`;
}

/** @param {HomeBoard} board @param {number} now */
function boardCard(board, now) {
  const key = escapeHtml(board.key);
  const name = escapeHtml(board.name);
  let preview = '<div class="thumb-empty">No designs yet</div>';
  if (board.preview?.kind === "image") {
    preview = `<img src="${escapeHtml(board.preview.src)}" alt="" loading="lazy" decoding="async">`;
  } else if (board.preview?.kind === "frame") {
    preview = `<iframe data-src="${escapeHtml(board.preview.src)}" sandbox="allow-scripts" tabindex="-1" aria-hidden="true" title="" referrerpolicy="no-referrer"></iframe>`;
  }
  const when = relativeTime(board.updatedAt, now);
  const stamp = Date.parse(board.updatedAt);
  const full = Number.isFinite(stamp)
    ? new Date(stamp).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "";
  const time = when
    ? `<time datetime="${escapeHtml(board.updatedAt)}" title="${escapeHtml(full)}">${escapeHtml(when)}</time>`
    : "";
  return `<article class="board"><div class="thumb">${preview}</div><div class="board-title"><h2 class="board-name"><a href="/board/${key}">${name}</a></h2><span class="unread" data-unread-key="${key}" data-replies="${Math.max(0, Math.trunc(Number(board.agentReplies) || 0))}" hidden></span></div><p class="board-meta">${board.project ? '<span class="kind">Project</span>' : ""}<span class="folder" title="${escapeHtml(board.folderTitle)}">${escapeHtml(board.folder)}</span>${time}</p></article>`;
}

/**
 * Liesel's front door: every open board as a card, newest first, and a New board dialog.
 * @param {HomeBoard[]} boards in the order to show them
 * @param {{ now?: number }} [options]
 */
export function createHomeHtml(boards, { now = Date.now() } = {}) {
  const content =
    boards.length > 0
      ? `<section class="boards" aria-label="Boards">${boards.map((board) => boardCard(board, now)).join("")}</section>`
      : '<section class="empty"><h2>No boards open yet</h2><p>Open project reviews a repository\'s real pages. New board starts one from a folder of HTML designs.</p></section>';
  const dialog = `<dialog id="newBoardDialog" aria-labelledby="newBoardTitle"><div class="sheet"><h2 id="newBoardTitle">New board</h2><form id="newBoard" autocomplete="off"><label>Name<input name="name" required maxlength="120" placeholder="Checkout redesign"></label><div class="field"><label class="field-label" for="newBoardFolder">Folder</label><div class="folder-row"><input id="newBoardFolder" name="folder" required value="~/Liesel/" spellcheck="false"><button class="button" id="browseFolder" type="button" aria-expanded="false" aria-controls="folderBrowser">Browse</button></div>${browserMarkup("folder")}<p class="hint">HTML files in the folder join the board.</p></div><p class="error" id="newBoardError" role="alert"></p><div class="sheet-actions"><button class="button button-quiet" id="newBoardCancel" type="button">Cancel</button><button class="button button-primary" id="newBoardSubmit" type="submit">Create board</button></div></form></div></dialog>`;
  const project = `<dialog id="openProjectDialog" aria-labelledby="openProjectTitle"><div class="sheet"><h2 id="openProjectTitle">Open project</h2><form id="openProject" autocomplete="off"><div class="field"><label class="field-label" for="openProjectPath">Project folder or GitHub URL</label><div class="folder-row"><input id="openProjectPath" name="path" required spellcheck="false" placeholder="~/code/shop or github.com/owner/repo"><button class="button" id="browseProject" type="button" aria-expanded="false" aria-controls="projectBrowser">Browse</button></div>${browserMarkup("project")}<p class="hint">A GitHub URL is cloned into ~/${PRODUCT_NAME}. Nothing runs until you press Start.</p></div><p class="error" id="openProjectError" role="alert"></p><div class="sheet-actions"><button class="button button-quiet" id="openProjectCancel" type="button">Cancel</button><button class="button button-primary" id="openProjectSubmit" type="submit">Open project</button></div></form></div></dialog>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${PRODUCT_NAME}</title><style>${STYLE}</style></head><body><div class="wrap"><header class="top"><h1>${PRODUCT_NAME}</h1><div class="actions" id="homeActions"><button class="button" type="button" data-open-new-board>${PLUS_ICON}New board</button><button class="button button-primary" type="button" data-open-project>Open project</button></div></header><main>${content}</main></div>${dialog}${project}<script>${SCRIPT}</script></body></html>`;
}
