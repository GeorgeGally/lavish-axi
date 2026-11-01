import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findChrome } from "../src/board-crop.js";
import { serve } from "../src/server.js";
import { launchChrome } from "./board-cdp-browser.js";

const runBrowserE2e = process.env.LIESEL_BROWSER_E2E === "1";
// Set to a folder to keep screenshots of each step.
const shotsDir = process.env.LIESEL_RUNNER_SHOTS || "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>hero</title><style>
body { margin: 0; font: 16px sans-serif; } h1 { margin: 0; padding: 40px; font-size: 48px; }
</style></head><body><h1 id="title">The whole fleet</h1></body></html>
`;

// Stands in for a coding agent: reads the notes on stdin, edits the board's item, says so.
const FAKE_AGENT = `
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  process.stdout.write("Reading the notes...\\n");
  await new Promise((r) => setTimeout(r, 1500));
  const file = path.join(process.env.LIESEL_BOARD_DIR, "01-hero.html");
  const note = (input.match(/Note: (.*)/) || [])[1] || "";
  await writeFile(file, (await readFile(file, "utf8")).replace("The whole fleet", note.slice(0, 60)));
  process.stdout.write("Set the headline to your words.\\n");
});
`;

test(
  "the Agent tab picks an installed agent, and a sent note runs it, edits the item and answers in Chat",
  { skip: !runBrowserE2e || !findChrome(), timeout: 120_000 },
  async () => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-runner-e2e-")));
    const profile = path.join(temp, "chrome");
    await mkdir(profile, { recursive: true });
    const boardDir = path.join(temp, "board");
    await mkdir(boardDir, { recursive: true });
    await writeFile(path.join(boardDir, "01-hero.html"), ITEM_HTML);
    const agentScript = path.join(temp, "fake-agent.mjs");
    await writeFile(agentScript, FAKE_AGENT);
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
    /** @type {Awaited<ReturnType<typeof launchChrome>> | null} */
    let browser = null;
    const shoot = async (name) => {
      if (!shotsDir || !browser) return;
      await mkdir(shotsDir, { recursive: true });
      const { data } = await browser.send("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(shotsDir, `${name}.png`), Buffer.from(data, "base64"));
    };
    try {
      const opened = await fetch(`${base}/api/boards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: boardDir }),
      }).then((response) => response.json());
      assert.ok(opened.url, JSON.stringify(opened));
      const chrome = findChrome();
      assert.ok(chrome);
      browser = await launchChrome(chrome, profile);
      const { send, evaluate } = browser;
      await send("Page.enable");
      await send("Page.navigate", { url: opened.url });
      const until = async (expression, label, tries = 150) => {
        for (let i = 0; i < tries; i++) {
          if (await evaluate(expression).catch(() => false)) return;
          await sleep(100);
        }
        throw new Error(`timed out: ${label}`);
      };
      await until(`document.readyState === "complete" && !!document.getElementById("sideTabAgent")`, "board loaded");

      // Agent tab: only installed agents plus Custom, defaulting to the board's own folder.
      await evaluate(`document.getElementById("sideTabAgent").click()`);
      await until(`document.getElementById("agentSelect").options.length > 1`, "agents listed");
      const view = await fetch(`${base}/api/boards/${opened.key}/runner`).then((response) => response.json());
      const offered = await evaluate(`[...document.getElementById("agentSelect").options].map((o) => o.value)`);
      assert.deepEqual(offered, ["off", ...view.agents.map((agent) => agent.id)]);
      assert.equal(offered.at(-1), "custom");
      assert.equal(await evaluate(`document.getElementById("agentCwd").value`), boardDir);
      assert.equal(await evaluate(`document.getElementById("agentCommandField").hidden`), true);
      await shoot("01-agent-tab");

      await evaluate(`(() => {
        const select = document.getElementById("agentSelect");
        select.value = "custom";
        select.dispatchEvent(new Event("change"));
        document.getElementById("agentCommand").value = ${JSON.stringify(`"${process.execPath}" "${agentScript}"`)};
      })()`);
      assert.equal(await evaluate(`document.getElementById("agentCommandField").hidden`), false);
      await shoot("02-custom-command");
      await evaluate(`document.getElementById("agentSave").click()`);
      await until(`/^Saved/.test(document.getElementById("agentSaveStatus").textContent)`, "saved");
      assert.doesNotMatch(await readFile(path.join(boardDir, "board.json"), "utf8"), /fake-agent/);

      // Send a note from Chat; the agent starts at once.
      await evaluate(`document.getElementById("sideTabChat").click()`);
      await evaluate(`(() => {
        const input = document.getElementById("composerInput");
        input.value = "Hello from the runner";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("send").click();
      })()`);
      await until(`!document.getElementById("runnerLine").hidden`, "runner line shows");
      assert.match(
        await evaluate(`document.getElementById("runnerLine").textContent`),
        /^Custom command is working on 1 noteOutput$/,
      );
      assert.equal(await evaluate(`document.getElementById("agentTabDot").dataset.state`), "running");
      await shoot("03-chat-running");

      await until(`document.getElementById("runnerLine").hidden`, "run finishes", 300);
      await until(
        `[...document.querySelectorAll("#chatLog *")].some((node) => /Set the headline to your words/.test(node.textContent))`,
        "reply in chat",
      );
      assert.match(await readFile(path.join(boardDir, "01-hero.html"), "utf8"), /Hello from the runner/);
      await shoot("04-chat-replied");

      await evaluate(`document.getElementById("sideTabAgent").click()`);
      await until(`document.getElementById("agentRunState").dataset.state === "finished"`, "finished state");
      assert.match(await evaluate(`document.getElementById("agentOutput").textContent`), /Reading the notes/);
      await shoot("05-agent-finished");
    } finally {
      browser?.close();
      await server.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
