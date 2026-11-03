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

/** @param {string} title */
const page = (title) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>
`;

// One design per tab can be chosen as the final: saved as its status in board.json,
// shown on the board, and told to the agent as an ordinary prompt for every change.
test(
  "Choose as final marks one design per tab, moves, takes back and undoes, and tells the agent each time",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-final-e2e-")));
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    const boardDir = path.join(temp, "board");
    await mkdir(boardDir, { recursive: true });
    await writeFile(path.join(boardDir, "01-calm.html"), page("Calm"));
    await writeFile(path.join(boardDir, "02-loud.html"), page("Loud"));
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
      /** @param {string} expression @param {string} label */
      const until = async (expression, label) => {
        for (let i = 0; i < 150; i++) {
          if (await evaluate(expression).catch(() => false)) return;
          await sleep(100);
        }
        throw new Error(`timed out: ${label}`);
      };
      await until(
        `[...document.querySelectorAll(".artboard-label .item-actions")].filter((a) => !a.hidden).length >= 2`,
        "design labels",
      );

      const board = async () => JSON.parse(await readFile(path.join(boardDir, "board.json"), "utf8"));
      const statuses = async () => Object.fromEntries((await board()).items.map((item) => [item.id, item.status]));
      const items = [...(await board()).items].sort((a, b) => String(a.file).localeCompare(String(b.file)));
      assert.equal(items.length, 2);
      const [calm, loud] = items.map((item) => item.id);
      const [calmLabel, loudLabel] = items.map((item) => item.label);
      /** A design's final button: the visible label rows run in file order. @param {number} index */
      const finalButton = (index) =>
        `[...document.querySelectorAll(".artboard-label .item-actions")].filter((a) => !a.hidden)[${index}].querySelector(".item-final")`;
      const CALM = 0;
      const LOUD = 1;

      // Always shown, so it is reachable on touch without a hover.
      assert.equal(await evaluate(`${finalButton(CALM)}.getAttribute("aria-label")`), "Choose as final");
      assert.equal(await evaluate(`${finalButton(CALM)}.hasAttribute("data-reveal")`), false);
      assert.equal(await evaluate(`getComputedStyle(${finalButton(CALM)}).opacity`), "1");

      const poll = async () => {
        const reply = await fetch(
          `${base}/api/poll?file=${encodeURIComponent(path.join(boardDir, "board.json"))}&timeoutMs=4000`,
        ).then((response) => response.json());
        assert.equal(reply.status, "feedback", JSON.stringify(reply));
        return reply.prompts.map((prompt) => String(prompt.prompt)).join("\n");
      };
      /** @param {Record<string, string>} expected */
      const savedAs = async (expected) => {
        for (let i = 0; i < 50; i++) {
          const now = await statuses();
          if (Object.entries(expected).every(([id, status]) => now[id] === status)) return;
          await sleep(100);
        }
        assert.deepEqual(await statuses(), expected);
      };

      // Choose one: saved, marked, the rest dimmed, and the agent told.
      await evaluate(`${finalButton(CALM)}.click()`);
      await savedAs({ [calm]: "final", [loud]: "open" });
      assert.equal(await evaluate(`${finalButton(CALM)}.textContent`), "✓ Final");
      assert.equal(await evaluate(`${finalButton(CALM)}.getAttribute("aria-pressed")`), "true");
      await until(
        `[...document.querySelectorAll(".artboard[data-final='other']")].length > 0 && [...document.querySelectorAll(".artboard[data-final='chosen']")].length > 0`,
        "chosen and dimmed",
      );
      assert.match(await poll(), new RegExp(`^Chosen as final: ${calmLabel} \\(item ${calm}, 01-calm\\.html\\)$`, "m"));

      // Choose another: the pick moves, and the agent hears which it replaced.
      await until(`${finalButton(CALM)}.getAttribute("aria-pressed") === "true"`, "calm shown as final");
      await evaluate(`${finalButton(LOUD)}.click()`);
      await savedAs({ [calm]: "open", [loud]: "final" });
      assert.match(await poll(), new RegExp(`Chosen as final: ${loudLabel} .*replacing ${calmLabel}`));

      // Take it back: no final at all.
      await until(`${finalButton(LOUD)}.getAttribute("aria-pressed") === "true"`, "loud shown as final");
      await evaluate(`${finalButton(LOUD)}.click()`);
      await savedAs({ [calm]: "open", [loud]: "open" });
      assert.equal(await evaluate(`document.querySelectorAll(".artboard[data-final]").length`), 0);
      assert.match(await poll(), new RegExp(`^No longer final: ${loudLabel}`, "m"));

      // Undo brings the pick back.
      await evaluate(`document.querySelector("#dropToast .drop-toast-undo").click()`);
      await savedAs({ [calm]: "open", [loud]: "final" });
      assert.match(await poll(), new RegExp(`Chosen as final: ${loudLabel}`));
    } finally {
      browser?.close();
      await server.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
