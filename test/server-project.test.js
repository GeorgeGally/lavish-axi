import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LIESEL_HOST = "127.0.0.1";
process.env.LIESEL_LINK_HOST = "127.0.0.1";

import { serve } from "../src/server.js";

// A stand-in dev server: it records that it ran, picks a free port, says where it is the
// way Vite and Next do, and serves two pages.
const FAKE_DEV = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_DEV_MARKER, String(process.pid));
const server = createServer((req, res) => {
  const page = req.url.split("?")[0];
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><html><head><title>Shop</title></head><body><h1 id=title>Shop " + page + "</h1></body></html>");
});
server.listen(0, "127.0.0.1", () => {
  console.log("  Local:   http://localhost:" + server.address().port + "/");
});
process.on("SIGTERM", () => process.exit(0));
`;

const FAKE_AGENT = `
import { appendFile } from "node:fs/promises";
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  await appendFile(process.env.FAKE_AGENT_LOG, JSON.stringify({ cwd: process.cwd(), prompt: input }) + "\\n");
  process.stdout.write("Made the title red.\\n");
});
`;

async function setup(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-project-server-")));
  const repo = path.join(dir, "shop");
  await mkdir(path.join(repo, ".git", "info"), { recursive: true });
  await writeFile(path.join(repo, ".git", "info", "exclude"), "");
  await writeFile(path.join(repo, "fake-dev.mjs"), FAKE_DEV);
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ scripts: { dev: "node fake-dev.mjs" }, devDependencies: { vite: "5" } }),
  );
  const agentScript = path.join(dir, "fake-agent.mjs");
  await writeFile(agentScript, FAKE_AGENT);
  const marker = path.join(dir, "dev-ran");
  const agentLog = path.join(dir, "agent-log.jsonl");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    detectTailscale: async () => null,
    idleTimeoutMs: null,
    env: { ...process.env, FAKE_DEV_MARKER: marker, FAKE_AGENT_LOG: agentLog, LIESEL_NOTIFY_CMD: "" },
    log: () => {},
  });
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, repo, base, marker, agentLog, agentCommand: `"${process.execPath}" "${agentScript}"` };
}

function write(base) {
  return { "content-type": "application/json", origin: base };
}

async function post(base, route, body, headers = write(base)) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function waitFor(check, { tries = 200, ms = 50 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  throw new Error("timed out waiting");
}

test("Open project keeps the board in the repo, out of git, and runs nothing until Start", async (t) => {
  const { base, repo, marker } = await setup(t);

  const foreign = await post(
    base,
    "/api/projects",
    { path: repo },
    { "content-type": "application/json", origin: "http://evil.example" },
  );
  assert.equal(foreign.status, 403);

  const opened = await post(base, "/api/projects", { path: repo });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.root, repo);
  assert.equal(opened.body.git_exclude, "added");
  assert.equal(opened.body.dir, path.join(repo, ".liesel"));
  assert.match(await readFile(path.join(repo, ".git", "info", "exclude"), "utf8"), /^\/\.liesel\/$/m);
  await assert.rejects(stat(path.join(repo, ".gitignore")), "the project's .gitignore is never written");
  const board = JSON.parse(await readFile(path.join(repo, ".liesel", "board.json"), "utf8"));
  assert.equal(board.name, "shop");
  assert.deepEqual(
    board.items.map((item) => [item.id, item.page]),
    [["home", "/"]],
  );

  const again = await post(base, "/api/projects", { path: repo });
  assert.equal(again.body.key, opened.body.key, "opening twice opens the same board");
  assert.equal(again.body.git_exclude, "present");

  const project = await fetch(`${base}/api/boards/${opened.body.key}/project`).then((response) => response.json());
  assert.equal(project.root, repo);
  assert.equal(project.name, "shop");
  assert.match(project.proxy, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(project.dev.status, "stopped");
  assert.equal(project.detected.command, "npm run dev");
  assert.equal(project.config, null);

  const idle = await fetch(`${project.proxy}/`);
  assert.equal(idle.status, 503);
  assert.match(await idle.text(), /No dev server yet/);

  const home = await fetch(`${base}/`).then((response) => response.text());
  assert.match(home, />shop<\/a>/);
  assert.match(home, /<span class="kind">Project<\/span>/);

  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(stat(marker), "nothing from the repo ran before Start");
});

test("a live page runs on the project's dev server with the SDK, and a note reaches the agent with its path and selector", async (t) => {
  const { base, repo, marker, agentLog, agentCommand } = await setup(t);
  const { body: opened } = await post(base, "/api/projects", { path: repo });
  const key = opened.key;

  const foreign = await post(
    base,
    `/api/boards/${key}/project/dev`,
    { command: "touch pwned" },
    {
      "content-type": "application/json",
      origin: "http://evil.example",
    },
  );
  assert.equal(foreign.status, 403);
  const startedEarly = await post(base, `/api/boards/${key}/project/start`, {});
  assert.equal(startedEarly.status, 400, "Start needs a command first");

  const saved = await post(base, `/api/boards/${key}/project/dev`, { command: "node fake-dev.mjs", port: "" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.config.command, "node fake-dev.mjs");
  assert.doesNotMatch(await readFile(path.join(repo, ".liesel", "board.json"), "utf8"), /fake-dev/);

  const started = await post(base, `/api/boards/${key}/project/start`, {});
  assert.equal(started.status, 200);
  const running = await waitFor(async () => {
    const view = await fetch(`${base}/api/boards/${key}/project`).then((response) => response.json());
    return view.dev.status === "running" ? view : null;
  });
  assert.ok(running.dev.port > 0);
  assert.ok((await stat(marker)).isFile());

  const page = await fetch(`${running.proxy}/store?x=1`).then((response) => response.text());
  assert.match(page, /<h1 id=title>Shop \/store<\/h1>/);
  assert.match(
    page,
    new RegExp(
      `<script src="${base}/board-sdk\\.js\\?key=${key}&live=1&v=9\\.9\\.9-test" data-liesel-live></script></body>`,
    ),
  );

  const added = await post(base, `/api/boards/${key}/pages`, { page: "/store" });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.item.id, "store");
  assert.equal(added.body.item.page, "/store");

  const runner = await post(base, `/api/boards/${key}/runner`, { agent: "custom", command: agentCommand });
  assert.equal(runner.status, 200, JSON.stringify(runner.body));
  assert.equal(runner.body.config.cwd, repo, "the agent works in the repo root");

  const queued = await post(base, `/api/${key}/prompts`, {
    prompts: [
      {
        uid: "u1",
        prompt_id: "p1",
        prompt: "Make the title red",
        tag: "pin",
        selector: "#title",
        thread: "n1",
        item: { id: "store", label: "/store", page: "/store?x=1" },
        pin: { id: "n1", number: 1, excerpt: "Shop /store" },
      },
    ],
    domSnapshot: "",
  });
  assert.equal(queued.status, 200);
  const call = await waitFor(async () => {
    const lines = (await readFile(agentLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
    return lines.length > 0 ? JSON.parse(lines[0]) : null;
  });
  assert.equal(call.cwd, repo);
  assert.match(call.prompt, /Project folder: /);
  assert.match(call.prompt, new RegExp(`Dev server: http://localhost:${running.dev.port}`));
  assert.match(call.prompt, /Live page \/store\?x=1 "\/store" \(id store, http:\/\/localhost:\d+\/store\?x=1\)/);
  assert.match(call.prompt, /Pin 1 on `#title` at path \/store\?x=1/);
  assert.match(call.prompt, /Make the title red/);

  const stopped = await post(base, `/api/boards/${key}/project/stop`, {});
  assert.equal(stopped.body.dev.status, "stopped");
  await waitFor(async () => {
    const view = await fetch(`${base}/api/boards/${key}/project`).then((response) => response.json());
    return view.dev.running === false;
  });
});

test("a live page's snapshot is saved script-free as a history round that resolves on the proxy", async (t) => {
  const { base, repo } = await setup(t);
  const { body: opened } = await post(base, "/api/projects", { path: repo });
  const key = opened.key;
  const html =
    "<!doctype html><html><head><title>Shop</title></head><body><h1>Shop</h1><script>alert(1)</script></body></html>";
  const foreign = await post(
    base,
    `/api/boards/${key}/live-snapshot`,
    { item: "home", html },
    {
      "content-type": "application/json",
      origin: "http://evil.example",
    },
  );
  assert.equal(foreign.status, 403);
  const first = await post(base, `/api/boards/${key}/live-snapshot`, { item: "home", html, page: "/" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.recorded, true);
  const repeat = await post(base, `/api/boards/${key}/live-snapshot`, { item: "home", html, page: "/" });
  assert.equal(repeat.body.recorded, false, "an unchanged page is not a new round");
  const hash = first.body.builds.at(-1).hash;
  const project = await fetch(`${base}/api/boards/${key}/project`).then((response) => response.json());
  const saved = await fetch(`${base}/board/${key}/item/home/build/${hash}?device=desktop`).then((response) =>
    response.text(),
  );
  assert.match(saved, new RegExp(`<head><base href="${project.proxy}/">`));
  assert.doesNotMatch(saved, /alert\(1\)/);
  assert.match(saved, new RegExp(`<script src="${base}/board-sdk\\.js\\?key=${key}&item=home&device=desktop`));
});
