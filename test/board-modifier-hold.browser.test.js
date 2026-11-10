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
<html><head><meta charset="utf-8"><title>hold</title><style>
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

// CDP modifier bits.
const ALT = 1;
const META = 4;
const MODIFIER = {
  Meta: { code: "MetaLeft", bit: META },
  Alt: { code: "AltLeft", bit: ALT },
};

// A tap of Cmd or Option toggles its mode for good; holding either one switches the mode
// only while it is held, so a reviewer can drop a note, pick an element, or reach the
// page's own buttons for a moment and be back where they were on release.
test(
  "holding Cmd or Option switches the mode only while held, and a click under the hold acts in that mode",
  { skip: !runBrowserE2e || !findChrome(), timeout: 240_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "liesel-hold-e2e-"));
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
      await writeFile(path.join(board, "01-hold.html"), ITEM_HTML);
      const output = run(process.execPath, ["bin/liesel.js", "board", "open", board, "--no-open"], lieselEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      browser = await launchChrome(findChrome(), profile);
      const { send, evaluate, list } = browser;
      let held = 0;
      /** @param {"Meta" | "Alt"} name */
      const down = async (name) => {
        held |= MODIFIER[name].bit;
        await send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: name,
          code: MODIFIER[name].code,
          modifiers: held,
        });
      };
      /** @param {"Meta" | "Alt"} name */
      const up = async (name) => {
        held &= ~MODIFIER[name].bit;
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: MODIFIER[name].code, modifiers: held });
        await sleep(150);
      };
      /** @param {"Meta" | "Alt"} name */
      const tap = async (name) => {
        await down(name);
        await up(name);
      };
      /** Press and keep holding past a tap. @param {"Meta" | "Alt"} name */
      const hold = async (name) => {
        await down(name);
        await sleep(600);
      };
      /** @param {string} key @param {string} code */
      const press = async (key, code) => {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers: held });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: held });
        await sleep(150);
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
      const mode = () => evaluate(`document.getElementById("modeState").dataset.mode || "view"`);

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
      const presses = async () => {
        const button = await pointInDesign("#press");
        return Number(await evaluate(`document.getElementById("press").dataset.count`, button.sessionId));
      };
      const notePop = () => evaluate(`document.querySelector(".note-pop") ? "note" : "none"`);

      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(2500);
      const title = await pointInDesign("#title");
      await mouse("mouseMoved", title.x, title.y, { button: "none", clickCount: 0 });
      await sleep(300);
      assert.equal(await mode(), "view");

      // From View: holding Cmd is Chat while held, and a click under it leaves a note.
      await hold("Meta");
      assert.equal(await mode(), "annotate", "holding Cmd turns notes on while held");
      await up("Meta");
      assert.equal(await mode(), "view", "letting Cmd go returns to View");
      await hold("Meta");
      await click(title.x, title.y);
      assert.equal(await notePop(), "note", "a click while Cmd is held leaves a note");
      await up("Meta");
      assert.equal(await mode(), "view", "after the held click, letting go returns to View");
      await press("Escape", "Escape");
      assert.equal(await notePop(), "none");

      // From View: holding Option is Edit while held, and its click picks the element.
      await hold("Alt");
      assert.equal(await mode(), "tune", "holding Option turns the controls selector on while held");
      await click(title.x, title.y);
      assert.equal(await evaluate(`document.getElementById("tuneLoaded").hidden`), false, "the held click picks");
      await up("Alt");
      assert.equal(await mode(), "view", "letting Option go returns to View");

      // From Chat: holding Cmd hands the page back while held, its buttons included.
      const button = await pointInDesign("#press");
      await tap("Meta");
      assert.equal(await mode(), "annotate", "a tap still latches notes on");
      const before = await presses();
      await click(button.x, button.y);
      assert.equal(await presses(), before, "with notes on a click never reaches the page");
      await press("Escape", "Escape");
      await hold("Meta");
      assert.equal(await mode(), "view", "holding Cmd in Chat is View while held");
      await click(button.x, button.y);
      assert.equal(await presses(), before + 1, "the page's own button takes the held click");
      await up("Meta");
      assert.equal(await mode(), "annotate", "letting Cmd go returns to Chat");

      // From Edit: holding Option hands the page back too, and Option never eats the click.
      await tap("Alt");
      assert.equal(await mode(), "tune");
      await hold("Alt");
      assert.equal(await mode(), "view", "holding Option in Edit is View while held");
      await click(button.x, button.y);
      assert.equal(await presses(), before + 2, "a click with Option held reaches the page in a held View");
      await up("Alt");
      assert.equal(await mode(), "tune", "letting Option go returns to Edit");
      await click(button.x, button.y);
      assert.equal(await presses(), before + 2, "back in Edit the page gets no click");
      await press("Escape", "Escape");
      await press("Escape", "Escape");
      assert.equal(await mode(), "view");

      // A shortcut under a hold ends it at once and leaves the latched mode as it was.
      await hold("Meta");
      assert.equal(await mode(), "annotate");
      await press("c", "KeyC");
      assert.equal(await mode(), "view", "Cmd+C ends the held mode at once");
      await up("Meta");
      assert.equal(await mode(), "view");

      // Focus inside the design: the frame's keys hold the mode too, and a lost release
      // (Cmd-Tab) leaves nothing stuck.
      await click(button.x, button.y);
      assert.equal(await evaluate(`document.hasFocus()`, button.sessionId), true, "the click focused the design");
      await hold("Meta");
      assert.equal(await mode(), "annotate", "holding Cmd in a focused design turns notes on while held");
      await up("Meta");
      assert.equal(await mode(), "view");
      await hold("Alt");
      assert.equal(await mode(), "tune", "holding Option in a focused design turns the selector on while held");
      await evaluate(`window.dispatchEvent(new Event("blur"))`, button.sessionId);
      await evaluate(`window.dispatchEvent(new Event("blur"))`);
      await sleep(150);
      assert.equal(await mode(), "view", "a release lost to another app ends the held mode");
      await up("Alt");
      assert.equal(await mode(), "view");
      await tap("Meta");
      assert.equal(await mode(), "annotate", "a tap still toggles after a lost hold");
      await tap("Meta");
      assert.equal(await mode(), "view");
    } finally {
      browser?.close();
      run(process.execPath, ["bin/liesel.js", "stop", "--port", String(port)], lieselEnv, 15_000);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
