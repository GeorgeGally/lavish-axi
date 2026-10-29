import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runNotifyCommand } from "../src/board-notify.js";

function fakeChild() {
  const child = /** @type {any} */ (new EventEmitter());
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.unref = () => {};
  return child;
}

test("runNotifyCommand passes board values as parameters, never as shell text", () => {
  const calls = [];
  const child = fakeChild();
  runNotifyCommand({
    command: "/opt/notify --flag",
    board: "Hero $(rm -rf ~)",
    boardJson: "/b/board.json",
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
    "easel-notify",
    "Hero $(rm -rf ~)",
    "/b/board.json",
    "s1",
  ]);
  assert.equal(calls[0].options.env.EASEL_BOARD, "Hero $(rm -rf ~)");
  assert.equal(calls[0].options.env.EASEL_BOARD_JSON, "/b/board.json");
  assert.equal(calls[0].options.env.EASEL_SUBMISSION_ID, "s1");
});

test("runNotifyCommand logs a failing command and never throws", () => {
  const lines = [];
  const child = fakeChild();
  runNotifyCommand({
    command: "notify",
    board: "b",
    boardJson: "/b/board.json",
    submissionId: "s2",
    log: (line) => lines.push(line),
    spawnFn: /** @type {any} */ (() => child),
  });
  child.stderr.emit("data", "no such inbox\n");
  child.emit("exit", 3, null);
  assert.match(lines.join("\n"), /board notify exited 3 submission=s2: no such inbox/);
  assert.equal(
    runNotifyCommand({
      command: "notify",
      board: "b",
      boardJson: "/b",
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
  assert.equal(runNotifyCommand({ command: " ", board: "b", boardJson: "/b", submissionId: "s4" }), null);
});
