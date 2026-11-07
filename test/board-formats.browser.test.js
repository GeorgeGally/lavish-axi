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
<html><head><meta charset="utf-8"><title>lead</title></head><body><h1>Lead</h1></body></html>
`;

// Each screen format has a switch in Settings. The All view and the top-bar tabs show only
// the formats that are on, the choice is kept per board, a saved ultrawide choice still
// counts, and the last format on cannot be turned off.
test(
  "Settings turns each screen format on and off",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-formats-e2e-")));
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
      /** @param {string} expression @param {string} label */
      const until = async (expression, label) => {
        for (let i = 0; i < 150; i++) {
          if (await evaluate(expression).catch(() => false)) return;
          await sleep(100);
        }
        throw new Error(`timed out: ${label}`);
      };
      const load = async () => {
        await send("Page.navigate", { url: opened.url });
        await until(`document.querySelectorAll("#deviceBar button, [data-device]").length > 1`, "the format tabs");
        await sleep(400);
      };
      const tabs = () =>
        evaluate(
          `JSON.stringify([...document.querySelectorAll("button[data-device]")].map((b) => b.dataset.device))`,
        ).then(JSON.parse);
      const artboards = () =>
        evaluate(
          `JSON.stringify([...new Set([...document.querySelectorAll(".artboard:not([hidden])")].map((b) => b.dataset.device))].sort())`,
        ).then(JSON.parse);
      /** @param {string} id */
      const flip = (id) => evaluate(`document.querySelector('[data-format="${id}"]').click()`);
      /** @param {string} id */
      const swatch = (id) => `document.querySelector('[data-format="${id}"]')`;
      const storageKey = `liesel:formats:${opened.key}`;

      // Today's default: ultrawide off, the other three on.
      await load();
      assert.deepEqual(await tabs(), ["all", "desktop", "ipad", "phone"]);
      await until(`document.querySelectorAll(".artboard:not([hidden])").length === 3`, "three artboards");
      assert.deepEqual(await artboards(), ["desktop", "ipad", "phone"]);
      assert.equal(await evaluate(`${swatch("ultrawide")}.checked`), false);
      assert.equal(await evaluate(`${swatch("phone")}.checked`), true);

      // Turning one off takes it out of the tabs and All; it stays off after a reload.
      await flip("phone");
      await until(`document.querySelectorAll(".artboard:not([hidden])").length === 2`, "two artboards");
      assert.deepEqual(await tabs(), ["all", "desktop", "ipad"]);
      await flip("ultrawide");
      await until(`document.querySelectorAll(".artboard:not([hidden])").length === 3`, "ultrawide joins All");
      assert.deepEqual(await artboards(), ["desktop", "ipad", "ultrawide"]);
      await flip("ultrawide");
      await load();
      assert.deepEqual(await tabs(), ["all", "desktop", "ipad"]);
      assert.equal(await evaluate(`${swatch("phone")}.checked`), false);

      // Turning off the format on screen goes back to All.
      await evaluate(`document.querySelector('button[data-device="ipad"]').click()`);
      await until(
        `document.querySelector('button[data-device="ipad"]').getAttribute("aria-pressed") === "true"`,
        "iPad view",
      );
      await flip("ipad");
      await until(
        `document.querySelector('button[data-device="all"]').getAttribute("aria-pressed") === "true"`,
        "back to All",
      );
      assert.deepEqual(await tabs(), ["all", "desktop"]);

      // The last format on cannot be turned off.
      assert.equal(await evaluate(`${swatch("desktop")}.disabled`), true);
      await flip("desktop");
      assert.equal(await evaluate(`${swatch("desktop")}.checked`), true);
      assert.deepEqual(await artboards(), ["desktop"]);
      await flip("phone");
      assert.equal(await evaluate(`${swatch("desktop")}.disabled`), false);

      // A board that saved Show ultrawide before these switches existed keeps it on.
      await evaluate(`localStorage.removeItem(${JSON.stringify(storageKey)})`);
      await evaluate(`localStorage.setItem("liesel:ultrawide:${opened.key}", "on")`);
      await load();
      assert.deepEqual(await tabs(), ["all", "ultrawide", "desktop", "ipad", "phone"]);
      assert.equal(await evaluate(`${swatch("ultrawide")}.checked`), true);

      // A view saved on a format that is now off opens on All.
      await evaluate(`localStorage.setItem(${JSON.stringify(storageKey)}, '["desktop"]')`);
      await evaluate(`localStorage.setItem("liesel:device:${opened.key}", "phone")`);
      await load();
      assert.equal(
        await evaluate(`document.querySelector('button[data-device="all"]').getAttribute("aria-pressed")`),
        "true",
      );
    } finally {
      browser?.close();
      await server.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
