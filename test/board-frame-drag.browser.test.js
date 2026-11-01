import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findChrome } from "../src/board-crop.js";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
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

// A drag-to-scroll carousel the way pages write one: pointerdown on the rail, pointer
// capture, and scrollLeft following the pointer. A board that kept any of that from
// the page would leave the rail where it was.
const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>carousel</title><style>
body { margin: 0; font: 16px sans-serif; }
.pad { height: 160px; }
.rail { overflow-x: auto; scrollbar-width: none; user-select: none; touch-action: pan-y; cursor: grab; }
.track { display: flex; width: 4000px; }
.track div { flex: 0 0 320px; height: 320px; background: linear-gradient(90deg, #ddd, #777); }
</style></head><body>
<div class="pad"></div>
<div class="rail" id="rail"><div class="track">${"<div></div>".repeat(12)}</div></div>
<div style="height: 1400px"></div>
<script>
const rail = document.getElementById("rail");
let start = null;
rail.addEventListener("pointerdown", (event) => {
  start = { x: event.clientX, left: rail.scrollLeft };
  rail.setPointerCapture(event.pointerId);
});
rail.addEventListener("pointermove", (event) => {
  if (start) rail.scrollLeft = start.left - (event.clientX - start.x);
});
rail.addEventListener("pointerup", () => { start = null; });
</script></body></html>
`;

/** A trusted-input browser over raw CDP: synthetic DOM events would never prove the frame gets the drag. */
async function launchChrome(chrome, profile) {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1600,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(200);
    try {
      port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
    } catch {
      // Chrome has not written it yet.
    }
  }
  if (!port) {
    child.kill("SIGKILL");
    throw new Error("Chrome did not open a DevTools port");
  }
  const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageTarget = (await list()).find((target) => target.type === "page");
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  /** @type {Map<number, (value: any) => void>} */
  const pending = new Map();
  ws.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)?.(data);
      pending.delete(data.id);
    }
  });
  /** @param {string} method @param {Record<string, unknown>} [params] @param {string} [sessionId] */
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (data) => (data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result)));
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  /** @param {string} expression @param {string} [sessionId] */
  const evaluate = async (expression, sessionId = undefined) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const close = () => {
    ws.close();
    child.kill("SIGKILL");
  };
  return { send, evaluate, list, close };
}

test(
  "a plain press-and-drag inside a design scrolls the page's own carousel in every device view, and Cmd held keeps it for notes",
  { skip: !runBrowserE2e || !findChrome(), timeout: 240_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "easel-frame-drag-e2e-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    /** @type {Awaited<ReturnType<typeof launchChrome>> | null} */
    let browser = null;
    try {
      const board = path.join(temp, "board");
      await mkdir(board, { recursive: true });
      await writeFile(path.join(board, "01-carousel.html"), ITEM_HTML);
      const output = run(process.execPath, ["bin/lavish-axi.js", "board", "open", board, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      browser = await launchChrome(findChrome(), profile);
      const { send, evaluate, list } = browser;
      /** @param {string} type @param {number} x @param {number} y @param {Record<string, unknown>} [extra] */
      const mouse = (type, x, y, extra = {}) =>
        send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });

      /** Press inside the frame's rail, pull left, let go; returns how far the rail scrolled and how far it should have. */
      async function dragRail(device, modifiers = 0) {
        const target = (await list()).find(
          (entry) => entry.type === "iframe" && entry.url.includes(`device=${device}`),
        );
        assert.ok(target, `no ${device} frame`);
        const { sessionId } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
        const inner = await evaluate(
          `(() => { const rail = document.getElementById("rail"); rail.scrollLeft = 0; const r = rail.getBoundingClientRect(); const visible = Math.min(r.width, innerWidth); return { x: r.left + visible * 0.8, width: visible, y: r.top + r.height / 2, max: rail.scrollWidth - rail.clientWidth }; })()`,
          sessionId,
        );
        const frame = await evaluate(
          `(() => { const f = [...document.querySelectorAll(".artboard iframe")].find((f) => f.src.includes("device=${device}")); const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / f.offsetWidth, viewport: [innerWidth, innerHeight] }; })()`,
        );
        const x = frame.left + inner.x * frame.scale;
        const y = frame.top + inner.y * frame.scale;
        assert.ok(x > 0 && x < frame.viewport[0] && y > 0 && y < frame.viewport[1], `${device} rail is off screen`);
        // The pull stays inside the frame: a drag that leaves a sandboxed frame is the
        // browser's to route, with or without a board around it.
        const distance = Math.min(200, inner.width * 0.6 * frame.scale);
        await mouse("mouseMoved", x, y, { button: "none", clickCount: 0, modifiers });
        await mouse("mousePressed", x, y, { buttons: 1, modifiers });
        for (let step = 1; step <= 10; step++) {
          await mouse("mouseMoved", x - (distance * step) / 10, y, { buttons: 1, modifiers });
          await sleep(16);
        }
        await mouse("mouseReleased", x - distance, y, { buttons: 0, modifiers });
        await sleep(250);
        const moved = await evaluate(`document.getElementById("rail").scrollLeft`, sessionId);
        return { moved, expected: Math.min(inner.max, distance / frame.scale) };
      }

      await send("Page.enable");
      for (const mode of ["all", "desktop", "ipad", "phone"]) {
        await send("Page.navigate", { url });
        await sleep(2000);
        await evaluate(`document.querySelector('#devices [data-device="${mode}"]').click()`);
        await sleep(2500);
        for (const device of mode === "all" ? ["desktop", "ipad", "phone"] : [mode]) {
          const { moved, expected } = await dragRail(device);
          assert.ok(
            Math.abs(moved - expected) <= Math.max(4, expected * 0.05),
            `${mode} view, ${device} frame: rail scrolled ${moved}px, expected about ${expected}px`,
          );
        }
      }

      // Cmd held is the notes gesture: the board's shield takes the press, so the page's
      // carousel stays put.
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Meta", code: "MetaLeft", modifiers: 4 });
      await sleep(150);
      assert.equal(await evaluate(`document.body.dataset.notes`), "true");
      const held = await dragRail("phone", 4);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", modifiers: 0 });
      await sleep(150);
      assert.equal(held.moved, 0, "a drag with Cmd held reached the page");
      assert.equal(await evaluate(`document.body.dataset.notes`), "false");
    } finally {
      browser?.close();
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
