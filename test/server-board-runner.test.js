import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LIESEL_HOST = "127.0.0.1";
process.env.LIESEL_LINK_HOST = "127.0.0.1";

import { boardFilePath } from "../src/board.js";
import { serve } from "../src/server.js";

// A stand-in for a coding agent: reads the prompt on stdin, edits every item file the
// prompt names, logs the prompt it saw, and prints its answer.
const FAKE_AGENT = `
import { appendFile, readFile, writeFile } from "node:fs/promises";
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  await appendFile(process.env.FAKE_AGENT_LOG, JSON.stringify({ cwd: process.cwd(), prompt: input }) + "\\n");
  if (process.env.FAKE_AGENT_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_AGENT_DELAY)));
  if (input.includes("FAIL")) {
    process.stderr.write("agent blew up\\n");
    process.exit(2);
  }
  for (const match of input.matchAll(/file (\\/[^)]+\\.html)\\)/g)) {
    const html = await readFile(match[1], "utf8");
    await writeFile(match[1], html.replace("The whole fleet", "Edited by agent"));
  }
  process.stdout.write("working...\\n");
  process.stdout.write("Changed the headline.\\n");
});
`;

async function setup(t, { delay = "" } = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-runner-server-")));
  const boardDirectory = path.join(dir, "hero");
  await mkdir(boardDirectory, { recursive: true });
  await writeFile(
    path.join(boardDirectory, "v1.html"),
    "<!doctype html><html><body><h1>The whole fleet</h1></body></html>",
  );
  const agentScript = path.join(dir, "fake-agent.mjs");
  await writeFile(agentScript, FAKE_AGENT);
  const agentLog = path.join(dir, "agent-log.jsonl");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    detectTailscale: async () => null,
    idleTimeoutMs: null,
    env: { ...process.env, FAKE_AGENT_LOG: agentLog, FAKE_AGENT_DELAY: delay, LIESEL_NOTIFY_CMD: "" },
    log: () => {},
  });
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    // The board's history mirror can still be landing as a test ends.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const registered = await fetch(`${base}/api/boards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: boardDirectory }),
  }).then((response) => response.json());
  return {
    dir,
    boardDirectory,
    base,
    key: registered.key,
    agentCommand: `"${process.execPath}" "${agentScript}"`,
    agentLog,
  };
}

function write(base) {
  return { "content-type": "application/json", origin: base };
}

async function setRunner(base, key, body) {
  const response = await fetch(`${base}/api/boards/${key}/runner`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function queueNote(base, key, text, extra = {}) {
  const response = await fetch(`${base}/api/${key}/prompts`, {
    method: "POST",
    headers: write(base),
    body: JSON.stringify({
      prompts: [{ uid: text, prompt_id: `p-${text.length}-${Date.now()}`, prompt: text, tag: "pin", ...extra }],
      domSnapshot: "",
    }),
  });
  assert.equal(response.status, 200);
}

async function runnerState(base, key) {
  return fetch(`${base}/api/boards/${key}/runner`).then((response) => response.json());
}

async function waitFor(check, { tries = 200, ms = 50 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  throw new Error("timed out waiting");
}

async function agentCalls(agentLog) {
  return (await readFile(agentLog, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("nothing runs until the user picks an agent; the notes wait for a poll", async (t) => {
  const { base, key, boardDirectory, agentLog } = await setup(t);
  const view = await runnerState(base, key);
  assert.equal(view.config, null);
  assert.equal(view.run, null);
  assert.ok(view.agents.some((agent) => agent.id === "custom"));
  assert.equal(view.default_cwd, await realpath(boardDirectory));

  await queueNote(base, key, "Too loud", { item: { id: "v1", label: "v1" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await agentCalls(agentLog), []);
  const polled = await fetch(
    `${base}/api/poll?file=${encodeURIComponent(boardFilePath(boardDirectory))}&timeoutMs=2000`,
  ).then((response) => response.json());
  assert.equal(polled.status, "feedback");
  assert.equal(polled.prompts.length, 1);
});

test("a sent note runs the board's agent in its folder, edits the item and posts the reply", async (t) => {
  const { base, key, boardDirectory, agentCommand, agentLog, dir } = await setup(t);
  const saved = await setRunner(base, key, { agent: "custom", command: agentCommand });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.config.cwd, await realpath(boardDirectory), "the folder defaults to the board's own");
  // The choice is this machine's, never written into the shareable board.json.
  assert.doesNotMatch(await readFile(boardFilePath(boardDirectory), "utf8"), /fake-agent|runner/);
  assert.match(await readFile(path.join(dir, "board-runners.json"), "utf8"), /fake-agent/);

  await queueNote(base, key, "Make it quieter $(touch pwned)", {
    item: { id: "v1", label: "v1" },
    selector: "h1",
    pin: { id: "n1", number: 1 },
    thread: "n1",
  });
  const finished = await waitFor(async () => {
    const view = await runnerState(base, key);
    return view.run?.status === "finished" ? view : null;
  });
  assert.equal(finished.run.reply, "working...\nChanged the headline.");
  assert.match(finished.run.output, /Changed the headline/);
  assert.equal(finished.run.notes, 1);
  assert.match(await readFile(path.join(boardDirectory, "v1.html"), "utf8"), /Edited by agent/);
  const [call] = await agentCalls(agentLog);
  assert.equal(call.cwd, await realpath(boardDirectory));
  assert.match(call.prompt, /Make it quieter \$\(touch pwned\)/);
  await assert.rejects(readFile(path.join(boardDirectory, "pwned")), "note text never reaches a shell");

  const board = await fetch(`${base}/api/boards/${key}`).then((response) => response.json());
  const note = board.chat.find((entry) => entry.role === "user");
  assert.ok(note.done_at, "the reply settles the note");
  assert.equal(board.chat.at(-1).role, "agent");
  assert.match(board.chat.at(-1).text, /Changed the headline/);
  assert.equal(board.pending_prompts, 0);
});

test("notes sent while the agent runs wait for the next run", async (t) => {
  const { base, key, agentCommand, agentLog } = await setup(t, { delay: "500" });
  await setRunner(base, key, { agent: "custom", command: agentCommand });
  await queueNote(base, key, "First note");
  await waitFor(async () => (await runnerState(base, key)).run?.status === "running");
  await queueNote(base, key, "Second note");
  const queued = await runnerState(base, key);
  assert.equal(queued.run.queued, true);
  await waitFor(async () => (await agentCalls(agentLog)).length === 2);
  await waitFor(async () => {
    const board = await fetch(`${base}/api/boards/${key}`).then((response) => response.json());
    return board.chat.filter((entry) => entry.role === "agent").length === 2;
  });
  const calls = await agentCalls(agentLog);
  assert.equal(calls.length, 2, "one run at a time, then one for what queued");
  assert.match(calls[0].prompt, /First note/);
  assert.doesNotMatch(calls[0].prompt, /Second note/);
  assert.match(calls[1].prompt, /Second note/);
  assert.doesNotMatch(calls[1].prompt, /First note/);
});

test("a failed run keeps its notes queued and shows the output", async (t) => {
  const { base, key, boardDirectory, agentCommand } = await setup(t);
  await setRunner(base, key, { agent: "custom", command: agentCommand });
  await queueNote(base, key, "FAIL please");
  const failed = await waitFor(async () => {
    const view = await runnerState(base, key);
    return view.run?.status === "failed" ? view : null;
  });
  assert.equal(failed.run.error, "Exited with 2");
  assert.match(failed.run.output, /agent blew up/);
  assert.equal(failed.pending_prompts, 1, "the note goes back on the queue");
  const polled = await fetch(
    `${base}/api/poll?file=${encodeURIComponent(boardFilePath(boardDirectory))}&timeoutMs=2000`,
  ).then((response) => response.json());
  assert.equal(polled.status, "feedback");
  assert.match(polled.prompts[0].prompt, /FAIL please/);
});

test("a poll already listening keeps the board's notes", async (t) => {
  const { base, key, boardDirectory, agentCommand, agentLog } = await setup(t);
  await setRunner(base, key, { agent: "custom", command: agentCommand });
  const poll = fetch(`${base}/api/poll?file=${encodeURIComponent(boardFilePath(boardDirectory))}&timeoutMs=4000`).then(
    (response) => response.json(),
  );
  await waitFor(async () => (await runnerState(base, key)).listener);
  await queueNote(base, key, "For the poller");
  const polled = await poll;
  assert.equal(polled.status, "feedback");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(await agentCalls(agentLog), []);
});

test("choosing the agent is same-origin only and validates the agent and folder", async (t) => {
  const { base, key, agentCommand, dir } = await setup(t);
  const foreign = await fetch(`${base}/api/boards/${key}/runner`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ agent: "custom", command: "touch pwned" }),
  });
  assert.equal(foreign.status, 403);
  const headerless = await fetch(`${base}/api/boards/${key}/runner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "custom", command: "touch pwned" }),
  });
  assert.equal(headerless.status, 403, "a header-less request cannot set a command either");
  const foreignRead = await fetch(`${base}/api/boards/${key}/runner`, { headers: { origin: "https://evil.example" } });
  assert.equal(foreignRead.status, 403);
  const unknown = await setRunner(base, key, { agent: "not-an-agent", cwd: dir });
  assert.equal(unknown.status, 400);
  const missingFolder = await setRunner(base, key, {
    agent: "custom",
    command: agentCommand,
    cwd: path.join(dir, "nope"),
  });
  assert.equal(missingFolder.status, 400);
  assert.match(missingFolder.body.error, /does not exist/);
  const elsewhere = await setRunner(base, key, { agent: "custom", command: agentCommand, cwd: dir });
  assert.equal(elsewhere.body.config.cwd, dir);
  const off = await setRunner(base, key, { agent: "off" });
  assert.equal(off.body.config, null);
});

test("Stop ends a run and puts its notes back", async (t) => {
  const { base, key, agentCommand } = await setup(t, { delay: "20000" });
  await setRunner(base, key, { agent: "custom", command: agentCommand });
  await queueNote(base, key, "Slow one");
  await waitFor(async () => (await runnerState(base, key)).run?.status === "running");
  const stop = await fetch(`${base}/api/boards/${key}/runner/stop`, { method: "POST", headers: write(base) });
  assert.equal(stop.status, 200);
  const stopped = await waitFor(async () => {
    const view = await runnerState(base, key);
    return view.run?.status === "failed" ? view : null;
  });
  assert.equal(stopped.run.error, "Stopped");
  assert.equal(stopped.pending_prompts, 1);
});
