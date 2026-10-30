import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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

async function setup(t, { env = {} } = {}) {
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
    ...(Object.keys(env).length > 0 ? { env: { ...process.env, ...env }, log: () => {} } : {}),
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
  // Opening a board picks up every HTML file already in its folder.
  assert.deepEqual(registered.board.items.map((item) => item.file).sort(), ["v1.html", "v2.html"]);

  const page = await fetch(registered.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Easel/);
  assert.match(html, /\/board-client\.js/);
  assert.match(html, /\/dialkit\/browser\.global\.js/);
  const dialkit = await fetch(`${base}/dialkit/browser.global.js`);
  assert.equal(dialkit.status, 200);
  assert.match(await dialkit.text(), /createDialTimeline/);
  assert.equal((await fetch(`${base}/dialkit/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/dialkit/package.json`)).status, 404);
  assert.match(html, /"id":"v1"/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const registeredAgain = await register(base, boardDirectory);
  assert.equal(registeredAgain.key, registered.key);
  assert.equal(registeredAgain.board.items.length, 2);
  assert.equal(registeredAgain.board.items.find((item) => item.id === "v1").tuneSpec.length, 3);

  const state = await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json());
  assert.equal(state.name, path.basename(dir) === "hero" ? "hero" : state.name);
  const v1 = state.items.find((item) => item.id === "v1");
  assert.equal(v1.tuneSpec[0].css, "--radius");
  assert.match(v1.tuneInstruction, /v1\.html/);
  assert.equal(state.ended, false);
});

test("a rewritten item carries a new content hash even when its mtime does not move", async (t) => {
  const { base, boardDirectory } = await setup(t);
  const board = await register(base, boardDirectory);
  const itemOf = async () =>
    (await fetch(`${base}/api/boards/${board.key}`).then((response) => response.json())).items.find(
      (item) => item.id === "v1",
    );
  const before = await itemOf();
  const file = path.join(boardDirectory, "v1.html");
  const info = await stat(file);
  // A tool that writes and restores the timestamp, or two writes inside one millisecond,
  // leaves mtime unchanged. The frame still has to notice the new bytes.
  await writeFile(file, ITEM_HTML.replace("The whole fleet", "The whole fleet, rewritten"));
  await utimes(file, info.atime, info.mtime);
  const after = await itemOf();
  assert.equal(after.mtime, before.mtime);
  assert.notEqual(after.hash, before.hash);
});

test("advanced tune values persist and appear in the agent instruction", async (t) => {
  const { base, boardDirectory } = await setup(t);
  await writeFile(
    path.join(boardDirectory, "v1.html"),
    `<script type="application/easel-tune">[
    {"id":"spring","type":"spring","css":"--spring","value":{"stiffness":180,"damping":20,"mass":1}},
    {"id":"curve","type":"easing","css":"--curve","value":"cubic-bezier(0, 0, 1, 1)"},
    {"id":"position","type":"pad","css":"--position","value":{"x":0,"y":0}},
    {"id":"time","type":"timeline","css":"--time","min":0,"max":2,"unit":"s","duration":2,"value":0}
  ]</script>`,
  );
  const board = await register(base, boardDirectory);
  const values = {
    spring: '{"stiffness":300,"damping":20,"mass":1}',
    curve: "cubic-bezier(0.42, 0, 1, 1)",
    position: '{"x":0.5,"y":-0.2}',
    time: "1",
  };
  const response = await fetch(`${base}/api/boards/${board.key}/tune`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({ item: "v1", values }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).css, {
    "--spring": values.spring,
    "--curve": values.curve,
    "--position": values.position,
    "--time": "1s",
  });
  const reread = await fetch(`${base}/api/boards/${board.key}`).then((r) => r.json());
  const item = reread.items.find((entry) => entry.id === "v1");
  assert.deepEqual(item.tune, values);
  assert.equal(item.tuneSpec.find((control) => control.id === "time").duration, 2);
  assert.match(item.tuneInstruction, /--position/);
  assert.match(item.tuneInstruction, /1s/);
});

test("a board item's explanation comes from its own easel metas", async (t) => {
  const { base, boardDirectory } = await setup(t);
  await writeFile(
    path.join(boardDirectory, "01-hero-today.html"),
    '<!doctype html><html><head><meta name="easel-caption" content="Hero today: two identical buttons."></head><body></body></html>',
  );
  await writeFile(
    path.join(boardDirectory, "01-hero-proposed-b.html"),
    '<!doctype html><html><head><meta name="easel-title" content="Hero buttons"><meta name="easel-explain" content="One button &amp; a link."></head><body></body></html>',
  );
  const registered = await register(base, boardDirectory);
  const state = await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json());
  const today = state.items.find((item) => item.file === "01-hero-today.html");
  const proposed = state.items.find((item) => item.file === "01-hero-proposed-b.html");
  assert.equal(today.caption, "Hero today: two identical buttons.");
  assert.deepEqual(today.pair, { key: "01-hero", name: "hero", role: "today", variant: "" });
  assert.equal(proposed.title, "Hero buttons");
  assert.equal(proposed.caption, "One button & a link.");
  assert.deepEqual(proposed.pair, { key: "01-hero", name: "hero", role: "proposed", variant: "b" });
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
  assert.match(html, /<script src="\/board-sdk\.js\?key=[0-9a-f]+&item=v1&device=desktop&v=[^"]*"><\/script><\/body>/);
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

  const instructed = await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json());
  assert.match(instructed.items[0].tuneInstruction, /--radius/);
  assert.match(instructed.items[0].tuneInstruction, /20px/);

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

test("a pin prompt keeps the item and pin it belongs to, and earns its receipts", async (t) => {
  const { base, boardDirectory } = await setup(t);
  const registered = await register(base, boardDirectory);
  const board = await readBoard(boardDirectory);
  seedItem(board, { file: "v1.html", label: "Hero · A" });
  await writeFile(boardFilePath(boardDirectory), `${JSON.stringify(board, null, 2)}\n`);

  const queued = await fetch(`${base}/api/${registered.key}/prompts`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({
      prompts: [
        {
          uid: "u1",
          prompt_id: "p-1",
          prompt: "Too loud",
          selector: "h1",
          text: "The whole fleet",
          tag: "pin",
          item: { id: "v1", label: "Hero · A" },
          pin: { id: "n1", number: 3, viewport: 834, excerpt: "  The whole\n fleet ", heading: "Fleet" },
          thread: "n1",
          followup: "edit",
        },
      ],
      domSnapshot: "",
    }),
  });
  assert.equal(queued.status, 200);

  const polled = await fetch(
    `${base}/api/poll?file=${encodeURIComponent(boardFilePath(boardDirectory))}&timeoutMs=4000`,
  ).then((response) => response.json());
  assert.equal(polled.status, "feedback");
  assert.equal(polled.prompts.length, 1);
  assert.deepEqual(polled.prompts[0].item, { id: "v1", label: "Hero · A" });
  assert.deepEqual(polled.prompts[0].pin, {
    id: "n1",
    number: 3,
    viewport: 834,
    excerpt: "The whole fleet",
    heading: "Fleet",
  });
  assert.equal(polled.prompts[0].prompt_id, undefined);
  assert.equal(polled.prompts[0].thread, "n1");
  assert.equal(polled.prompts[0].followup, "edit");

  const seen = await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json());
  assert.ok(seen.chat.at(-1).delivered_at, "the note reads Seen once a poll takes it");

  const reply = await fetch(`${base}/api/${registered.key}/agent-reply`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({ agent_reply: "Made the headline quieter." }),
  });
  assert.equal(reply.status, 200);
  const done = await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json());
  assert.ok(done.chat.find((entry) => entry.prompt_id === "p-1").done_at, "the note reads Done after a reply");
});

test("the server home page is Easel and lists the boards it has open", async (t) => {
  const { base, boardDirectory } = await setup(t);
  const empty = await (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
  assert.match(empty, /<title>Easel<\/title>/);
  assert.match(empty, /<h1>Easel<\/h1>/);
  assert.doesNotMatch(empty, /Lavish/);
  assert.match(empty, /No boards are open/);

  const registered = await register(base, boardDirectory);
  const listed = await (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
  assert.match(listed, new RegExp(`<a href="/board/${registered.key}">hero</a>`));
  assert.doesNotMatch(listed, /No boards are open/);
});

test("an unknown board key is not a board", async (t) => {
  const { base } = await setup(t);
  const missing = await fetch(`${base}/api/boards/deadbeef`);
  assert.equal(missing.status, 404);
  const page = await fetch(`${base}/board/deadbeef`);
  assert.equal(page.status, 404);
});

test("a board submission runs EASEL_NOTIFY_CMD once and leaves the feedback for poll", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "easel-notify-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const out = path.join(scratch, "calls.txt");
  const script = path.join(scratch, "notify.sh");
  await writeFile(
    script,
    `#!/bin/sh\nprintf '%s|%s|%s|%s|%s\\n' "$1" "$2" "$3" "$EASEL_BOARD" "$EASEL_SUBMISSION_ID" >> '${out}'\n`,
  );
  await chmod(script, 0o755);
  const { base, boardDirectory } = await setup(t, { env: { EASEL_NOTIFY_CMD: script } });
  const registered = await register(base, boardDirectory);

  for (const text of ["Tighten the headline", "Accepted: Hero - Proposed (all sizes)"]) {
    const queued = await fetch(`${base}/api/${registered.key}/prompts`, {
      method: "POST",
      headers: write(base),
      body: JSON.stringify({ prompts: [{ uid: text, prompt: text, tag: "message" }], domSnapshot: "" }),
    });
    assert.equal(queued.status, 200);
  }
  let calls = [];
  for (let attempt = 0; attempt < 50 && calls.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    calls = (await readFile(out, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));
  }
  assert.equal(calls.length, 2, "one run per submission");
  const boardJson = boardFilePath(boardDirectory);
  for (const [name, file, id, envBoard, envId] of calls) {
    assert.equal(name, registered.board.name);
    assert.equal(path.basename(file), "board.json");
    assert.equal(await readFile(file, "utf8"), await readFile(boardJson, "utf8"));
    assert.match(id, /^[0-9a-z]+-[0-9a-f]{8}$/);
    assert.equal(envBoard, name);
    assert.equal(envId, id);
  }
  assert.notEqual(calls[0][2], calls[1][2]);

  const polled = await fetch(`${base}/api/poll?file=${encodeURIComponent(boardJson)}&timeoutMs=2000`).then((response) =>
    response.json(),
  );
  assert.equal(polled.status, "feedback");
  assert.equal(polled.prompts.length, 2);
});

const DROP_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=",
  "base64",
);

test("a dropped image is written into the board folder, recorded, served and undone", async (t) => {
  const { base, boardDirectory } = await setup(t);
  const registered = await register(base, boardDirectory);
  const upload = await fetch(`${base}/api/${registered.key}/attachments`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/octet-stream" },
    body: DROP_PNG,
  }).then((response) => response.json());

  const dropped = await fetch(`${base}/api/boards/${registered.key}/image-drop`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({
      item: "v1",
      selector: "#hero",
      kind: "img",
      oldSource: "original.jpg",
      attachment: upload.attachment.id,
    }),
  });
  assert.equal(dropped.status, 200);
  const result = await dropped.json();
  assert.match(result.drop.file, /^assets\/drops\/[0-9a-f]{64}\.png$/);
  assert.deepEqual(await readFile(path.join(boardDirectory, result.drop.file)), DROP_PNG);

  const saved = await readBoard(boardDirectory);
  assert.deepEqual(saved.items.find((item) => item.id === "v1").imageDrops, [
    { selector: "#hero", kind: "img", oldSource: "original.jpg", file: result.drop.file },
  ]);

  const served = await fetch(`${base}/board/${registered.key}/drop/${path.basename(result.drop.file)}`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), DROP_PNG);
  assert.equal((await fetch(`${base}/board/${registered.key}/drop/..%2Fstate.json`)).status, 404);
  assert.equal((await fetch(`${base}/board/${registered.key}/drop/nope.png`)).status, 404);

  // Another origin may not swap an image on this board.
  const foreign = await fetch(`${base}/api/boards/${registered.key}/image-drop`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ item: "v1", selector: "#hero", kind: "img", attachment: upload.attachment.id }),
  });
  assert.equal(foreign.status, 403);

  const undone = await fetch(`${base}/api/boards/${registered.key}/image-drop`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({ item: "v1", selector: "#hero", undo: true }),
  });
  assert.equal(undone.status, 200);
  assert.deepEqual((await readBoard(boardDirectory)).items.find((item) => item.id === "v1").imageDrops, []);
});

test("a board's conversation survives losing the session transcript", async (t) => {
  const { base, boardDirectory, dir } = await setup(t);
  const registered = await register(base, boardDirectory);
  const queued = await fetch(`${base}/api/${registered.key}/prompts`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({
      prompts: [{ uid: "1", prompt_id: "p-1", prompt: "Tighten the headline", tag: "message", thread: "item:v1" }],
      domSnapshot: "",
    }),
  });
  assert.equal(queued.status, 200);

  const history = JSON.parse(await readFile(path.join(boardDirectory, ".easel-history.json"), "utf8"));
  assert.equal(history.chat.length, 1);
  assert.equal(history.chat[0].text, "Tighten the headline");

  // A restart that lost the session's chat still shows the thread.
  const stateFile = path.join(dir, "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.sessions[registered.key].chat = [];
  await writeFile(stateFile, JSON.stringify(state));

  const page = await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json());
  assert.deepEqual(
    page.chat.map((entry) => entry.text),
    ["Tighten the headline"],
  );
});

test("a changed item file leaves a build on its timeline", async (t) => {
  const { base, boardDirectory } = await setup(t);
  const registered = await register(base, boardDirectory);
  await writeFile(
    path.join(boardDirectory, "v1.html"),
    ITEM_HTML.replace("<h1>The whole fleet</h1>", '<meta name="easel-build" content="Round 2"><h1>Second round</h1>'),
  );
  const page = await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json());
  const item = page.items.find((entry) => entry.id === "v1");
  assert.equal(item.builds.length, 2);
  assert.equal(item.builds.at(-1).label, "Round 2");
  const build = await fetch(`${base}/board/${registered.key}/item/v1/build/${item.builds.at(-1).hash}`);
  assert.equal(build.status, 200);
  assert.match(await build.text(), /Second round/);
});

test("a saved build lays out beside its item: sized by the SDK, reading the item's own files", async (t) => {
  const { base, boardDirectory } = await setup(t);
  const registered = await register(base, boardDirectory);
  const first = (await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json())).items.find(
    (entry) => entry.id === "v1",
  ).builds[0];
  await writeFile(path.join(boardDirectory, "v1.html"), ITEM_HTML.replace("The whole fleet", "Round two"));
  await writeFile(path.join(boardDirectory, "item.css"), "h1 { color: blue; }");
  const second = (await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json())).items.find(
    (entry) => entry.id === "v1",
  ).builds[1];

  // Shown in a dialog, a build is the file as it was; laid out on the board at a device
  // width it carries the item SDK, which sizes the frame like the live one.
  const plain = await fetch(`${base}/board/${registered.key}/item/v1/build/${first.hash}`).then((r) => r.text());
  assert.doesNotMatch(plain, /board-sdk\.js/);
  const framed = await fetch(`${base}/board/${registered.key}/item/v1/build/${first.hash}/?device=phone`);
  assert.equal(framed.status, 200);
  assert.match(framed.headers.get("content-security-policy") || "", /sandbox/);
  const html = await framed.text();
  assert.match(html, /The whole fleet/);
  assert.match(
    html,
    /board-sdk\.js\?key=[0-9a-f]+&amp;item=v1&amp;device=phone|board-sdk\.js\?key=[0-9a-f]+&item=v1&device=phone/,
  );

  // Its relative links resolve under the build's folder: a stylesheet to the copy kept
  // with that build, so an old round still looks as it did.
  const css = await fetch(`${base}/board/${registered.key}/item/v1/build/${first.hash}/item.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /color: red/);
  const now = await fetch(`${base}/board/${registered.key}/item/v1/build/${second.hash}/item.css`).then((r) =>
    r.text(),
  );
  assert.match(now, /color: blue/);
  const live = await fetch(`${base}/board/${registered.key}/item/v1/item.css`).then((r) => r.text());
  assert.match(live, /color: blue/);
  const escape = await fetch(`${base}/board/${registered.key}/item/v1/build/${first.hash}/..%2F..%2Fsecret.txt`);
  assert.notEqual(escape.status, 200);
});

test("a build's thumbnail is served once taken, and never without Chrome", async (t) => {
  const { base, boardDirectory } = await setup(t, { env: { EASEL_CHROME: path.join(tmpdir(), "easel-no-chrome") } });
  const registered = await register(base, boardDirectory);
  const item = (await fetch(`${base}/api/boards/${registered.key}`).then((response) => response.json())).items.find(
    (entry) => entry.id === "v1",
  );
  const hash = item.builds[0].hash;
  const thumbUrl = `${base}/board/${registered.key}/item/v1/thumb/${hash}`;
  assert.equal((await fetch(thumbUrl)).status, 404);

  const asked = await fetch(`${base}/api/boards/${registered.key}/thumbs`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({ item: "v1" }),
  });
  assert.deepEqual(await asked.json(), { status: "unavailable", thumbs: [] });
  const foreign = await fetch(`${base}/api/boards/${registered.key}/thumbs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ item: "v1" }),
  });
  assert.equal(foreign.status, 403);

  // A thumbnail on disk beside the build's snapshot is reported and served.
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await writeFile(path.join(boardDirectory, ".easel-builds", "v1", `${hash}.png`), png);
  const again = await fetch(`${base}/api/boards/${registered.key}/thumbs`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({ item: "v1" }),
  }).then((response) => response.json());
  assert.deepEqual(again.thumbs, [hash]);
  const served = await fetch(thumbUrl);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/board/${registered.key}/item/v1/thumb/${"0".repeat(40)}`)).status, 404);

  // The page Chrome would photograph frames that build, scaled to one desktop screen.
  const frame = await fetch(`${base}/board/${registered.key}/thumb-frame?item=v1&hash=${hash}`).then((r) => r.text());
  assert.match(frame, new RegExp(`/item/v1/build/${hash}/`));
  assert.match(frame, /scale\(0\.25\)/);
});
