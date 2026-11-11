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
<html><head><meta charset="utf-8"><title>label</title><style>
body { margin: 0; font: 16px sans-serif; }
#top { margin: 0; padding: 20px; font-size: 32px; }
.hero { margin: 120px 40px 40px; padding: 30px; background: #fde68a; color: #111; }
</style></head>
<body><h1 id="top">Top</h1><div class="hero card"><p id="copy">Some copy</p></div></body></html>
`;

/**
 * A board with one design open in headless Chrome, handed to `body`, then torn down.
 * @param {(browser: Awaited<ReturnType<typeof launchChrome>>, url: string) => Promise<void>} body
 */
async function withLabelBoard(body) {
  const temp = await mkdtemp(path.join(tmpdir(), "liesel-edit-label-e2e-"));
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
    await writeFile(path.join(board, "01-label.html"), ITEM_HTML);
    const output = run(process.execPath, ["bin/liesel.js", "board", "open", board, "--no-open"], lieselEnv);
    const url = output.match(/url:\s*"([^"]+)"/)?.[1];
    assert.ok(url, output);
    browser = await launchChrome(findChrome(), profile);
    await browser.send("Page.enable");
    await browser.send("Page.navigate", { url });
    await sleep(2500);
    await body(browser, url);
  } finally {
    browser?.close();
    run(process.execPath, ["bin/liesel.js", "stop", "--port", String(port)], lieselEnv, 15_000);
    await rm(temp, { recursive: true, force: true });
  }
}

/** @param {Awaited<ReturnType<typeof launchChrome>>} browser */
function labelDriver({ send, evaluate, list }) {
  /** @param {string} type @param {number} x @param {number} y @param {Record<string, unknown>} [extra] */
  const mouse = (type, x, y, extra = {}) =>
    send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  /** @param {number} x @param {number} y */
  const click = async (x, y) => {
    await mouse("mouseMoved", x, y, { button: "none", clickCount: 0 });
    await sleep(150);
    await mouse("mousePressed", x, y, { buttons: 1 });
    await mouse("mouseReleased", x, y, { buttons: 0 });
  };
  /** @param {string} word */
  const clickWord = async (word) => {
    const at = await evaluate(
      `(() => { const b = [...document.querySelectorAll("#modeState button")].find((b) => b.textContent === ${JSON.stringify(word)}); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    await click(at.x, at.y);
    await sleep(300);
  };
  const attach = async () => {
    const target = (await list()).find((entry) => entry.type === "iframe" && entry.url.includes("device=desktop"));
    assert.ok(target, "no desktop frame");
    const { sessionId } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
    return sessionId;
  };
  /** Click just inside an element's top-left corner in the desktop frame. @param {string} sessionId @param {string} selector */
  const clickInFrame = async (sessionId, selector) => {
    const frame = await evaluate(
      `(() => { const f = [...document.querySelectorAll(".artboard iframe")].find((f) => f.src.includes("device=desktop")); const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / f.offsetWidth }; })()`,
    );
    const inner = await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10 }; })()`,
      sessionId,
    );
    await click(frame.left + inner.x * frame.scale, frame.top + inner.y * frame.scale);
    await sleep(900);
  };
  /** The label and outline the frame draws for the edited element. @param {string} sessionId @param {string} selector */
  const readLabel = (sessionId, selector) =>
    evaluate(
      `(() => {
        const tag = document.getElementById("liesel-edit-tag");
        const box = document.getElementById("liesel-edit-box");
        const el = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        if (!tag || tag.style.display === "none") return null;
        const r = tag.getBoundingClientRect();
        return {
          text: tag.textContent,
          above: r.bottom <= el.top + 0.5,
          below: r.top >= el.bottom - 0.5,
          ui: tag.closest("[data-liesel-ui]") !== null,
          outline: box ? Number(getComputedStyle(box).opacity) : 0,
          boxFits: box ? Math.abs(box.getBoundingClientRect().top - el.top) < 1 : false,
        };
      })()`,
      sessionId,
    );
  return { mouse, click, clickWord, attach, clickInFrame, readLabel };
}

// Edit: the element loaded into Controls carries a small black tag just above it, naming the
// element and the property being changed. A thin outline shows only while the pointer is on
// the controls or just after a change, so it never sits on the design while it is judged.
test(
  "Edit tags the edited element with its name and the property being changed",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async (t) => {
    await withLabelBoard(async (browser) => {
      const { evaluate } = browser;
      const { mouse, clickWord, attach, clickInFrame, readLabel } = labelDriver(browser);
      await clickWord("Edit");
      const sessionId = await attach();
      await clickInFrame(sessionId, ".hero");

      const picked = await readLabel(sessionId, ".hero");
      assert.ok(picked, "the edited element has a tag");
      assert.equal(picked.text, "div.hero");
      assert.ok(picked.above, `the tag sits above the element: ${JSON.stringify(picked)}`);
      assert.ok(picked.ui, "the tag is the board's own drawing, never part of the page");
      assert.equal(picked.outline, 0, "no outline sits on the design after a pick");

      const control = await evaluate(
        `(() => { const c = [...document.querySelectorAll("#tuneBody .tune-control")].find((n) => /Fill/.test(n.textContent)); c.scrollIntoView({ block: "center" }); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      await mouse("mouseMoved", control.x, control.y, { button: "none", clickCount: 0 });
      await sleep(400);
      const hovered = await readLabel(sessionId, ".hero");
      assert.equal(hovered?.text, "div.hero · background-color");
      assert.equal(hovered?.outline, 1, "the outline shows while the pointer is on the controls");
      assert.ok(hovered?.boxFits, "the outline hugs the element");

      await mouse("mouseMoved", 5, 5, { button: "none", clickCount: 0 });
      await sleep(600);
      const away = await readLabel(sessionId, ".hero");
      assert.equal(away?.outline, 0, "leaving the controls fades the outline");
      assert.equal(away?.text, "div.hero · background-color", "the tag stays on the element");

      await clickInFrame(sessionId, "#top");
      const top = await readLabel(sessionId, "#top");
      assert.equal(top?.text, "h1#top");
      assert.ok(top?.below, `with no room above, the tag flips below: ${JSON.stringify(top)}`);

      await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await clickWord("View");
      t.diagnostic(JSON.stringify({ picked, hovered, away, top }));
    });
  },
);

// Font: a picked element changes its font from one searchable picker that lists the page's
// own fonts, system stacks and Google Fonts, each set in its own face. A Google font is
// loaded into the design as the board's own link, and the pick is saved like any change.
test(
  "Edit picks a Google font for an element from the searchable font picker",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async (t) => {
    await withLabelBoard(async (browser, url) => {
      const { evaluate, send } = browser;
      const { click, clickWord, attach, clickInFrame } = labelDriver(browser);
      await clickWord("Edit");
      const sessionId = await attach();
      await clickInFrame(sessionId, ".hero");
      const field = await evaluate(
        `(() => { const f = document.querySelector("#tuneBody .tune-font-field"); f.scrollIntoView({ block: "center" }); const r = f.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: f.textContent }; })()`,
      );
      assert.equal(field.text, "sans-serif", "the element's own font shows in the field");
      await click(field.x, field.y);
      await sleep(300);
      const groups = await evaluate(
        `[...document.querySelectorAll(".tune-fonts .tune-fonts-group")].map((g) => g.textContent)`,
      );
      assert.deepEqual(groups, ["On this page", "System", "Google Fonts"]);
      const total = await evaluate(`document.querySelectorAll(".tune-fonts .tune-font-option").length`);
      assert.ok(total > 200, `far more than four fonts: ${total}`);
      await send("Input.insertText", { text: "Lora" });
      await sleep(300);
      const lora = await evaluate(
        `(() => { const row = [...document.querySelectorAll(".tune-fonts .tune-font-option")].find((r) => r.textContent === "Lora"); const r = row.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, face: row.style.fontFamily }; })()`,
      );
      assert.match(lora.face, /^"?Lora"?, serif$/, "each font is set in its own face");
      await click(lora.x, lora.y);
      await sleep(900);
      assert.equal(await evaluate(`document.querySelector(".tune-fonts")`), null, "the picker closes on a pick");
      const frame = await evaluate(
        `({ font: getComputedStyle(document.querySelector(".hero")).fontFamily, link: document.querySelector("link[data-liesel-ui='font']")?.href || "" })`,
        sessionId,
      );
      assert.match(frame.font, /^"?Lora"?, serif$/);
      assert.match(frame.link, /^https:\/\/fonts\.googleapis\.com\/css2\?family=Lora/);
      const key = new URL(url).pathname.split("/").pop();
      const saved = await evaluate(
        `fetch("/api/boards/${key}").then((r) => r.json()).then((b) => b.items[0].elementTune)`,
      );
      assert.deepEqual(Object.values(saved), [{ "font-family": '"Lora", serif' }], "the pick is saved on the board");
      const back = await evaluate(
        `(() => { const r = document.querySelector("#tuneBody .tune-font-field").getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`,
      );
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: back.x, y: back.y, button: "none" });
      await sleep(300);
      assert.match(
        await evaluate(`document.querySelector("#liesel-edit-tag")?.textContent || ""`, sessionId),
        /div\.hero · font-family/,
      );
      t.diagnostic(JSON.stringify({ total, frame }));
    });
  },
);

// V is View, the way the other modes have their keys.
test("V switches the board to View", { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 }, async () => {
  await withLabelBoard(async (browser) => {
    const { send, evaluate } = browser;
    const { clickWord } = labelDriver(browser);
    const mode = () => evaluate(`document.getElementById("modeState").dataset.mode || "view"`);
    await clickWord("Edit");
    assert.equal(await mode(), "tune");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", text: "v" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV" });
    await sleep(200);
    assert.equal(await mode(), "view");
  });
});
