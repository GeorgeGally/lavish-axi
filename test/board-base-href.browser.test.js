import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findChrome } from "../src/board-crop.js";
import { serve } from "../src/server.js";
import { launchChrome } from "./board-cdp-browser.js";

const runBrowserE2e = process.env.LIESEL_BROWSER_E2E === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

// A design whose assets live on another server says so with a <base>. Every relative URL
// in the page follows it, which must not include the SDK: without the SDK in the frame,
// the board's keys die the moment a click lands in the design, and notes cannot land.
test(
  "a design with a <base> keeps the board's keys and notes after a click into it",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-base-href-e2e-")));
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    const boardDir = path.join(temp, "board");
    await mkdir(boardDir, { recursive: true });
    await writeFile(
      path.join(boardDir, "based.html"),
      `<!doctype html>
<html><head><meta charset="utf-8"><title>based</title><base href="http://127.0.0.1:${await closedPort()}/">
<style>body { margin: 0; } h1 { margin: 0; height: 600px; font: 64px sans-serif; }</style></head>
<body><h1>Lead</h1></body></html>
`,
    );
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
      const { send, evaluate } = browser;
      await send("Page.enable");
      await send("Page.navigate", { url: opened.url });
      await sleep(3000);

      const designPoint = () =>
        evaluate(`(() => {
          const frame = document.querySelector('.artboard[data-key="based::desktop"] iframe');
          const box = frame.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 4 };
        })()`);
      /** @param {{ x: number, y: number }} point */
      const click = async (point) => {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
        await sleep(500);
      };
      const zoom = () => evaluate(`document.getElementById("zoomLabel").textContent`);

      await click(await designPoint());
      assert.equal(await evaluate(`document.activeElement.tagName`), "IFRAME", "the click did not reach the design");

      // Focus is inside the design: only the SDK can hand these keys up to the board.
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "1", code: "Digit1" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "1", code: "Digit1" });
      await sleep(400);
      assert.equal(await zoom(), "100%", "1 pressed inside the design did not reach the board");

      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Meta", code: "MetaLeft", modifiers: 4 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", modifiers: 0 });
      await sleep(400);
      assert.equal(
        await evaluate(`document.body.dataset.notes`),
        "true",
        "Cmd inside the design did not turn notes on",
      );

      await click(await designPoint());
      assert.equal(
        await evaluate(`document.querySelector(".note-pop") ? "note" : "none"`),
        "note",
        "a click on the design leaves no note",
      );
    } finally {
      browser?.close();
      await server.close();
      await rm(temp, { recursive: true, force: true });
    }
  },
);
