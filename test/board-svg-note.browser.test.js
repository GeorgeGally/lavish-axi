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

// A logo lockup as the agent writes one: an inline SVG inside a card, whose shapes are
// what a click lands on. The camelCase clipPath is there because SVG names are
// case-sensitive in a selector.
const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>logo</title><style>
body { margin: 0; font: 16px sans-serif; }
.card { margin: 40px; padding: 80px; background: #f4f4f2; border-radius: 16px; }
svg { display: block; width: 600px; height: 200px; }
</style></head><body>
<div class="card"><svg viewBox="0 0 600 200" aria-label="Logo">
<defs><clipPath id="cut"><rect width="600" height="200"/></clipPath></defs>
<g clip-path="url(#cut)"><rect width="600" height="200" fill="#fff"/><g><path d="M40 40h520v120H40z" fill="#111"/></g></g>
</svg></div>
</body></html>
`;

test(
  "a click in notes mode on a shape inside an inline SVG opens a note whose selector finds that shape",
  { skip: !runBrowserE2e || !findChrome(), timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "liesel-svg-note-e2e-"));
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
      await writeFile(path.join(board, "logo.html"), ITEM_HTML);
      const output = run(process.execPath, ["bin/liesel.js", "board", "open", board, "--no-open"], lieselEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      browser = await launchChrome(findChrome(), profile);
      const { send, evaluate, list } = browser;
      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(2500);
      await evaluate(`document.querySelector('#devices [data-device="desktop"]').click()`);
      await sleep(1500);

      let frameSession = "";
      for (const target of (await list()).filter((entry) => entry.type === "iframe")) {
        if (!target.url.includes("device=desktop")) continue;
        frameSession = (await send("Target.attachToTarget", { targetId: target.id, flatten: true })).sessionId;
      }
      assert.ok(frameSession, "the desktop frame is not open");
      await evaluate(`document.querySelector("path").setAttribute("data-clicked", "")`, frameSession);
      const inner = await evaluate(
        `(() => { const r = document.querySelector("path").getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`,
        frameSession,
      );
      const frame = await evaluate(
        `(() => { const f = document.querySelector('.artboard[data-key="logo::desktop"] iframe'); const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / f.offsetWidth }; })()`,
      );
      const point = { x: frame.left + inner.x * frame.scale, y: frame.top + inner.y * frame.scale };

      // A lone Cmd tap turns notes on.
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Meta", code: "MetaLeft", modifiers: 4 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", modifiers: 0 });
      await sleep(300);
      assert.equal(await evaluate(`document.body.dataset.notes`), "true");

      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await sleep(300);
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
      await sleep(800);
      assert.equal(
        await evaluate(`document.querySelector(".note-pop") ? "note" : "none"`),
        "note",
        "a click on the logo's shape leaves no note",
      );

      // The note names the shape, and that selector finds it again in the page.
      const selector = await evaluate(
        `(() => { const id = document.querySelector(".note-pop").dataset.note; for (const item of state.items) for (const note of item.notes || []) if (note.id === id) return note.selector; return ""; })()`,
      );
      assert.ok(selector, "the note has no selector");
      assert.equal(
        await evaluate(
          `document.querySelector(${JSON.stringify(selector)})?.hasAttribute("data-clicked") || false`,
          frameSession,
        ),
        true,
        `the selector ${selector} does not find the clicked shape`,
      );
    } finally {
      browser?.close();
      run(process.execPath, ["bin/liesel.js", "stop", "--port", String(port)], lieselEnv, 15_000);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
