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
  <span class="mode-state" id="modeState" role="status" aria-live="polite" hidden></span>
  <button class="bar-toggle" id="duplicateToggle" type="button" hidden>Duplicate</button>
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
  <button class="icon-button settings-toggle" id="settingsToggle" type="button" aria-expanded="false" aria-controls="settings" aria-label="Settings" title="Settings">
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
    <span class="run-dot" id="settingsDot" hidden></span>
  </button>
</header>
<main class="plane" id="plane">
  <div class="canvas" id="canvas"></div>
  <div class="empty" id="empty" hidden>Nothing on this board yet. Drop HTML files here, or ask your agent to add designs.</div>
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
    <button class="runner-line" id="runnerLine" type="button" hidden></button>
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
    <p class="tune-empty tune-idle" id="tuneIdle">Tap ⌥ Option, then click an element to tune it, or press Tune on a design.</p>
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
<div class="settings" id="settings" role="dialog" aria-labelledby="settingsTitle" hidden>
  <div class="settings-head">
    <h2 class="settings-title" id="settingsTitle">Settings</h2>
    <button class="icon-button" id="settingsClose" type="button" aria-label="Close settings" title="Close (Esc)">&times;</button>
  </div>
  <div class="settings-body">
    <section class="settings-section" aria-labelledby="viewHeading">
      <h3 class="settings-heading" id="viewHeading">View</h3>
      <label class="settings-check">
        <input type="checkbox" id="ultrawideSetting">
        <span class="settings-check-text">Show ultrawide<span class="agent-hint">Adds the 3440 ultrawide to the All view.</span></span>
      </label>
    </section>
    <section class="settings-section agent-pane" id="agentPane" aria-labelledby="agentHeading">
      <h3 class="settings-heading" id="agentHeading">Agent</h3>
      <p class="agent-lede">Pick the agent that answers notes on this board. When you send notes, ${PRODUCT_NAME} starts it in the folder below, hands it the notes, and posts its answer in Chat.</p>
      <form class="agent-form" id="agentForm">
        <label class="agent-field">
          <span class="agent-label">Answered by</span>
          <select class="agent-input" id="agentSelect"></select>
        </label>
        <label class="agent-field" id="agentCommandField" hidden>
          <span class="agent-label">Command</span>
          <input class="agent-input" id="agentCommand" type="text" spellcheck="false" autocomplete="off" placeholder="my-agent --headless">
          <span class="agent-hint">Runs in the folder below. The notes arrive on stdin and in <code>$LIESEL_PROMPT_FILE</code>; what it prints becomes the reply.</span>
        </label>
        <label class="agent-field" id="agentCwdField">
          <span class="agent-label">Working folder</span>
          <input class="agent-input" id="agentCwd" type="text" spellcheck="false" autocomplete="off">
          <span class="agent-hint">The agent can edit files here. The board's own folder is the default.</span>
        </label>
        <div class="agent-actions">
          <button class="button button-primary" id="agentSave" type="submit">Save</button>
          <span class="chat-status" id="agentSaveStatus" role="status"></span>
        </div>
      </form>
      <div class="agent-run" id="agentRun" hidden>
        <div class="agent-run-head">
          <span class="run-state" id="agentRunState" data-state="running"></span>
          <button class="tune-link" id="agentStop" type="button" hidden>Stop</button>
          <button class="tune-link" id="agentRetry" type="button" hidden>Run again</button>
        </div>
        <p class="agent-run-error" id="agentRunError" hidden></p>
        <pre class="agent-output" id="agentOutput" tabindex="0" aria-label="Agent output"></pre>
      </div>
    </section>
  </div>
</div>
<!-- /settings -->
<button class="chat-open" id="chatOpen" type="button" hidden>Notes</button>
<div class="ended" id="ended" hidden>Session ended. Run <code>liesel board open</code> when you want it reopened.</div>
<script id="liesel-board" type="application/json">${bootstrap}</script>
<script src="/dialkit/browser.global.js"></script>
<script src="/board-client.js?v=${encodeURIComponent(assetVersion)}"></script>
</body>
</html>`;
}
