import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
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

const ITEM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>gestures</title></head>
<body><h1 id="title">Gestures</h1><input id="field"></body></html>
`;

// Cmd is a toggle: a lone press and release turns notes on, the next turns them off,
// and Cmd used in a shortcut, or lost to another app, flips nothing. The keys are
// dispatched on the board window, which is where the frame's reports land too.
const GESTURE_SCRIPT = `(() => {
  const key = (type, value, extra = {}) =>
    window.dispatchEvent(new KeyboardEvent(type, { key: value, bubbles: true, ...extra }));
  const notes = () => document.body.dataset.notes;
  const out = [];
  key("keydown", "Meta", { metaKey: true });
  key("keyup", "Meta");
  out.push("lone:" + notes());
  key("keydown", "Meta", { metaKey: true });
  key("keydown", "c", { code: "KeyC", metaKey: true });
  key("keyup", "Meta");
  out.push("chord:" + notes());
  key("keydown", "Escape", { code: "Escape" });
  out.push("escape:" + notes());
  key("keydown", "Meta", { metaKey: true });
  window.dispatchEvent(new Event("blur"));
  key("keyup", "Meta");
  out.push("lost:" + notes());
  key("keydown", " ", { code: "Space" });
  out.push("space:" + document.body.dataset.gesture);
  key("keyup", " ", { code: "Space" });
  out.push("released:" + (document.body.dataset.gesture || "none"));
  return out.join(" ");
})()`;

test(
  "Cmd toggles board notes, a chord or a lost release never flips it, and Space holds the hand",
  { skip: !runBrowserE2e, timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "easel-gestures-e2e-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `easel-gestures-e2e-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);

    try {
      const board = path.join(temp, "board");
      await mkdir(board, { recursive: true });
      await writeFile(path.join(board, "01-gestures.html"), ITEM_HTML);
      const output = run(process.execPath, ["bin/lavish-axi.js", "board", "open", board, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      browser("open", url);
      browser("wait", "1500");
      const result = browser("eval", GESTURE_SCRIPT);
      assert.match(result, /lone:true chord:true escape:false lost:false space:hand released:none/, result);

      browser("open", `http://127.0.0.1:${port}/`);
      const home = browser("snapshot");
      assert.match(home, /heading "Easel"/, home);
      assert.match(home, /link "board"/, home);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
