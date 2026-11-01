import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * When a reviewer queues a note on a board, the server can run one command so a
 * supervisor wakes up without keeping a poll open. The command is the operator's own
 * (`LIESEL_NOTIFY_CMD`, or `notify_cmd` in the state directory's `config.json`); it gets
 * the board name, the board.json path and a submission id as arguments and as
 * `LIESEL_BOARD`, `LIESEL_BOARD_JSON` and `LIESEL_SUBMISSION_ID`, plus `LIESEL_BOARD_DIR`,
 * `LIESEL_BOARD_ID` (the session key) and `LIESEL_NOTE_COUNT` (notes waiting for the
 * agent). The note text is never passed. It is fire and forget: it never holds the
 * request, never consumes the feedback (a poll still collects it), runs at most once per
 * board per debounce window, and a failure is only logged.
 */

export const NOTIFY_TIMEOUT_MS = 30_000;
export const NOTIFY_DEBOUNCE_MS = 3_000;
const STDERR_KEEP = 2000;

export function newSubmissionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * The environment wins; otherwise `notify_cmd` from `<stateRoot>/config.json`, read on
 * every call so a long-running server picks it up without a restart.
 * @param {{ envCommand?: string, stateRoot: string }} options
 * @returns {Promise<string>}
 */
export async function resolveNotifyCommand({ envCommand, stateRoot }) {
  const fromEnv = String(envCommand || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const config = JSON.parse(await readFile(path.join(stateRoot, "config.json"), "utf8"));
    return typeof config?.notify_cmd === "string" ? config.notify_cmd.trim() : "";
  } catch {
    return "";
  }
}

/**
 * At most one run per board per window. The first note runs at once; notes inside the
 * window collapse into one trailing run at its end, so the last note is always followed
 * by a run (a supervisor that polled after the first run still hears about the rest).
 * @param {{
 *   run: (key: string) => void,
 *   windowMs?: number,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (timer: any) => void,
 * }} options
 */
export function createBoardNotifier({
  run,
  windowMs = NOTIFY_DEBOUNCE_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /** @type {Map<string, { last: number, timer: any }>} */
  const boards = new Map();
  const fire = (/** @type {string} */ key) => {
    const entry = boards.get(key);
    if (entry) {
      entry.last = now();
      entry.timer = null;
    }
    run(key);
  };
  return {
    /** @param {string} key */
    notify(key) {
      const entry = boards.get(key) ?? { last: -Infinity, timer: null };
      boards.set(key, entry);
      if (entry.timer) return;
      const wait = entry.last + windowMs - now();
      if (wait <= 0) {
        fire(key);
        return;
      }
      entry.timer = setTimer(() => fire(key), wait);
      entry.timer?.unref?.();
    },
    close() {
      for (const entry of boards.values()) if (entry.timer) clearTimer(entry.timer);
      boards.clear();
    },
  };
}

/**
 * @param {{
 *   command: string,
 *   boardDir: string,
 *   boardId: string,
 *   noteCount: number,
 *   board: string,
 *   boardJson: string,
 *   submissionId: string,
 *   log?: (line: string) => void,
 *   spawnFn?: typeof spawn,
 *   timeoutMs?: number,
 *   platform?: string,
 * }} options
 * @returns {import("node:child_process").ChildProcess | null}
 */
export function runNotifyCommand({
  command,
  boardDir,
  boardId,
  noteCount,
  board,
  boardJson,
  submissionId,
  log = () => {},
  spawnFn = spawn,
  timeoutMs = NOTIFY_TIMEOUT_MS,
  platform = process.platform,
}) {
  const cmd = String(command || "").trim();
  if (!cmd) return null;
  const env = {
    ...process.env,
    LIESEL_BOARD_DIR: boardDir,
    LIESEL_BOARD_ID: boardId,
    LIESEL_NOTE_COUNT: String(noteCount),
    LIESEL_BOARD: board,
    LIESEL_BOARD_JSON: boardJson,
    LIESEL_SUBMISSION_ID: submissionId,
  };
  /** @type {import("node:child_process").ChildProcess} */
  let child;
  try {
    // The command line is the operator's; the board's values travel only as positional
    // parameters and environment, never spliced into the shell text.
    child =
      platform === "win32"
        ? // cmd.exe has no safe "$@"; Windows reads the values from the environment.
          spawnFn(cmd, { shell: true, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
        : spawnFn("/bin/sh", ["-c", `${cmd} "$@"`, "liesel-notify", board, boardJson, submissionId], {
            env,
            stdio: ["ignore", "ignore", "pipe"],
            detached: true,
          });
  } catch (error) {
    log(`board notify failed to start submission=${submissionId}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < STDERR_KEEP) stderr += String(chunk).slice(0, STDERR_KEEP - stderr.length);
  });
  const timer = setTimeout(() => {
    log(`board notify timed out after ${timeoutMs}ms submission=${submissionId}`);
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();
  child.on("error", (error) => {
    clearTimeout(timer);
    log(`board notify failed submission=${submissionId}: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    if (code === 0) return;
    const detail = stderr.trim().replace(/\s+/g, " ");
    log(`board notify exited ${code ?? signal} submission=${submissionId}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  });
  child.unref?.();
  return child;
}
