import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBoardHtml } from "../src/board-page.js";

const board = { name: "Board", tabs: [{ id: "main", label: "Main" }], items: [], pairs: [] };

test("the tune controls live in the sidebar, behind a Controls tab beside Chat", () => {
  const html = createBoardHtml({ key: "k", file: "/tmp/board.json" }, /** @type {any} */ (board));
  const sidebar = html.slice(html.indexOf('<aside class="chat"'), html.indexOf("</aside>") + "</aside>".length);
  assert.match(sidebar, /role="tablist"/);
  assert.match(sidebar, /id="sideTabChat"[^>]*aria-selected="true"[^>]*>Chat</);
  assert.match(sidebar, /id="sideTabControls"[^>]*aria-selected="false"[^>]*>Controls</);
  // Chat shows first; Controls holds the tune panel and its actions.
  assert.match(sidebar, /id="chatPane" role="tabpanel"/);
  assert.match(sidebar, /id="tune" role="tabpanel"[^>]*hidden/);
  for (const id of ["tuneBody", "tuneSend", "tuneSave", "tuneCopy", "tuneReset", "tuneVersions", "composerInput"]) {
    assert.match(sidebar, new RegExp(`id="${id}"`), id);
  }
  // No floating card is left behind.
  assert.equal((html.match(/id="tune"/g) || []).length, 1);
  assert.doesNotMatch(html, /tuneClose/);
});

test("Settings in the top bar holds the agent picker and the ultrawide toggle; the sidebar is Chat and Controls", () => {
  const html = createBoardHtml({ key: "k", file: "/tmp/board.json" }, /** @type {any} */ (board));
  const bar = html.slice(html.indexOf('<header class="bar"'), html.indexOf("</header>"));
  const sidebar = html.slice(html.indexOf('<aside class="chat"'), html.indexOf("</aside>") + "</aside>".length);
  const settingsStart = html.indexOf('id="settings"');
  assert.ok(settingsStart > 0, "settings panel");
  const settings = html.slice(settingsStart, html.indexOf("<!-- /settings -->"));
  assert.match(bar, /id="settingsToggle"[^>]*aria-expanded="false"[^>]*aria-controls="settings"/);
  assert.match(html, /id="settings"[^>]*role="dialog"[^>]*hidden/);
  // The sidebar keeps only its two tabs.
  assert.equal((sidebar.match(/role="tab"/g) || []).length, 2);
  assert.doesNotMatch(html, /sideTabAgent/);
  assert.doesNotMatch(sidebar, /agentPane|agentSelect/);
  for (const id of [
    "ultrawideSetting",
    "agentForm",
    "agentSelect",
    "agentCwd",
    "agentCommand",
    "agentOutput",
    "oldNotesSetting",
  ]) {
    assert.match(settings, new RegExp(`id="${id}"`), id);
  }
  // No ultrawide or old-notes button in the bar any more: both are switches in Settings.
  assert.doesNotMatch(bar, /ultrawide/i);
  assert.doesNotMatch(bar, /oldNotes|old notes/i);
  assert.match(settings, /<input type="checkbox" role="switch" id="oldNotesSetting" checked>/);
  // Settings save as they change: no Save buttons anywhere on the page.
  assert.doesNotMatch(settings, />Save</);
  assert.doesNotMatch(settings, /type="submit"/);
});

test("Settings is a full page with a way back to the board, in the home page's calm type", async () => {
  const html = createBoardHtml({ key: "k", file: "/tmp/board.json" }, /** @type {any} */ ({ ...board, name: "Shop" }));
  const settings = html.slice(html.indexOf('id="settings"'), html.indexOf("<!-- /settings -->"));
  assert.match(html, /id="settings"[^>]*aria-modal="true"/);
  assert.match(settings, /<button class="settings-back" id="settingsClose"[^>]*>[\s\S]*Back to board\s*<\/button>/);
  // The way back carries no tooltip that would cover it.
  assert.doesNotMatch(settings.match(/<button class="settings-back"[^>]*>/)?.[0] || "", /title=/);
  assert.match(settings, /<h1 class="settings-title" id="settingsTitle">Settings<\/h1>/);
  assert.match(settings, /<p class="settings-board" id="settingsBoardName">Shop<\/p>/);
  const css = await readFile(new URL("../src/board.css", import.meta.url), "utf8");
  const rule = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf("}", at));
  };
  // It covers the whole window, board and bar included.
  assert.match(rule(".settings"), /position: fixed;\s*inset: 0;/);
  for (const match of css.matchAll(/letter-spacing:\s*([-\d.]+)em/g)) {
    assert.ok(Number(match[1]) <= 0.04, `letter-spacing ${match[1]}em`);
  }
  assert.doesNotMatch(css, /text-transform:\s*uppercase/);
});

test("from a board, the brand goes home and the plus menu starts a new board or opens a project there", () => {
  const html = createBoardHtml({ key: "k", file: "/tmp/board.json" }, /** @type {any} */ (board));
  const bar = html.slice(html.indexOf('<header class="bar"'), html.indexOf("</header>"));
  assert.match(bar, /<a class="brand" href="\/"/);
  assert.match(bar, /id="newToggle"[^>]*popovertarget="newMenu"/);
  const menu = html.slice(html.indexOf('id="newMenu"'), html.indexOf("</nav>", html.indexOf('id="newMenu"')));
  assert.match(html, /<nav class="new-menu" id="newMenu" popover/);
  // The home page's own dialogs do the work: the menu only links to them.
  assert.match(menu, /href="\/#new-board">New board/);
  assert.match(menu, /href="\/#open-project">Open project/);
  assert.doesNotMatch(menu, /fetch|<form/);
});

test("Duplicate on a design's label shows at rest; only a copy's Rename and Delete wait for hover", async () => {
  const css = await readFile(new URL("../src/board.css", import.meta.url), "utf8");
  const at = css.indexOf("\n.artboard-label .item-actions {");
  const block = css.slice(at, css.indexOf("}", at));
  assert.doesNotMatch(block, /opacity/);
  assert.match(css, /\.artboard-label \.item-action\[data-reveal\] \{\s*opacity: 0;/);
  const client = await readFile(new URL("../src/board-client.js", import.meta.url), "utf8");
  assert.match(client, /button\("Duplicate", "Duplicate this design \(⌘D\)", \(\) => duplicateDesign\(item\.id\)\)/);
  assert.match(client, /button\("Rename", "Rename this copy", \(\) => startRename\(item\.id\), true\)/);
  assert.match(client, /button\("Delete", "Delete this copy", \(\) => deleteCopy\(item\.id\), true\)/);
});

test("a project board's top bar has only Pages; the server's controls are folded under Advanced", () => {
  const html = createBoardHtml({ key: "k", file: "/repo/.liesel/board.json" }, /** @type {any} */ (board), {
    project: { root: "/repo" },
  });
  const bar = html.slice(html.indexOf('<header class="bar"'), html.indexOf("</header>"));
  const settings = html.slice(html.indexOf('id="settings"'), html.indexOf("<!-- /settings -->"));
  // The server runs by itself, so the bar carries no state pill and no Start.
  assert.doesNotMatch(bar, /devState|devToggle|dev-state|>Start</);
  // Pages opens the page picker; the bare path field is gone.
  assert.match(bar, /id="pagesToggle"[^>]*aria-haspopup="dialog"[^>]*aria-controls="pagesPicker"[^>]*>Pages</);
  assert.doesNotMatch(html, /addPageForm|addPageInput|addPageToggle/);
  // The board's name is a button that turns into a field.
  assert.match(bar, /<button class="board-name" id="boardName" type="button" title="Rename this board">/);
  const advanced = settings.slice(settings.indexOf('id="devAdvanced"'));
  assert.match(settings, /<details class="settings-advanced" id="devAdvanced">\s*<summary[^>]*>Advanced<\/summary>/);
  assert.doesNotMatch(settings, /id="devAdvanced" open/, "Advanced starts folded");
  for (const id of ["devStart", "devStop", "devRestart", "devCommand", "devPort", "devOutput"]) {
    assert.match(advanced, new RegExp(`id="${id}"`), id);
  }
  // The project path is cut in the middle, keeping its last folder.
  assert.match(settings, /class="settings-path-head"><\/span><span class="settings-path-tail">/);
});

test("the page picker is a full page with All pages, a filter, a way to add a page by path, and Show in reach", () => {
  const html = createBoardHtml({ key: "k", file: "/repo/.liesel/board.json" }, /** @type {any} */ (board), {
    project: { root: "/repo" },
  });
  const picker = html.slice(html.indexOf('id="pagesPicker"'));
  assert.match(html, /<div class="settings pages-picker" id="pagesPicker" role="dialog" aria-modal="true"[^>]*hidden>/);
  assert.match(picker, /id="pagesClose"[^>]*>[\s\S]*Back to board/);
  assert.match(picker, /<div class="settings-top-inner">[\s\S]*id="pagesApply"/, "Show sits in the sticky top");
  assert.match(picker, /<input type="checkbox" id="pagesAll">[\s\S]*All pages/);
  assert.match(picker, /id="pagesFilter"[^>]*hidden/);
  assert.match(picker, /<form class="pages-add" id="pagesAddForm"[\s\S]*id="pagesAddInput"/);
});
