import { PRODUCT_NAME } from "./brand.js";

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
 * @param {{ tuneSpecs?: Record<string, import("./board.js").TuneControl[]>, chat?: unknown[], ended?: boolean, endedBy?: string | null, assetVersion?: string }} [options]
 */
export function createBoardHtml(
  session,
  board,
  { tuneSpecs = {}, chat = [], ended = false, endedBy = null, assetVersion = "" } = {},
) {
  const items = board.items.map((item) => ({ ...item, tuneSpec: tuneSpecs[item.id] || [] }));
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
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(board.name)} · ${PRODUCT_NAME}</title>
<link rel="stylesheet" href="/board.css?v=${encodeURIComponent(assetVersion)}">
</head>
<body>
<header class="bar">
  <div class="brand">${PRODUCT_NAME}</div>
  <div class="board-name" id="boardName">${escapeHtml(board.name)}</div>
  <nav class="tabs" id="tabs" role="tablist" aria-label="Board tabs"></nav>
  <div class="bar-spacer"></div>
  <div class="devices" id="devices" role="group" aria-label="Device width"></div>
  <div class="zoom">
    <button id="zoomOut" type="button" title="Zoom out (-)" aria-label="Zoom out">&minus;</button>
    <span class="zoom-label" id="zoomLabel">100%</span>
    <button id="zoomIn" type="button" title="Zoom in (+)" aria-label="Zoom in">+</button>
    <button id="fit" type="button" title="Fit the board (0)" aria-label="Fit the board">fit</button>
    <button id="actual" type="button" title="Actual size, 1:1 (1)" aria-label="Actual size">100%</button>
  </div>
</header>
<main class="plane" id="plane">
  <div class="canvas" id="canvas"></div>
  <div class="empty" id="empty" hidden>
    Nothing on this tab yet.<br>
    <code>easel board add &lt;dir&gt; &lt;file.html&gt;</code>
  </div>
</main>
<aside class="tune" id="tune" hidden aria-label="Tune panel">
  <div class="tune-head">
    <span class="tune-title">Tune</span>
    <span class="tune-sub" id="tuneSub"></span>
    <button class="tune-close" id="tuneClose" type="button" aria-label="Close tune panel">&times;</button>
  </div>
  <div id="tuneBody"></div>
  <div class="tune-actions">
    <button class="tune-action" id="tuneSave" type="button">Save version</button>
    <button class="tune-action" id="tuneCopy" type="button">Copy</button>
    <button class="tune-action" id="tuneReset" type="button">Reset</button>
  </div>
  <div class="versions" id="tuneVersions"></div>
</aside>
<aside class="chat" id="chat" aria-label="Conversation">
  <header class="chat-head">
    <h2 class="chat-title">Conversation</h2>
    <span class="presence" id="presence" data-state="waiting" role="status" aria-live="polite"></span>
    <button class="chat-collapse" id="chatToggle" type="button" aria-expanded="true" title="Hide conversation">Hide</button>
  </header>
  <div class="chat-log" id="chatLog"></div>
  <div class="chat-drafts" id="chatDrafts"></div>
  <div class="chat-compose">
    <textarea id="composerInput" rows="2" placeholder="Write for the agent..."></textarea>
    <button class="send" id="send" type="button">Send</button>
  </div>
  <div class="chat-status" id="dockStatus"></div>
</aside>
<button class="chat-open" id="chatOpen" type="button" hidden title="Show conversation">Notes</button>
<div class="ended" id="ended" hidden>Session ended. Run <code>easel board open</code> when you want it reopened.</div>
<script id="easel-board" type="application/json">${bootstrap}</script>
<script src="/board-client.js?v=${encodeURIComponent(assetVersion)}"></script>
</body>
</html>`;
}
