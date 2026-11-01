import { PRODUCT_NAME } from "./brand.js";
import { pairInfo } from "./board.js";

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {unknown} value */
function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * @param {{ key: string, file: string }} session
 * @param {import("./board.js").Board} board
 * @param {{ tuneSpecs?: Record<string, import("./board.js").TuneControl[]>, captions?: Record<string, { title: string, explain: string, changed?: string, parent?: string, mtime?: number, hash?: string, created?: number }>, chat?: unknown[], ended?: boolean, endedBy?: string | null, assetVersion?: string, agentName?: string }} [options]
 */
export function createBoardHtml(
  session,
  board,
  {
    tuneSpecs = {},
    captions = {},
    chat = [],
    ended = false,
    endedBy = null,
    assetVersion = "",
    agentName = "Agent",
  } = {},
) {
  const items = board.items.map((item) => ({
    ...item,
    tuneSpec: tuneSpecs[item.id] || [],
    caption: captions[item.id]?.explain || "",
    title: captions[item.id]?.title || "",
    changed: captions[item.id]?.changed || "",
    parent: captions[item.id]?.parent || "",
    mtime: captions[item.id]?.mtime || 0,
    hash: captions[item.id]?.hash || "",
    created: captions[item.id]?.created || 0,
    pair: pairInfo(item.file),
  }));
  const bootstrap = jsonScript({
    key: session.key,
    file: session.file,
    name: board.name,
    tabs: board.tabs,
    items,
    pairs: board.pairs,
    chat,
    ended,
    endedBy,
    agentName,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(board.name)} · ${PRODUCT_NAME}</title>
<link rel="stylesheet" href="/board.css?v=${encodeURIComponent(assetVersion)}">
<link rel="stylesheet" href="/dialkit/styles.css">
</head>
<body>
<header class="bar">
  <div class="brand">${PRODUCT_NAME}</div>
  <div class="board-name" id="boardName">${escapeHtml(board.name)}</div>
  <nav class="tabs" id="tabs" role="tablist" aria-label="Board tabs"></nav>
  <div class="bar-spacer"></div>
  <button class="bar-toggle" id="historyToggle" type="button" hidden>History</button>
  <button class="bar-toggle" id="oldNotesToggle" type="button">Old notes shown</button>
  <div class="segmented" id="devices" role="group" aria-label="Device"></div>
  <div class="zoom" role="group" aria-label="Zoom">
    <button id="zoomOut" type="button" title="Zoom out" aria-label="Zoom out">&minus;</button>
    <span class="zoom-label" id="zoomLabel">100%</span>
    <button id="zoomIn" type="button" title="Zoom in" aria-label="Zoom in">+</button>
    <button class="zoom-text" id="fit" type="button" title="Fit everything (0)">Fit</button>
    <button class="zoom-text" id="actual" type="button" title="Actual size (1)">100%</button>
  </div>
</header>
<main class="plane" id="plane">
  <div class="canvas" id="canvas"></div>
  <div class="empty" id="empty" hidden>Nothing on this board yet.</div>
</main>
<aside class="chat" id="chat" data-view="chat" aria-label="Sidebar">
  <header class="chat-head">
    <div class="side-tabs" role="tablist" aria-label="Sidebar">
      <button class="side-tab" id="sideTabChat" type="button" role="tab" aria-selected="true" aria-controls="chatPane" title="Chat (Tab)">Chat</button>
      <button class="side-tab" id="sideTabControls" type="button" role="tab" aria-selected="false" aria-controls="tune" tabindex="-1" title="Controls (Tab)">Controls</button>
    </div>
    <span class="presence" id="presence" data-state="waiting" role="status" aria-live="polite"></span>
    <button class="icon-button chat-collapse" id="chatToggle" type="button" aria-expanded="true" aria-label="Hide sidebar" title="Hide sidebar">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </header>
  <section class="side-pane chat-pane" id="chatPane" role="tabpanel" aria-labelledby="sideTabChat">
    <div class="chat-log" id="chatLog"></div>
    <div class="chat-foot">
      <div class="chat-drafts" id="chatDrafts"></div>
      <div class="composer-images" id="composerImages" hidden></div>
      <textarea id="composerInput" rows="2" placeholder="Write a note, or paste an image"></textarea>
      <div class="chat-actions">
        <span class="chat-status" id="dockStatus" role="status"></span>
        <button class="button button-primary" id="send" type="button">Send</button>
      </div>
    </div>
  </section>
  <section class="side-pane tune" id="tune" role="tabpanel" aria-labelledby="sideTabControls" hidden>
    <p class="tune-empty tune-idle" id="tuneIdle">Option-click an element to tune it, or press Tune on a design.</p>
    <div class="tune-loaded" id="tuneLoaded" hidden>
      <div class="tune-head">
        <span class="tune-title" id="tuneTitle">Tune</span>
        <span class="tune-sub" id="tuneSub"></span>
      </div>
      <div class="tune-body" id="tuneBody"></div>
      <div class="tune-actions">
        <button class="button button-primary" id="tuneSend" type="button">Send</button>
        <button class="tune-link" id="tuneSave" type="button">Save version</button>
        <button class="tune-link" id="tuneCopy" type="button">Copy</button>
        <button class="tune-link" id="tuneReset" type="button">Reset</button>
      </div>
      <div class="versions" id="tuneVersions"></div>
    </div>
  </section>
</aside>
<button class="chat-open" id="chatOpen" type="button" hidden>Notes</button>
<div class="ended" id="ended" hidden>Session ended. Run <code>easel board open</code> when you want it reopened.</div>
<script id="easel-board" type="application/json">${bootstrap}</script>
<script src="/dialkit/browser.global.js"></script>
<script src="/board-client.js?v=${encodeURIComponent(assetVersion)}"></script>
</body>
</html>`;
}
