import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBoardNotifier, resolveNotifyCommand, runNotifyCommand } from "../src/board-notify.js";

function fakeChild() {
  const child = /** @type {any} */ (new EventEmitter());
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.unref = () => {};
  return child;
}

const BASE = { boardId: "k1", noteCount: 2, board: "b", boardJson: "/b/board.json" };

test("runNotifyCommand passes board values as parameters and environment, never as shell text", () => {
  const calls = [];
  const child = fakeChild();
  runNotifyCommand({
    ...BASE,
    command: "/opt/notify --flag",
    boardDir: "/boards/Hero $(rm -rf ~)",
    board: "Hero $(rm -rf ~)",
    submissionId: "s1",
    platform: "darwin",
    spawnFn: /** @type {any} */ (
      (file, args, options) => {
        calls.push({ file, args, options });
        return child;
      }
    ),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/bin/sh");
  assert.deepEqual(calls[0].args, [
    "-c",
    '/opt/notify --flag "$@"',
    "liesel-notify",
    "Hero $(rm -rf ~)",
    "/b/board.json",
    "s1",
  ]);
  assert.equal(calls[0].options.detached, true);
  const env = calls[0].options.env;
  assert.equal(env.LIESEL_BOARD_ID, "k1");
  assert.equal(env.LIESEL_NOTE_COUNT, "2");
  assert.equal(env.LIESEL_BOARD_DIR, "/boards/Hero $(rm -rf ~)");
  assert.equal(env.LIESEL_BOARD, "Hero $(rm -rf ~)");
  assert.equal(env.LIESEL_BOARD_JSON, "/b/board.json");
  assert.equal(env.LIESEL_SUBMISSION_ID, "s1");
});

test("runNotifyCommand logs a failing command and never throws", () => {
  const lines = [];
  const child = fakeChild();
  runNotifyCommand({
    ...BASE,
    command: "notify",
    boardDir: "/b",
    submissionId: "s2",
    log: (line) => lines.push(line),
    spawnFn: /** @type {any} */ (() => child),
  });
  child.stderr.emit("data", "no such inbox\n");
  child.emit("exit", 3, null);
  assert.match(lines.join("\n"), /board notify exited 3 submission=s2: no such inbox/);
  assert.equal(
    runNotifyCommand({
      ...BASE,
      command: "notify",
      boardDir: "/b",
      submissionId: "s3",
      log: (line) => lines.push(line),
      spawnFn: /** @type {any} */ (
        () => {
          throw new Error("spawn EACCES");
        }
      ),
    }),
    null,
  );
  assert.match(lines.at(-1), /failed to start submission=s3: spawn EACCES/);
  assert.equal(runNotifyCommand({ ...BASE, command: " ", boardDir: "/b", submissionId: "s4" }), null);
});

test("createBoardNotifier runs at once, then collapses a burst into one trailing run per board", () => {
  let clock = 1000;
  /** @type {Array<{ fn: () => void, at: number }>} */
  const timers = [];
  const runs = [];
  const notifier = createBoardNotifier({
    windowMs: 3000,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock + ms };
      timers.push(timer);
      return timer;
    },
    run: (key) => runs.push(`${key}@${clock}`),
  });
  const advance = (ms) => {
    clock += ms;
    for (const timer of timers.splice(0).filter((t) => t.at <= clock)) timer.fn();
  };

  notifier.notify("a");
  assert.deepEqual(runs, ["a@1000"], "the first note runs immediately");
  notifier.notify("a");
  notifier.notify("a");
  notifier.notify("b");
  assert.deepEqual(runs, ["a@1000", "b@1000"], "a burst waits; another board is independent");
  assert.equal(timers.length, 1, "one trailing timer for the burst");
  advance(3000);
  assert.deepEqual(runs, ["a@1000", "b@1000", "a@4000"], "one trailing run at the window's end");
  advance(10_000);
  notifier.notify("a");
  assert.deepEqual(runs.at(-1), "a@14000", "a quiet board runs at once again");
  assert.equal(runs.length, 4);
});

test("resolveNotifyCommand prefers the environment, then config.json notify_cmd, else off", async (t) => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "liesel-notify-config-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  assert.equal(await resolveNotifyCommand({ envCommand: "", stateRoot }), "");
  await writeFile(path.join(stateRoot, "config.json"), "not json");
  assert.equal(await resolveNotifyCommand({ envCommand: undefined, stateRoot }), "");
  await writeFile(path.join(stateRoot, "config.json"), JSON.stringify({ notify_cmd: " /opt/wake " }));
  assert.equal(await resolveNotifyCommand({ envCommand: "", stateRoot }), "/opt/wake");
  assert.equal(await resolveNotifyCommand({ envCommand: "/opt/env", stateRoot }), "/opt/env");
});
