import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { isIgnoredProjectPath, projectSourceDirs, watchProjectTree } from "../src/project-watch.js";

const run = promisify(execFile);

function openDescriptors() {
  for (const dir of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return readdirSync(dir).length;
    } catch {
      // try the next one
    }
  }
  return 0;
}

/** @param {string} dir @param {number} count @param {string} [content] */
async function fill(dir, count, content = "x") {
  await mkdir(dir, { recursive: true });
  await Promise.all(Array.from({ length: count }, (_, i) => writeFile(path.join(dir, `f${i}.txt`), content)));
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "liesel-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** @param {() => boolean} check */
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test("isIgnoredProjectPath skips dependency, cache, log and build folders at any depth", () => {
  for (const ignored of [
    ".git/HEAD",
    "node_modules/a/b.js",
    "packages/x/node_modules/y.js",
    "tmp/cache/z",
    "log/development.log",
    "storage/a.png",
    "vendor/bundle/x.rb",
    "coverage/index.html",
    "public/assets/app.js",
    "public/packs/app.js",
    "dist/index.js",
    ".venv/lib/x.py",
    ".liesel/board.json",
  ]) {
    assert.equal(isIgnoredProjectPath(ignored), true, ignored);
  }
  for (const source of ["app/views/home.html.erb", "src/index.js", "public/index.html", "config/routes.rb", ""]) {
    assert.equal(isIgnoredProjectPath(source), false, source);
  }
});

test("a large repository is watched by a bounded set of source folders without exhausting descriptors", async (t) => {
  const root = await tempRoot(t);
  // About 12,000 files: a recursive per-file watcher would need that many descriptors.
  const heavy = [];
  for (let i = 0; i < 40; i += 1) heavy.push(fill(path.join(root, "node_modules", `pkg${i}`), 120));
  for (let i = 0; i < 20; i += 1) heavy.push(fill(path.join(root, "models", `m${i}`), 120));
  heavy.push(fill(path.join(root, "tmp", "cache"), 500), fill(path.join(root, "log"), 50));
  heavy.push(fill(path.join(root, "vendor", "bundle"), 500), fill(path.join(root, "public", "assets"), 500));
  for (let i = 0; i < 120; i += 1) heavy.push(fill(path.join(root, "app", `area${i}`, "views"), 10));
  await Promise.all(heavy);
  await writeFile(path.join(root, ".gitignore"), "/models/\n");
  await run("git", ["init", "-q", root]);

  const listed = await projectSourceDirs(root, { maxDirs: 100_000 });
  assert.equal(listed.source, "git");
  assert.ok(listed.dirs.includes(""), "the root itself is watched");
  assert.ok(listed.dirs.includes("app/area0/views"));
  assert.ok(
    listed.dirs.every((dir) => !/^(node_modules|models|tmp|log|vendor|public\/assets)(\/|$)/.test(dir)),
    "ignored and gitignored folders are never listed",
  );

  const before = openDescriptors();
  const logs = [];
  const changes = [];
  const watcher = watchProjectTree(root, {
    maxDirs: 150,
    onChange: (file) => changes.push(file),
    onLog: (message) => logs.push(message),
  });
  t.after(() => watcher.close());
  const ready = await watcher.ready;

  assert.ok(ready.truncated, "a tree over the cap is truncated");
  assert.ok(ready.dirs <= 150, `watched ${ready.dirs} folders, cap 150`);
  assert.match(logs.join("\n"), /project watch capped .*watching=150 of 242/);
  const grown = openDescriptors() - before;
  assert.ok(grown < 200, `watching opened ${grown} descriptors`);

  await writeFile(path.join(root, "tmp", "cache", "f0.txt"), "changed");
  await writeFile(path.join(root, "node_modules", "pkg0", "f0.txt"), "changed");
  await writeFile(path.join(root, "app", "area0", "views", "f0.txt"), "changed");
  assert.ok(await until(() => changes.includes("app/area0/views/f0.txt")), `a source change is reported: ${changes}`);
  assert.ok(
    changes.every((file) => !/^(tmp|node_modules)\//.test(file)),
    `ignored changes stay quiet: ${changes}`,
  );
});

test("a folder that is not a git repository is walked with the same bound", async (t) => {
  const root = await tempRoot(t);
  for (let i = 0; i < 30; i += 1) await mkdir(path.join(root, "src", `d${i}`), { recursive: true });
  await fill(path.join(root, "node_modules", "pkg"), 20);

  const listed = await projectSourceDirs(root, { maxDirs: 10 });
  assert.equal(listed.source, "walk");
  assert.equal(listed.truncated, true);
  assert.equal(listed.dirs.length, 10);
  assert.ok(listed.dirs.every((dir) => !dir.startsWith("node_modules")));
});

test("closing before setup finishes leaves nothing watched", async (t) => {
  const root = await tempRoot(t);
  await fill(path.join(root, "src"), 5);
  const watcher = watchProjectTree(root, { onChange: () => {} });
  await watcher.close();
  const ready = await watcher.ready;
  assert.equal(ready.dirs, 0);
  assert.equal(watcher.watchedCount(), 0);
});

test("an unreadable root is logged, not thrown", async () => {
  const logs = [];
  const watcher = watchProjectTree(path.join(os.tmpdir(), "liesel-watch-missing-root"), {
    onChange: () => {},
    onLog: (message) => logs.push(message),
  });
  const ready = await watcher.ready;
  await watcher.close();
  assert.equal(ready.dirs, 0);
});
