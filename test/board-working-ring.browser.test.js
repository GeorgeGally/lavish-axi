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

const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>hero</title><style>
body { margin: 0; font: 16px sans-serif; } h1 { margin: 0; padding: 40px; font-size: 48px; }
</style></head><body><h1 id="title">The whole fleet</h1></body></html>
`;

// A note the agent has taken but not answered shows a thin turning ring around its
// number, on the pin in the design and on its thread in Chat, until the reply lands.
test(
  "A delivered note shows a working ring on its pin and thread until the agent replies",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-ring-e2e-")));
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    const boardDir = path.join(temp, "board");
    await mkdir(boardDir, { recursive: true });
    await writeFile(path.join(boardDir, "01-hero.html"), ITEM_HTML);
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
    const write = { "content-type": "application/json", origin: base };
    /** @type {Awaited<ReturnType<typeof launchChrome>> | null} */
    let browser = null;
    try {
      const opened = await fetch(`${base}/api/boards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: boardDir }),
      }).then((response) => response.json());
      assert.ok(opened.url, JSON.stringify(opened));
      const board = await fetch(`${base}/api/boards/${opened.key}`).then((response) => response.json());
      const item = board.items[0];
      const note = {
        id: "n1",
        number: 1,
        label: "The whole fleet",
        selector: "#title",
        tag: "h1",
        text: "Quieter",
        x: 60,
        y: 60,
        ox: 20,
        oy: 20,
        device: "desktop",
        prompt_id: "p-1",
      };
      const saved = await fetch(`${base}/api/boards/${opened.key}/notes`, {
        method: "POST",
        headers: write,
        body: JSON.stringify({
          item: item.id,
          notes: [note, { ...note, id: "n10", number: 10, x: 200, ox: 160, text: "Wider", prompt_id: "p-10" }],
        }),
      });
      assert.equal(saved.status, 200);
      const queued = await fetch(`${base}/api/${opened.key}/prompts`, {
        method: "POST",
        headers: write,
        body: JSON.stringify({
          prompts: [
            {
              uid: "u1",
              prompt_id: "p-1",
              prompt: "Quieter",
              selector: "#title",
              tag: "pin",
              item: { id: item.id, label: item.label },
              pin: { id: "n1", number: 1 },
              thread: "n1",
            },
            {
              uid: "u10",
              prompt_id: "p-10",
              prompt: "Wider",
              selector: "#title",
              tag: "pin",
              item: { id: item.id, label: item.label },
              pin: { id: "n10", number: 10 },
              thread: "n10",
            },
          ],
          domSnapshot: "",
        }),
      });
      assert.equal(queued.status, 200);

      const chrome = findChrome();
      assert.ok(chrome);
      browser = await launchChrome(chrome, profile);
      const { send, evaluate, list } = browser;
      await send("Page.enable");
      await send("Page.navigate", { url: opened.url });
      /** @param {string} expression @param {string} label @param {string} [session] */
      const until = async (expression, label, session) => {
        for (let i = 0; i < 150; i++) {
          if (await evaluate(expression, session).catch(() => false)) return;
          await sleep(100);
        }
        throw new Error(`timed out: ${label}`);
      };
      await until(`document.readyState === "complete" && !!document.querySelector(".artboard iframe")`, "board");
      let target;
      for (let i = 0; i < 100 && !target; i++) {
        target = (await list()).find((entry) => entry.type === "iframe" && entry.url.includes("device=desktop"));
        if (!target) await sleep(100);
      }
      assert.ok(target, "no desktop frame");
      const { sessionId: design } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
      const pin = `document.querySelector('.liesel-pin[data-pin="n1"]')`;
      const ringOnPin = `!!${pin}?.querySelector(".liesel-pin-ring")`;
      const ringOnThread = `!!document.querySelector(".thread-number.is-working")`;

      // Sent, not yet taken: a plain filled pin, no ring.
      await until(`${pin}?.dataset.state === "sent"`, "sent pin", design);
      assert.equal(await evaluate(ringOnPin, design), false);
      assert.equal(await evaluate(ringOnThread), false);

      // The agent takes it: the ring turns on the pin and on the thread's number.
      const polled = await fetch(
        `${base}/api/poll?file=${encodeURIComponent(path.join(boardDir, "board.json"))}&timeoutMs=4000`,
      ).then((response) => response.json());
      assert.equal(polled.status, "feedback");
      await until(`${pin}?.dataset.state === "working"`, "working pin", design);
      await until(ringOnPin, "ring on pin", design);
      assert.equal(
        await evaluate(`getComputedStyle(${pin}.querySelector(".liesel-pin-ring rect")).animationName`, design),
        "liesel-pin-turn",
      );
      // The ring follows the badge's own shape 2px off its edge, centred on it: a circle
      // for one digit, a pill for two, never a bigger circle off to one side.
      /** @param {string} id */
      const ringFit = (id) =>
        evaluate(
          `(() => {
            const badge = document.querySelector('.liesel-pin[data-pin="${id}"]');
            const rect = badge.querySelector(".liesel-pin-ring rect");
            const b = badge.getBoundingClientRect();
            const r = rect.getBoundingClientRect();
            const stroke = parseFloat(getComputedStyle(rect).strokeWidth);
            return {
              dx: Math.abs(r.left + r.width / 2 - (b.left + b.width / 2)),
              dy: Math.abs(r.top + r.height / 2 - (b.top + b.height / 2)),
              gapX: (r.width - stroke - b.width) / 2,
              gapY: (r.height - stroke - b.height) / 2,
              round: Math.abs(Number(rect.getAttribute("rx")) - r.height / 2),
              wide: r.width - r.height,
              stroke,
              color: getComputedStyle(rect).stroke,
            };
          })()`,
          design,
        );
      await until(`!!document.querySelector('.liesel-pin[data-pin="n10"] .liesel-pin-ring')`, "ring on 10", design);
      for (const { id, pill } of [
        { id: "n1", pill: false },
        { id: "n10", pill: true },
      ]) {
        const fit = await ringFit(id);
        assert.ok(fit.dx < 0.5 && fit.dy < 0.5, `${id} ring centred: ${JSON.stringify(fit)}`);
        assert.ok(Math.abs(fit.gapX - 2) < 0.5 && Math.abs(fit.gapY - 2) < 0.5, `${id} gap: ${JSON.stringify(fit)}`);
        assert.ok(fit.round < 0.5, `${id} ends are round: ${JSON.stringify(fit)}`);
        assert.equal(fit.wide > 4, pill, `${id} shape: ${JSON.stringify(fit)}`);
        assert.ok(fit.stroke >= 1.5 && fit.stroke <= 2, `${id} thin stroke: ${JSON.stringify(fit)}`);
        assert.equal(fit.color, "rgb(255, 255, 255)");
      }
      await until(ringOnThread, "ring on thread");

      // The reply lands: the ring goes and the pin leaves the design for the gutter.
      const reply = await fetch(`${base}/api/${opened.key}/agent-reply`, {
        method: "POST",
        headers: write,
        body: JSON.stringify({ agent_reply: "Made it quieter." }),
      });
      assert.equal(reply.status, 200);
      await until(`!${pin}`, "pin parked", design);
      await until(`!document.querySelector(".thread-number.is-working")`, "thread ring gone");
    } finally {
      browser?.close();
      await server.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
