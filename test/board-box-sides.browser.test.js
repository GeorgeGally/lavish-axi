import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

/** @param {string} dir */
async function findBoardFile(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === "board.json") return path.join(entry.parentPath, entry.name);
  }
  throw new Error("no board.json");
}

const ALT = 1;
const META = 4;
const SHIFT = 8;

/**
 * A board with one design, served on its own port and state, and a headless Chrome on
 * it: trusted keys and clicks plus readers for the Controls panel and the design.
 * @param {string} name @param {string} html
 */
async function startBoard(name, html) {
  const temp = await mkdtemp(path.join(tmpdir(), "liesel-box-sides-e2e-"));
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
  const board = path.join(temp, "board");
  await mkdir(board, { recursive: true });
  await writeFile(path.join(board, name), html);
  const output = run(process.execPath, ["bin/liesel.js", "board", "open", board, "--no-open"], lieselEnv);
  const url = output.match(/url:\s*"([^"]+)"/)?.[1];
  assert.ok(url, output);

  const browser = await launchChrome(findChrome(), profile);
  const { send, evaluate, list } = browser;
  let held = 0;
  /** @param {string} key @param {string} code @param {number} [modifiers] */
  const press = async (key, code, modifiers = held) => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
    await sleep(250);
  };
  const tapAlt = async () => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Alt", code: "AltLeft", modifiers: ALT });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Alt", code: "AltLeft", modifiers: 0 });
    await sleep(150);
  };
  /** @param {string} type @param {number} x @param {number} y @param {Record<string, unknown>} [extra] */
  const mouse = (type, x, y, extra = {}) =>
    send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, modifiers: held, ...extra });
  const move = async (x, y) => {
    await mouse("mouseMoved", x, y, { button: "none", clickCount: 0 });
    await sleep(250);
  };
  const click = async (x, y) => {
    await move(x, y);
    await mouse("mousePressed", x, y, { buttons: 1 });
    await mouse("mouseReleased", x, y, { buttons: 0 });
    await sleep(700);
  };

  /** The desktop design's own session, for reading what the page now looks like. */
  async function design(device = "desktop") {
    const target = (await list()).find((entry) => entry.type === "iframe" && entry.url.includes(`device=${device}`));
    assert.ok(target, `no ${device} frame`);
    const { sessionId } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
    return sessionId;
  }
  /** A board-screen point for a page point or an element's middle. */
  async function pointInDesign(sessionId, selector, offset = { x: 0.5, y: 0.5 }) {
    const inner = await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + ${offset.x <= 1 ? `r.width * ${offset.x}` : offset.x}, y: r.top + r.height * ${offset.y} }; })()`,
      sessionId,
    );
    const frame = await evaluate(
      `(() => { const f = [...document.querySelectorAll(".artboard iframe")].find((f) => f.src.includes("device=desktop")); const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / f.offsetWidth }; })()`,
    );
    return { x: frame.left + inner.x * frame.scale, y: frame.top + inner.y * frame.scale };
  }
  const crumbs = () =>
    evaluate(
      `[...document.querySelectorAll(".tune-crumb")].map((b) => (b.getAttribute("aria-current") ? "*" : "") + b.textContent).join(" > ")`,
    );
  const groups = () =>
    evaluate(
      `[...document.querySelectorAll(".tune-inherited")].map((d) => d.querySelector(".tune-inherited-from").textContent + (d.open ? ":open" : ":closed") + "[" + [...d.querySelectorAll(".tune-control-label > span:first-child")].map((s) => s.textContent).join(",") + "]")`,
    );
  /** The element the frame outlines, matched by its box. */
  const outlined = (sessionId) =>
    evaluate(
      `(() => { const h = document.getElementById("liesel-hover"); if (!h || h.style.display !== "block") return ""; const box = { left: parseFloat(h.style.left) - scrollX, top: parseFloat(h.style.top) - scrollY, width: parseFloat(h.style.width), height: parseFloat(h.style.height) }; const all = [document.body, ...document.body.querySelectorAll("*:not([data-liesel-ui])")]; const hit = all.find((e) => { const r = e.getBoundingClientRect(); return Math.abs(r.left - box.left) < 1 && Math.abs(r.top - box.top) < 1 && Math.abs(r.width - box.width) < 1 && Math.abs(r.height - box.height) < 1; }); return hit ? (hit.id || hit.className || hit.tagName.toLowerCase()) : "?"; })()`,
      sessionId,
    );
  const colourOf = (sessionId, selector) =>
    evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color`, sessionId);
  const saved = async () => JSON.parse(await readFile(await findBoardFile(board), "utf8")).items[0].elementTune || {};

  const close = () => {
    browser.close();
    run(process.execPath, ["bin/liesel.js", "stop", "--port", String(port)], lieselEnv, 15_000);
    return rm(temp, { recursive: true, force: true });
  };
  return {
    send,
    evaluate,
    list,
    press,
    tapAlt,
    mouse,
    move,
    click,
    design,
    pointInDesign,
    crumbs,
    groups,
    outlined,
    colourOf,
    saved,
    url,
    board,
    close,
  };
}

const BOX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>sides</title><style>
body { margin: 0; font: 16px sans-serif; }
.cards { display: block; padding: 20px; }
.card { display: block; margin: 0 0 12px; padding: 10px; background: rgb(240, 240, 240); }
</style></head>
<body><div class="cards"><div class="card" id="a">First card</div><div class="card" id="b">Second card</div><div class="card" id="c">Third card</div></div></body></html>
`;

// Padding keeps its all-sides slider; a link toggle opens linked pairs, then each side,
// and Radius opens to corners. Every side reaches the picked element only, at every size
// or one size alone, and keeps its value against the all-sides one in either order.
test(
  "Controls sets padding per side, in pairs or alone, and radius per corner, on the picked element only",
  { skip: !runBrowserE2e || !findChrome(), timeout: 240_000 },
  async () => {
    const b = await startBoard("01-cards.html", BOX_HTML);
    const { send, evaluate, tapAlt, click, press, design, pointInDesign, saved, url } = b;
    try {
      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(2500);
      const desktop = await design();
      /** @param {string} selector @param {string} css @param {string} [session] */
      const cssOf = (selector, css, session = desktop) =>
        evaluate(
          `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).getPropertyValue(${JSON.stringify(css)})`,
          session,
        );
      /** @param {string} selector */
      const paddingOf = async (selector, session = desktop) =>
        (
          await Promise.all(
            ["top", "right", "bottom", "left"].map((side) => cssOf(selector, `padding-${side}`, session)),
          )
        ).join(" ");
      const control = (label) =>
        `[...document.querySelectorAll("#tuneBody > .tune-control")].find((c) => c.querySelector(".tune-control-label span")?.textContent === ${JSON.stringify(label)})`;
      /** The sides a box control shows, as "label=value". @param {string} label */
      const sides = (label) =>
        evaluate(
          `[...${control(label)}.querySelectorAll(".tune-side")].map((s) => s.querySelector(".tune-control-label span").textContent + "=" + s.querySelector(".tune-control-value").textContent)`,
        );
      /** Drag a slider to a value, ending the change the way a pointer does. */
      const slide = async (expression, value) => {
        await evaluate(`(() => {
          const input = ${expression}.querySelector('input[type="range"]');
          input.value = ${JSON.stringify(String(value))};
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        })()`);
        await sleep(600);
      };
      const side = (label, name) =>
        `[...${control(label)}.querySelectorAll(".tune-side")].find((s) => s.querySelector(".tune-control-label span").textContent === ${JSON.stringify(name)})`;
      const tapButton = async (expression) => {
        await evaluate(`${expression}.click()`);
        await sleep(400);
      };
      const toggle = (label) => `${control(label)}.querySelector(".tune-link")`;

      const point = await pointInDesign(desktop, "#b");
      await tapAlt();
      await click(point.x, point.y);
      await tapAlt();

      // Even padding: one slider, the toggle closed.
      assert.equal(await evaluate(`${toggle("Padding")}.getAttribute("aria-pressed")`), "false");
      assert.deepEqual(await sides("Padding"), []);

      // Open: linked pairs first.
      await tapButton(toggle("Padding"));
      assert.deepEqual(await sides("Padding"), ["Left · right=10", "Top · bottom=10"]);
      await slide(side("Padding", "Left · right"), 24);
      assert.equal(await paddingOf("#b"), "10px 24px 10px 24px");
      assert.equal(await paddingOf("#a"), "10px 10px 10px 10px", "a sibling keeps its padding");
      assert.equal(await evaluate(`${control("Padding")}.querySelector(".tune-control-value").textContent`), "Mixed");

      // Each side on its own.
      await tapButton(
        `[...${control("Padding")}.querySelectorAll(".tune-side-mode")].find((m) => m.textContent === "Each side")`,
      );
      assert.deepEqual(await sides("Padding"), ["Top=10", "Right=24", "Bottom=10", "Left=24"]);
      await slide(side("Padding", "Top"), 4);
      assert.equal(await paddingOf("#b"), "4px 24px 10px 24px");

      // Undo takes the one side back; redo puts it on again.
      await press("z", "KeyZ", META);
      assert.equal(await paddingOf("#b"), "10px 24px 10px 24px");
      await press("z", "KeyZ", META | SHIFT);
      assert.equal(await paddingOf("#b"), "4px 24px 10px 24px");

      // The all-sides slider really sets every side, and the sides follow it.
      await slide(control("Padding"), 12);
      assert.equal(await paddingOf("#b"), "12px 12px 12px 12px");
      assert.deepEqual(await sides("Padding"), ["Top=12", "Right=12", "Bottom=12", "Left=12"]);
      const tuned = Object.entries(await saved());
      assert.equal(tuned.length, 1, JSON.stringify(tuned));
      assert.deepEqual(tuned[0][1], { padding: "12px" });
      assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(tuned[0][0])}).length`, desktop), 1);

      // A side set after the all-sides value keeps its own, here and after a reload.
      await slide(side("Padding", "Left"), 30);
      assert.equal(await paddingOf("#b"), "12px 12px 12px 30px");

      // One size alone: the phone frame keeps the shared sides.
      await tapButton(
        `[...document.querySelectorAll(".tune-scope-option")].find((o) => o.textContent === "Desktop only")`,
      );
      await slide(side("Padding", "Right"), 40);
      assert.equal(await paddingOf("#b"), "12px 40px 12px 30px");
      const phone = await design("phone");
      assert.equal(await paddingOf("#b", phone), "12px 12px 12px 30px", "the phone keeps the shared sides");

      // Radius opens straight to its corners.
      await tapButton(toggle("Radius"));
      assert.deepEqual(await sides("Radius"), ["Top left=0", "Top right=0", "Bottom right=0", "Bottom left=0"]);
      await slide(side("Radius", "Top left"), 8);
      assert.equal(await cssOf("#b", "border-top-left-radius"), "8px");
      assert.equal(await cssOf("#b", "border-top-right-radius"), "0px");

      // Saved in the order it was tuned, shown the same after a reload.
      await sleep(600);
      await send("Page.reload");
      await sleep(3000);
      const again = await design();
      assert.equal(await paddingOf("#b", again), "12px 40px 12px 30px");
      assert.equal(await paddingOf("#a", again), "10px 10px 10px 10px");
      assert.equal(await cssOf("#b", "border-top-left-radius", again), "8px");
      assert.equal(await paddingOf("#b", await design("phone")), "12px 12px 12px 30px");
    } finally {
      await b.close();
    }
  },
);
