import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findChrome } from "../src/board-crop.js";
import { serve } from "../src/server.js";
import { launchChrome } from "./board-cdp-browser.js";

const runBrowserE2e = process.env.LIESEL_BROWSER_E2E === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>lead</title></head><body><h1>Lead</h1></body></html>
`;

// A design's name on the board renames it in place: click (or tap) the name, type,
// Enter or a click away saves the label in board.json, Escape keeps the old one, and
// the file is never renamed or touched.
for (const input of ["mouse", "touch"]) {
  test(
    `Clicking a design's name renames it inline (${input})`,
    { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
    async () => {
      const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-rename-e2e-")));
      const profile = path.join(temp, "chrome");
      await mkdir(profile, { recursive: true });
      const boardDir = path.join(temp, "board");
      await mkdir(boardDir, { recursive: true });
      await writeFile(path.join(boardDir, "spotlight-lead.html"), ITEM_HTML);
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
        if (input === "touch") {
          await send("Emulation.setDeviceMetricsOverride", {
            width: 820,
            height: 1180,
            deviceScaleFactor: 2,
            mobile: true,
          });
          await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        }
        await send("Page.navigate", { url: opened.url });
        /** @param {string} expression @param {string} label */
        const until = async (expression, label) => {
          for (let i = 0; i < 150; i++) {
            if (await evaluate(expression).catch(() => false)) return;
            await sleep(100);
          }
          throw new Error(`timed out: ${label}`);
        };
        const heading = `document.querySelector(".explain-title[data-rename]")`;
        await until(`!!${heading}`, "a renamable heading");
        await sleep(800);
        const label = async () => JSON.parse(await readFile(path.join(boardDir, "board.json"), "utf8")).items[0].label;
        const original = await label();
        assert.equal(await evaluate(`${heading}.textContent`), original);

        /** Click or tap the middle of what an expression names. @param {string} expression */
        const press = async (expression) => {
          const at = await evaluate(
            `(() => { const r = ${expression}.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 }; })()`,
          );
          if (input === "touch") {
            await send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [{ x: at.x, y: at.y, id: 0, radiusX: 4, radiusY: 4, force: 1 }],
            });
            await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } else {
            await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
            await send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: at.x,
              y: at.y,
              button: "left",
              clickCount: 1,
            });
            await send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: at.x,
              y: at.y,
              button: "left",
              clickCount: 1,
            });
          }
          await sleep(300);
        };
        const field = `document.querySelector(".explain-title .rename-input")`;
        /** @param {string} key */
        const key = async (key) => {
          await send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code: key,
            windowsVirtualKeyCode: key === "Enter" ? 13 : 27,
          });
          await send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code: key,
            windowsVirtualKeyCode: key === "Enter" ? 13 : 27,
          });
          await sleep(300);
        };
        const fileBefore = await readFile(path.join(boardDir, "spotlight-lead.html"), "utf8");

        // Escape keeps the old name.
        await press(heading);
        await until(`!!${field} && document.activeElement === ${field}`, "the name field");
        await send("Input.insertText", { text: "Throwaway" });
        await key("Escape");
        await until(`!${field}`, "the field closed");
        assert.equal(await evaluate(`${heading}.textContent`), original);
        assert.equal(await label(), original);

        // Enter saves.
        await press(heading);
        await until(`!!${field}`, "the name field again");
        await send("Input.insertText", { text: "Spotlight hero" });
        await key("Enter");
        await until(`${heading}?.textContent === "Spotlight hero"`, "the new name shown");
        for (let i = 0; i < 30 && (await label()) !== "Spotlight hero"; i++) await sleep(100);
        assert.equal(await label(), "Spotlight hero");

        // A click away saves too.
        await press(heading);
        await until(`!!${field}`, "the name field a third time");
        await send("Input.insertText", { text: "Spotlight final" });
        await press(`document.querySelector(".plane")`);
        await until(`${heading}?.textContent === "Spotlight final"`, "saved on blur");
        for (let i = 0; i < 30 && (await label()) !== "Spotlight final"; i++) await sleep(100);
        assert.equal(await label(), "Spotlight final");

        // The file keeps its name and its bytes.
        assert.equal(await readFile(path.join(boardDir, "spotlight-lead.html"), "utf8"), fileBefore);
        const board = JSON.parse(await readFile(path.join(boardDir, "board.json"), "utf8"));
        assert.equal(board.items[0].file, "spotlight-lead.html");
      } finally {
        browser?.close();
        await server.close();
        await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
  );
}
