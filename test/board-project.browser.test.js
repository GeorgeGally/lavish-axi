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

// A stand-in dev server that takes a moment to come up, the way real ones do. Its home
// page links to the site's other pages, which is how the picker finds them.
const FAKE_DEV = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_DEV_MARKER, String(process.pid));
const server = createServer((req, res) => {
  const page = req.url.split("?")[0];
  res.writeHead(200, { "content-type": "text/html" });
  res.end('<!doctype html><html><body><h1 id=title>Shop ' + page + '</h1><nav><a href="/store">Store</a> <a href="/about">About</a> <a href="/blog/hello">Hello</a></nav></body></html>');
});
setTimeout(() => server.listen(0, "127.0.0.1", () => console.log("  Local:   http://localhost:" + server.address().port + "/")), 800);
process.on("SIGTERM", () => process.exit(0));
`;

test(
  "opening a project asks which pages to show; the picker adds and removes pages; the server recovers by itself; the board renames in place",
  { skip: !runBrowserE2e || !findChrome(), timeout: 180_000 },
  async () => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-project-e2e-")));
    const shots = process.env.LIESEL_E2E_SHOTS || "";
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    const repo = path.join(temp, "shop");
    const marker = path.join(temp, "dev-pid");
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
      env: { ...process.env, LIESEL_NOTIFY_CMD: "", FAKE_DEV_MARKER: marker },
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
      assert.equal(opened.created, true);
      browser = await launchChrome(/** @type {string} */ (findChrome()), profile);
      const { send, evaluate } = browser;
      await send("Page.enable");
      const until = async (expression, label, tries = 200) => {
        for (let i = 0; i < tries; i++) {
          if (await evaluate(expression).catch(() => false)) return;
          await sleep(100);
        }
        throw new Error(`timed out: ${label}`);
      };
      const shot = async (name) => {
        if (!shots) return;
        await sleep(400);
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        await mkdir(shots, { recursive: true });
        await writeFile(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
      };
      const boardPages = async () =>
        (await fetch(`${base}/api/boards/${opened.key}`).then((response) => response.json())).items
          .map((item) => item.page)
          .filter(Boolean)
          .sort();
      const row = (page) => `document.querySelector('#pagesRows .pages-row[data-page="${page}"] input')`;
      const devState = `document.getElementById("devStatus").dataset.state`;

      // A first open lands on the page picker, home already ticked.
      await send("Page.navigate", { url: `${opened.url}#pages` });
      await until(`document.readyState === "complete" && !document.getElementById("pagesPicker").hidden`, "picker");
      await until(`!!${row("/store")}`, "the running site's links are offered");
      assert.equal(await evaluate(`${row("/")}.checked`), true);
      assert.equal(await evaluate(`${row("/store")}.checked`), false);
      assert.equal(await evaluate(`document.getElementById("pagesApply").textContent`), "Show 1 page");
      await until(`document.querySelectorAll("#pagesRows .pages-preview.loaded").length >= 2`, "previews load");
      await shot("picker-on-open");

      // Pick some pages.
      await evaluate(`${row("/store")}.click()`);
      await evaluate(`${row("/about")}.click()`);
      assert.equal(await evaluate(`document.getElementById("pagesApply").textContent`), "Show 3 pages");
      assert.equal(await evaluate(`document.getElementById("pagesAll").indeterminate`), true);
      await evaluate(`document.getElementById("pagesApply").click()`);
      await until(`document.getElementById("pagesPicker").hidden`, "picker closes");
      assert.equal(await evaluate(`location.hash`), "");
      assert.deepEqual(await boardPages(), ["/", "/about", "/store"]);
      await until(`document.querySelectorAll(".artboard").length >= 3`, "frames for the pages");
      await shot("board-some-pages");

      // All pages.
      await evaluate(`document.getElementById("pagesToggle").click()`);
      await until(`!document.getElementById("pagesPicker").hidden && !!${row("/blog/hello")}`, "picker again");
      await evaluate(`document.getElementById("pagesAll").click()`);
      assert.equal(await evaluate(`document.getElementById("pagesApply").textContent`), "Show 4 pages");
      await evaluate(`document.getElementById("pagesApply").click()`);
      await until(`document.getElementById("pagesPicker").hidden`, "picker closes after all");
      assert.deepEqual(await boardPages(), ["/", "/about", "/blog/hello", "/store"]);

      // Later: add a page by its path and take one away, with Undo.
      await evaluate(`document.getElementById("pagesToggle").click()`);
      await until(`!!${row("/about")}`, "picker for a change");
      await evaluate(`${row("/about")}.click()`);
      await evaluate(`(() => {
        document.getElementById("pagesAddInput").value = "contact";
        document.getElementById("pagesAddForm").requestSubmit();
      })()`);
      assert.equal(await evaluate(`${row("/contact")}.checked`), true, "a typed page joins the list, ticked");
      await shot("picker-add-later");
      // Escape on the picker goes back to the board without changing anything.
      await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await until(`document.getElementById("pagesPicker").hidden`, "Escape closes");
      assert.deepEqual(await boardPages(), ["/", "/about", "/blog/hello", "/store"]);
      await evaluate(`document.getElementById("pagesToggle").click()`);
      await until(`!!${row("/about")}`, "picker once more");
      await evaluate(`${row("/about")}.click()`);
      await evaluate(`(() => {
        document.getElementById("pagesAddInput").value = "/contact";
        document.getElementById("pagesAddForm").requestSubmit();
      })()`);
      await evaluate(`document.getElementById("pagesApply").click()`);
      await until(`document.getElementById("pagesPicker").hidden`, "applied");
      assert.deepEqual(await boardPages(), ["/", "/blog/hello", "/contact", "/store"]);
      await until(`!!document.querySelector("#dropToast .drop-toast-undo")`, "Undo offered");
      await evaluate(`document.querySelector("#dropToast .drop-toast-undo").click()`);
      for (let i = 0; i < 50 && !(await boardPages()).includes("/about"); i++) await sleep(100);
      assert.deepEqual(await boardPages(), ["/", "/about", "/blog/hello", "/contact", "/store"]);

      // The server's controls wait under Advanced, folded.
      await evaluate(`document.getElementById("settingsToggle").click()`);
      await until(`!document.getElementById("settings").hidden`, "settings open");
      assert.equal(await evaluate(`document.getElementById("devAdvanced").open`), false);
      await until(`${devState} === "running"`, "server running");
      await evaluate(`document.getElementById("devAdvanced").open = true`);
      await shot("settings-advanced");
      await evaluate(`document.getElementById("settingsClose").click()`);

      // Kill the server: it comes back by itself, and the frames with it.
      const firstPid = Number(await readFile(marker, "utf8"));
      process.kill(firstPid, "SIGKILL");
      let pid = firstPid;
      for (let i = 0; i < 100 && pid === firstPid; i++) {
        await sleep(100);
        pid = Number(await readFile(marker, "utf8").catch(() => "0")) || firstPid;
      }
      assert.notEqual(pid, firstPid, "a new server started");
      await until(`${devState} === "running"`, "running again");
      await shot("recovered");

      // Rename the board by clicking its name; Escape keeps the old one.
      await evaluate(`document.getElementById("boardName").click()`);
      await until(`!!document.getElementById("boardNameInput")`, "name field");
      await evaluate(`(() => {
        const input = document.getElementById("boardNameInput");
        input.value = "Nope";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      })()`);
      assert.equal(await evaluate(`document.getElementById("boardName").textContent`), "shop");
      await evaluate(`document.getElementById("boardName").click()`);
      await evaluate(`(() => {
        const input = document.getElementById("boardNameInput");
        input.value = "Shop redesign";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      })()`);
      await until(`document.title === "Shop redesign · Liesel"`, "tab title follows");
      assert.equal(await evaluate(`document.getElementById("settingsBoardName").textContent`), "Shop redesign");
      await shot("renamed");
      for (let i = 0; i < 50; i++) {
        const board = await fetch(`${base}/api/boards/${opened.key}`).then((response) => response.json());
        if (board.name === "Shop redesign") break;
        await sleep(100);
      }
      await send("Page.navigate", { url: `${base}/` });
      await until(`document.readyState === "complete"`, "home");
      assert.match(await evaluate(`document.body.innerText`), /Shop redesign/);
      await send("Page.navigate", { url: opened.url });
      await until(`document.readyState === "complete" && !!document.getElementById("boardName")`, "board again");
      assert.equal(await evaluate(`document.getElementById("boardName").textContent`), "Shop redesign");
      assert.equal(await evaluate(`location.pathname`), new URL(opened.url).pathname, "the address stays");
    } finally {
      browser?.close();
      await server.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
