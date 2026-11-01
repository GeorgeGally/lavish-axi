import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addItem,
  BoardError,
  boardFilePath,
  duplicateFileName,
  duplicateItem,
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

test("normalizeBoard keeps where inside its element a note was dropped", () => {
  const board = normalizeBoard(
    {
      items: [
        {
          file: "a.html",
          notes: [
            { id: "n1", number: 1, selector: "h1", ox: 12.4, oy: 7, x: 40, y: 50 },
            { id: "n2", number: 2 },
          ],
        },
      ],
    },
    "b",
  );
  assert.equal(board.items[0].notes[0].ox, 12);
  assert.equal(board.items[0].notes[0].oy, 7);
  assert.equal("ox" in board.items[0].notes[1], false);
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

test("advanced tune declarations survive extraction and handoff", () => {
  const spec = extractTuneSpec(`<script type="application/easel-tune">[
    {"id":"spring","type":"spring","css":"--spring","value":{"stiffness":180,"damping":20,"mass":1}},
    {"id":"curve","type":"easing","css":"--curve","value":"cubic-bezier(0.25, 0.1, 0.25, 1)"},
    {"id":"position","type":"pad","css":"--position","value":{"x":0.5,"y":0.25}},
    {"id":"time","type":"timeline","css":"--time","min":0,"max":2,"step":0.01,"value":0.5,"unit":"s"}
  ]</script>`);
  assert.deepEqual(
    spec.map((control) => control.type),
    ["spring", "easing", "pad", "timeline"],
  );
  const board = normalizeBoard({ items: [{ id: "v1", file: "v1.html" }] }, "b");
  const values = Object.fromEntries(spec.map((control) => [control.id, control.value]));
  assert.deepEqual(tuneCssValues(board, "v1", spec, values), {
    "--spring": '{"stiffness":180,"damping":20,"mass":1}',
    "--curve": "cubic-bezier(0.25, 0.1, 0.25, 1)",
    "--position": '{"x":0.5,"y":0.25}',
    "--time": "0.5s",
  });
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

test("normalizeBoard keeps what a pin points at", () => {
  const crop = `${"a".repeat(64)}.png`;
  const board = normalizeBoard(
    {
      items: [
        {
          file: "a.html",
          notes: [
            {
              id: "n1",
              number: 1,
              excerpt: "Find an adviser",
              heading: "When opportunity crosses borders",
              box: { x: 40.4, y: 300, w: 160, h: 44 },
              crop: { id: crop },
            },
            { id: "n2", number: 2, box: { x: "a" }, crop: { id: "../etc/passwd" } },
          ],
        },
      ],
    },
    "b",
  );
  const [pinned, bare] = board.items[0].notes;
  assert.equal(pinned.excerpt, "Find an adviser");
  assert.equal(pinned.heading, "When opportunity crosses borders");
  assert.deepEqual(pinned.box, { x: 40, y: 300, w: 160, h: 44 });
  assert.deepEqual(pinned.crop, { id: crop });
  assert.equal("box" in bare, false);
  assert.equal("crop" in bare, false);
});

test("board keeps an image drop, an element tune and a line of builds", () => {
  const file = `assets/drops/${"a".repeat(64)}.png`;
  const board = normalizeBoard(
    {
      items: [
        {
          file: "hero.html",
          imageDrops: [
            { selector: "#hero", kind: "img", oldSource: "old.jpg", file },
            { selector: "#hero", kind: "img", oldSource: "old.jpg", file: "../../etc/passwd" },
            { selector: "#card", kind: "background", oldSource: "", file },
          ],
          elementTune: { "body > main > h1": { "font-size": "62px", "bad key": "1" } },
          builds: [
            { at: "2026-10-30T10:00:00.000Z", hash: "abcdef1234", label: "" },
            { at: "2026-10-30T11:00:00.000Z", hash: "0123456789", label: "Round 2" },
            { at: "2026-10-30T11:00:00.000Z", hash: "0123456789", label: "Round 2" },
          ],
        },
      ],
    },
    "b",
  );
  const item = board.items[0];
  // A file outside assets/drops never becomes a drop.
  assert.deepEqual(
    item.imageDrops.map((drop) => [drop.selector, drop.kind, drop.file]),
    [
      ["#hero", "img", file],
      ["#card", "background", file],
    ],
  );
  assert.deepEqual(item.elementTune, { "body > main > h1": { "font-size": "62px" } });
  assert.deepEqual(
    item.builds.map((build) => build.label),
    ["", "Round 2"],
  );
});

test("a duplicate's file is name-copy, then name-copy-2, never one that exists", () => {
  const board = normalizeBoard({ items: [{ id: "hero", file: "hero.html" }] }, "b");
  assert.equal(
    duplicateFileName(board, "hero.html", () => false),
    "hero-copy.html",
  );
  assert.equal(
    duplicateFileName(board, "hero.html", (name) => name === "hero-copy.html"),
    "hero-copy-2.html",
  );
  // A copy of a copy counts on from the same name instead of growing "-copy-copy".
  const withCopy = normalizeBoard(
    {
      items: [
        { id: "hero", file: "hero.html" },
        { id: "hero-copy", file: "hero-copy.html", copyOf: "hero" },
      ],
    },
    "b",
  );
  assert.equal(
    duplicateFileName(withCopy, "hero-copy.html", () => false),
    "hero-copy-2.html",
  );
});

test("a duplicate carries tune values, element tunes and image drops, not notes or history, and is locked beside its design", () => {
  const board = normalizeBoard(
    {
      tabs: [
        { id: "main", label: "Main" },
        { id: "cards", label: "Cards" },
      ],
      items: [
        {
          id: "hero",
          label: "Hero",
          file: "hero.html",
          tab: "cards",
          x: 10,
          y: 20,
          w: 800,
          h: 600,
          status: "accepted",
          notes: [{ id: "n1", number: 1, text: "bigger" }],
          tune: { radius: "12" },
          elementTune: { h1: { color: "red" } },
          imageDrops: [
            { selector: "img.hero", kind: "img", oldSource: "a.png", file: `assets/drops/${"a".repeat(64)}.png` },
          ],
          builds: [{ at: "2026-01-01", hash: "abcdef12", label: "" }],
          versions: [{ id: "v1", label: "V1", values: { radius: "4" } }],
        },
      ],
    },
    "b",
  );
  const copy = duplicateItem(board, "hero", "hero-copy.html");
  assert.equal(copy.id, "hero-copy");
  assert.equal(copy.label, "Hero copy");
  assert.equal(copy.file, "hero-copy.html");
  assert.equal(copy.tab, "cards");
  assert.equal(copy.copyOf, "hero");
  assert.equal(copy.status, "open");
  assert.deepEqual(copy.tune, { radius: "12" });
  assert.deepEqual(copy.elementTune, { h1: { color: "red" } });
  assert.equal(copy.imageDrops.length, 1);
  assert.deepEqual(copy.notes, []);
  assert.deepEqual(copy.builds, []);
  assert.deepEqual(copy.versions, []);
  assert.deepEqual(board.pairs, [{ a: "hero", b: "hero-copy", locked: true }]);
  // The copy is its own record: changing it leaves the original alone.
  copy.tune.radius = "30";
  copy.elementTune.h1.color = "blue";
  const original = board.items.find((item) => item.id === "hero");
  assert.equal(original?.tune.radius, "12");
  assert.equal(original?.elementTune.h1.color, "red");
  assert.equal(original?.notes.length, 1);
  // It survives a save and load with the design it came from.
  const saved = normalizeBoard(JSON.parse(JSON.stringify(board)), "b");
  assert.equal(saved.items.find((item) => item.id === "hero-copy")?.copyOf, "hero");
  assert.equal(duplicateItem(saved, "hero-copy", "hero-copy-2.html").label, "Hero copy 2");
  assert.throws(() => duplicateItem(board, "nope", "x.html"), BoardError);
});
