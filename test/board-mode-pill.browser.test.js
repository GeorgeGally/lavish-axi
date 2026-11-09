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

const runBrowserE2e = process.env.LIESEL_BROWSER_E2E === "1";
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

const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>pill</title><style>
body { margin: 0; font: 16px sans-serif; }
#title { margin: 0; padding: 40px; font-size: 48px; }
#press { margin: 40px; width: 300px; height: 60px; font-size: 20px; }
</style></head>
<body><h1 id="title">Hold</h1><button id="press" type="button" data-count="0">Pressed 0</button>
<script>
const press = document.getElementById("press");
press.addEventListener("click", () => {
  press.dataset.count = String(Number(press.dataset.count) + 1);
  press.textContent = "Pressed " + press.dataset.count;
});
</script></body></html>
`;

// The mode pill under the top bar is also a switch: clicking a word turns that mode on.
test(
  "clicking a word in the mode pill switches to that mode",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "liesel-pill-e2e-"));
    const port = await freePort();
    const lieselEnv = {
      LIESEL_PORT: String(port),
      LIESEL_STATE_DIR: path.join(temp, "state"),
      LIESEL_NO_OPEN: "1",
      LIESEL_TELEMETRY: "0",
      LIESEL_HOST: "127.0.0.1",
      LIESEL_LINK_HOST: "127.0.0.1",
    };
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    /** @type {Awaited<ReturnType<typeof launchChrome>> | null} */
    let browser = null;
    try {
      const board = path.join(temp, "board");
      await mkdir(board, { recursive: true });
      await writeFile(path.join(board, "01-pill.html"), ITEM_HTML);
      const output = run(process.execPath, ["bin/liesel.js", "board", "open", board, "--no-open"], lieselEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      browser = await launchChrome(findChrome(), profile);
      const { send, evaluate } = browser;
      /** @param {string} type @param {number} x @param {number} y @param {Record<string, unknown>} [extra] */
      const mouse = (type, x, y, extra = {}) =>
        send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
      /** @param {string} word */
      const clickWord = async (word) => {
        const at = await evaluate(
          `(() => { const b = [...document.querySelectorAll("#modeState button")].find((b) => b.textContent === ${JSON.stringify(word)}); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
        await mouse("mouseMoved", at.x, at.y, { button: "none", clickCount: 0 });
        await mouse("mousePressed", at.x, at.y, { buttons: 1 });
        await mouse("mouseReleased", at.x, at.y, { buttons: 0 });
        await sleep(300);
      };
      const state = () =>
        evaluate(`(() => {
        const badge = document.getElementById("modeState");
        return (badge.dataset.mode || "view") + ":" + badge.querySelector("[aria-pressed=true]").textContent;
      })()`);

      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(2500);
      assert.equal(await state(), "view:View");
      await clickWord("Discuss");
      assert.equal(await state(), "annotate:Discuss");
      await clickWord("Edit");
      assert.equal(await state(), "tune:Edit");
      await clickWord("View");
      assert.equal(await state(), "view:View");
    } finally {
      browser?.close();
      run(process.execPath, ["bin/liesel.js", "stop", "--port", String(port)], lieselEnv, 15_000);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
