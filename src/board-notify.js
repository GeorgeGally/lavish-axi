import { spawn } from "node:child_process";
import crypto from "node:crypto";

/**
 * When a reviewer submits feedback on a board, the server can run one command so a
 * supervisor learns about it without keeping a poll open. The command is the
 * operator's own (`EASEL_NOTIFY_CMD`); it gets the board name, the board.json path
 * and a submission id as arguments and as `EASEL_BOARD`, `EASEL_BOARD_JSON` and
 * `EASEL_SUBMISSION_ID`. It is fire and forget: it never holds the request, never
 * consumes the feedback (a poll still collects it), and a failure is only logged.
 */

export const NOTIFY_TIMEOUT_MS = 30_000;
const STDERR_KEEP = 2000;

export function newSubmissionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * @param {{
 *   command: string,
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
  const env = { ...process.env, EASEL_BOARD: board, EASEL_BOARD_JSON: boardJson, EASEL_SUBMISSION_ID: submissionId };
  /** @type {import("node:child_process").ChildProcess} */
  let child;
  try {
    // The command line is the operator's; the board's values travel only as positional
    // parameters and environment, never spliced into the shell text.
    child =
      platform === "win32"
        ? spawnFn(cmd, { shell: true, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
        : spawnFn("/bin/sh", ["-c", `${cmd} "$@"`, "easel-notify", board, boardJson, submissionId], {
            env,
            stdio: ["ignore", "ignore", "pipe"],
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
