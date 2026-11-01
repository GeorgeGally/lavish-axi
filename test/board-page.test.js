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
