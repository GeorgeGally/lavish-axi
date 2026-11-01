import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  agentInvocation,
  buildRunnerPrompt,
  createRunnerConfigStore,
  detectInstalledAgents,
  findExecutable,
  runAgent,
  validateRunnerConfig,
} from "../src/board-runner.js";

async function scratch(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "liesel-runner-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("detection finds only agent CLIs that are executable on PATH", async (t) => {
  const dir = await scratch(t);
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), "#!/bin/sh\n");
  await chmod(path.join(bin, "claude"), 0o755);
  // Present but not executable: not offered.
  await writeFile(path.join(bin, "codex"), "#!/bin/sh\n");
  const options = { env: { PATH: bin }, home: path.join(dir, "nohome"), platform: "linux" };
  assert.equal(await findExecutable("claude", options), path.join(bin, "claude"));
  assert.equal(await findExecutable("codex", options), "");
  const installed = await detectInstalledAgents(options);
  assert.deepEqual(
    installed.map((agent) => agent.id),
    ["claude"],
  );
});

test("a runner config needs an installed agent and an existing absolute folder", async (t) => {
  const dir = await scratch(t);
  const installed = ["claude"];
  assert.match(
    /** @type {any} */ (await validateRunnerConfig({ agent: "codex", cwd: dir }, { installed })).error,
    /not installed/,
  );
  assert.match(
    /** @type {any} */ (await validateRunnerConfig({ agent: "", cwd: dir }, { installed })).error,
    /Pick an agent/,
  );
  assert.match(
    /** @type {any} */ (await validateRunnerConfig({ agent: "claude", cwd: "relative" }, { installed })).error,
    /absolute/,
  );
  assert.match(
    /** @type {any} */ (await validateRunnerConfig({ agent: "claude", cwd: path.join(dir, "missing") }, { installed }))
      .error,
    /does not exist/,
  );
  assert.match(
    /** @type {any} */ (await validateRunnerConfig({ agent: "custom", cwd: dir }, { installed })).error,
    /needs a command/,
  );
  assert.match(
    /** @type {any} */ (await validateRunnerConfig({ agent: "custom", command: "a\nb", cwd: dir }, { installed }))
      .error,
    /one line/,
  );
  assert.deepEqual(await validateRunnerConfig({ agent: "claude", cwd: dir, command: "ignored" }, { installed }), {
    config: { agent: "claude", cwd: dir },
  });
  assert.deepEqual(await validateRunnerConfig({ agent: "custom", command: " my-agent ", cwd: dir }, { installed }), {
    config: { agent: "custom", command: "my-agent", cwd: dir },
  });
});

test("runner configs live in the state directory, keyed by board.json, owner-only", async (t) => {
  const dir = await scratch(t);
  const store = createRunnerConfigStore(dir);
  assert.equal(await store.get("/a/board.json"), null);
  await store.set("/a/board.json", { agent: "claude", cwd: "/a" });
  await store.set("/b/board.json", { agent: "codex", cwd: "/b" });
  assert.equal((await store.get("/a/board.json"))?.agent, "claude");
  await store.set("/a/board.json", null);
  assert.equal(await store.get("/a/board.json"), null);
  assert.equal((await store.get("/b/board.json"))?.agent, "codex");
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
});

test("the prompt names each note's item file, pin and images", () => {
  const prompt = buildRunnerPrompt({
    boardDir: "/boards/hero",
    boardName: "Hero",
    cwd: "/boards/hero",
    items: [{ id: "v1", label: "Hero · A", file: "v1.html" }],
    prompts: [
      {
        prompt: "Too loud\nmake it quieter",
        tag: "pin",
        selector: "h1",
        item: { id: "v1", label: "Hero · A" },
        pin: { number: 3, excerpt: "The whole fleet", heading: "Fleet", viewport: 834 },
        attachments: [{ id: "a", path: "/state/att/a.png" }],
      },
      { prompt: "Overall: calmer", tag: "message" },
    ],
  });
  assert.match(prompt, /Board folder: \/boards\/hero/);
  assert.match(prompt, /1\. Item "Hero · A" \(id v1, file \/boards\/hero\/v1\.html\)/);
  assert.match(prompt, /Pin 3 on `h1` \("The whole fleet"\) in section "Fleet" at 834px wide/);
  assert.match(prompt, /Note: Too loud\n {3}make it quieter/);
  assert.match(prompt, /Image: \/state\/att\/a\.png/);
  assert.match(prompt, /2\. The whole board/);
  assert.match(prompt, /Do not run `liesel poll`/);
  assert.doesNotMatch(prompt, /Working folder/);
});

test("named agents launch from an argv array, never a shell line", () => {
  const base = { prompt: "$(touch pwned) `id`", boardDir: "/b", outputFile: "/tmp/out.txt", executable: "/bin/x" };
  const claude = agentInvocation({ ...base, config: { agent: "claude", cwd: "/b" } });
  assert.deepEqual(claude, {
    file: "/bin/x",
    args: ["-p", "--permission-mode", "acceptEdits"],
    stdin: base.prompt,
    shell: false,
  });
  const claudeElsewhere = agentInvocation({ ...base, config: { agent: "claude", cwd: "/project" } });
  assert.deepEqual(claudeElsewhere.args.slice(-2), ["--add-dir", "/b"]);
  const codex = agentInvocation({ ...base, config: { agent: "codex", cwd: "/b" } });
  assert.equal(codex.shell, false);
  assert.deepEqual(codex.args.slice(-3), ["-o", "/tmp/out.txt", "-"]);
  assert.equal(codex.stdin, base.prompt);
  const opencode = agentInvocation({ ...base, config: { agent: "opencode", cwd: "/b" } });
  assert.deepEqual(opencode.args, ["run", "--auto", base.prompt]);
  assert.equal(opencode.shell, false);
  const gemini = agentInvocation({ ...base, config: { agent: "gemini", cwd: "/b" } });
  assert.deepEqual(gemini.args.slice(-2), ["-p", base.prompt]);
  const custom = agentInvocation({ ...base, config: { agent: "custom", command: "my-agent --x", cwd: "/b" } });
  assert.deepEqual(custom, { file: "/bin/sh", args: ["-c", "my-agent --x"], stdin: base.prompt, shell: false });
});

test("runAgent feeds the prompt on stdin, runs in the chosen folder and returns the last message", async (t) => {
  const dir = await scratch(t);
  const script = path.join(dir, "agent.mjs");
  await writeFile(
    script,
    `let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile("seen.txt", input + "|" + process.env.LIESEL_BOARD_DIR + "|" + process.env.LIESEL_PROMPT_FILE);
  process.stderr.write("thinking\\n");
  process.stdout.write("Changed the headline.\\n");
});
`,
  );
  const chunks = [];
  const outcome = await runAgent({
    config: { agent: "custom", command: `"${process.execPath}" "${script}"`, cwd: dir },
    executable: "",
    prompt: "note: $(touch pwned)",
    boardDir: dir,
    extraEnv: { LIESEL_BOARD_DIR: dir },
    onOutput: (chunk) => chunks.push(chunk),
  });
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.reply, "Changed the headline.");
  assert.match(outcome.output, /thinking/);
  assert.ok(chunks.length > 0);
  const seen = await readFile(path.join(dir, "seen.txt"), "utf8");
  const [stdin, boardDir, promptFile] = seen.split("|");
  assert.equal(stdin, "note: $(touch pwned)");
  assert.equal(boardDir, dir);
  assert.match(promptFile, /prompt\.txt$/);
  await assert.rejects(readFile(path.join(dir, "pwned")), "note text never reaches a shell");
});

test("runAgent reports a failing agent, a timeout and a stop", async (t) => {
  const dir = await scratch(t);
  const failing = await runAgent({
    config: { agent: "custom", command: "echo nope >&2; exit 3", cwd: dir },
    executable: "",
    prompt: "x",
    boardDir: dir,
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.error, "Exited with 3");
  assert.match(failing.output, /nope/);

  const slow = await runAgent({
    config: { agent: "custom", command: "sleep 30", cwd: dir },
    executable: "",
    prompt: "x",
    boardDir: dir,
    timeoutMs: 200,
  });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /Timed out/);

  const stopped = await runAgent({
    config: { agent: "custom", command: "sleep 30", cwd: dir },
    executable: "",
    prompt: "x",
    boardDir: dir,
    onSpawn: (stop) => setTimeout(stop, 100),
  });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.error, "Stopped");
});
