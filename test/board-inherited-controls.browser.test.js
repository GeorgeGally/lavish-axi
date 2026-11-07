import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>inherited</title><style>
body { margin: 0; font-family: Georgia, serif; color: rgb(51, 51, 51); }
#main { display: block; }
.hero { padding: 40px; color: rgb(10, 20, 30); letter-spacing: 1px; }
.copy { padding: 6px; }
.hero h2 { margin: 0; font-size: 40px; }
.edge { padding: 0 0 8px; }
.edge p { margin: 0; height: 120px; }
</style></head>
<body><main id="main"><section class="hero"><div class="copy"><h2 id="head">Inherited heading</h2></div></section>
<section class="edge"><p id="fill">Edge filler</p></section></main></body></html>
`;

const ALT = 1;
const META = 4;
const SHIFT = 8;

/**
 * A board with one design, served on its own port and state, and a headless Chrome on
 * it: trusted keys and clicks plus readers for the Controls panel and the design.
 * @param {string} name @param {string} html
 */
async function startBoard(name, html) {
  const temp = await mkdtemp(path.join(tmpdir(), "liesel-inherited-e2e-"));
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

// Controls reaches what the picked element inherits, DevTools style, and picks bigger
// boxes: a breadcrumb from Page down, Up and Down keys, and a section's edge.
test(
  "Controls tunes inherited properties on the ancestor that sets them, with breadcrumbs, Up/Down and undo",
  { skip: !runBrowserE2e || !findChrome(), timeout: 240_000 },
  async () => {
    const b = await startBoard("01-inherited.html", ITEM_HTML);
    const {
      send,
      evaluate,
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
    } = b;
    try {
      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(2500);
      let frame = await design();
      const head = await pointInDesign(frame, "#head");
      await move(head.x, head.y);

      // Pick the heading: the breadcrumb runs from Page down to it, and what it takes
      // from above shows as collapsed groups, nearest first.
      await tapAlt();
      await click(head.x, head.y);
      assert.equal(await crumbs(), "Page > main#main > section.hero > div.copy > *h2#head");
      assert.deepEqual(await groups(), ["section.hero:closed[Tracking,Colour]", "Page:closed[Font]"]);

      // Editing an inherited colour changes the section, and so the heading, live and saved.
      await evaluate(`document.querySelector(".tune-inherited").open = true`);
      await evaluate(`(() => {
        const input = document.querySelector(".tune-inherited .tune-hex");
        input.value = "#ff0000";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await sleep(900);
      assert.equal(await colourOf(frame, ".hero"), "rgb(255, 0, 0)");
      assert.equal(await colourOf(frame, "#head"), "rgb(255, 0, 0)");
      const heroSelector = Object.keys(await saved()).find((selector) => selector.includes("section"));
      assert.ok(heroSelector, JSON.stringify(await saved()));
      assert.equal((await saved())[heroSelector].color, "#ff0000");
      assert.match(await evaluate(`document.getElementById("tuneSend").disabled ? "off" : "on"`), /on/);

      // Cmd-Z puts the section back, live and saved; Cmd-Shift-Z brings the change back.
      await evaluate(`document.activeElement?.blur()`);
      await press("z", "KeyZ", META);
      await sleep(600);
      assert.equal(await colourOf(frame, "#head"), "rgb(10, 20, 30)", "undo restores the inherited colour");
      assert.equal((await saved())[heroSelector], undefined, "undo takes the saved override off");
      await press("z", "KeyZ", META | SHIFT);
      await sleep(600);
      assert.equal(await colourOf(frame, "#head"), "rgb(255, 0, 0)", "redo brings it back");

      // The selector widens with Up and narrows with Down, outlining live, and a click
      // tunes the widened box with the breadcrumb still running down to the heading.
      await move(head.x + 2, head.y);
      assert.equal(await outlined(frame), "head");
      await press("ArrowUp", "ArrowUp");
      assert.equal(await outlined(frame), "copy");
      await press("[", "BracketLeft");
      assert.equal(await outlined(frame), "hero");
      await press("ArrowDown", "ArrowDown");
      assert.equal(await outlined(frame), "copy");
      await press("ArrowUp", "ArrowUp");
      await mouse("mousePressed", head.x + 2, head.y, { buttons: 1 });
      await mouse("mouseReleased", head.x + 2, head.y, { buttons: 0 });
      await sleep(700);
      assert.equal(await crumbs(), "Page > main#main > *section.hero > div.copy > h2#head");

      // With the selector off, Down and Up walk the tuned element along that path.
      await press("Escape", "Escape");
      assert.equal(await evaluate(`document.body.dataset.controls`), "false");
      await press("ArrowDown", "ArrowDown");
      await sleep(400);
      assert.equal(await crumbs(), "Page > main#main > section.hero > *div.copy > h2#head");
      await press("]", "BracketRight");
      await sleep(400);
      assert.equal(await crumbs(), "Page > main#main > section.hero > div.copy > *h2#head");

      // Hovering a crumb outlines it in the design.
      await evaluate(`document.querySelectorAll(".tune-crumb")[2].dispatchEvent(new PointerEvent("pointerenter"))`);
      await sleep(250);
      assert.equal(await outlined(frame), "hero");
      await evaluate(`document.querySelectorAll(".tune-crumb")[2].dispatchEvent(new PointerEvent("pointerleave"))`);

      // Page is one click: it offers the whole page's controls.
      await evaluate(`document.querySelector(".tune-crumb").click()`);
      await sleep(600);
      assert.equal(await evaluate(`document.getElementById("tuneTitle").textContent`), "Page");
      assert.deepEqual(
        await evaluate(
          `[...document.querySelectorAll("#tuneBody > .tune-control .tune-control-label > span:first-child")].map((s) => s.textContent)`,
        ),
        ["Background", "Base font", "Base size", "Max width", "Side padding"],
      );
      await evaluate(`(() => {
        const label = [...document.querySelectorAll("#tuneBody > .tune-control")].find((c) => c.textContent.startsWith("Max width"));
        const input = label.querySelector("input[type=range]");
        input.value = "600";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await sleep(500);
      assert.deepEqual(
        await evaluate(
          `(() => { const s = getComputedStyle(document.body); return [s.maxWidth, s.marginLeft === s.marginRight && s.marginLeft !== "0px"]; })()`,
          frame,
        ),
        ["600px", true],
        "a narrower page stays centred",
      );

      // Near a section's edge the selector prefers the section to the child filling it.
      await tapAlt();
      const edge = await pointInDesign(frame, ".edge", { x: 2, y: 0.5 });
      await move(edge.x, edge.y);
      assert.equal(await outlined(frame), "edge");
      const middle = await pointInDesign(frame, ".edge", { x: 0.5, y: 0.5 });
      await move(middle.x, middle.y);
      assert.equal(await outlined(frame), "fill");
      await tapAlt();

      // After a reload the inherited group shows the saved value, not the file's.
      await send("Page.navigate", { url });
      await sleep(2500);
      frame = await design();
      const again = await pointInDesign(frame, "#head");
      await move(again.x, again.y);
      await tapAlt();
      await click(again.x, again.y);
      await evaluate(`document.querySelector(".tune-inherited").open = true`);
      assert.equal(await evaluate(`document.querySelector(".tune-inherited .tune-hex").value`), "#ff0000");

      // No browser picker: a swatch and a slider both change the design live.
      assert.equal(
        await evaluate(
          `document.querySelectorAll('.tune-body input[type="color"], #tuneBody input[type="color"]').length`,
        ),
        0,
      );
      assert.equal(await evaluate(`document.querySelectorAll(".tune-inherited .tune-colour-option").length`), 10);
      await evaluate(`document.querySelector('.tune-inherited .tune-colour-option[data-hex="#00ffff"]').click()`);
      await sleep(600);
      assert.equal(await colourOf(frame, "#head"), "rgb(0, 255, 255)");
      assert.equal(await evaluate(`document.querySelector(".tune-inherited .tune-hex").value`), "#00ffff");
      await evaluate(`(() => {
        const hue = document.querySelector(".tune-inherited .tune-colour-hue");
        hue.value = "120";
        hue.dispatchEvent(new Event("input", { bubbles: true }));
        hue.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await sleep(900);
      assert.equal(await colourOf(frame, "#head"), "rgb(0, 255, 0)");
      assert.equal((await saved())[heroSelector].color, "#00ff00");
    } finally {
      await b.close();
    }
  },
);

const RAIL_HTML = readFileSync(path.join(repoRoot, "test/fixtures/hftw-rail.html"), "utf8");

// The Home for the Woods rail: a pick names exactly the block clicked, a change under
// All like this reaches every card's block in that rail at every size, and a box's text settings say which
// text inside sets its own.
test(
  "Controls tunes all like this in a product rail, across sizes, and names text that sets its own",
  { skip: !runBrowserE2e || !findChrome(), timeout: 240_000 },
  async () => {
    const b = await startBoard("01-home.html", RAIL_HTML);
    const { send, evaluate, press, tapAlt, click, design, pointInDesign, crumbs, saved, url } = b;
    try {
      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(2500);
      const desktop = await design();
      const phone = await design("phone");
      const meta = ".rail-section:nth-of-type(1) article:nth-of-type(5) .product-meta";
      /** @param {string} session @param {string} selector @param {string} css */
      const styleOf = (session, selector, css) =>
        evaluate(
          `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => getComputedStyle(e).getPropertyValue(${JSON.stringify(css)}))`,
          session,
        );
      /** @param {string} label @param {string} value */
      const slide = (label, value) =>
        evaluate(`(() => {
          const control = [...document.querySelectorAll("#tuneBody > .tune-control")].find((c) => c.querySelector(".tune-control-label span")?.textContent === ${JSON.stringify(label)});
          const input = control.querySelector("input[type=range]");
          input.value = ${JSON.stringify(value)};
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        })()`).then(() => sleep(500));
      /** @param {string} text */
      const choose = (text) =>
        evaluate(
          `[...document.querySelectorAll(".tune-scope-option")].find((b) => b.textContent.startsWith(${JSON.stringify(text)})).click()`,
        ).then(() => sleep(300));
      const scopes = () =>
        evaluate(
          `[...document.querySelectorAll(".tune-scope-option")].map((b) => (b.getAttribute("aria-checked") === "true" ? "*" : "") + b.textContent)`,
        );

      // Pick the Green Silicone Cup's text block by its padding, the way a reviewer
      // reaches the block rather than one line of it.
      const point = await pointInDesign(desktop, meta, { x: 0.5, y: 0.05 });
      await tapAlt();
      await click(point.x, point.y);
      await tapAlt();
      assert.equal(
        await crumbs(),
        "Page > main > section.rail-section > div.rail-window > div.rail-track > article.product > *div.product-meta",
      );
      assert.deepEqual(await scopes(), ["*This one", "All like this (5)", "*All sizes", "Desktop only"]);

      // Chosen, one change reaches every card's block in this rail, in every size, and nothing else.
      await choose("All like");
      await slide("Line height", "20");
      assert.deepEqual(
        await styleOf(desktop, ".rail-section:nth-of-type(1) .product-meta", "line-height"),
        Array(5).fill("20px"),
      );
      assert.deepEqual(
        await styleOf(phone, ".rail-section:nth-of-type(1) .product-meta", "line-height"),
        Array(5).fill("20px"),
      );
      assert.ok(
        (await styleOf(desktop, ".rail-section:nth-of-type(2) .product-meta", "line-height")).every(
          (v) => v !== "20px",
        ),
        "the other rail keeps its own",
      );
      assert.notEqual(
        (await styleOf(desktop, ".section-heading a", "line-height"))[0],
        "20px",
        "SHOP ALL is untouched",
      );
      const keys = Object.keys(await saved());
      assert.equal(keys.length, 1, JSON.stringify(keys));
      assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(keys[0])}).length`, desktop), 5);

      // This one alone: the cup's block differs, then matches the others again.
      await choose("This one");
      await slide("Line height", "31");
      assert.deepEqual(await styleOf(desktop, ".rail-section:nth-of-type(1) .product-meta", "line-height"), [
        "20px",
        "20px",
        "20px",
        "20px",
        "31px",
      ]);
      await evaluate(`document.querySelector(".tune-match").click()`);
      await sleep(500);
      assert.deepEqual(
        await styleOf(desktop, ".rail-section:nth-of-type(1) .product-meta", "line-height"),
        Array(5).fill("20px"),
      );

      // Desktop only: phone keeps the shared value, and Copy writes a media query for it.
      await choose("All like");
      await choose("Desktop only");
      await slide("Tracking", "2");
      assert.equal((await styleOf(desktop, meta, "letter-spacing"))[0], "2px");
      assert.notEqual((await styleOf(phone, meta, "letter-spacing"))[0], "2px");
      await choose("All sizes");
      assert.match(await evaluate(`document.querySelector("#tuneBody").textContent`), /Own value on Desktop/);
      await evaluate(
        `(() => { window.__copied = ""; navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); }; document.getElementById("tuneCopy").click(); })()`,
      );
      await sleep(300);
      const copied = await evaluate(`window.__copied`);
      assert.match(
        copied,
        /@media \(min-width: 835px\) and \(max-width: 1440px\) \{ .*product-meta \{ letter-spacing: 2px; \} \}/,
      );
      assert.match(copied, /product-meta \{ line-height: 20px; \}/);

      // The card around it: its line height does not reach text that sets its own.
      await press("ArrowUp", "ArrowUp");
      await sleep(400);
      assert.match(await crumbs(), /\*article\.product/);
      assert.match(
        await evaluate(`document.querySelector("#tuneBody").textContent`),
        /Set separately on div\.product-meta/,
      );
      await evaluate(`document.querySelector(".tune-note-jump").click()`);
      await sleep(600);
      assert.match(await crumbs(), /\*div\.product-meta/);
    } finally {
      await b.close();
    }
  },
);

const EMAIL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>email</title><style>
body { margin: 0; font-family: Helvetica, Arial, sans-serif; color: rgb(13, 37, 63); }
#email-content { width: 600px; margin: 40px auto; border-collapse: collapse; }
td { padding: 24px 40px; }
p { margin: 0 0 16px; font-size: 18px; font-weight: 400; line-height: 1.6; }
a { color: rgb(46, 107, 168); }
</style></head>
<body><table id="email-content"><tbody><tr><td>
<h1 id="title">Project Haley</h1>
<p id="label">Assistance requested</p>
<p id="body">We welcome suggestions re: potential buyers and prior experience in the space.</p>
<p id="contact"><a href="mailto:someone@example.com">someone@example.com</a></p>
</td></tr></tbody></table></body></html>
`;

// The CapFive email: three paragraphs in one cell look "like" each other, but making
// the picked one bold must bold that paragraph alone, never the text below it.
test(
  "Controls tunes only the picked element by default, never the siblings like it",
  { skip: !runBrowserE2e || !findChrome(), timeout: 240_000 },
  async () => {
    const b = await startBoard("01-email.html", EMAIL_HTML);
    const { send, evaluate, tapAlt, click, design, pointInDesign, saved, url } = b;
    try {
      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(2500);
      const desktop = await design();
      /** @param {string} selector */
      const weightOf = (selector) =>
        evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontWeight`, desktop);
      const scopes = () =>
        evaluate(
          `[...document.querySelectorAll(".tune-scope-option")].map((b) => (b.getAttribute("aria-checked") === "true" ? "*" : "") + b.textContent)`,
        );

      const point = await pointInDesign(desktop, "#label");
      await tapAlt();
      await click(point.x, point.y);
      await tapAlt();
      assert.deepEqual(await scopes(), ["*This one", "All like this (3)", "*All sizes", "Desktop only"]);

      await evaluate(`(() => {
        const control = [...document.querySelectorAll("#tuneBody > .tune-control")].find((c) => c.querySelector(".tune-control-label span")?.textContent === "Weight");
        const select = control.querySelector("select");
        select.value = "800";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await sleep(800);

      assert.equal(await weightOf("#label"), "800");
      assert.equal(await weightOf("#body"), "400", "the paragraph below keeps its weight");
      assert.equal(await weightOf("#contact"), "400", "the contact line keeps its weight");
      assert.equal(await weightOf("#contact a"), "400", "the link keeps its weight");
      const keys = Object.keys(await saved());
      assert.equal(keys.length, 1, JSON.stringify(keys));
      assert.equal(
        await evaluate(`document.querySelectorAll(${JSON.stringify(keys[0])}).length`, desktop),
        1,
        `${keys[0]} names the picked paragraph alone`,
      );
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(keys[0])}).id`, desktop), "label");
    } finally {
      await b.close();
    }
  },
);
