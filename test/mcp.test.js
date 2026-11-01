import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLieselMcpTools, createMcpHandler, runMcpStdio } from "../src/mcp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeTools(calls = []) {
  return createLieselMcpTools({
    openBoard: async (args) => (calls.push(["open", args]), { board: { url: "http://x/board/k" } }),
    boardStatus: async (args) => (calls.push(["status", args]), { board: {} }),
    poll: async (args) => (calls.push(["poll", args]), { session: { status: "waiting" } }),
    reply: async (args) => {
      calls.push(["reply", args]);
      if (!args.message) throw Object.assign(new Error("The reply was empty"), { code: "VALIDATION_ERROR" });
      return { reply: { status: "sent" } };
    },
  });
}

test("the MCP handler answers initialize, ping, tools/list and tools/call", async () => {
  const calls = [];
  const handle = createMcpHandler({ tools: fakeTools(calls), name: "liesel", version: "1.2.3", instructions: "hi" });
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(init.result.serverInfo, { name: "liesel", version: "1.2.3" });
  assert.ok(init.result.capabilities.tools);
  const unknownVersion = await handle({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "1999" },
  });
  assert.equal(unknownVersion.result.protocolVersion, "2025-06-18");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual((await handle({ jsonrpc: "2.0", id: 3, method: "ping" })).result, {});
  const listed = await handle({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["liesel_board_open", "liesel_board_status", "liesel_poll", "liesel_reply"],
  );
  for (const tool of listed.result.tools) assert.equal(tool.inputSchema.type, "object");

  const polled = await handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "liesel_poll", arguments: { board: "/b", timeout_seconds: 5, reply: "  " } },
  });
  assert.deepEqual(JSON.parse(polled.result.content[0].text), { session: { status: "waiting" } });
  assert.deepEqual(calls.at(-1), ["poll", { board: "/b", timeout_seconds: 5 }], "a blank reply is not sent");

  const failed = await handle({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "liesel_reply", arguments: { board: "/b", message: "" } },
  });
  assert.equal(failed.result.isError, true);
  assert.equal(JSON.parse(failed.result.content[0].text).code, "VALIDATION_ERROR");

  const unknownTool = await handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } });
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = await handle({ jsonrpc: "2.0", id: 8, method: "resources/list" });
  assert.equal(unknownMethod.error.code, -32601);
  assert.equal((await handle({ id: 9, method: "ping" })).error.code, -32600);
});

test("the stdio transport answers line by line and reports parse errors", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  readline.createInterface({ input: output }).on("line", (line) => lines.push(JSON.parse(line)));
  const done = runMcpStdio({ handle: createMcpHandler({ tools: fakeTools() }), input, output });
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write("not json\n");
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.find((line) => line.id === 1).result, {});
  assert.equal(lines.find((line) => line.error?.code === -32700).id, null);
  assert.equal(lines.find((line) => line.id === 2).result.tools.length, 4);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined)));
  const address = /** @type {net.AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

test("liesel mcp drives a real board: open, poll a note, reply", { timeout: 60_000 }, async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-mcp-")));
  const board = path.join(temp, "board");
  await mkdir(board, { recursive: true });
  await writeFile(path.join(board, "01-hero.html"), "<!doctype html><html><body><h1>Hi</h1></body></html>");
  const port = await freePort();
  const env = {
    ...process.env,
    LIESEL_PORT: String(port),
    LIESEL_STATE_DIR: path.join(temp, "state"),
    LIESEL_NO_OPEN: "1",
    LIESEL_TELEMETRY: "0",
    LIESEL_HOST: "127.0.0.1",
    LIESEL_LINK_HOST: "127.0.0.1",
    LIESEL_NOTIFY_CMD: "",
  };
  const child = spawn(process.execPath, ["bin/liesel.js", "mcp"], { cwd: repoRoot, env, stdio: "pipe" });
  t.after(async () => {
    child.kill();
    spawnSync(process.execPath, ["bin/liesel.js", "stop"], { cwd: repoRoot, env, timeout: 15_000 });
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  /** @type {Map<number, (value: any) => void>} */
  const waiting = new Map();
  const stray = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      stray.push(line);
      return;
    }
    waiting.get(message.id)?.(message);
  });
  let nextId = 1;
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name, args) => {
    const response = await rpc("tools/call", { name, arguments: args });
    assert.ok(response.result, JSON.stringify(response));
    const body = JSON.parse(response.result.content[0].text);
    assert.notEqual(response.result.isError, true, JSON.stringify(body));
    return body;
  };

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } });
  assert.equal(init.result.serverInfo.name, "liesel");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const opened = await call("liesel_board_open", { board });
  assert.match(opened.board.url, /\/board\/[0-9a-f]+$/);
  const key = opened.board.url.split("/").pop();
  const status = await call("liesel_board_status", { board });
  assert.deepEqual(
    status.board.items.map((item) => item.file),
    ["01-hero.html"],
  );

  const waitingPoll = await call("liesel_poll", { board, timeout_seconds: 1 });
  assert.equal(waitingPoll.session.status, "waiting");

  const base = `http://127.0.0.1:${port}`;
  const poll = call("liesel_poll", { board, timeout_seconds: 20 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const queued = await fetch(`${base}/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      prompts: [
        { uid: "u1", prompt_id: "p1", prompt: "Bigger headline", tag: "pin", item: { id: "01-hero", label: "Hero" } },
      ],
      domSnapshot: "",
    }),
  });
  assert.equal(queued.status, 200);
  const feedback = await poll;
  assert.equal(feedback.session.status, "feedback");
  assert.equal(feedback.prompts[0].prompt, "Bigger headline");
  assert.match(feedback.next_step, /liesel_reply/);

  const replied = await call("liesel_reply", { board, message: "Made it bigger." });
  assert.equal(replied.reply.status, "sent");
  const after = await fetch(`${base}/api/boards/${key}`).then((response) => response.json());
  assert.equal(after.chat.at(-1).text, "Made it bigger.");
  assert.ok(after.chat.find((entry) => entry.prompt_id === "p1").done_at);
  assert.deepEqual(stray, [], "stdout carries only protocol messages");
});
