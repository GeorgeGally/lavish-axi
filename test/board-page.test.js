import assert from "node:assert/strict";
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
    "agentSave",
    "agentOutput",
  ]) {
    assert.match(settings, new RegExp(`id="${id}"`), id);
  }
  // No ultrawide button in the bar any more.
  assert.doesNotMatch(bar, /ultrawide/i);
});
