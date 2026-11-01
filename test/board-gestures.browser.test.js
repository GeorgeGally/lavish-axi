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

const runBrowserE2e = process.env.EASEL_BROWSER_E2E === "1";
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
<html><head><meta charset="utf-8"><title>gestures</title><style>
body { margin: 0; font: 16px sans-serif; }
#title { margin: 0; padding: 40px; font-size: 48px; }
#field { margin: 40px; width: 300px; height: 40px; font-size: 20px; }
</style></head>
<body><h1 id="title">Gestures</h1><input id="field"></body></html>
`;

// CDP modifier bits.
const ALT = 1;
const META = 4;
const SHIFT = 8;
const MODIFIER = {
  Meta: { code: "MetaLeft", bit: META },
  Alt: { code: "AltLeft", bit: ALT },
  Shift: { code: "ShiftLeft", bit: SHIFT },
};

// Cmd toggles notes and Option toggles the controls selector, one at a time. Every key,
// click, scroll and drag here is trusted input, on the board and inside a focused design.
test(
  "Cmd toggles notes and Option toggles the controls selector, exclusively, and a chord or a lost release flips neither",
  { skip: !runBrowserE2e || !findChrome(), timeout: 240_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "easel-gestures-e2e-"));
    const port = await freePort();
    const easelEnv = {
      EASEL_PORT: String(port),
      EASEL_STATE_DIR: path.join(temp, "state"),
      EASEL_NO_OPEN: "1",
      EASEL_TELEMETRY: "0",
      EASEL_HOST: "127.0.0.1",
      EASEL_LINK_HOST: "127.0.0.1",
    };
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    /** @type {Awaited<ReturnType<typeof launchChrome>> | null} */
    let browser = null;
    try {
      const board = path.join(temp, "board");
      await mkdir(board, { recursive: true });
      await writeFile(path.join(board, "01-gestures.html"), ITEM_HTML);
      const output = run(process.execPath, ["bin/easel.js", "board", "open", board, "--no-open"], easelEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      browser = await launchChrome(findChrome(), profile);
      const { send, evaluate, list } = browser;
      let held = 0;
      /** @param {"Meta" | "Alt" | "Shift"} name */
      const down = async (name) => {
        held |= MODIFIER[name].bit;
        await send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: name,
          code: MODIFIER[name].code,
          modifiers: held,
        });
      };
      /** @param {"Meta" | "Alt" | "Shift"} name */
      const up = async (name) => {
        held &= ~MODIFIER[name].bit;
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: MODIFIER[name].code, modifiers: held });
        await sleep(120);
      };
      /** @param {"Meta" | "Alt" | "Shift"} name */
      const tap = async (name) => {
        await down(name);
        await up(name);
      };
      // Only Cmd, Option or another modifier: a system shortcut such as Cmd-Shift-3 or
      // Cmd-Shift-4 whose last key macOS takes before the page sees it, then a long hold
      // and Cmd-Tab. None of them may toggle anything.
      /** @param {string} where */
      const rejectsNonTaps = async (where) => {
        await down("Shift");
        await down("Meta");
        await up("Meta");
        await up("Shift");
        assert.equal(await status(), off, `${where}: Shift then Cmd, third key swallowed, leaves notes off`);
        await down("Meta");
        await down("Shift");
        await up("Shift");
        await up("Meta");
        assert.equal(await status(), off, `${where}: Cmd then Shift, third key swallowed, leaves notes off`);
        await down("Shift");
        await down("Alt");
        await up("Shift");
        await up("Alt");
        assert.equal(await status(), off, `${where}: Shift with Option leaves the selector off`);
        await down("Meta");
        await sleep(600);
        await up("Meta");
        assert.equal(await status(), off, `${where}: a long Cmd hold leaves notes off`);
        await tap("Meta");
        assert.equal(await status(), notesOn, `${where}: a clean Cmd tap still turns notes on`);
        await tap("Meta");
        assert.equal(await status(), off);
      };
      /** @param {string} key @param {string} code */
      const press = async (key, code, text = "") => {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers: held });
        if (text && !held) await send("Input.dispatchKeyEvent", { type: "char", key, code, text });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: held });
        await sleep(120);
      };
      /** @param {string} type @param {number} x @param {number} y @param {Record<string, unknown>} [extra] */
      const mouse = (type, x, y, extra = {}) =>
        send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, modifiers: held, ...extra });
      const click = async (x, y) => {
        await mouse("mouseMoved", x, y, { button: "none", clickCount: 0 });
        await mouse("mousePressed", x, y, { buttons: 1 });
        await mouse("mouseReleased", x, y, { buttons: 0 });
        await sleep(400);
      };
      const status = () =>
        evaluate(`(() => {
          const badge = document.getElementById("modeState");
          return [
            "notes:" + (document.body.dataset.notes === "true"),
            "controls:" + (document.body.dataset.controls === "true"),
            "badge:" + (badge.hidden ? "none" : badge.textContent),
          ].join(" ");
        })()`);
      const off = "notes:false controls:false badge:none";
      const notesOn = "notes:true controls:false badge:Notes⌘";
      const controlsOn = "notes:false controls:true badge:Controls⌥";

      /** Where an element of the desktop design sits on the board's screen. */
      async function pointInDesign(selector) {
        const target = (await list()).find((entry) => entry.type === "iframe" && entry.url.includes("device=desktop"));
        assert.ok(target, "no desktop frame");
        const { sessionId } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
        const inner = await evaluate(
          `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 }; })()`,
          sessionId,
        );
        const frame = await evaluate(
          `(() => { const f = [...document.querySelectorAll(".artboard iframe")].find((f) => f.src.includes("device=desktop")); const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / f.offsetWidth }; })()`,
        );
        return { x: frame.left + inner.x * frame.scale, y: frame.top + inner.y * frame.scale, sessionId };
      }
      const hovered = () =>
        evaluate(`document.querySelector('.artboard[data-device="desktop"]')?.dataset.hover === "true"`);

      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(2500);
      // The first cursor entry shows a one-time hint; move there once so it is spent.
      const title = await pointInDesign("#title");
      await mouse("mouseMoved", title.x, title.y, { button: "none", clickCount: 0 });
      await sleep(300);

      assert.equal(await status(), off);
      await tap("Meta");
      assert.equal(await status(), notesOn, "a lone Cmd tap turns notes on");
      assert.equal(await evaluate(`document.body.dataset.gesture`), "annotate");
      assert.equal(await hovered(), true, "notes outline the element under a still pointer");
      await tap("Meta");
      assert.equal(await status(), off, "the next Cmd tap turns notes off");

      await tap("Alt");
      assert.equal(await status(), controlsOn, "a lone Option tap turns the controls selector on");
      assert.equal(await evaluate(`document.body.dataset.gesture`), "tune");
      assert.equal(await hovered(), true, "the selector outlines the element under a still pointer");
      await tap("Meta");
      assert.equal(await status(), notesOn, "Cmd while the selector is on swaps to notes");
      await tap("Alt");
      assert.equal(await status(), controlsOn, "Option while notes are on swaps to the selector");
      await press("Escape", "Escape");
      assert.equal(await status(), off, "Escape turns the selector off");
      await tap("Meta");
      await press("Escape", "Escape");
      assert.equal(await status(), off, "Escape turns notes off");

      // Chords flip nothing: Cmd+C, Cmd+Z, Cmd+scroll, Cmd+click, Option+drag, Cmd+Option.
      await down("Meta");
      await press("c", "KeyC");
      await press("z", "KeyZ");
      await up("Meta");
      assert.equal(await status(), off, "Cmd+C and Cmd+Z leave notes off");
      const zoomBefore = await evaluate(`document.getElementById("zoomLabel").textContent`);
      await down("Meta");
      await mouse("mouseWheel", title.x, title.y, { button: "none", clickCount: 0, deltaX: 0, deltaY: -120 });
      await sleep(200);
      await up("Meta");
      assert.equal(await status(), off, "Cmd+scroll leaves notes off");
      assert.notEqual(
        await evaluate(`document.getElementById("zoomLabel").textContent`),
        zoomBefore,
        "Cmd+scroll zooms",
      );
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "0", code: "Digit0", modifiers: 0 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "0", code: "Digit0", modifiers: 0 });
      await sleep(500);
      const fitted = await pointInDesign("#title");
      await down("Alt");
      await mouse("mouseMoved", fitted.x, fitted.y, { button: "none", clickCount: 0 });
      await mouse("mousePressed", fitted.x, fitted.y, { buttons: 1 });
      await mouse("mouseMoved", fitted.x + 40, fitted.y + 10, { buttons: 1 });
      await mouse("mouseReleased", fitted.x + 40, fitted.y + 10, { buttons: 0 });
      await up("Alt");
      assert.equal(await status(), off, "Option+drag leaves the selector off");
      await down("Meta");
      await tap("Alt");
      await up("Meta");
      assert.equal(await status(), off, "Cmd and Option pressed together flip neither");
      await tap("Meta");
      await down("Alt");
      await press("c", "KeyC");
      await up("Alt");
      assert.equal(await status(), notesOn, "an Option chord leaves notes as they were");
      await tap("Meta");

      // A release lost to another app (Cmd-Tab) flips nothing and leaves nothing stuck.
      await down("Meta");
      await evaluate(`window.dispatchEvent(new Event("blur"))`);
      await up("Meta");
      assert.equal(await status(), off, "a Cmd release lost to another app leaves notes off");
      await down("Meta");
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", modifiers: held });
      await evaluate(`window.dispatchEvent(new Event("blur"))`);
      await up("Meta");
      assert.equal(await status(), off, "Cmd-Tab leaves notes off");
      await rejectsNonTaps("board");

      // With both modes off a click belongs to the page: it focuses the design's field.
      const field = await pointInDesign("#field");
      await click(field.x, field.y);
      assert.equal(await evaluate(`document.activeElement?.id || ""`, field.sessionId), "field");
      assert.equal(await evaluate(`document.querySelector(".note-pop") ? "note" : "none"`), "none");
      await press("a", "KeyA", "a");
      assert.equal(await evaluate(`document.getElementById("field").value`, field.sessionId), "a");

      // Focus inside the design: the frame reports the taps, chords and Escape.
      await tap("Meta");
      assert.equal(await status(), notesOn, "a Cmd tap from a focused design turns notes on");
      await tap("Alt");
      assert.equal(await status(), controlsOn, "an Option tap from a focused design swaps to the selector");
      await press("Escape", "Escape");
      assert.equal(await status(), off, "Escape from a focused design turns the selector off");
      await down("Meta");
      await press("c", "KeyC");
      await up("Meta");
      assert.equal(await status(), off, "Cmd+C in a focused design flips nothing");
      await down("Meta");
      await evaluate(`window.dispatchEvent(new Event("blur"))`, field.sessionId);
      await evaluate(`window.dispatchEvent(new Event("blur"))`);
      await up("Meta");
      assert.equal(await status(), off, "a lost release from a focused design flips nothing");
      await evaluate(`document.getElementById("field").focus()`, field.sessionId);
      await rejectsNonTaps("focused design");

      // The selector picks an element into Controls and stays on for the next one.
      await tap("Alt");
      await click(title.x, title.y);
      const fresh = await pointInDesign("#title");
      await click(fresh.x, fresh.y);
      assert.equal(await evaluate(`document.getElementById("chat").dataset.view`), "controls");
      assert.equal(await evaluate(`document.getElementById("tuneLoaded").hidden`), false, "Controls shows the pick");
      assert.equal(await status(), controlsOn, "the selector stays on after a pick");
      await press("Escape", "Escape");
      assert.equal(await status(), off);
      assert.equal(await evaluate(`document.getElementById("tuneLoaded").hidden`), false, "Escape kept the pick");

      // Tab still switches the sidebar between Chat and Controls, once focus is back on
      // the board: in the design's field it stays the field's.
      await evaluate(`document.activeElement?.blur()`);
      await press("Tab", "Tab");
      assert.equal(await evaluate(`document.getElementById("chat").dataset.view`), "chat");
      await press("Tab", "Tab");
      assert.equal(await evaluate(`document.getElementById("chat").dataset.view`), "controls");

      // A view change keeps the toggles working, and Space still holds the hand.
      await evaluate(`document.querySelector('#devices [data-device="desktop"]').click()`);
      await sleep(1500);
      await tap("Meta");
      assert.equal(await status(), notesOn, "Cmd toggles after a view change");
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", modifiers: 0 });
      await sleep(120);
      assert.equal(await evaluate(`document.body.dataset.gesture`), "hand");
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", modifiers: 0 });
      await sleep(120);
      assert.equal(await evaluate(`document.body.dataset.gesture`), "annotate", "letting go of Space returns to notes");
      await tap("Meta");
      assert.equal(await status(), off);

      // Clicked into a busy design in Desktop view: the design's own work holds each keyup
      // back past the tap limit before the frame can report it. A quick tap still toggles,
      // because a tap is timed by the keys themselves, and a click then leaves a note.
      const busy = await pointInDesign("#title");
      await click(busy.x, busy.y);
      assert.equal(await evaluate(`document.hasFocus()`, busy.sessionId), true, "the click focused the design");
      await evaluate(
        `document.addEventListener("keydown", () => setTimeout(() => { const t = performance.now(); while (performance.now() - t < 500) {} }))`,
        busy.sessionId,
      );
      /** @param {"Meta" | "Alt"} name */
      const quickTap = async (name) => {
        await down(name);
        await sleep(100);
        await up(name);
        await sleep(500);
      };
      await quickTap("Meta");
      assert.equal(await status(), notesOn, "a quick Cmd tap from a busy focused design turns notes on");
      await quickTap("Alt");
      assert.equal(await status(), controlsOn, "a quick Option tap from a busy focused design swaps to the selector");
      await quickTap("Meta");
      assert.equal(await status(), notesOn);
      const noted = await pointInDesign("#title");
      await click(noted.x, noted.y);
      assert.equal(
        await evaluate(`document.querySelector(".note-pop") ? "note" : "none"`),
        "note",
        "the click leaves a note",
      );
      await press("Escape", "Escape");
      await press("Escape", "Escape");
      assert.equal(await status(), off);
      await click(noted.x, noted.y);
      await down("Meta");
      await sleep(600);
      await up("Meta");
      await sleep(500);
      assert.equal(await status(), off, "a long Cmd hold in a busy focused design still leaves notes off");

      await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
      await sleep(1000);
      const home = await evaluate(`document.body.innerText`);
      assert.match(home, /Easel/, home);
      assert.match(home, /board/, home);
    } finally {
      browser?.close();
      run(process.execPath, ["bin/easel.js", "stop", "--port", String(port)], easelEnv, 15_000);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
