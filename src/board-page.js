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
 * @param {{ tuneSpecs?: Record<string, import("./board.js").TuneControl[]>, captions?: Record<string, { title: string, explain: string, changed?: string, parent?: string, mtime?: number, hash?: string, created?: number }>, chat?: unknown[], ended?: boolean, endedBy?: string | null, assetVersion?: string, agentName?: string, project?: unknown }} [options]
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
    project = null,
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
    project,
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
  <a class="brand" href="/" title="All boards">${PRODUCT_NAME}</a>
  <button class="icon-button new-toggle" id="newToggle" type="button" popovertarget="newMenu" aria-label="New board or project" title="New board or project">
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  </button>
  <div class="board-name" id="boardName">${escapeHtml(board.name)}</div>
  <div class="project-bar" id="projectBar" hidden>
    <button class="bar-toggle add-page-toggle" id="addPageToggle" type="button" aria-expanded="false" aria-controls="addPageForm">
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      Add page
    </button>
    <form class="add-page" id="addPageForm" autocomplete="off" hidden>
      <input class="add-page-input" id="addPageInput" type="text" placeholder="/path, then Enter" spellcheck="false" aria-label="Page path on the dev server">
    </form>
  </div>
  <nav class="tabs" id="tabs" role="tablist" aria-label="Board tabs"></nav>
  <div class="bar-spacer"></div>
  <span class="mode-state" id="modeState" role="status" aria-live="polite" hidden></span>
  <button class="bar-toggle" id="duplicateToggle" type="button" hidden>Duplicate</button>
  <button class="bar-toggle" id="historyToggle" type="button" hidden>History</button>
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
<nav class="new-menu" id="newMenu" popover aria-label="New">
  <a class="new-menu-item" href="/#new-board">New board<span>From a folder of HTML designs</span></a>
  <a class="new-menu-item" href="/#open-project">Open project<span>A repository folder or GitHub URL</span></a>
</nav>
<div class="settings" id="settings" role="dialog" aria-modal="true" aria-labelledby="settingsTitle" hidden>
  <div class="settings-top">
    <div class="settings-top-inner">
    <button class="settings-back" id="settingsClose" type="button" aria-keyshortcuts="Escape">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Back to board
    </button>
    <span class="settings-saved" id="settingsSaved" role="status" aria-live="polite"></span>
    </div>
  </div>
  <div class="settings-body">
    <header class="settings-intro">
      <h1 class="settings-title" id="settingsTitle">Settings</h1>
      <p class="settings-board">${escapeHtml(board.name)}</p>
    </header>
    <section class="settings-section" aria-labelledby="viewHeading">
      <div class="settings-section-head">
        <h2 class="settings-heading" id="viewHeading">View</h2>
      </div>
      <div class="settings-card">
        <label class="settings-row settings-switch">
          <span class="settings-row-text">
            <span class="settings-row-title">Show ultrawide</span>
            <span class="settings-hint">Adds the 3440 ultrawide to the All view.</span>
          </span>
          <input type="checkbox" role="switch" id="ultrawideSetting">
        </label>
        <label class="settings-row settings-switch">
          <span class="settings-row-text">
            <span class="settings-row-title">Show old notes</span>
            <span class="settings-hint">Answered notes wait in the gutter beside the design. Open notes always show.</span>
          </span>
          <input type="checkbox" role="switch" id="oldNotesSetting" checked>
        </label>
      </div>
    </section>
    <section class="settings-section" id="projectPane" aria-labelledby="projectHeading" hidden>
      <div class="settings-section-head">
        <h2 class="settings-heading" id="projectHeading">Project</h2>
        <p class="settings-path" id="projectRoot"><span class="settings-path-head"></span><span class="settings-path-tail"></span></p>
      </div>
      <div class="settings-card">
        <div class="settings-row dev-row">
          <span class="settings-row-text">
            <span class="dev-status" id="devStatus" data-state="stopped">Dev server off</span>
            <span class="settings-hint" id="devStatusHint"></span>
          </span>
          <span class="settings-row-actions">
            <button class="button" id="devRestart" type="button" hidden>Restart</button>
            <button class="button button-stop" id="devStop" type="button" hidden>Stop</button>
            <button class="button button-primary" id="devStart" type="button" hidden>Start</button>
          </span>
        </div>
        <form class="settings-form" id="projectForm" autocomplete="off">
          <label class="settings-row settings-field">
            <span class="settings-row-title">Command</span>
            <input class="settings-input" id="devCommand" type="text" spellcheck="false" autocomplete="off">
            <span class="settings-hint" id="devDetected"></span>
          </label>
          <label class="settings-row settings-field">
            <span class="settings-row-title">Port</span>
            <input class="settings-input settings-input-short" id="devPort" type="text" inputmode="numeric" spellcheck="false" autocomplete="off">
            <span class="settings-hint">Leave empty to use the port the server prints. For a server you run yourself, give only its port.</span>
          </label>
          <p class="settings-error" id="projectStatus" role="status"></p>
        </form>
        <details class="settings-row settings-output" id="devOutputBox" hidden>
          <summary>Output</summary>
          <pre class="agent-output" id="devOutput" tabindex="0" aria-label="Dev server output"></pre>
        </details>
      </div>
    </section>
    <section class="settings-section agent-pane" id="agentPane" aria-labelledby="agentHeading">
      <div class="settings-section-head">
        <h2 class="settings-heading" id="agentHeading">Agent</h2>
        <p class="settings-lede">The agent that answers notes on this board. When you send notes, ${PRODUCT_NAME} starts it in the working folder, hands it the notes and posts its answer in Chat.</p>
      </div>
      <div class="settings-card">
        <form class="settings-form" id="agentForm" autocomplete="off">
          <label class="settings-row settings-field">
            <span class="settings-row-title">Answered by</span>
            <select class="settings-input" id="agentSelect"></select>
          </label>
          <label class="settings-row settings-field" id="agentCommandField" hidden>
            <span class="settings-row-title">Command</span>
            <input class="settings-input" id="agentCommand" type="text" spellcheck="false" autocomplete="off" placeholder="my-agent --headless">
            <span class="settings-hint">Runs in the working folder. The notes arrive on stdin and in <code>$LIESEL_PROMPT_FILE</code>; what it prints becomes the reply.</span>
          </label>
          <label class="settings-row settings-field" id="agentCwdField">
            <span class="settings-row-title">Working folder</span>
            <input class="settings-input" id="agentCwd" type="text" spellcheck="false" autocomplete="off">
            <span class="settings-hint">The agent can edit files here. The board's own folder is the default.</span>
          </label>
          <p class="settings-error" id="agentSaveStatus" role="status"></p>
        </form>
        <div class="settings-row agent-run" id="agentRun" hidden>
          <div class="agent-run-head">
            <span class="run-state" id="agentRunState" data-state="running"></span>
            <button class="button" id="agentRetry" type="button" hidden>Run again</button>
            <button class="button button-stop" id="agentStop" type="button" hidden>Stop</button>
          </div>
          <p class="agent-run-error" id="agentRunError" hidden></p>
          <pre class="agent-output" id="agentOutput" tabindex="0" aria-label="Agent output"></pre>
        </div>
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
