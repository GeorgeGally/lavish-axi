import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { addLiveItem, livePageSlug, normalizeBoard } from "../src/board.js";
import { buildRunnerPrompt } from "../src/board-runner.js";
import {
  createLiveProxy,
  createProjectConfigStore,
  detectDevServer,
  devServerPortFromOutput,
  ensureGitExclude,
  injectLiveSdk,
  normalizeLivePage,
  parseGithubRepoUrl,
  projectRootForBoardDir,
  resolveProjectFolder,
  validateDevConfig,
} from "../src/project.js";

async function tempDir(t, prefix = "liesel-project-") {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("parseGithubRepoUrl accepts repository URLs and nothing else", () => {
  assert.deepEqual(parseGithubRepoUrl("https://github.com/owner/repo"), {
    owner: "owner",
    repo: "repo",
    url: "https://github.com/owner/repo.git",
  });
  assert.equal(parseGithubRepoUrl("https://github.com/owner/repo.git")?.repo, "repo");
  assert.equal(parseGithubRepoUrl("github.com/owner/my.site/")?.repo, "my.site");
  assert.equal(parseGithubRepoUrl("https://github.com/owner/repo/tree/main/src")?.repo, "repo");
  assert.equal(parseGithubRepoUrl("https://gitlab.com/owner/repo"), null);
  assert.equal(parseGithubRepoUrl("https://github.com/owner/repo;rm -rf"), null);
  assert.equal(parseGithubRepoUrl("--upload-pack=evil"), null);
  assert.equal(parseGithubRepoUrl("https://github.com/owner/.."), null);
  assert.equal(parseGithubRepoUrl("~/code/shop"), null);
});

test("detectDevServer reads package.json only, and picks the package manager and framework port", async (t) => {
  const dir = await tempDir(t);
  assert.equal(await detectDevServer(dir), null);
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "^5" } }),
  );
  assert.deepEqual(await detectDevServer(dir), {
    command: "npm run dev",
    port: 5173,
    framework: "Vite",
    script: "dev",
    packageManager: "npm",
  });
  await writeFile(path.join(dir, "pnpm-lock.yaml"), "");
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { start: "next start -p 4100" }, dependencies: { next: "15", react: "19" } }),
  );
  const next = await detectDevServer(dir);
  assert.equal(next?.command, "pnpm run start");
  assert.equal(next?.port, 4100);
  assert.equal(next?.framework, "Next.js");
});

test("devServerPortFromOutput finds the URL a dev server prints, through color codes", () => {
  assert.equal(devServerPortFromOutput("\u001b[32m  ➜  Local:   \u001b[1mhttp://localhost:5174/\u001b[22m"), 5174);
  assert.equal(devServerPortFromOutput("ready - started server on 0.0.0.0:3000, url: http://localhost:3000"), 3000);
  assert.equal(devServerPortFromOutput("Listening on http://127.0.0.1:8080"), 8080);
  assert.equal(devServerPortFromOutput("compiling..."), 0);
});

test("normalizeLivePage keeps paths and refuses anything that is not one", () => {
  assert.equal(normalizeLivePage("/"), "/");
  assert.equal(normalizeLivePage("store"), "/store");
  assert.equal(normalizeLivePage("/products/x?ref=1"), "/products/x?ref=1");
  assert.equal(normalizeLivePage("http://localhost:5173/store"), "/store");
  assert.equal(normalizeLivePage("//evil.example/x"), "");
  assert.equal(normalizeLivePage("/a b"), "");
  assert.equal(normalizeLivePage(""), "");
  assert.equal(livePageSlug("/"), "home");
  assert.equal(livePageSlug("/products/x?ref=1"), "products-x");
});

test("validateDevConfig needs a command or a port, and refuses Liesel's own port", () => {
  assert.deepEqual(validateDevConfig({ command: "npm run dev", port: "" }), {
    config: { command: "npm run dev", port: 0 },
  });
  assert.deepEqual(validateDevConfig({ port: "3000" }), { config: { command: "", port: 3000 } });
  assert.match(String(/** @type {any} */ (validateDevConfig({})).error), /command/);
  assert.match(String(/** @type {any} */ (validateDevConfig({ port: "99999" })).error), /port/);
  assert.match(String(/** @type {any} */ (validateDevConfig({ command: "a\nb" })).error), /one line/);
  assert.match(
    String(/** @type {any} */ (validateDevConfig({ port: 4387 }, { reservedPorts: [4387] })).error),
    /Liesel/,
  );
});

test("ensureGitExclude adds the board folder once, to info/exclude and never .gitignore", async (t) => {
  const root = await tempDir(t);
  assert.deepEqual(await ensureGitExclude(root), { file: null, added: false });
  await mkdir(path.join(root, ".git", "info"), { recursive: true });
  await writeFile(
    path.join(root, ".git", "info", "exclude"),
    "# git ls-files --others --exclude-from=.git/info/exclude\n*.log",
  );
  const first = await ensureGitExclude(root);
  assert.equal(first.added, true);
  const second = await ensureGitExclude(root);
  assert.equal(second.added, false);
  const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
  assert.equal(exclude.match(/^\/\.liesel\/$/gm)?.length, 1);
  assert.match(exclude, /^\*\.log$/m);
  await assert.rejects(readFile(path.join(root, ".gitignore"), "utf8"));
});

test("ensureGitExclude follows a worktree's .git file to the shared git dir", async (t) => {
  const dir = await tempDir(t);
  const common = path.join(dir, "main", ".git");
  const worktreeGit = path.join(common, "worktrees", "feature");
  await mkdir(worktreeGit, { recursive: true });
  await writeFile(path.join(worktreeGit, "commondir"), "../..\n");
  const worktree = path.join(dir, "feature");
  await mkdir(worktree);
  await writeFile(path.join(worktree, ".git"), `gitdir: ${worktreeGit}\n`);
  const result = await ensureGitExclude(worktree);
  assert.equal(result.file, path.join(common, "info", "exclude"));
  assert.match(await readFile(path.join(common, "info", "exclude"), "utf8"), /^\/\.liesel\/$/m);
});

test("resolveProjectFolder refuses missing folders, files, the home folder and the disk root", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "file.txt");
  await writeFile(file, "x");
  assert.equal(await resolveProjectFolder(dir), dir);
  await assert.rejects(resolveProjectFolder(path.join(dir, "missing")), /does not exist/);
  await assert.rejects(resolveProjectFolder(file), /file/);
  await assert.rejects(resolveProjectFolder("relative/path"), /full path/);
  await assert.rejects(resolveProjectFolder(dir, { home: dir }), /home folder/);
  await assert.rejects(resolveProjectFolder("/"), /home folder or the disk/);
  assert.equal(projectRootForBoardDir(path.join(dir, ".liesel")), dir);
  assert.equal(projectRootForBoardDir(dir), null);
});

test("the project config store keeps per-machine dev settings outside the repo", async (t) => {
  const dir = await tempDir(t);
  const store = createProjectConfigStore(dir);
  assert.equal(await store.get("/repo/.liesel/board.json"), null);
  await store.update("/repo/.liesel/board.json", { command: "npm run dev", port: 0 });
  await store.update("/repo/.liesel/board.json", { proxyPort: 45678 });
  assert.deepEqual(await store.get("/repo/.liesel/board.json"), { command: "npm run dev", port: 0, proxyPort: 45678 });
});

test("live items are pages by path, deduplicated, and survive normalization", () => {
  const board = normalizeBoard({ name: "shop" }, "shop");
  const home = addLiveItem(board, { page: "/" });
  const store = addLiveItem(board, { page: "store", label: "Store" });
  assert.equal(addLiveItem(board, { page: "/store" }), store);
  assert.equal(home.id, "home");
  assert.equal(store.page, "/store");
  assert.throws(() => addLiveItem(board, { page: "//evil" }), /URL path/);
  const again = normalizeBoard(JSON.parse(JSON.stringify(board)), "shop");
  assert.deepEqual(
    again.items.map((item) => [item.id, item.page, item.file]),
    [
      ["home", "/", ""],
      ["store", "/store", ""],
    ],
  );
  const noted = normalizeBoard(
    { items: [{ ...store, notes: [{ id: "n1", number: 1, selector: "h1", page: "/store?x=1" }] }] },
    "shop",
  );
  assert.equal(noted.items[0].notes[0].page, "/store?x=1");
});

test("the runner prompt for a project names the page path, selector and project folder", () => {
  const prompt = buildRunnerPrompt({
    boardDir: "/repo/.liesel",
    boardName: "shop",
    items: [{ id: "store", label: "/store", file: "", page: "/store" }],
    prompts: [
      {
        prompt: "Make the title red",
        selector: "#title",
        item: { id: "store", label: "/store", page: "/store?x=1" },
        pin: { number: 1, excerpt: "Shop" },
      },
    ],
    cwd: "/repo",
    project: { root: "/repo", url: "http://localhost:5173" },
  });
  assert.match(prompt, /Project folder: \/repo/);
  assert.match(prompt, /Live page \/store\?x=1 "\/store" \(id store, http:\/\/localhost:5173\/store\?x=1\)/);
  assert.match(prompt, /Pin 1 on `#title` at path \/store\?x=1/);
  assert.match(prompt, /edit them in place/);
  assert.doesNotMatch(prompt, /Working folder/);
});

test("injectLiveSdk adds the SDK before the last </body>, or appends it", () => {
  assert.equal(
    injectLiveSdk("<body><p></body><script>x='</body>'</script></body>", "/s.js"),
    `<body><p></body><script>x='</body>'</script><script src="/s.js" data-liesel-live></script></body>`,
  );
  assert.equal(injectLiveSdk("<p>hi", "/s.js"), `<p>hi\n<script src="/s.js" data-liesel-live></script>`);
});

/**
 * A stand-in dev server: an HTML page that names the Host it saw, a stylesheet, a redirect,
 * and a WebSocket-style upgrade that echoes.
 */
async function fakeDevServer(t) {
  /** @type {any[]} */
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      encoding: req.headers["accept-encoding"],
    });
    if (req.url === "/style.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end("h1{color:red}");
      return;
    }
    if (req.url === "/old") {
      res.writeHead(302, { location: `http://localhost:${port}/store` });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
    });
    res.end(
      `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><h1>Host ${req.headers.host}</h1></body></html>`,
    );
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ upgrade: req.url, host: req.headers.host, origin: req.headers.origin });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("end", () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  return { port, seen };
}

/** @param {string} url @param {Record<string, string>} [headers] */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the live proxy serves the dev server's pages with the SDK added and frame blockers removed", async (t) => {
  const dev = await fakeDevServer(t);
  let upstream = 0;
  const proxy = createLiveProxy({ upstreamPort: () => upstream, sdkSrc: "http://127.0.0.1:1/board-sdk.js?live=1" });
  const origin = await proxy.listen();
  t.after(() => proxy.close());

  const idle = /** @type {any} */ (await get(`${origin}/`));
  assert.equal(idle.status, 503);
  assert.match(idle.body, /No dev server/);
  assert.match(idle.body, /board-sdk\.js\?live=1/);

  upstream = dev.port;
  const page = /** @type {any} */ (await get(`${origin}/store`, { origin }));
  assert.equal(page.status, 200);
  assert.match(
    page.body,
    /<script src="http:\/\/127\.0\.0\.1:1\/board-sdk\.js\?live=1" data-liesel-live><\/script><\/body>/,
  );
  assert.match(page.body, new RegExp(`Host localhost:${dev.port}`));
  assert.equal(page.headers["x-frame-options"], undefined);
  assert.equal(page.headers["content-security-policy"], undefined);
  assert.equal(Number(page.headers["content-length"]), Buffer.byteLength(page.body));
  const seen = dev.seen.find((entry) => entry.url === "/store");
  assert.equal(seen.origin, `http://localhost:${dev.port}`);
  assert.equal(seen.encoding, "identity");

  const css = /** @type {any} */ (await get(`${origin}/style.css`));
  assert.equal(css.body, "h1{color:red}");

  const moved = /** @type {any} */ (await get(`${origin}/old`));
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.location, `${origin}/store`);
});

test("the live proxy answers only to its own loopback address", async (t) => {
  const dev = await fakeDevServer(t);
  const proxy = createLiveProxy({ upstreamPort: () => dev.port, sdkSrc: "/sdk.js" });
  const origin = await proxy.listen();
  t.after(() => proxy.close());
  const rebound = /** @type {any} */ (await get(`${origin}/`, { host: "evil.example" }));
  assert.equal(rebound.status, 403);
  assert.equal(dev.seen.length, 0);
});

test("the live proxy refuses to forward to a reserved port", async (t) => {
  const dev = await fakeDevServer(t);
  const proxy = createLiveProxy({ upstreamPort: () => dev.port, reservedPorts: () => [dev.port], sdkSrc: "/sdk.js" });
  const origin = await proxy.listen();
  t.after(() => proxy.close());
  const refused = /** @type {any} */ (await get(`${origin}/`));
  assert.equal(refused.status, 503);
  assert.equal(dev.seen.length, 0);
});

test("the live proxy passes hot-reload WebSocket upgrades through with the dev server's own Host", async (t) => {
  const dev = await fakeDevServer(t);
  const proxy = createLiveProxy({ upstreamPort: () => dev.port, sdkSrc: "/sdk.js" });
  const origin = await proxy.listen();
  t.after(() => proxy.close());
  const port = proxy.port();
  const echoed = await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET /_hmr HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      );
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n\r\n") && !data.includes("ping")) socket.write("ping");
      if (data.includes("ping")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", reject);
  });
  assert.match(String(echoed), /101 Switching Protocols/);
  const upgrade = dev.seen.find((entry) => entry.upgrade === "/_hmr");
  assert.equal(upgrade.host, `localhost:${dev.port}`);
  assert.equal(upgrade.origin, `http://localhost:${dev.port}`);
});

test("the live proxy keeps its port across restarts when it is free", async (t) => {
  const first = createLiveProxy({ upstreamPort: () => 0, sdkSrc: "/sdk.js" });
  await first.listen();
  const port = first.port();
  await first.close();
  const second = createLiveProxy({ upstreamPort: () => 0, sdkSrc: "/sdk.js" });
  t.after(() => second.close());
  await second.listen(port);
  assert.equal(second.port(), port);
});
