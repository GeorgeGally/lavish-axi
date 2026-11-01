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

// A stand-in dev server that takes a moment to come up, the way real ones do.
const FAKE_DEV = `
import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><html><body><h1 id=title>Shop</h1></body></html>");
});
setTimeout(() => server.listen(0, "127.0.0.1", () => console.log("  Local:   http://localhost:" + server.address().port + "/")), 800);
process.on("SIGTERM", () => process.exit(0));
`;

test(
  "opening a project board starts its dev server; Stop in Settings holds across a reload until Start",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-project-e2e-")));
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    const repo = path.join(temp, "shop");
    await mkdir(path.join(repo, ".git", "info"), { recursive: true });
    await writeFile(path.join(repo, ".git", "info", "exclude"), "");
    await writeFile(path.join(repo, "fake-dev.mjs"), FAKE_DEV);
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { dev: "node fake-dev.mjs" } }));
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
      const opened = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ path: repo }),
      }).then((response) => response.json());
      assert.ok(opened.url, JSON.stringify(opened));
      browser = await launchChrome(/** @type {string} */ (findChrome()), profile);
      const { send, evaluate } = browser;
      await send("Page.enable");
      const until = async (expression, label, tries = 150) => {
        for (let i = 0; i < tries; i++) {
          if (await evaluate(expression).catch(() => false)) return;
          await sleep(100);
        }
        throw new Error(`timed out: ${label}`);
      };
      const devState = `document.getElementById("devStatus").dataset.state`;
      await send("Page.navigate", { url: opened.url });
      await until(`document.readyState === "complete" && !!document.getElementById("devStatus")`, "board loaded");
      // Nobody pressed Start: opening the board is enough, and the top bar says nothing of it.
      await until(`${devState} === "running"`, "dev server running on open");
      assert.equal(await evaluate(`!!document.getElementById("devState")`), false);

      // Add page is one small control that opens a path field; Escape puts it back.
      await evaluate(`document.getElementById("addPageToggle").click()`);
      assert.equal(await evaluate(`document.getElementById("addPageForm").hidden`), false);
      assert.equal(await evaluate(`document.activeElement.id`), "addPageInput");
      await evaluate(
        `document.getElementById("addPageInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
      );
      assert.equal(await evaluate(`document.getElementById("addPageForm").hidden`), true);
      assert.equal(await evaluate(`document.getElementById("addPageToggle").hidden`), false);
      await evaluate(`document.getElementById("addPageToggle").click()`);
      await evaluate(`(() => {
        document.getElementById("addPageInput").value = "/store";
        document.getElementById("addPageForm").requestSubmit();
      })()`);
      await until(`document.getElementById("addPageForm").hidden`, "field closes after adding");
      const board = await fetch(`${base}/api/boards/${opened.key}`).then((response) => response.json());
      assert.ok(JSON.stringify(board).includes('"page":"/store"'), "the page joined the board");

      // Stop lives in Settings.
      await evaluate(`document.getElementById("settingsToggle").click()`);
      await until(`!document.getElementById("settings").hidden`, "settings open");
      assert.equal(await evaluate(`document.getElementById("devStop").hidden`), false);
      assert.equal(await evaluate(`document.getElementById("devRestart").hidden`), false);
      assert.equal(await evaluate(`document.getElementById("devCommand").value`), "npm run dev");
      await evaluate(`document.getElementById("devStop").click()`);
      await until(`${devState} === "stopped"`, "stopped");
      assert.equal(await evaluate(`document.getElementById("devStart").hidden`), false);

      // A reload is the board opening again: a Stop the user pressed holds.
      await send("Page.navigate", { url: opened.url });
      await until(`document.readyState === "complete" && !!document.getElementById("devStatus")`, "board reloaded");
      await sleep(1200);
      assert.equal(await evaluate(devState), "stopped");

      await evaluate(`document.getElementById("settingsToggle").click()`);
      await until(`!document.getElementById("devStart").hidden`, "start offered");
      await evaluate(`document.getElementById("devStart").click()`);
      await until(`${devState} === "running"`, "running again");
      await evaluate(`document.getElementById("devStop").click()`);
      await until(`${devState} === "stopped"`, "stopped at the end");
    } finally {
      browser?.close();
      await server.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
