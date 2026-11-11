import {
  access,
  constants as fsConstants,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { AsyncMutex } from "./async-mutex.js";
import { CHANGE_CONTRACT_RULE, changeRecordLines } from "./board-changes.js";
import { sourceText } from "./board-source.js";

/** @type {typeof import("node:child_process").spawn} */
const crossSpawn = createRequire(import.meta.url)("cross-spawn");

/**
 * The built-in agent runner. A board can name one agent CLI to handle its notes; when
 * notes are sent, the server takes them like a poll would, launches that agent headless
 * in the folder the user chose with the notes as its prompt, and posts the agent's final
 * message back as the reply. Nothing here ever builds a shell line out of note text: a
 * named agent is spawned from an argv array and gets the prompt on stdin (or as one argv
 * element), and a custom command is the user's own shell text with the prompt on stdin.
 *
 * The choice lives in the state directory (`board-runners.json`), keyed by the board's
 * canonical board.json path, never in board.json itself: a board folder is something
 * people share, and a shared folder must not carry a command that runs on the recipient's
 * machine. Nothing runs until the user picks an agent for that board on this machine.
 */

export const RUNNER_CONFIG_FILE = "board-runners.json";
export const RUNNER_DEFAULT_TIMEOUT_MS = 20 * 60_000;
export const RUNNER_OUTPUT_KEEP = 256 * 1024;
export const RUNNER_REPLY_MAX = 20_000;
const MAX_CUSTOM_COMMAND = 2000;

/**
 * @typedef {{ id: string, label: string, bin: string }} RunnerAgent
 * @typedef {{ agent: string, command?: string, cwd: string, updated_at?: string }} RunnerConfig
 */

/** @type {RunnerAgent[]} */
export const RUNNER_AGENTS = [
  { id: "claude", label: "Claude Code", bin: "claude" },
  { id: "codex", label: "Codex", bin: "codex" },
  { id: "opencode", label: "OpenCode", bin: "opencode" },
  { id: "gemini", label: "Gemini CLI", bin: "gemini" },
];

export const CUSTOM_AGENT = { id: "custom", label: "Custom command" };

/** @param {string} id */
export function runnerAgentLabel(id) {
  if (id === CUSTOM_AGENT.id) return CUSTOM_AGENT.label;
  return RUNNER_AGENTS.find((agent) => agent.id === id)?.label || id;
}

/**
 * Where agent CLIs usually live besides PATH: a server started from a GUI or a login
 * shell that never sourced the user's profile can miss them.
 * @param {string} home
 */
function extraBinDirs(home) {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * @param {string} bin
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, home?: string }} [options]
 * @returns {Promise<string>} the executable's absolute path, or "" when it is not installed
 */
export async function findExecutable(
  bin,
  { env = process.env, platform = process.platform, home = os.homedir() } = {},
) {
  const pathDirs = String(env.PATH || env.Path || "")
    .split(path.delimiter)
    .filter(Boolean);
  const dirs = [...new Set([...pathDirs, ...extraBinDirs(home)])];
  const names =
    platform === "win32"
      ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((ext) => `${bin}${ext.toLowerCase()}`)
      : [bin];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        if (platform !== "win32") await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return "";
}

/**
 * The agent CLIs installed on this machine, in catalog order. Only these are offered.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, home?: string }} [options]
 * @returns {Promise<Array<RunnerAgent & { path: string }>>}
 */
export async function detectInstalledAgents(options = {}) {
  const found = await Promise.all(
    RUNNER_AGENTS.map(async (agent) => ({ ...agent, path: await findExecutable(agent.bin, options) })),
  );
  return found.filter((agent) => agent.path);
}

/**
 * Validates what the UI sent. Returns the config to store, or an `error` string.
 * @param {unknown} value
 * @param {{ installed: string[] }} options
 * @returns {Promise<{ config: RunnerConfig } | { error: string }>}
 */
export async function validateRunnerConfig(value, { installed }) {
  const source = /** @type {any} */ (value && typeof value === "object" ? value : {});
  const agent = String(source.agent || "").trim();
  if (agent !== CUSTOM_AGENT.id && !installed.includes(agent)) {
    return { error: agent ? `${runnerAgentLabel(agent)} is not installed on this machine` : "Pick an agent" };
  }
  const command = agent === CUSTOM_AGENT.id ? String(source.command || "").trim() : "";
  if (agent === CUSTOM_AGENT.id && !command) return { error: "A custom agent needs a command" };
  if (command.length > MAX_CUSTOM_COMMAND) return { error: "That command is too long" };
  if (/[\r\n\0]/.test(command)) return { error: "The command must be one line" };
  const cwdInput = String(source.cwd || "").trim();
  if (!cwdInput || !path.isAbsolute(cwdInput.replace(/^~(?=$|\/)/, os.homedir()))) {
    return { error: "The working folder must be an absolute path" };
  }
  let cwd;
  try {
    cwd = await realpath(cwdInput.replace(/^~(?=$|\/)/, os.homedir()));
    if (!(await stat(cwd)).isDirectory()) return { error: "The working folder is not a folder" };
  } catch {
    return { error: "The working folder does not exist" };
  }
  return { config: { agent, ...(command ? { command } : {}), cwd } };
}

/**
 * Per-board runner choices, stored beside state.json and keyed by the canonical
 * board.json path.
 * @param {string} stateRoot
 */
export function createRunnerConfigStore(stateRoot) {
  const file = path.join(stateRoot, RUNNER_CONFIG_FILE);
  const lock = new AsyncMutex();
  /** @returns {Promise<Record<string, RunnerConfig>>} */
  async function readAll() {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {
    file,
    /** @param {string} boardFile @returns {Promise<RunnerConfig | null>} */
    async get(boardFile) {
      const entry = (await readAll())[boardFile];
      return entry && typeof entry.agent === "string" && typeof entry.cwd === "string" ? entry : null;
    },
    /** @param {string} boardFile @param {RunnerConfig | null} config */
    async set(boardFile, config) {
      return lock.runExclusive(async () => {
        const all = await readAll();
        if (config) all[boardFile] = { ...config, updated_at: new Date().toISOString() };
        else delete all[boardFile];
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
        return config ? all[boardFile] : null;
      });
    },
  };
}

/**
 * What the agent is told. The notes are data inside the prompt; the prompt itself is
 * never handed to a shell.
 * @param {{
 *   boardDir: string,
 *   boardName: string,
 *   items: Array<{ id: string, label: string, file: string, page?: string }>,
 *   prompts: any[],
 *   cwd: string,
 *   project?: { root: string, url: string } | null,
 * }} options
 */
export function buildRunnerPrompt({ boardDir, boardName, items, prompts, cwd, project = null }) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const lines = project
    ? [
        `You are the agent for a Liesel project board: the user is reviewing the real, running pages of the project at ${project.root} in a browser.`,
        `Board: ${boardName}`,
        `Project folder: ${project.root}`,
        ...(project.url ? [`Dev server: ${project.url}`] : []),
        `Board folder: ${boardDir}`,
        ...(cwd !== project.root ? [`Working folder: ${cwd}`] : []),
        "",
        "The user sent the notes below. A note on a live page names its URL path and the element's CSS selector: find the project source files that render that page and element (routes, components, styles) and edit them in place. The page hot-reloads through the dev server, so do not copy it into a new HTML file. A note on an HTML file item is applied by editing that file in place. Do not edit .liesel/board.json or anything under .liesel/.liesel-builds. Open any image path listed under a note to see what the user means.",
      ]
    : [
        `You are the agent for a Liesel board: a folder of HTML designs that the user is reviewing in a browser.`,
        `Board: ${boardName}`,
        `Board folder: ${boardDir}`,
        ...(cwd !== boardDir ? [`Working folder: ${cwd}`] : []),
        "",
        "The user sent the notes below. Apply each one by editing the HTML file of the item it names, in place; the board reloads a file as soon as it is saved. board.json holds only positions, labels and notes, never an item's content, so do not edit it. Open any image path listed under a note to see what the user means.",
      ];
  lines.push(
    "Do not run `liesel poll` or `liesel reply`: Liesel posts your final message to the user as your reply when you exit.",
    "When you are done, end with a short message to the user (one to three sentences) saying what you changed, or what you need from them.",
    ...(prompts.some((prompt) => Array.isArray(prompt?.changes) && prompt.changes.length > 0)
      ? [CHANGE_CONTRACT_RULE]
      : []),
    "",
    "Notes:",
  );
  prompts.forEach((prompt, index) => {
    const itemRef = prompt?.item && typeof prompt.item === "object" ? prompt.item : null;
    const item = itemRef ? byId.get(String(itemRef.id || "")) : null;
    const header = [`${index + 1}.`];
    const page = String(itemRef?.page || item?.page || "");
    if (item && page) {
      const url = project?.url ? `, ${project.url}${page}` : "";
      header.push(`Live page ${page} "${item.label}" (id ${item.id}${url})`);
    } else if (item) header.push(`Item "${item.label}" (id ${item.id}, file ${path.join(boardDir, item.file)})`);
    else if (itemRef) header.push(`Item "${itemRef.label || itemRef.id}" (id ${itemRef.id})`);
    else header.push("The whole board");
    if (prompt?.followup) header.push(`[${prompt.followup} on thread ${prompt.thread || ""}]`);
    lines.push(header.join(" "));
    if (prompt?.pin) {
      const where = [`Pin ${prompt.pin.number ?? ""}`.trim()];
      if (prompt.selector) where.push(`on \`${prompt.selector}\``);
      if (page) where.push(`at path ${page}`);
      if (prompt.pin.excerpt) where.push(`("${String(prompt.pin.excerpt).slice(0, 200)}")`);
      if (prompt.pin.heading) where.push(`in section "${String(prompt.pin.heading).slice(0, 120)}"`);
      if (prompt.pin.viewport) where.push(`at ${prompt.pin.viewport}px wide`);
      lines.push(`   ${where.join(" ")}`);
      if (prompt.pin.source) lines.push(`   Source: ${sourceText(prompt.pin.source, project?.root)}`);
    } else if (prompt?.selector) {
      lines.push(`   Element: \`${prompt.selector}\`${page ? ` at path ${page}` : ""}`);
    }
    const text = String(prompt?.prompt ?? "").trim();
    lines.push(`   Note: ${text ? text.replace(/\n/g, "\n   ") : "(no text)"}`);
    lines.push(...changeRecordLines(prompt?.changes));
    const attachments = Array.isArray(prompt?.attachments) ? prompt.attachments : [];
    for (const attachment of attachments) {
      if (attachment?.path) lines.push(`   Image: ${attachment.path}`);
    }
  });
  return `${lines.join("\n")}\n`;
}

/**
 * How to launch one agent. `file` + `args` go straight to spawn (no shell); `stdin` is
 * written to the child's stdin. `outputFile` names where an agent that can write its last
 * message to a file (Codex) should put it.
 * @param {{ config: RunnerConfig, executable: string, prompt: string, boardDir: string, outputFile: string, platform?: string }} options
 * @returns {{ file: string, args: string[], stdin: string, shell: boolean }}
 */
export function agentInvocation({ config, executable, prompt, boardDir, outputFile, platform = process.platform }) {
  const addDir = config.cwd === boardDir ? [] : ["--add-dir", boardDir];
  switch (config.agent) {
    case "claude":
      // -p prints the final answer; acceptEdits lets it edit files in its folder unattended.
      return {
        file: executable,
        args: ["-p", "--permission-mode", "acceptEdits", ...addDir],
        stdin: prompt,
        shell: false,
      };
    case "codex":
      // `-` reads the prompt from stdin; -o writes the last message to a file.
      return {
        file: executable,
        args: [
          "exec",
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check",
          "-C",
          config.cwd,
          ...addDir,
          "-o",
          outputFile,
          "-",
        ],
        stdin: prompt,
        shell: false,
      };
    case "opencode":
      return { file: executable, args: ["run", "--auto", prompt], stdin: "", shell: false };
    case "gemini":
      return {
        file: executable,
        args: [
          "--approval-mode",
          "auto_edit",
          ...(addDir.length ? ["--include-directories", boardDir] : []),
          "-p",
          prompt,
        ],
        stdin: "",
        shell: false,
      };
    case "custom":
      // The command line is the user's own; the prompt arrives on stdin and as a file
      // path in LIESEL_PROMPT_FILE, never spliced into the shell text.
      return platform === "win32"
        ? { file: String(config.command || ""), args: [], stdin: prompt, shell: true }
        : { file: "/bin/sh", args: ["-c", String(config.command || "")], stdin: prompt, shell: false };
    default:
      throw new Error(`Unknown agent: ${config.agent}`);
  }
}

/**
 * Runs one agent to completion. Output (stdout and stderr, interleaved) is kept up to
 * RUNNER_OUTPUT_KEEP and streamed through `onOutput`.
 * @param {{
 *   config: RunnerConfig,
 *   executable: string,
 *   prompt: string,
 *   boardDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   extraEnv?: Record<string, string>,
 *   timeoutMs?: number,
 *   onOutput?: (chunk: string) => void,
 *   onSpawn?: (stop: () => void) => void,
 *   spawnFn?: typeof import("node:child_process").spawn,
 *   platform?: string,
 * }} options
 * @returns {Promise<{ ok: boolean, code: number | null, signal: string | null, output: string, reply: string, error: string, stopped: boolean }>}
 */
export async function runAgent({
  config,
  executable,
  prompt,
  boardDir,
  env = process.env,
  extraEnv = {},
  timeoutMs = RUNNER_DEFAULT_TIMEOUT_MS,
  onOutput = () => {},
  onSpawn = () => {},
  spawnFn = crossSpawn,
  platform = process.platform,
}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "liesel-run-"));
  const promptFile = path.join(scratch, "prompt.txt");
  const outputFile = path.join(scratch, "last-message.txt");
  await writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
  const invocation = agentInvocation({ config, executable, prompt, boardDir, outputFile, platform });
  const binDir = config.agent === "custom" ? "" : path.dirname(executable);
  const childEnv = {
    ...env,
    ...(binDir ? { PATH: [binDir, env.PATH || ""].filter(Boolean).join(path.delimiter) } : {}),
    ...extraEnv,
    LIESEL_PROMPT_FILE: promptFile,
    LIESEL_RUNNER: "1",
  };
  let output = "";
  let stdout = "";
  let stopped = false;
  let timedOut = false;
  const keep = (/** @type {string} */ chunk) => {
    output = (output + chunk).slice(-RUNNER_OUTPUT_KEEP);
    onOutput(chunk);
  };
  try {
    const result = await new Promise((resolve) => {
      /** @type {import("node:child_process").ChildProcess} */
      let child;
      try {
        child = spawnFn(invocation.file, invocation.args, {
          cwd: config.cwd,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
          shell: invocation.shell,
          windowsHide: true,
          detached: platform !== "win32",
        });
      } catch (error) {
        resolve({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const kill = () => {
        try {
          if (platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        const hard = setTimeout(() => {
          try {
            if (platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, 3000);
        hard.unref?.();
      };
      onSpawn(() => {
        stopped = true;
        kill();
      });
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout = (stdout + chunk).slice(-RUNNER_OUTPUT_KEEP);
        keep(chunk);
      });
      child.stderr?.on("data", keep);
      child.stdin?.on("error", () => {});
      child.stdin?.end(invocation.stdin);
      let spawnError = "";
      child.on("error", (error) => {
        spawnError = error.message;
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, error: spawnError });
      });
    });
    const lastMessage = await readFile(outputFile, "utf8").catch(() => "");
    const reply = (lastMessage.trim() || stdout.trim()).slice(-RUNNER_REPLY_MAX);
    const ok = !stopped && !timedOut && !result.error && result.code === 0;
    const error = stopped
      ? "Stopped"
      : timedOut
        ? `Timed out after ${Math.round(timeoutMs / 60_000)} min`
        : result.error
          ? result.error
          : result.code !== 0
            ? `Exited with ${result.code ?? result.signal}`
            : "";
    return { ok, code: result.code, signal: result.signal, output, reply, error, stopped };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
