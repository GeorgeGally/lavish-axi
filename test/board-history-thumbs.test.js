import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

/** The client is served raw, so its two thumbnail functions run here against a stub server. */
async function loadThumbFunctions(context) {
  const source = await readFile(new URL("../src/board-client.js", import.meta.url), "utf8");
  const start = source.indexOf("/** Ask the server for one build's thumbnail");
  const end = source.indexOf("function openHistory(");
  assert.ok(start > 0 && end > start);
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
}

test("history fills each card as its thumbnail is taken, newest first", async () => {
  /** @type {string[]} */
  const asked = [];
  /** @type {string[][]} */
  const rendered = [];
  const thumbsReady = new Map();
  const context = {
    key: "k",
    historyItem: "v1",
    thumbsReady,
    renderHistory: () => rendered.push([...thumbsReady.get("v1")]),
    fetch: async (_url, options) => {
      const { hash } = JSON.parse(options.body);
      asked.push(hash);
      return { ok: true, json: async () => ({ thumbs: [hash] }) };
    },
  };
  await loadThumbFunctions(context);
  await context.requestHistoryThumbs("v1", [{ hash: "old" }, { hash: "mid" }, { hash: "new" }]);
  assert.deepEqual(asked, ["new", "mid", "old"]);
  assert.deepEqual(rendered, [["new"], ["new", "mid"], ["new", "mid", "old"]]);
});

test("closing history stops asking for thumbnails", async () => {
  /** @type {string[]} */
  const asked = [];
  const context = {
    key: "k",
    historyItem: "v1",
    thumbsReady: new Map(),
    renderHistory: () => {},
    fetch: async (_url, options) => {
      asked.push(JSON.parse(options.body).hash);
      context.historyItem = "";
      return { ok: false };
    },
  };
  await loadThumbFunctions(context);
  await context.requestHistoryThumbs("v1", [{ hash: "old" }, { hash: "new" }]);
  assert.deepEqual(asked, ["new"]);
});
