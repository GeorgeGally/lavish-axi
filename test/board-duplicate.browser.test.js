import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findChrome } from "../src/board-crop.js";
import { launchChrome } from "./board-cdp-browser.js";

const runBrowserE2e = process.env.LIESEL_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Where to leave a screenshot of the board with its duplicate, when asked.
const shotDir = process.env.LIESEL_E2E_SHOTS || "";

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>hero</title><style>
body { margin: 0; font: 16px sans-serif; }
section { height: 700px; border-bottom: 1px solid #ccc; padding: 40px; }
</style></head><body>
<section><h1>The whole fleet</h1></section><section>Two</section><section>Three</section><section>Four</section>
</body></html>
`;

test(
  "a design duplicates beside itself, scrolls with its copy, renames, and deletes with undo",
  { skip: !runBrowserE2e || !findChrome(), timeout: 240_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "liesel-duplicate-e2e-"));
    const port = await freePort();
    const lieselEnv = {
      LIESEL_PORT: String(port),
      LIESEL_STATE_DIR: path.join(temp, "state"),
      LIESEL_NO_OPEN: "1",
      LIESEL_TELEMETRY: "0",
      LIESEL_HOST: "127.0.0.1",
      LIESEL_LINK_HOST: "127.0.0.1",
    };
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    /** @type {Awaited<ReturnType<typeof launchChrome>> | null} */
    let browser = null;
    try {
      const board = path.join(temp, "board");
      await mkdir(board, { recursive: true });
      await writeFile(path.join(board, "hero.html"), ITEM_HTML);
      const output = run(process.execPath, ["bin/liesel.js", "board", "open", board, "--no-open"], lieselEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      browser = await launchChrome(findChrome(), profile);
      const { send, evaluate, list } = browser;
      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(2500);
      await evaluate(`document.querySelector('#devices [data-device="desktop"]').click()`);
      await sleep(1500);

      const boxes = () =>
        evaluate(
          `[...document.querySelectorAll(".artboard")].filter((a) => !a.hidden).map((a) => ({ key: a.dataset.key, x: parseFloat(a.style.left), y: parseFloat(a.style.top) }))`,
        );
      // The label's Duplicate makes a copy, beside the design on the same row.
      await evaluate(
        `[...document.querySelectorAll(".item-action")].find((b) => b.textContent === "Duplicate").click()`,
      );
      await sleep(1500);
      const copied = await stat(path.join(board, "hero-copy.html"));
      assert.ok(copied.isFile());
      assert.equal(await readFile(path.join(board, "hero-copy.html"), "utf8"), ITEM_HTML);
      const placed = await boxes();
      const hero = placed.find((entry) => entry.key === "hero::desktop");
      const copy = placed.find((entry) => entry.key === "hero-copy::desktop");
      assert.ok(hero && copy, JSON.stringify(placed));
      assert.equal(copy.y, hero.y, "the copy is not on the original's row");
      assert.ok(copy.x > hero.x, "the copy is not to the right of the original");
      const names = await evaluate(
        `[...document.querySelectorAll(".artboard-label .name")].map((n) => n.textContent).filter(Boolean)`,
      );
      assert.ok(names.includes("hero copy"), JSON.stringify(names));
      assert.match(
        await evaluate(`document.getElementById("dropToast")?.textContent || ""`),
        /Duplicated as hero copy/,
      );
      if (shotDir) {
        await mkdir(shotDir, { recursive: true });
        const shot = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(path.join(shotDir, "duplicate-beside.png"), Buffer.from(shot.data, "base64"));
      }

      // A wheel over the original scrolls its copy the same way: they are locked.
      const frame = await evaluate(
        `(() => { const r = document.querySelector('.artboard[data-key="hero::desktop"] .screen').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: frame.x, y: frame.y });
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: frame.x, y: frame.y, deltaX: 0, deltaY: 400 });
      await sleep(600);
      const scrolled = {};
      for (const target of (await list()).filter((entry) => entry.type === "iframe")) {
        const { sessionId } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
        if (!target.url.includes("device=desktop")) continue;
        const id = /\/item\/([^/]+)\//.exec(target.url)?.[1] || "";
        scrolled[id] = await evaluate("window.scrollY", sessionId);
      }
      assert.ok(scrolled.hero > 0, JSON.stringify(scrolled));
      assert.equal(
        scrolled["hero-copy"],
        scrolled.hero,
        `the copy did not scroll with its design: ${JSON.stringify(scrolled)}`,
      );

      // Rename the copy in place.
      await evaluate(`[...document.querySelectorAll(".item-action")].find((b) => b.textContent === "Rename").click()`);
      await sleep(200);
      assert.equal(await evaluate(`document.activeElement?.className`), "rename-input");
      await send("Input.insertText", { text: "Hero, louder" });
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await sleep(800);
      const saved = JSON.parse(await readFile(path.join(board, "board.json"), "utf8"));
      assert.equal(saved.items.find((item) => item.id === "hero-copy").label, "Hero, louder");

      // Cmd-D duplicates the picked design (the copy just renamed is picked).
      await evaluate(`document.activeElement?.blur()`);
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "d",
        code: "KeyD",
        modifiers: 4,
        windowsVirtualKeyCode: 68,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "d",
        code: "KeyD",
        modifiers: 4,
        windowsVirtualKeyCode: 68,
      });
      await sleep(1500);
      assert.ok((await stat(path.join(board, "hero-copy-2.html"))).isFile());

      // Delete a copy, then Undo brings it back with its file.
      await evaluate(
        `[...document.querySelectorAll('.artboard-label')].find((l) => l.querySelector(".name")?.textContent === "Hero, louder").querySelector('.item-action:last-child').click()`,
      );
      await sleep(1000);
      await assert.rejects(stat(path.join(board, "hero-copy.html")));
      assert.equal(
        (await boxes()).some((entry) => entry.key === "hero-copy::desktop"),
        false,
      );
      assert.match(await evaluate(`document.getElementById("dropToast")?.textContent || ""`), /Deleted Hero, louder/);
      await evaluate(`document.querySelector("#dropToast .drop-toast-undo").click()`);
      await sleep(1500);
      assert.ok((await stat(path.join(board, "hero-copy.html"))).isFile());
      assert.ok((await boxes()).some((entry) => entry.key === "hero-copy::desktop"));
      if (shotDir) {
        const shot = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(path.join(shotDir, "duplicate-restored.png"), Buffer.from(shot.data, "base64"));
      }
    } finally {
      browser?.close();
      run(process.execPath, ["bin/liesel.js", "stop", "--port", String(port)], lieselEnv, 15_000);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
