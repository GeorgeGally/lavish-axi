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

const runBrowserE2e = process.env.EASEL_BROWSER_E2E === "1";
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

test(
  "a plain press-and-drag inside a design scrolls the page's own carousel in every device view, and notes on keep it for the board",
  { skip: !runBrowserE2e || !findChrome(), timeout: 240_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "easel-frame-drag-e2e-"));
    const port = await freePort();
    const easelEnv = {
      EASEL_PORT: String(port),
      EASEL_STATE_DIR: path.join(temp, "state"),
      EASEL_NO_OPEN: "1",
      EASEL_TELEMETRY: "0",
      EASEL_HOST: "127.0.0.1",
      EASEL_LINK_HOST: "127.0.0.1",
    };
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    /** @type {Awaited<ReturnType<typeof launchChrome>> | null} */
    let browser = null;
    try {
      const board = path.join(temp, "board");
      await mkdir(board, { recursive: true });
      await writeFile(path.join(board, "01-carousel.html"), ITEM_HTML);
      const output = run(process.execPath, ["bin/easel.js", "board", "open", board, "--no-open"], easelEnv);
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

      // A Cmd tap turns notes on: the board's shield takes the press, so the page's
      // carousel stays put, and the next tap turns notes off again.
      const tapMeta = async () => {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Meta", code: "MetaLeft", modifiers: 4 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", modifiers: 0 });
        await sleep(150);
      };
      await tapMeta();
      assert.equal(await evaluate(`document.body.dataset.notes`), "true");
      const armed = await dragRail("phone");
      assert.equal(armed.moved, 0, "a drag with notes on reached the page");
      assert.equal(await evaluate(`document.body.dataset.notes`), "true");
      await tapMeta();
      assert.equal(await evaluate(`document.body.dataset.notes`), "false");
    } finally {
      browser?.close();
      run(process.execPath, ["bin/easel.js", "stop", "--port", String(port)], easelEnv, 15_000);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
