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
<html><head><meta charset="utf-8"><title>lead</title><style>
body { margin: 0; font-family: Georgia, serif; }
#head { margin: 10px; padding: 10px; font-size: 40px; font-weight: 400; }
</style></head><body><h1 id="head">Lead</h1></body></html>
`;

// Everything here is driven by trusted input: a scripted click or a synthetic change
// passes where a real pointer does not.
test(
  "a select previews each option live, and Each side gives every padding and margin side a control",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-control-preview-e2e-")));
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    const boardDir = path.join(temp, "board");
    await mkdir(boardDir, { recursive: true });
    await writeFile(path.join(boardDir, "01-lead.html"), ITEM_HTML);
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
      await send("Page.navigate", { url: opened.url });
      await sleep(2500);

      const target = (await list()).find((entry) => entry.type === "iframe" && entry.url.includes("device=desktop"));
      assert.ok(target, "no desktop frame");
      const { sessionId: frame } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
      /** @param {string} css */
      const cssOf = (css) =>
        evaluate(`getComputedStyle(document.querySelector("#head"))[${JSON.stringify(css)}]`, frame);

      /** @param {number} x @param {number} y */
      const move = async (x, y) => {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await sleep(200);
      };
      /** @param {number} x @param {number} y */
      const click = async (x, y) => {
        await move(x, y);
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        await sleep(500);
      };
      /** @param {string} key */
      const press = async (key) => {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
        await sleep(250);
      };
      const tapAlt = async () => {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Alt", code: "AltLeft", modifiers: 1 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Alt", code: "AltLeft", modifiers: 0 });
        await sleep(200);
      };
      /** @param {string} expression */
      const centre = async (expression) => {
        const point = await evaluate(
          `(() => { const n = ${expression}; n.scrollIntoView({ block: "center" }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
        assert.ok(point, expression);
        return point;
      };
      /** @param {string} label */
      const control = (label) =>
        `[...document.querySelectorAll("#tuneBody .tune-control")].find((c) => c.querySelector(".tune-control-label span")?.textContent === ${JSON.stringify(label)})`;
      /** @param {string} text */
      const option = (text) =>
        `[...document.querySelectorAll(".tune-option")].find((o) => o.textContent === ${JSON.stringify(text)})`;
      /** @param {string} label */
      const sideLabels = (label) =>
        evaluate(
          `[...${control(label)}.querySelectorAll(".tune-side .tune-control-label span:first-child")].map((s) => s.textContent)`,
        );

      const point = await evaluate(
        `(() => { const f = [...document.querySelectorAll(".artboard iframe")].find((f) => f.src.includes("device=desktop")); const r = f.getBoundingClientRect(); const s = r.width / f.offsetWidth; return { x: r.left + 60 * s, y: r.top + 50 * s }; })()`,
      );
      await move(point.x, point.y);
      await tapAlt();
      await click(point.x, point.y);
      await tapAlt();
      await sleep(500);
      assert.ok(await evaluate(`Boolean(${control("Weight")})`), "the heading is picked");

      // Browsing the list shows each option in the design before anything is chosen.
      const weight = await centre(`${control("Weight")}.querySelector("select")`);
      await click(weight.x, weight.y);
      const hovered = await centre(option("800"));
      await move(hovered.x, hovered.y);
      assert.equal(await cssOf("fontWeight"), "800", "hovering previews");
      await press("ArrowDown");
      assert.equal(await cssOf("fontWeight"), "900", "the arrow keys preview");

      // Escape puts it back, as though the list had never been opened.
      await press("Escape");
      assert.equal(await cssOf("fontWeight"), "400", "Escape takes the preview off");
      assert.equal(await evaluate(`document.querySelectorAll(".tune-option").length`), 0);

      // Clicking an option keeps it.
      await click(weight.x, weight.y);
      const chosen = await centre(option("700"));
      await click(chosen.x, chosen.y);
      assert.equal(await cssOf("fontWeight"), "700");
      assert.equal(await evaluate(`${control("Weight")}.querySelector("select").value`), "700");

      // Padding and Margin: a real click on Each side opens four controls of their own.
      for (const [label, css] of [
        ["Padding", "paddingTop"],
        ["Margin", "marginTop"],
      ]) {
        const link = await centre(`${control(label)}.querySelector(".tune-link")`);
        await click(link.x, link.y);
        const each = await centre(
          `[...${control(label)}.querySelectorAll(".tune-side-mode")].find((m) => m.textContent === "Each side")`,
        );
        await click(each.x, each.y);
        assert.deepEqual(await sideLabels(label), ["Top", "Right", "Bottom", "Left"], label);
        const box = await evaluate(
          `(() => { const c = [...${control(label)}.querySelectorAll(".tune-side")].find((s) => s.textContent.startsWith("Top")); const i = c.querySelector("input"); i.scrollIntoView({ block: "center" }); const r = i.getBoundingClientRect(); return { left: r.left, width: r.width, y: r.top + r.height / 2 }; })()`,
        );
        await click(box.left + box.width * 0.75, box.y);
        await sleep(300);
        assert.notEqual(await cssOf(css), "10px", `${label} top moved`);
        assert.equal(await cssOf(css.replace("Top", "Bottom")), "10px", `${label} bottom kept`);
      }
    } finally {
      browser?.close();
      await server.close();
      await rm(temp, { recursive: true, force: true });
    }
  },
);
