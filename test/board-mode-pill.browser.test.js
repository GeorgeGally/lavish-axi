import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findChrome } from "../src/board-crop.js";
import { launchChrome } from "./board-cdp-browser.js";

const runBrowserE2e = process.env.LIESEL_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
<html><head><meta charset="utf-8"><title>pill</title><style>
body { margin: 0; font: 16px sans-serif; }
#title { margin: 0; padding: 40px; font-size: 48px; }
#press { margin: 40px; width: 300px; height: 60px; font-size: 20px; }
</style></head>
<body><h1 id="title">Hold</h1><button id="press" type="button" data-count="0">Pressed 0</button>
<script>
const press = document.getElementById("press");
press.addEventListener("click", () => {
  press.dataset.count = String(Number(press.dataset.count) + 1);
  press.textContent = "Pressed " + press.dataset.count;
});
</script></body></html>
`;

/**
 * A board with one design open in headless Chrome, handed to `body`, then torn down.
 * @param {(browser: Awaited<ReturnType<typeof launchChrome>>, url: string) => Promise<void>} body
 */
async function withPillBoard(body) {
  const temp = await mkdtemp(path.join(tmpdir(), "liesel-pill-e2e-"));
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
    await writeFile(path.join(board, "01-pill.html"), ITEM_HTML);
    const output = run(process.execPath, ["bin/liesel.js", "board", "open", board, "--no-open"], lieselEnv);
    const url = output.match(/url:\s*"([^"]+)"/)?.[1];
    assert.ok(url, output);
    browser = await launchChrome(findChrome(), profile);
    await browser.send("Page.enable");
    await browser.send("Page.navigate", { url });
    await sleep(2500);
    await body(browser, url);
  } finally {
    browser?.close();
    run(process.execPath, ["bin/liesel.js", "stop", "--port", String(port)], lieselEnv, 15_000);
    await rm(temp, { recursive: true, force: true });
  }
}

/** @param {Awaited<ReturnType<typeof launchChrome>>} browser */
function pillDriver({ send, evaluate }) {
  /** @param {string} type @param {number} x @param {number} y @param {Record<string, unknown>} [extra] */
  const mouse = (type, x, y, extra = {}) =>
    send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  /** @param {string} word */
  const clickWord = async (word) => {
    const at = await evaluate(
      `(() => { const b = [...document.querySelectorAll("#modeState button")].find((b) => b.textContent === ${JSON.stringify(word)}); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    await mouse("mouseMoved", at.x, at.y, { button: "none", clickCount: 0 });
    await mouse("mousePressed", at.x, at.y, { buttons: 1 });
    await mouse("mouseReleased", at.x, at.y, { buttons: 0 });
    await sleep(300);
  };
  const state = () =>
    evaluate(`(() => {
      const badge = document.getElementById("modeState");
      return (badge.dataset.mode || "view") + ":" + badge.querySelector("[aria-pressed=true]").textContent;
    })()`);
  return { mouse, clickWord, state };
}

// The mode pill under the top bar is also a switch: clicking a word turns that mode on.
test(
  "clicking a word in the mode pill switches to that mode",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    await withPillBoard(async (browser) => {
      const { clickWord, state } = pillDriver(browser);
      assert.equal(await state(), "view:View");
      await clickWord("Chat");
      assert.equal(await state(), "annotate:Chat");
      await clickWord("Edit");
      assert.equal(await state(), "tune:Edit");
      await clickWord("Move");
      assert.equal(await state(), "move:Move");
      await clickWord("View");
      assert.equal(await state(), "view:View");
    });
  },
);

// Move: a drag on a design moves the element under the pointer, saved as a translate on
// the board like an Edit change, and loaded into Controls so it can be sent as a note.
test(
  "dragging in Move mode moves the element and saves it as a CSS change",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    await withPillBoard(async (browser, url) => {
      const { send, evaluate, list } = browser;
      const { mouse, clickWord, state } = pillDriver(browser);
      await clickWord("Move");
      assert.equal(await state(), "move:Move");
      const target = (await list()).find((entry) => entry.type === "iframe" && entry.url.includes("device=desktop"));
      assert.ok(target, "no desktop frame");
      const { sessionId } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
      const frame = await evaluate(
        `(() => { const f = [...document.querySelectorAll(".artboard iframe")].find((f) => f.src.includes("device=desktop")); const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / f.offsetWidth }; })()`,
      );
      const inner = await evaluate(
        `(() => { const r = document.getElementById("press").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        sessionId,
      );
      const from = { x: frame.left + inner.x * frame.scale, y: frame.top + inner.y * frame.scale };
      await mouse("mouseMoved", from.x, from.y, { button: "none", clickCount: 0 });
      await sleep(200);
      await mouse("mousePressed", from.x, from.y, { buttons: 1 });
      await sleep(200);
      for (let step = 1; step <= 6; step++) {
        await mouse("mouseMoved", from.x + 10 * step * frame.scale, from.y + 5 * step * frame.scale, { buttons: 1 });
        await sleep(40);
      }
      await mouse("mouseReleased", from.x + 60 * frame.scale, from.y + 30 * frame.scale, { buttons: 0 });
      await sleep(900);

      assert.equal(
        await evaluate(`getComputedStyle(document.getElementById("press")).translate`, sessionId),
        "60px 30px",
        "the button moved with the drag",
      );
      assert.equal(
        await evaluate(`document.getElementById("press").dataset.count`, sessionId),
        "0",
        "the drag never clicked the page",
      );
      const key = new URL(url).pathname.split("/").pop();
      const saved = await evaluate(
        `fetch("/api/boards/${key}").then((r) => r.json()).then((b) => b.items[0].elementTune)`,
      );
      assert.deepEqual(saved, { "#press": { translate: "60px 30px" } }, "the move is saved on the board");
      assert.equal(
        await evaluate(`document.getElementById("tuneSend").disabled`),
        false,
        "Controls holds the moved element, ready to send",
      );
    });
  },
);

// The pill sits over the middle of what is left of the board, not the window, so it
// stays centred when the sidebar takes the right-hand side.
test(
  "the mode pill centres over the visible board beside the sidebar",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async (t) => {
    await withPillBoard(async ({ evaluate }) => {
      const centre = `(async () => {
        await new Promise((r) => setTimeout(r, 600));
        const pill = document.getElementById("modeState").getBoundingClientRect();
        const chat = document.getElementById("chat");
        const side = chat.classList.contains("collapsed") ? 0 : chat.getBoundingClientRect().width;
        return { pill: pill.left + pill.width / 2, room: (window.innerWidth - side) / 2, side };
      })()`;
      await evaluate(
        `(() => { if (!document.getElementById("chat").classList.contains("collapsed")) document.getElementById("chatToggle").click(); })()`,
      );
      const closed = await evaluate(centre);
      assert.equal(closed.side, 0, "the sidebar is closed");
      assert.ok(Math.abs(closed.pill - closed.room) < 1, JSON.stringify(closed));
      await evaluate(`document.getElementById("chatOpen").click()`);
      const open = await evaluate(centre);
      assert.ok(open.side > 0, "the sidebar is open");
      assert.ok(Math.abs(open.pill - open.room) < 1, JSON.stringify(open));
      t.diagnostic(JSON.stringify({ closed, open }));
    });
  },
);
