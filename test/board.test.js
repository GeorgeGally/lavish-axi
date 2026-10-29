import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addItem,
  BoardError,
  boardFilePath,
  ensureTab,
  extractTuneSpec,
  injectBoardSdk,
  normalizeBoard,
  pairItems,
  placeItem,
  readBoard,
  readOrCreateBoard,
  resolveBoardTarget,
  tuneCssValues,
  tuneInstruction,
  writeBoard,
} from "../src/board.js";
import { createBoardAddOutput, createBoardOpenOutput, createBoardStatusOutput } from "../src/cli.js";

async function boardDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "easel-board-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("normalizeBoard fills a usable board from nothing", () => {
  const board = normalizeBoard({}, "hero directions");
  assert.equal(board.format, 1);
  assert.equal(board.name, "hero directions");
  assert.deepEqual(board.tabs, [{ id: "main", label: "Main" }]);
  assert.deepEqual(board.items, []);
  assert.deepEqual(board.pairs, []);
});

test("normalizeBoard drops an item whose file escapes the board directory", () => {
  const board = normalizeBoard(
    {
      items: [
        { id: "ok", file: "a.html" },
        { id: "up", file: "../secret.html" },
        { id: "abs", file: "/etc/passwd" },
      ],
    },
    "b",
  );
  assert.deepEqual(
    board.items.map((item) => item.id),
    ["ok"],
  );
});

test("normalizeBoard keeps the device a note was made on", () => {
  const board = normalizeBoard(
    {
      items: [
        {
          id: "v1",
          file: "v1.html",
          notes: [
            { id: "n1", number: 1, selector: "h1", tag: "h1", text: "t", x: 1, y: 2, device: "phone" },
            { id: "n2", number: 2, selector: "p", tag: "p", text: "u", x: 3, y: 4 },
          ],
        },
      ],
    },
    "b",
  );
  assert.equal(board.items[0].notes[0].device, "phone");
  assert.equal(board.items[0].notes[1].device, undefined);
});

test("normalizeBoard keeps items on a known tab and clamps geometry", () => {
  const board = normalizeBoard(
    {
      tabs: [{ id: "hero", label: "Hero" }],
      items: [{ id: "v1", file: "v1.html", tab: "missing", x: -1e9, w: 1 }],
    },
    "b",
  );
  assert.equal(board.items[0].tab, "hero");
  assert.equal(board.items[0].x, -100_000);
  assert.equal(board.items[0].w, 160);
});

test("addItem places new variants in a free slot below the tab", () => {
  const board = normalizeBoard({}, "b");
  const first = addItem(board, { file: "a.html", label: "A" });
  assert.equal(first.w, 1440);
  const second = addItem(board, { file: "a.html", label: "B" });
  assert.equal(first.id, "a");
  assert.equal(second.id, "a-2");
  assert.equal(second.y, first.y + first.h + 48);
});

test("placeItem refuses unknown items and tabs", () => {
  const board = normalizeBoard({}, "b");
  addItem(board, { file: "a.html" });
  assert.throws(() => placeItem(board, "nope", { x: 1 }), BoardError);
  assert.throws(() => placeItem(board, "a", { tab: "nope" }), BoardError);
  placeItem(board, "a", { x: 12, status: "reviewed" });
  assert.equal(board.items[0].x, 12);
  assert.equal(board.items[0].status, "reviewed");
});

test("ensureTab creates a tab once and reuses it", () => {
  const board = normalizeBoard({}, "b");
  const id = ensureTab(board, "Hero B");
  assert.equal(id, "hero-b");
  assert.deepEqual(board.tabs[1], { id: "hero-b", label: "Hero B" });
  assert.equal(ensureTab(board, "hero b"), id);
});

test("pairItems locks and unlocks two known items", () => {
  const board = normalizeBoard({}, "b");
  addItem(board, { file: "a.html" });
  addItem(board, { file: "b.html" });
  assert.deepEqual(pairItems(board, "a", "b"), { a: "a", b: "b", locked: true });
  assert.throws(() => pairItems(board, "a", "missing"), BoardError);
  assert.equal(pairItems(board, "a", "b", false), null);
  assert.deepEqual(board.pairs, []);
});

test("extractTuneSpec reads declared controls and refuses a non-custom property", () => {
  const html = `<html><body><script type="application/easel-tune">
  [{"id":"radius","label":"Radius","type":"number","css":"--radius","min":0,"max":40,"step":1,"value":12,"unit":"px"},
   {"id":"accent","label":"Accent","type":"color","css":"--accent","value":"#111111"},
   {"id":"bad","css":"color"}]
  </script></body></html>`;
  const spec = extractTuneSpec(html);
  assert.deepEqual(
    spec.map((control) => control.id),
    ["radius", "accent"],
  );
  assert.equal(spec[0].unit, "px");
  assert.equal(spec[0].max, 40);
  assert.equal(extractTuneSpec("<html>no declarations</html>").length, 0);
  assert.equal(extractTuneSpec('<script type="application/easel-tune">nope</script>').length, 0);
});

test("tuneCssValues appends the declared unit and tuneInstruction names the file", () => {
  const board = normalizeBoard({ items: [{ id: "v1", file: "v1.html", tune: { radius: "18" } }] }, "b");
  const spec = extractTuneSpec(
    '<script type="application/easel-tune">[{"id":"radius","label":"Radius","type":"number","css":"--radius","value":12,"unit":"px"}]</script>',
  );
  assert.deepEqual(tuneCssValues(board, "v1", spec, {}), { "--radius": "18px" });
  const instruction = tuneInstruction(board.items[0], spec);
  assert.match(instruction, /v1\.html/);
  assert.match(instruction, /--radius/);
  assert.match(instruction, /18px/);
});

test("writeBoard round-trips through board.json and bounds what it stores", async (t) => {
  const dir = await boardDir(t);
  const board = normalizeBoard({ name: "hero", items: [{ id: "v1", file: "v1.html" }] }, "hero");
  const written = await writeBoard(dir, board);
  const stored = JSON.parse(await readFile(boardFilePath(dir), "utf8"));
  assert.equal(stored.format, 1);
  assert.equal(stored.items[0].file, "v1.html");
  assert.equal(written.name, "hero");
  assert.equal((await readBoard(dir)).items.length, 1);
});

test("readOrCreateBoard creates one board.json and never rewrites an existing board", async (t) => {
  const dir = await boardDir(t);
  const created = await readOrCreateBoard(dir, { name: "hero directions" });
  assert.equal(created.name, "hero directions");
  await writeBoard(dir, normalizeBoard({ name: "kept", items: [{ id: "v1", file: "v1.html" }] }, "kept"));
  const again = await readOrCreateBoard(dir, { name: "ignored" });
  assert.equal(again.name, "kept");
});

test("resolveBoardTarget turns a board directory into its board.json and leaves a file alone", async (t) => {
  const dir = await boardDir(t);
  await readOrCreateBoard(dir, { name: "b" });
  assert.equal(await resolveBoardTarget(dir), boardFilePath(dir));
  const html = path.join(dir, "page.html");
  await writeFile(html, "<p>hi</p>");
  assert.equal(await resolveBoardTarget(html), html);
});

test("injectBoardSdk appends exactly one script tag", () => {
  const html = "<!doctype html><html><body><h1>hi</h1></body></html>";
  const out = injectBoardSdk(html, "/board-sdk.js?key=k&item=v1");
  assert.equal((out.match(/board-sdk\.js/g) || []).length, 1);
  assert.match(out, /<script src="\/board-sdk\.js\?key=k&item=v1"><\/script><\/body>/);
  assert.match(injectBoardSdk("<h1>no body</h1>", "/x.js"), /<h1>no body<\/h1>\n<script src="\/x\.js"><\/script>$/);
});

test("board CLI outputs stay small and name the poll command", async (t) => {
  const dir = await boardDir(t);
  const board = normalizeBoard({ name: "hero", items: [{ id: "v1", file: "v1.html" }] }, "hero");
  addItem(board, { file: "v2.html", label: "Hero · B" });
  const open = createBoardOpenOutput({ dir, url: "http://127.0.0.1:1/board/k", board });
  assert.equal(open.board.items.length, 2);
  assert.match(open.next_step, /easel poll/);
  assert.match(open.next_step, /board add/);
  assert.equal(open.board.items[0].tune, undefined);

  const added = createBoardAddOutput({ dir, item: board.items[1], board });
  assert.equal(added.item.id, "v2");
  assert.match(added.next_step, /within a few seconds/);

  const status = createBoardStatusOutput({ dir, board });
  assert.equal(status.board.pairs.length, 0);
  assert.match(status.help.join(" "), /board open/);
});
