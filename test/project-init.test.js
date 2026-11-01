import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readBoard } from "../src/board.js";
import { AGENT_SECTION_END, AGENT_SECTION_START, initProject } from "../src/project-init.js";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/liesel.js", import.meta.url));

async function tempProject(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "liesel-init-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("initProject creates a board with one starter item and the agent instructions", async (t) => {
  const project = await tempProject(t);

  const result = await initProject({ projectDir: project });

  const boardDir = path.join(project, "board");
  const board = await readBoard(boardDir);
  assert.equal(board.items.length, 1);
  assert.equal(board.items[0].file, "welcome.html");
  const starter = await readFile(path.join(boardDir, "welcome.html"), "utf8");
  assert.match(starter, /<meta name="liesel-title"/);

  const guide = await readFile(path.join(project, "LIESEL.md"), "utf8");
  assert.match(guide, /liesel board open board/);
  assert.match(guide, /liesel poll board/);
  assert.match(guide, /--agent-reply/);
  assert.match(guide, /foreground/);

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const contents = await readFile(path.join(project, name), "utf8");
    assert.equal(count(contents, AGENT_SECTION_START), 1, `${name} carries the Liesel section once`);
    assert.match(contents, /LIESEL\.md/);
  }

  assert.equal(result.board.dir, boardDir);
  assert.deepEqual(
    result.files.map((entry) => [path.basename(entry.path), entry.action]),
    [
      ["welcome.html", "created"],
      ["LIESEL.md", "created"],
      ["AGENTS.md", "created"],
      ["CLAUDE.md", "created"],
    ],
  );
});

test("initProject appends to existing agent files and never overwrites them", async (t) => {
  const project = await tempProject(t);
  const agents = "# My project\n\nKeep tests green.\n";
  const gemini = "# Gemini notes";
  await writeFile(path.join(project, "AGENTS.md"), agents);
  await writeFile(path.join(project, "GEMINI.md"), gemini);
  await writeFile(path.join(project, "LIESEL.md"), "my own liesel notes\n");

  await initProject({ projectDir: project });

  const updated = await readFile(path.join(project, "AGENTS.md"), "utf8");
  assert.ok(updated.startsWith(agents), "existing AGENTS.md text is kept verbatim at the top");
  assert.ok(updated.trimEnd().endsWith(AGENT_SECTION_END));
  const updatedGemini = await readFile(path.join(project, "GEMINI.md"), "utf8");
  assert.ok(updatedGemini.startsWith(`${gemini}\n`));
  assert.equal(count(updatedGemini, AGENT_SECTION_START), 1);
  assert.equal(await readFile(path.join(project, "LIESEL.md"), "utf8"), "my own liesel notes\n");
});

test("initProject is idempotent and leaves a populated board alone", async (t) => {
  const project = await tempProject(t);
  await initProject({ projectDir: project });
  const second = await initProject({ projectDir: project });

  assert.ok(second.files.every((entry) => entry.action === "kept"));
  const board = await readBoard(path.join(project, "board"));
  assert.equal(board.items.length, 1);
  const agents = await readFile(path.join(project, "AGENTS.md"), "utf8");
  assert.equal(count(agents, AGENT_SECTION_START), 1);
});

test("initProject skips CLAUDE.md when it already imports AGENTS.md, and a symlinked one is written once", async (t) => {
  const importing = await tempProject(t);
  await writeFile(path.join(importing, "CLAUDE.md"), "@AGENTS.md\n");
  await initProject({ projectDir: importing });
  assert.equal(await readFile(path.join(importing, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");

  const linked = await tempProject(t);
  await writeFile(path.join(linked, "AGENTS.md"), "# Linked\n");
  await symlink("AGENTS.md", path.join(linked, "CLAUDE.md"));
  await initProject({ projectDir: linked });
  const contents = await readFile(path.join(linked, "AGENTS.md"), "utf8");
  assert.equal(count(contents, AGENT_SECTION_START), 1);
});

test("initProject honours a custom board folder and name", async (t) => {
  const project = await tempProject(t);
  await initProject({ projectDir: project, boardDir: "designs", name: "Checkout" });

  const board = await readBoard(path.join(project, "designs"));
  assert.equal(board.name, "Checkout");
  const guide = await readFile(path.join(project, "LIESEL.md"), "utf8");
  assert.match(guide, /liesel poll designs/);
});

test("initProject refuses a board folder outside the project", async (t) => {
  const project = await tempProject(t);
  await assert.rejects(initProject({ projectDir: project, boardDir: "../elsewhere" }), /inside the project/);
});

test("starter item carries no eyebrow label", async (t) => {
  const project = await tempProject(t);
  await initProject({ projectDir: project });
  const starter = await readFile(path.join(project, "board", "welcome.html"), "utf8");
  assert.doesNotMatch(starter, /eyebrow|text-transform:\s*uppercase/i);
});

test("liesel init runs from the CLI without starting a server", async (t) => {
  const project = await tempProject(t);
  const state = await tempProject(t);
  const { stdout } = await run(process.execPath, [CLI, "init", project], {
    env: { ...process.env, LIESEL_STATE_DIR: state, LIESEL_TELEMETRY: "0" },
  });
  assert.match(stdout, /LIESEL\.md/);
  assert.match(stdout, /liesel board open/);
  const board = await readBoard(path.join(project, "board"));
  assert.equal(board.items.length, 1);
});

test("liesel update never installs from npm, where Liesel is not published", async (t) => {
  const state = await tempProject(t);
  const { stdout } = await run(process.execPath, [CLI, "update"], {
    env: { ...process.env, LIESEL_STATE_DIR: state, LIESEL_TELEMETRY: "0" },
    timeout: 10_000,
  });
  assert.match(stdout, /github:GeorgeGally\/liesel/);
  assert.doesNotMatch(stdout, /registry\.npmjs\.org|Updated/);
});
