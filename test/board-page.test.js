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
  assert.match(settings, /<p class="settings-board">Shop<\/p>/);
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

test("a project board's top bar has only a small Add page; the dev server lives in Settings", () => {
  const html = createBoardHtml({ key: "k", file: "/repo/.liesel/board.json" }, /** @type {any} */ (board), {
    project: { root: "/repo" },
  });
  const bar = html.slice(html.indexOf('<header class="bar"'), html.indexOf("</header>"));
  const settings = html.slice(html.indexOf('id="settings"'), html.indexOf("<!-- /settings -->"));
  // The dev server starts by itself, so the bar carries no state pill and no Start.
  assert.doesNotMatch(bar, /devState|devToggle|dev-state|>Start</);
  // Add page is one control; its path field opens in its place.
  assert.match(bar, /id="addPageToggle"[^>]*aria-expanded="false"[^>]*aria-controls="addPageForm"/);
  assert.match(bar, /<form class="add-page" id="addPageForm" autocomplete="off" hidden>/);
  assert.doesNotMatch(bar.slice(bar.indexOf('id="addPageForm"')), /type="submit"/);
  for (const id of ["devStart", "devStop", "devRestart", "devCommand", "devPort", "devOutput", "projectRoot"]) {
    assert.match(settings, new RegExp(`id="${id}"`), id);
  }
  // The project path is cut in the middle, keeping its last folder.
  assert.match(settings, /class="settings-path-head"><\/span><span class="settings-path-tail">/);
});
