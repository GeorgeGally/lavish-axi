import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import { findChrome } from "../src/board-crop.js";
import { inlineBoardSource } from "../src/server.js";
import { launchChrome } from "./board-cdp-browser.js";

const runBrowserE2e = process.env.LIESEL_BROWSER_E2E === "1";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(projectRoot, "test/fixtures/react-source.browser.jsx");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The 1-based line of the first fixture line containing `text`. @param {string} source @param {string} text */
const lineOf = (source, text) => source.split("\n").findIndex((line) => line.includes(text)) + 1;

test(
  "a live React dev page names the component and source line of a picked element, in the note, the tune target and the edit tag",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-source-e2e-")));
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    // A development build, as a dev server serves it: JSX carries its source location.
    const bundle = await esbuild.build({
      entryPoints: [fixture],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      jsxDev: true,
      define: { "process.env.NODE_ENV": '"development"' },
      absWorkingDir: projectRoot,
    });
    const app = bundle.outputFiles[0].text;
    const sdk = inlineBoardSource(await readFile(path.join(projectRoot, "src/board-sdk.js"), "utf8"));
    const pages = {
      "/app.js": ["application/javascript", app],
      "/board-sdk.js": ["application/javascript", sdk],
      "/page.html": [
        "text/html",
        '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script><script src="/board-sdk.js?live=1"></script></body></html>',
      ],
      // Stands in for the board: frames the live page under the name the SDK expects
      // and keeps every message it reports.
      "/board.html": [
        "text/html",
        `<!doctype html><html><body><iframe name="liesel:home:desktop" src="/page.html" style="width:1200px;height:800px;border:0"></iframe>
<script>window.reports = []; addEventListener("message", (event) => { if (event.data && event.data.channel === "liesel") reports.push(event.data); });</script></body></html>`,
      ],
    };
    const server = createServer((req, res) => {
      const page = pages[String(req.url || "").split("?")[0]];
      if (!page) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": `${page[0]}; charset=utf-8` }).end(page[1]);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
    /** @type {Awaited<ReturnType<typeof launchChrome>> | null} */
    let browser = null;
    try {
      browser = await launchChrome(/** @type {string} */ (findChrome()), profile);
      await browser.send("Page.navigate", { url: `${base}/board.html` });
      const until = async (expression, what) => {
        for (let i = 0; i < 100; i++) {
          const value = await browser?.evaluate(expression);
          if (value) return value;
          await sleep(100);
        }
        throw new Error(`timed out waiting for ${what}`);
      };
      await until(
        `reports.some((r) => r.type === "ready") && !!frames[0].document.querySelector("button.cta")`,
        "ready",
      );
      /** Ask the page what is at the centre of `selector`, as the board does, and return the reply. */
      const pick = (selector, type) =>
        until(
          `(() => {
            window.asked = window.asked || {};
            if (!window.asked[${JSON.stringify(type)}]) {
              window.asked[${JSON.stringify(type)}] = true;
              const rect = frames[0].document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
              const message = { channel: "liesel", type: ${JSON.stringify(type === "select" ? "hit" : "tune-target")}, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
              frames[0].postMessage(message, "*");
            }
            return reports.find((r) => r.type === ${JSON.stringify(type)}) || null;
          })()`,
          type,
        );
      const source = await readFile(fixture, "utf8");
      const relative = path.relative(projectRoot, fixture);

      const note = await pick("button.cta", "select");
      assert.equal(note.source.framework, "react");
      assert.equal(note.source.component, "Button");
      assert.ok(note.source.file.endsWith(relative), note.source.file);
      assert.equal(note.source.line, lineOf(source, "<button"));
      assert.equal(note.source.owners[0].component, "Hero");
      assert.equal(note.source.owners[0].line, lineOf(source, "<Button>"));

      const tune = await pick("h1", "tune-target");
      assert.equal(tune.source.component, "Hero");
      assert.equal(tune.source.line, lineOf(source, "<h1>"));

      // The edit tag in the design names the component and line too.
      await browser.evaluate(
        `frames[0].postMessage({ channel: "liesel", type: "edit-label", selector: "h1", property: "color" }, "*")`,
      );
      const tag = await until(`frames[0].document.getElementById("liesel-edit-tag")?.textContent || ""`, "edit tag");
      assert.match(
        tag,
        new RegExp(`^h1 · Hero · .*${path.basename(fixture).replace(/\./g, "\\.")}:${lineOf(source, "<h1>")} · color$`),
      );
    } finally {
      browser?.close();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await rm(temp, { recursive: true, force: true });
    }
  },
);
