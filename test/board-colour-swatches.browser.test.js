import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findChrome } from "../src/board-crop.js";
import { launchChrome } from "./board-cdp-browser.js";

const runBrowserE2e = process.env.LIESEL_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

/** @param {string} dir */
async function findBoardFile(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === "board.json") return path.join(entry.parentPath, entry.name);
  }
  throw new Error("no board.json");
}

// Two colour tokens, one of them driving the heading, and a paint colour no token names.
const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>swatches</title><style>
:root { --ink: #1f2a44; --brand: #b95546; --gap: 12px; }
body { margin: 0; font-family: Georgia, serif; color: var(--ink); background: #fbf7f0; }
.hero { padding: 40px; }
.hero h2 { margin: 0; font-size: 40px; color: var(--ink); }
.tag { display: inline-block; padding: 4px 8px; background: #2f7d5b; color: #ffffff; }
</style></head>
<body><section class="hero"><h2 id="head">Swatch heading</h2><p><span class="tag">Tag</span> <span class="tag">Tag</span></p></section></body></html>
`;

// The Colour control leads with the page's own colours, named by their token, and
// follows with colours worked out from the current one. Picking a token applies it as
// var() and the change record names it.
test(
  "Colour swatches show the site's colours first, then suggested ones, and a picked token reaches the change record",
  { skip: !runBrowserE2e || !findChrome(), timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "liesel-swatches-e2e-"));
    const port = await freePort();
    const env = {
      LIESEL_PORT: String(port),
      LIESEL_STATE_DIR: path.join(temp, "state"),
      LIESEL_NO_OPEN: "1",
      LIESEL_TELEMETRY: "0",
      LIESEL_HOST: "127.0.0.1",
      LIESEL_LINK_HOST: "127.0.0.1",
    };
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    const board = path.join(temp, "board");
    await mkdir(board, { recursive: true });
    await writeFile(path.join(board, "01-swatches.html"), ITEM_HTML);
    const output = run(process.execPath, ["bin/liesel.js", "board", "open", board, "--no-open"], env);
    const url = output.match(/url:\s*"([^"]+)"/)?.[1];
    assert.ok(url, output);
    const browser = await launchChrome(findChrome(), profile);
    const { send, evaluate, list } = browser;
    /** @param {string} type @param {number} x @param {number} y @param {Record<string, unknown>} [extra] */
    const mouse = (type, x, y, extra = {}) =>
      send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
    try {
      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(2500);
      const target = (await list()).find((entry) => entry.type === "iframe" && entry.url.includes("device=desktop"));
      assert.ok(target, "no desktop frame");
      const { sessionId } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
      const inner = await evaluate(
        `(() => { const r = document.querySelector("#head").getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`,
        sessionId,
      );
      const frame = await evaluate(
        `(() => { const f = [...document.querySelectorAll(".artboard iframe")].find((f) => f.src.includes("device=desktop")); const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / f.offsetWidth }; })()`,
      );
      const point = { x: frame.left + inner.x * frame.scale, y: frame.top + inner.y * frame.scale };
      await mouse("mouseMoved", point.x, point.y, { button: "none", clickCount: 0 });
      await sleep(250);
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Alt", code: "AltLeft", modifiers: 1 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Alt", code: "AltLeft", modifiers: 0 });
      await sleep(150);
      await mouse("mousePressed", point.x, point.y, { buttons: 1 });
      await mouse("mouseReleased", point.x, point.y, { buttons: 0 });
      await sleep(1200);

      const colour = `[...document.querySelectorAll(".tune-colour")].find((c) => c.querySelector(".tune-hex").getAttribute("aria-label") === "Colour hex")`;
      const groups = await evaluate(
        `[...${colour}.querySelectorAll(".tune-colour-group")].map((g) => ({ caption: g.querySelector(".tune-colour-caption").textContent, swatches: [...g.querySelectorAll(".tune-colour-option")].map((o) => o.title) }))`,
      );
      assert.equal(groups.length, 2, JSON.stringify(groups));
      assert.equal(groups[0].caption, "Site");
      assert.deepEqual(groups[0].swatches.slice(0, 2), ["--ink · #1f2a44", "--brand · #b95546"]);
      for (const hex of ["#fbf7f0", "#2f7d5b", "#ffffff"])
        assert.ok(groups[0].swatches.includes(hex), `${hex} in ${JSON.stringify(groups)}`);
      // Only the page's colours: none of the board's own outline and pin colours.
      assert.equal(groups[0].swatches.length, 5, JSON.stringify(groups));
      assert.equal(
        new Set(groups[0].swatches.map((title) => title.split(" · ").pop())).size,
        groups[0].swatches.length,
      );
      assert.equal(groups[1].caption, "Suggested");
      assert.equal(groups[1].swatches.length, 10);

      // The panel, as the reviewer sees it, for the proof.
      const box = await evaluate(
        `(() => { const r = ${colour}.getBoundingClientRect(); return { x: r.left - 12, y: r.top - 32, width: r.width + 24, height: r.height + 44 }; })()`,
      );
      const shot = await send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 2 } });
      if (process.env.LIESEL_SWATCH_SHOT)
        await writeFile(process.env.LIESEL_SWATCH_SHOT, Buffer.from(shot.data, "base64"));

      // Hovering names the swatch in its column's caption.
      const brand = await evaluate(
        `(() => { const o = [...${colour}.querySelectorAll(".tune-colour-option")].find((o) => o.dataset.name === "--brand"); const r = o.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      await mouse("mouseMoved", brand.x, brand.y, { button: "none", clickCount: 0 });
      await sleep(200);
      assert.equal(await evaluate(`${colour}.querySelector(".tune-colour-caption").textContent`), "--brand · #b95546");

      // Picking the token applies it as var(), live and saved, and the record names it.
      await mouse("mousePressed", brand.x, brand.y, { buttons: 1 });
      await mouse("mouseReleased", brand.x, brand.y, { buttons: 0 });
      await sleep(900);
      assert.equal(
        await evaluate(`getComputedStyle(document.querySelector("#head")).color`, sessionId),
        "rgb(185, 85, 70)",
      );
      const saved = JSON.parse(await readFile(await findBoardFile(board), "utf8")).items[0].elementTune || {};
      assert.ok(
        Object.values(saved).some((css) => css.color === "var(--brand)"),
        JSON.stringify(saved),
      );
      const records = await evaluate(`tuneChangeRecords(itemById(tuneTarget.itemId))`);
      const record = records.find((entry) => entry.property === "color");
      assert.equal(record.new_value, "var(--brand)");
      assert.deepEqual(record.uses_variable, { name: "--brand", value: "#b95546" });
      assert.equal(record.variable?.name, "--ink");
    } finally {
      browser.close();
      run(process.execPath, ["bin/liesel.js", "stop", "--port", String(port)], env, 15_000);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
