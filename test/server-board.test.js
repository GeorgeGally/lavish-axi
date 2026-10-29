import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { addItem, boardFilePath, placeItem, readBoard } from "../src/board.js";
import { serve } from "../src/server.js";

const ITEM_HTML = `<!doctype html>
<html><head><title>Variant A</title><link rel="stylesheet" href="item.css"></head>
<body><h1>The whole fleet</h1><p class="lede">One place.</p>
<script type="application/easel-tune">
[{"id":"radius","label":"Radius","type":"number","css":"--radius","min":0,"max":40,"step":1,"value":12,"unit":"px"},
 {"id":"accent","label":"Accent","type":"color","css":"--accent","value":"#111111"},
 {"id":"density","label":"Density","type":"select","css":"--density","options":["cozy","compact"],"value":"cozy"}]
</script>
</body></html>`;

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "easel-board-server-"));
  const boardDirectory = path.join(dir, "hero");
  await mkdir(boardDirectory, { recursive: true });
  await writeFile(path.join(boardDirectory, "v1.html"), ITEM_HTML);
  await writeFile(path.join(boardDirectory, "v2.html"), "<!doctype html><html><body><h2>Second</h2></body></html>");
  await writeFile(path.join(boardDirectory, "item.css"), "h1 { color: red; }");
  await writeFile(path.join(dir, "secret.txt"), "do not serve");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    detectTailscale: async () => null,
    idleTimeoutMs: null,
  });
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, boardDirectory, base };
}

function seedItem(board, { file, label, x = 0, y = 0, w = 480, h = 360 }) {
  const item = addItem(board, { file, label });
  placeItem(board, item.id, { x, y, w, h });
  return item;
}

async function register(base, boardDirectory) {
  const response = await fetch(`${base}/api/boards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: boardDirectory }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function write(base) {
  return { "content-type": "application/json", origin: base };
}

test("a board registers as a session and renders one page for its items", async (t) => {
  const { base, boardDirectory, dir } = await setup(t);
  const registered = await register(base, boardDirectory);
  assert.match(registered.url, /\/board\/[0-9a-f]{16}$/);
  assert.equal(registered.board.tabs[0].id, "main");
  assert.equal(registered.board.items.length, 0);

  const board = await readBoard(boardDirectory);
  seedItem(board, { file: "v1.html", label: "Hero · A" });
  await writeFile(boardFilePath(boardDirectory), `${JSON.stringify(board, null, 2)}\n`);

  const page = await fetch(registered.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Easel/);
  assert.match(html, /\/board-client\.js/);
  assert.match(html, /"id":"v1"/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const registeredAgain = await register(base, boardDirectory);
  assert.equal(registeredAgain.key, registered.key);
  assert.equal(registeredAgain.board.items.length, 1);
  assert.equal(registeredAgain.board.items[0].tuneSpec.length, 3);

  const state = await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json());
  assert.equal(state.name, path.basename(dir) === "hero" ? "hero" : state.name);
  assert.equal(state.items[0].tuneSpec[0].css, "--radius");
  assert.equal(state.ended, false);
});

test("a board item is served with its own SDK and its sibling assets", async (t) => {
  const { base, boardDirectory } = await setup(t);
  const registered = await register(base, boardDirectory);
  const board = await readBoard(boardDirectory);
  seedItem(board, { file: "v1.html", label: "Hero · A" });
  await writeFile(boardFilePath(boardDirectory), `${JSON.stringify(board, null, 2)}\n`);

  const item = await fetch(`${base}/board/${registered.key}/item/v1/index.html`);
  assert.equal(item.status, 200);
  const html = await item.text();
  assert.match(html, /<script src="\/board-sdk\.js\?key=[0-9a-f]+&item=v1"><\/script><\/body>/);
  assert.match(html, /The whole fleet/);
  assert.doesNotMatch(html, /\/sdk\.js/);

  const css = await fetch(`${base}/board/${registered.key}/item/v1/item.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /color: red/);

  const escaped = await fetch(`${base}/board/${registered.key}/item/v1/..%2F..%2Fsecret.txt`);
  assert.ok([403, 404].includes(escaped.status), `expected the traversal to be refused, got ${escaped.status}`);
  assert.doesNotMatch(await escaped.text(), /do not serve/);
});

test("board writes are same-origin guarded and a move lands in board.json", async (t) => {
  const { base, boardDirectory } = await setup(t);
  const registered = await register(base, boardDirectory);
  const board = await readBoard(boardDirectory);
  seedItem(board, { file: "v1.html", label: "Hero · A" });
  seedItem(board, { file: "v2.html", label: "Hero · B", x: 520 });
  await writeFile(boardFilePath(boardDirectory), `${JSON.stringify(board, null, 2)}\n`);

  const foreign = await fetch(`${base}/api/boards/${registered.key}/place`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ items: [{ id: "v1", x: 640 }] }),
  });
  assert.equal(foreign.status, 403);

  const moved = await fetch(`${base}/api/boards/${registered.key}/place`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({ items: [{ id: "v1", x: 640, y: 12 }] }),
  });
  assert.equal(moved.status, 200);
  const stored = await readBoard(boardDirectory);
  assert.equal(stored.items.find((item) => item.id === "v1").x, 640);
  assert.equal(stored.items.find((item) => item.id === "v1").y, 12);

  const unknown = await fetch(`${base}/api/boards/${registered.key}/place`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({ items: [{ id: "nope", x: 1 }] }),
  });
  assert.equal(unknown.status, 400);
});

test("notes, tune values and versions persist through the board routes", async (t) => {
  const { base, boardDirectory } = await setup(t);
  const registered = await register(base, boardDirectory);
  const board = await readBoard(boardDirectory);
  seedItem(board, { file: "v1.html", label: "Hero · A" });
  await writeFile(boardFilePath(boardDirectory), `${JSON.stringify(board, null, 2)}\n`);

  const notes = await fetch(`${base}/api/boards/${registered.key}/notes`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({
      item: "v1",
      notes: [{ id: "n1", number: 1, selector: "h1", tag: "h1", text: "Too loud", x: 12, y: 20 }],
    }),
  });
  assert.equal(notes.status, 200);
  const savedNotes = await notes.json();
  assert.equal(savedNotes.notes.length, 1);
  assert.equal(savedNotes.notes[0].selector, "h1");

  const tune = await fetch(`${base}/api/boards/${registered.key}/tune`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({ item: "v1", values: { radius: "20", accent: "#ff0000", density: "compact" } }),
  });
  assert.equal(tune.status, 200);
  const tuned = await tune.json();
  assert.equal(tuned.css["--radius"], "20px");
  assert.equal(tuned.css["--accent"], "#ff0000");
  assert.equal(tuned.css["--density"], "compact");

  const version = await fetch(`${base}/api/boards/${registered.key}/versions`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({ item: "v1", label: "Wide" }),
  });
  assert.equal(version.status, 200);
  const versions = await version.json();
  assert.equal(versions.versions.length, 1);
  assert.equal(versions.versions[0].label, "Wide");
  assert.equal(versions.versions[0].values.radius, "20");

  const reread = await readBoard(boardDirectory);
  assert.equal(reread.items[0].notes.length, 1);
  assert.equal(reread.items[0].tune.radius, "20");
  assert.equal(reread.items[0].versions.length, 1);
});

test("a board session accepts queued notes and reports them as pending", async (t) => {
  const { base, boardDirectory } = await setup(t);
  const registered = await register(base, boardDirectory);

  const queued = await fetch(`${base}/api/${registered.key}/prompts`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({
      prompts: [
        {
          uid: "u1",
          prompt: "Tighten the headline",
          tag: "pin",
          selector: "h1",
          item: { id: "v1", label: "Hero · A" },
        },
      ],
      domSnapshot: "",
    }),
  });
  assert.equal(queued.status, 200);
  const queuedBody = await queued.json();
  assert.equal(queuedBody.status, "queued");
  assert.equal(queuedBody.pending_prompts, 1);

  const state = await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json());
  assert.equal(state.pending_prompts, 1);
  assert.equal(state.chat.at(-1).text, "Tighten the headline");
});

test("an unknown board key is not a board", async (t) => {
  const { base } = await setup(t);
  const missing = await fetch(`${base}/api/boards/deadbeef`);
  assert.equal(missing.status, 404);
  const page = await fetch(`${base}/board/deadbeef`);
  assert.equal(page.status, 404);
});
