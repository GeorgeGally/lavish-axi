import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findChrome } from "../src/board-crop.js";
import { serve } from "../src/server.js";
import { launchChrome } from "./board-cdp-browser.js";

const runBrowserE2e = process.env.LIESEL_BROWSER_E2E === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>long</title><style>
body { margin: 0; font: 16px sans-serif; } section { height: 600px; padding: 40px; border-bottom: 1px solid #ddd; }
</style></head><body><section id="one">One</section><section>Two</section><section>Three</section></body></html>
`;

const SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "iPad", width: 820, height: 1180 },
];

// On a phone or tablet one finger drags the board wherever it lands, a design's page
// included, and glides on when let go; two fingers pinch to zoom around their midpoint;
// a tap that never moved still drops a note.
for (const size of SIZES) {
  test(
    `Touch drags, glides and pinches the board on a ${size.name} without the frames taking the touch`,
    { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
    async () => {
      const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-touch-e2e-")));
      const profile = path.join(temp, "chrome");
      await mkdir(profile, { recursive: true });
      const boardDir = path.join(temp, "board");
      await mkdir(boardDir, { recursive: true });
      await writeFile(path.join(boardDir, "01-long.html"), ITEM_HTML);
      await mkdir(path.join(temp, "state"), { recursive: true });
      const server = await serve({
        port: 0,
        stateFile: path.join(temp, "state", "state.json"),
        version: "9.9.9-test",
        detectTailscale: async () => null,
        idleTimeoutMs: null,
        hosts: ["127.0.0.1"],
        linkHost: "127.0.0.1",
        env: { ...process.env, LIESEL_NOTIFY_CMD: "" },
        log: () => {},
      });
      const base = `http://127.0.0.1:${server.port}`;
      /** @type {Awaited<ReturnType<typeof launchChrome>> | null} */
      let browser = null;
      try {
        const opened = await fetch(`${base}/api/boards`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dir: boardDir }),
        }).then((response) => response.json());
        const chrome = findChrome();
        assert.ok(chrome);
        browser = await launchChrome(chrome, profile);
        const { send, evaluate, list } = browser;
        await send("Page.enable");
        await send("Emulation.setDeviceMetricsOverride", {
          width: size.width,
          height: size.height,
          deviceScaleFactor: 2,
          mobile: true,
        });
        await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        await send("Page.navigate", { url: opened.url });
        /** @param {string} expression @param {string} label @param {string} [session] */
        const until = async (expression, label, session) => {
          for (let i = 0; i < 150; i++) {
            if (await evaluate(expression, session).catch(() => false)) return;
            await sleep(100);
          }
          throw new Error(`timed out: ${label}`);
        };
        await until(`document.readyState === "complete" && !!document.querySelector(".artboard iframe")`, "board");
        await sleep(1500);
        assert.equal(await evaluate(`matchMedia("(hover: none) and (pointer: coarse)").matches`), true);

        // The sidebar starts open and on a phone it covers the board: hide it.
        await evaluate(
          `(() => { const t = document.getElementById("chatToggle"); if (t?.getAttribute("aria-expanded") === "true") t.click(); })()`,
        );
        await sleep(500);
        // Start on one design, big enough to land a finger on.
        await evaluate(
          `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Phone")?.click()`,
        );
        await sleep(800);
        const camera = () =>
          evaluate(
            `(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector(".canvas")).transform); return { x: m.e, y: m.f, zoom: m.a }; })()`,
          );
        // A point a finger lands on the design itself, not on the panel over the board.
        const shieldPoint = (fraction = 0.5) =>
          evaluate(`(() => {
            for (const s of document.querySelectorAll(".shield")) {
              const r = s.getBoundingClientRect();
              for (let y = r.top + 20; y < Math.min(r.bottom, innerHeight) - 20; y += 20)
                for (let x = r.left + r.width * ${fraction}; x < r.right - 4; x += 20)
                  if (document.elementFromPoint(x, y) === s && y > 300) return { x, y };
            }
            return null;
          })()`);
        const shield = await shieldPoint();
        assert.ok(shield, "a design under the finger");
        assert.equal(
          await evaluate(`getComputedStyle(document.querySelector(".shield")).pointerEvents`),
          "auto",
          "the shield is up over the frames on touch",
        );
        /** @param {"touchStart" | "touchMove" | "touchEnd"} type @param {{ x: number, y: number }[]} points */
        const touch = (type, points) =>
          send("Input.dispatchTouchEvent", {
            type,
            touchPoints: points.map((point, id) => ({ x: point.x, y: point.y, id, radiusX: 4, radiusY: 4, force: 1 })),
          });

        // One finger over the design drags the board up, and it glides on after.
        console.log(
          await evaluate(
            `(() => { const e = document.elementFromPoint(${shield.x}, ${shield.y}); return e.className + " / " + e.closest("[class]")?.parentElement?.className; })()`,
          ),
        );
        const before = await camera();
        await touch("touchStart", [shield]);
        for (let step = 1; step <= 10; step++) {
          await touch("touchMove", [{ x: shield.x, y: shield.y - step * 25 }]);
          await sleep(16);
        }
        await touch("touchEnd", []);
        const released = await camera();
        await sleep(1200);
        const after = await camera();
        assert.ok(released.y <= before.y - 240, `the drag moved the board: ${before.y} -> ${released.y}`);
        assert.ok(after.y < released.y - 20, `the board glided on: ${released.y} -> ${after.y}`);
        assert.equal(after.zoom, before.zoom);
        const target = (await list()).find((entry) => entry.type === "iframe" && entry.url.includes("device=phone"));
        assert.ok(target, "no phone frame");
        const { sessionId: design } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
        assert.equal(await evaluate("scrollY", design), 0, "the page inside did not take the drag");

        // Two fingers pinch out: the board zooms in around their midpoint.
        const mid = { x: size.width / 2, y: size.height / 2 };
        // The camera is in the plane's own coordinates, under the top bar.
        const top = await evaluate(`document.querySelector(".plane").getBoundingClientRect().top`);
        const pinchStart = await camera();
        const world = {
          x: (mid.x - pinchStart.x) / pinchStart.zoom,
          y: (mid.y - top - pinchStart.y) / pinchStart.zoom,
        };
        await touch("touchStart", [
          { x: mid.x - 30, y: mid.y },
          { x: mid.x + 30, y: mid.y },
        ]);
        for (let step = 1; step <= 10; step++) {
          await touch("touchMove", [
            { x: mid.x - 30 - step * 6, y: mid.y },
            { x: mid.x + 30 + step * 6, y: mid.y },
          ]);
          await sleep(16);
        }
        await touch("touchEnd", []);
        await sleep(400);
        const pinched = await camera();
        assert.ok(
          Math.abs(pinched.zoom / pinchStart.zoom - 3) < 0.05,
          `zoomed 3x: ${pinchStart.zoom} -> ${pinched.zoom}`,
        );
        const back = { x: (mid.x - pinched.x) / pinched.zoom, y: (mid.y - top - pinched.y) / pinched.zoom };
        assert.ok(
          Math.abs(back.x - world.x) < 2 && Math.abs(back.y - world.y) < 2,
          `the midpoint stayed put: ${JSON.stringify({ world, back })}`,
        );

        // A tap with notes on still drops a note on the design.
        await evaluate(
          `document.querySelector("[data-fit]")?.click() ?? [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Fit")?.click()`,
        );
        await sleep(600);
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Meta", code: "MetaLeft", modifiers: 4 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", modifiers: 0 });
        await sleep(200);
        assert.equal(await evaluate(`document.body.dataset.notes`), "true");
        const spot = await shieldPoint(0.2);
        assert.ok(spot, "a design to tap");
        const settled = await camera();
        await touch("touchStart", [spot]);
        await touch("touchEnd", []);
        await until(`!!document.querySelector(".note-pop textarea")`, "note card after a tap");
        assert.deepEqual(await camera(), settled, "a tap does not move the board");

        // With the controls selector on, a tap picks the element for Controls.
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Alt", code: "AltLeft", modifiers: 1 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Alt", code: "AltLeft", modifiers: 0 });
        await sleep(200);
        assert.equal(await evaluate(`document.body.dataset.controls`), "true");
        const pick = await shieldPoint(0.2);
        assert.ok(pick, "a design to pick from");
        await touch("touchStart", [pick]);
        await touch("touchEnd", []);
        await until(`!!document.querySelector(".tune-crumb[aria-current]")`, "Controls loaded the tapped element");
      } finally {
        browser?.close();
        await server.close();
        await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
  );
}
