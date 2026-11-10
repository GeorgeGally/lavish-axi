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
  // Installed already, so opening it never runs an install.
  await mkdir(path.join(repo, "node_modules"), { recursive: true });
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

test("Open project keeps the board in the repo, out of git, and gets its server going by itself", async (t) => {
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
  assert.equal(opened.body.created, true, "a first open says so, so the board asks which pages to show");
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
  assert.equal(again.body.created, false);
  assert.equal(again.body.git_exclude, "present");

  const project = await fetch(`${base}/api/boards/${opened.body.key}/project`).then((response) => response.json());
  assert.equal(project.root, repo);
  assert.equal(project.name, "shop");
  assert.match(project.proxy, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(project.detected.command, "npm run dev");

  // Nobody pressed anything: the server is started in the background.
  await waitFor(() => stat(marker).catch(() => null));
  const running = await waitFor(async () => {
    const view = await fetch(`${base}/api/boards/${opened.body.key}/project`).then((response) => response.json());
    return view.dev.status === "running" ? view : null;
  });
  assert.equal(running.mode, "dev");
  assert.equal(running.config.command, "npm run dev");

  const home = await fetch(`${base}/`).then((response) => response.text());
  assert.match(home, />shop<\/a>/);
  assert.match(home, /<span class="kind">Project<\/span>/);
  await post(base, `/api/boards/${opened.body.key}/project/stop`, {});
});

test("a starting frame is a quiet spinner that says nothing of the server", async (t) => {
  const { base, dir } = await setup(t);
  const slow = path.join(dir, "slow");
  await mkdir(path.join(slow, ".git", "info"), { recursive: true });
  await writeFile(path.join(slow, "slow.mjs"), "setTimeout(() => {}, 60000);\n");
  await writeFile(path.join(slow, "package.json"), JSON.stringify({ scripts: { dev: "node slow.mjs" } }));
  const { body: opened } = await post(base, "/api/projects", { path: slow });
  const view = await waitFor(async () => {
    const current = await fetch(`${base}/api/boards/${opened.key}/project`).then((response) => response.json());
    return current.dev.status === "starting" ? current : null;
  });
  const idle = await fetch(`${view.proxy}/`);
  assert.equal(idle.status, 503);
  const text = await idle.text();
  assert.match(text, /Getting the page ready/);
  assert.match(text, /<meta http-equiv="refresh" content="2">/, "a starting frame looks again by itself");
  assert.doesNotMatch(text, /npm run dev|localhost:|dev server/i, "no command, port or server words");
  await post(base, `/api/boards/${opened.key}/project/stop`, {});
});

test("the board opening keeps the server going; Stop holds until Start, and Restart runs it again", async (t) => {
  const { base, repo, marker } = await setup(t);
  const { body: opened } = await post(base, "/api/projects", { path: repo });
  const key = opened.key;

  const foreign = await post(
    base,
    `/api/boards/${key}/project/start`,
    { auto: true },
    { "content-type": "application/json", origin: "http://evil.example" },
  );
  assert.equal(foreign.status, 403);

  const auto = await post(base, `/api/boards/${key}/project/start`, { auto: true });
  assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.equal(auto.body.config.command, "npm run dev", "the detected command is accepted and kept on this machine");
  assert.doesNotMatch(await readFile(path.join(repo, ".liesel", "board.json"), "utf8"), /npm run dev/);
  const running = await waitFor(async () => {
    const view = await fetch(`${base}/api/boards/${key}/project`).then((response) => response.json());
    return view.dev.status === "running" ? view : null;
  });
  const firstPid = Number(await readFile(marker, "utf8"));
  assert.ok(firstPid > 0);
  const page = await waitFor(async () => {
    const text = await fetch(`${running.proxy}/`).then((response) => response.text());
    return /Shop \//.test(text) ? text : null;
  });
  assert.match(page, /<h1 id=title>Shop \/<\/h1>/);

  const again = await post(base, `/api/boards/${key}/project/start`, { auto: true });
  assert.equal(again.body.dev.running, true, "a second board tab leaves the running server alone");
  assert.equal(Number(await readFile(marker, "utf8")), firstPid, "and does not start another");

  const restarted = await post(base, `/api/boards/${key}/project/restart`, {});
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  await waitFor(async () => {
    const pid = Number(await readFile(marker, "utf8").catch(() => "0"));
    return pid && pid !== firstPid;
  });

  const stopped = await post(base, `/api/boards/${key}/project/stop`, {});
  assert.equal(stopped.body.user_stopped, true);
  await waitFor(async () => {
    const view = await fetch(`${base}/api/boards/${key}/project`).then((response) => response.json());
    return view.dev.running === false;
  });
  const reopened = await post(base, `/api/boards/${key}/project/start`, { auto: true });
  assert.equal(reopened.body.dev.running, false, "reopening the board does not undo a Stop");
  const held = await fetch(`${running.proxy}/`).then((response) => response.text());
  assert.match(held, /The project&#39;s server is stopped\.|The project's server is stopped\./);
  assert.match(held, /<button type="button" data-liesel-dev="start">Start<\/button>/);

  const started = await post(base, `/api/boards/${key}/project/start`, {});
  assert.equal(started.body.dev.running, true);
  assert.equal(started.body.user_stopped, false);
  await post(base, `/api/boards/${key}/project/stop`, {});
});

test("a dev server that dies is started again by itself", async (t) => {
  const { base, repo, marker } = await setup(t);
  const { body: opened } = await post(base, "/api/projects", { path: repo });
  const key = opened.key;
  await waitFor(async () => {
    const view = await fetch(`${base}/api/boards/${key}/project`).then((response) => response.json());
    return view.dev.status === "running" ? view : null;
  });
  const firstPid = Number(await readFile(marker, "utf8"));
  process.kill(firstPid, "SIGKILL");
  await waitFor(async () => {
    const pid = Number(await readFile(marker, "utf8").catch(() => "0"));
    return pid && pid !== firstPid;
  });
  const back = await waitFor(async () => {
    const view = await fetch(`${base}/api/boards/${key}/project`).then((response) => response.json());
    return view.dev.status === "running" ? view : null;
  });
  assert.equal(back.gave_up, false);
  const page = await waitFor(async () => {
    const text = await fetch(`${back.proxy}/`).then((response) => response.text());
    return /Shop \//.test(text) ? text : null;
  });
  assert.match(page, /<h1 id=title>Shop \/<\/h1>/);
  await post(base, `/api/boards/${key}/project/stop`, {});
});

test("a frame left open across a Liesel restart starts the project's server instead of spinning forever", async (t) => {
  const { base, dir, repo, marker } = await setup(t);
  const { body: opened } = await post(base, "/api/projects", { path: repo });
  await waitFor(async () => {
    const view = await fetch(`${base}/api/boards/${opened.key}/project`).then((response) => response.json());
    return view.dev.status === "running" ? view : null;
  });
  await post(base, `/api/boards/${opened.key}/project/stop`, {});
  await rm(marker, { force: true });
  // A new Liesel on the same state: the board page is not reopened, so nothing asks it to start.
  const next = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    detectTailscale: async () => null,
    idleTimeoutMs: null,
    env: { ...process.env, FAKE_DEV_MARKER: marker, LIESEL_NOTIFY_CMD: "" },
    log: () => {},
  });
  const nextBase = `http://127.0.0.1:${next.port}`;
  t.after(async () => {
    await post(nextBase, `/api/boards/${opened.key}/project/stop`, {}).catch(() => null);
    await next.close();
  });
  const idle = await fetch(`${nextBase}/api/boards/${opened.key}/project`).then((response) => response.json());
  assert.equal(idle.dev.status, "stopped");
  const page = await waitFor(async () => {
    const text = await fetch(`${idle.proxy}/`).then((response) => response.text());
    return /Shop \//.test(text) ? text : null;
  });
  assert.match(page, /<h1 id=title>Shop \/<\/h1>/, "the open frame's own refresh got the server going");
});

test("a server already running from the repo is reused, and replaced when it goes away", async (t) => {
  const { base, repo, marker } = await setup(t);
  const { spawn } = await import("node:child_process");
  const own = spawn(process.execPath, ["fake-dev.mjs"], {
    cwd: repo,
    env: { ...process.env, FAKE_DEV_MARKER: `${marker}.own` },
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => own.kill("SIGKILL"));
  await new Promise((resolve) => own.stdout.once("data", resolve));
  const { body: opened } = await post(base, "/api/projects", { path: repo });
  const reused = await waitFor(async () => {
    const view = await fetch(`${base}/api/boards/${opened.key}/project`).then((response) => response.json());
    return view.mode === "reused" ? view : view.dev.status === "running" ? view : null;
  });
  if (reused.mode !== "reused") {
    // No lsof here: reuse fails open and Liesel runs its own server instead.
    t.diagnostic("lsof unavailable; reuse not exercised");
    await post(base, `/api/boards/${opened.key}/project/stop`, {});
    return;
  }
  await assert.rejects(stat(marker), "Liesel started nothing of its own");
  assert.match(await fetch(`${reused.proxy}/`).then((response) => response.text()), /Shop \//);
  own.kill("SIGKILL");
  await new Promise((resolve) => own.once("close", resolve));
  // The next request finds it gone, and Liesel starts the project's server itself.
  await fetch(`${reused.proxy}/`).catch(() => null);
  await waitFor(() => stat(marker).catch(() => null));
  const own2 = await waitFor(async () => {
    const view = await fetch(`${base}/api/boards/${opened.key}/project`).then((response) => response.json());
    return view.mode === "dev" && view.dev.status === "running" ? view : null;
  });
  assert.match(await fetch(`${own2.proxy}/`).then((response) => response.text()), /Shop \//);
  await post(base, `/api/boards/${opened.key}/project/stop`, {});
});

test("a folder of HTML with no dev script is served by Liesel itself, and its pages are offered", async (t) => {
  const { base, dir } = await setup(t);
  const site = path.join(dir, "site");
  await mkdir(path.join(site, ".git", "info"), { recursive: true });
  await mkdir(path.join(site, "docs"), { recursive: true });
  await writeFile(path.join(site, "package.json"), JSON.stringify({ name: "site", dependencies: { viem: "2" } }));
  await writeFile(path.join(site, "index.html"), '<!doctype html><h1>Home</h1><a href="flow.html">Flow</a>');
  await writeFile(path.join(site, "flow.html"), "<!doctype html><h1>Flow</h1>");
  await writeFile(path.join(site, "privacy.html"), "<!doctype html><h1>Privacy</h1>");
  await writeFile(path.join(site, "docs", "index.html"), "<!doctype html><h1>Docs</h1>");
  await writeFile(path.join(site, ".env"), "SECRET=1");
  const { body: opened } = await post(base, "/api/projects", { path: site });
  const view = await waitFor(async () => {
    const current = await fetch(`${base}/api/boards/${opened.key}/project`).then((response) => response.json());
    return current.mode === "static" ? current : null;
  });
  assert.equal(view.issue, "", "no command is asked for");
  assert.match(await fetch(`${view.proxy}/flow.html`).then((response) => response.text()), /<h1>Flow<\/h1>/);
  assert.match(await fetch(`${view.proxy}/docs/`).then((response) => response.text()), /<h1>Docs<\/h1>/);
  assert.equal((await fetch(`${view.proxy}/.env`)).status, 404, "no dot file is served");
  assert.equal((await fetch(`${view.proxy}/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  await assert.rejects(stat(path.join(site, "node_modules")), "nothing is installed for a static site");

  const pages = await fetch(`${base}/api/boards/${opened.key}/project/pages`).then((response) => response.json());
  assert.deepEqual(
    pages.pages.map((page) => page.path),
    ["/", "/docs/", "/flow.html", "/privacy.html"],
  );
  const foreign = await fetch(`${base}/api/boards/${opened.key}/project/pages`, {
    headers: { origin: "http://evil.example" },
  });
  assert.equal(foreign.status, 403);
});

test("the page picker's choice becomes the board's live pages, and Undo brings a removed one back", async (t) => {
  const { base, repo } = await setup(t);
  const { body: opened } = await post(base, "/api/projects", { path: repo });
  const key = opened.key;
  const foreign = await post(
    base,
    `/api/boards/${key}/pages/set`,
    { pages: ["/"] },
    { "content-type": "application/json", origin: "http://evil.example" },
  );
  assert.equal(foreign.status, 403);

  const chosen = await post(base, `/api/boards/${key}/pages/set`, { pages: ["/", "/store", "/about"] });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  assert.deepEqual(chosen.body.added.map((item) => item.page).sort(), ["/about", "/store"]);
  assert.deepEqual(chosen.body.removed, []);

  const fewer = await post(base, `/api/boards/${key}/pages/set`, { pages: ["/store"] });
  assert.deepEqual(fewer.body.removed.map((entry) => entry.page).sort(), ["/", "/about"]);
  let board = await fetch(`${base}/api/boards/${key}`).then((response) => response.json());
  assert.deepEqual(
    board.items.map((item) => item.page),
    ["/store"],
  );
  const home = fewer.body.removed.find((entry) => entry.page === "/");
  const restored = await post(base, `/api/boards/${key}/restore`, { token: home.token });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.item.page, "/");
  board = await fetch(`${base}/api/boards/${key}`).then((response) => response.json());
  assert.deepEqual(board.items.map((item) => item.page).sort(), ["/", "/store"]);

  const bad = await post(base, `/api/boards/${key}/pages/set`, { pages: "nope" });
  assert.equal(bad.status, 400);
  await post(base, `/api/boards/${key}/project/stop`, {});
});

test("a board is renamed by its name, and keeps its address", async (t) => {
  const { base, repo } = await setup(t);
  const { body: opened } = await post(base, "/api/projects", { path: repo });
  const key = opened.key;
  const foreign = await post(
    base,
    `/api/boards/${key}/name`,
    { name: "Evil" },
    { "content-type": "application/json", origin: "http://evil.example" },
  );
  assert.equal(foreign.status, 403);
  const empty = await post(base, `/api/boards/${key}/name`, { name: "   " });
  assert.equal(empty.status, 400);
  const renamed = await post(base, `/api/boards/${key}/name`, { name: "  Shop   redesign " });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.name, "Shop redesign");
  const board = JSON.parse(await readFile(path.join(repo, ".liesel", "board.json"), "utf8"));
  assert.equal(board.name, "Shop redesign");
  const page = await fetch(`${base}/board/${key}`).then((response) => response.text());
  assert.match(page, /<title>Shop redesign · Liesel<\/title>/);
  assert.match(page, /id="boardName"[^>]*>Shop redesign<\/button>/);
  const home = await fetch(`${base}/`).then((response) => response.text());
  assert.match(home, />Shop redesign<\/a>/);
  await post(base, `/api/boards/${key}/project/stop`, {});
});

test("a project with nothing to run says so in one sentence, and a server that keeps failing offers Retry", async (t) => {
  const { base, dir } = await setup(t);
  const bare = path.join(dir, "bare");
  await mkdir(path.join(bare, ".git", "info"), { recursive: true });
  const { body: opened } = await post(base, "/api/projects", { path: bare });
  const auto = await post(base, `/api/boards/${opened.key}/project/start`, { auto: true });
  assert.equal(auto.status, 200, "the board asking on open never errors for want of a command");
  assert.equal(auto.body.dev.running, false);
  assert.match(auto.body.issue, /no package\.json/);
  const frame = await fetch(`${auto.body.proxy}/`).then((response) => response.text());
  assert.match(frame, /Liesel could not find how to run this project\./);
  assert.doesNotMatch(frame, /http-equiv="refresh"/);
  assert.match(frame, /data-liesel-dev="settings">Open Settings</);

  const saved = await post(base, `/api/boards/${opened.key}/project/dev`, {
    command: "echo 'vite: not found' >&2; exit 127",
    port: "",
  });
  assert.equal(saved.body.issue, "", "saving a command clears the reason");
  await post(base, `/api/boards/${opened.key}/project/start`, {});
  const failed = await waitFor(
    async () => {
      const view = await fetch(`${base}/api/boards/${opened.key}/project`).then((response) => response.json());
      return view.gave_up ? view : null;
    },
    { tries: 300, ms: 50 },
  );
  assert.equal(failed.dev.last_line, "vite: not found", "the detail stays in Settings, Advanced");
  const reason = await fetch(`${failed.proxy}/`).then((response) => response.text());
  assert.match(reason, /The project(&#39;|')s server could not start\./);
  assert.doesNotMatch(reason, /vite: not found|Exited with/, "one plain sentence, no detail");
  assert.match(
    reason,
    /<button type="button" data-liesel-dev="restart">Retry<\/button>/,
    "a quiet Retry, in the frame",
  );
  const retried = await post(base, `/api/boards/${opened.key}/project/restart`, {});
  assert.equal(retried.body.gave_up, false, "Retry tries again from scratch");
  await post(base, `/api/boards/${opened.key}/project/stop`, {});
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
