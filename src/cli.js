import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { access, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AxiError, installSessionStartHooks, RESERVED_COMMANDS, runAxiCli } from "axi-sdk-js";

import {
  addItem,
  BoardError,
  boardDirPath,
  boardFilePath,
  ensureTab,
  pairItems,
  placeItem,
  readBoard,
  readOrCreateBoard,
  resolveBoardTarget,
  writeBoard,
} from "./board.js";
import {
  adoptLegacyEnv,
  BOARD_FILE_NAME,
  CLI_NAME,
  INSTALL_SOURCE,
  POLL_INTERRUPTED_MESSAGE,
  productEnv,
  SERVER_APP_ID,
} from "./brand.js";

import { createDesignOutput, DESIGN_PRIORITY_RULE, DESIGN_SYSTEM_HINT } from "./design-reference.js";
import {
  buildSelfContainedHtml,
  exportFileName,
  exportWarningSummaries,
  splitExportWarnings,
} from "./export-bundle.js";
import {
  createUnpublishedPageHtml,
  hostRejectedShareWrite,
  normalizeSiteId,
  publishedDespiteError,
  publishToHtmlApp,
  updateHtmlApp,
} from "./html-app.js";
import { localInterfaceAddresses } from "./local-address.js";
import {
  clientHost,
  DEFAULT_PORT,
  defaultPort,
  ensureStateDir,
  hostForUrl,
  isWildcardHost,
  LOOPBACK_HOST,
  resolveConcreteListenHosts,
  serverLogFile,
  stateFile,
  stateId,
} from "./paths.js";
import {
  computeVsCodePluginLocationsUpdate,
  linkCursorLocalPlugin,
  readPluginManifest,
  resolveCursorLocalPluginsDir,
  resolvePluginRoot,
  resolveVsCodeSettingsFile,
  spawnPluginClientSync,
  writeTextFileAtomically,
} from "./plugin.js";
import { findPlaybook, listPlaybooks, playbookIds, PLAYBOOK_ROUTER_HELP } from "./playbooks.js";
import { DEFAULT_BOARD_DIR, initProject, ProjectInitError } from "./project-init.js";
import { analyzeSelfPaint, SELF_PAINT_WARNING } from "./self-paint.js";
import { resolveDesignAssetPath, serve } from "./server.js";
import { isHtmlPath } from "./artifact-path.js";
import { canonicalFile, sessionKey, SessionStore } from "./session-store.js";
import { generateSharePassword } from "./share-password.js";
import { initDefaultTelemetry } from "./telemetry.js";
import { excalidrawLibrariesDir, loadExcalidrawLibraries } from "./whiteboard-library-store.js";

const SHARE_VALUE_FLAGS = ["--password", "--token", "--site", "--update-key"];
const COMMANDS = new Set([
  "open",
  "poll",
  "reply",
  "end",
  "stop",
  "server",
  "playbook",
  "design",
  "setup",
  "export",
  "share",
  "libraries",
  "board",
  "init",
  "mcp",
]);
// SDK-reserved built-ins (e.g. `update`) must reach runAxiCli untouched; otherwise
// the bare-arg normalization below would rewrite them into the hidden `open` command.
const RESERVED = new Set(RESERVED_COMMANDS);
const DESCRIPTION =
  "Liesel helps agents turn rich HTML designs and artifacts into collaborative human review surfaces. Whenever you are about to give user a complex response that will be easier to understand via a rich / interactive page, consider using Liesel. " +
  "First generate an interactive HTML artifact according to user request, then run `liesel <html-file>` so the user can visually review it, annotate elements or selected text, queue prompts, and send feedback back through `liesel poll`.";
export const POLL_WAKE_PATH_RULES = Object.freeze([
  "Keep the poll in the foreground by default and let it return the feedback directly to the agent.",
  "A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent.",
  "Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive.",
  "If the harness has no completion-aware background facility, use the foreground poll or first wire a verified wake callback into the surrounding supervisor.",
  "Do not tell the user the artifact is being monitored until that wake path is live.",
  "If the poll gets killed or times out before feedback arrives, re-run it - feedback remains queued until delivery. Poll delivery consumes the response, so read it completely.",
  "If it returns browser_disconnected, the review window stayed disconnected past its reconnect grace period but the session remains resumable; ask the user whether to reopen or end it, and do neither uninvited.",
]);
export const POLL_SEND_AND_END_RULE =
  "`Send & End` ends the session. Its final feedback is still delivered once. After that response, polling stops, and the agent must not reopen the session uninvited.";
export const POLL_AGENT_REPLY_RULE =
  "Keep the reply concise. Only when a longer reply is genuinely necessary, use Markdown structure - blank-line paragraphs, `- ` / `1. ` lists, `## ` headings - so it renders scannably instead of a wall of text, and pass that body with `--agent-reply-file <path>` (`-` reads stdin) so newlines survive quoting.";
const POLL_AGENT_REPLY_HELP_POINTER =
  "The Conversation panel's Markdown subset is in README's Feedback controls bullet.";
const POLL_AGENT_REPLY_NEXT_POINTER = "The Conversation panel's Markdown subset is in `liesel poll --help` and README.";
const POLL_VALUE_FLAGS = ["--agent-reply", "--agent-reply-file", "--timeout-ms", "--owner", "--pending", "--thread"];
const AGENT_REPLY_JSON_LIMIT_BYTES = 2 * 1024 * 1024;
const AGENT_REPLY_JSON_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ agent_reply: "" }));
const AGENT_REPLY_INPUT_LIMIT_BYTES = AGENT_REPLY_JSON_LIMIT_BYTES - AGENT_REPLY_JSON_ENVELOPE_BYTES;
const AGENT_REPLY_LIMIT_LABEL = "2 MB JSON request limit";
const POLL_STATE_HEADER = "liesel-poll-state";
const CODEX_POLL_WAKE_PATH_GUIDANCE =
  "Codex detected: completed background tasks may not resume Codex automatically, so keep the poll attached to the active turn.";
// Inlined at build time from package.json; falls back to reading package.json so source-run tests work.
export const VERSION =
  process.env.LIESEL_BUILD_VERSION ||
  process.env.LIESEL_BUILD_VERSION ||
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export function detectInvokingAgent(env = process.env) {
  return ["CODEX_SANDBOX", "CODEX_THREAD_ID"].some((key) => Object.hasOwn(env, key)) ? "codex" : "generic";
}

export function shouldNarratePollWaitTicks({ isTTY }) {
  return Boolean(isTTY);
}

export function herdrPollChimeEnabled(env = process.env) {
  return env.HERDR_ENV === "1" && productEnv("HERDR_CHIME", env) === "1";
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   runner?: (command: string, args: string[], options: { stdio: "ignore" }) => import("node:child_process").ChildProcess,
 * }} [options]
 */
export function notifyHerdrPollReady({ env = process.env, runner = spawn } = {}) {
  if (!herdrPollChimeEnabled(env)) return false;
  try {
    const child = runner(
      "herdr",
      [
        "notification",
        "show",
        "Liesel review ready",
        "--body",
        "The artifact is open and Liesel is polling for your feedback.",
        "--sound",
        "request",
      ],
      { stdio: "ignore" },
    );
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        return;
      }
    };
    const timer = setTimeout(kill, 2_000);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      process.off("exit", kill);
    };
    child.on("error", () => {});
    child.once("close", cleanup);
    process.once("exit", kill);
    child.unref();
    return true;
  } catch {
    // A desktop notification is optional and must never interrupt feedback delivery.
    return false;
  }
}

export function pollExecutionGuidance({ agent = "generic" } = {}) {
  const sharedGuidance = POLL_WAKE_PATH_RULES.join(" ");
  const agentGuidance = agent === "codex" ? ` ${CODEX_POLL_WAKE_PATH_GUIDANCE}` : "";
  return `${sharedGuidance}${agentGuidance}`;
}

// Mirrors the SDK's own version-flag detection so the fast path below prints exactly
// what `runAxiCli` would have printed, for exactly the same argv shapes.
export function isVersionOnlyArgv(argv) {
  return argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V");
}

export async function run(argv) {
  adoptLegacyEnv(process.env);
  // `--version` sits on the agent-startup hot path (harnesses probe every tool's version
  // at session start), so it must never pay for state-dir creation or the telemetry
  // request drain in the `finally` below - that drain alone costs up to a full second.
  if (isVersionOnlyArgv(argv)) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  await ensureStateDir();
  const normalizedArgv = normalizeArgv(argv);
  const agent = detectInvokingAgent(process.env);
  const isTopLevelHelp = argv.length === 1 && argv[0] === "--help";
  const command = telemetryCommandName(argv);
  const telemetry = initDefaultTelemetry({
    app: CLI_NAME,
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
  });
  telemetry.pageview(`/${command}`, { command });
  try {
    await runAxiCli({
      description: DESCRIPTION,
      version: VERSION,
      argv: isTopLevelHelp ? [] : normalizedArgv,
      topLevelHelp: createTopLevelHelp({ agent }),
      home: async () =>
        createHomeOutput({
          bin: process.argv[1] || "liesel",
          sessions: isTopLevelHelp ? [] : await visibleSessions(),
          includeSessions: !isTopLevelHelp,
          agent,
        }),
      commands: {
        open: openCommand,
        poll: pollCommand,
        reply: replyCommand,
        end: endCommand,
        stop: stopCommand,
        playbook: playbookCommand,
        design: designCommand,
        setup: setupCommand,
        server: serverCommand,
        export: exportCommand,
        share: shareCommand,
        libraries: librariesCommand,
        board: boardCommand,
        init: initCommand,
        update: updateCommand,
        mcp: mcpCommand,
      },
      getCommandHelp: (command) => getCommandHelp(command, { agent }),
    });
    telemetry.track("command", { command, status: "success" });
  } catch (error) {
    telemetry.track("command", { command, status: "error" });
    throw error;
  } finally {
    await telemetry.close(1_000);
  }
}

export function collapseHomeDirectory(file, home) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");

  if (normalizedFile === normalizedHome) {
    return "~";
  }
  if (normalizedFile.startsWith(`${normalizedHome}/`)) {
    return `~/${normalizedFile.slice(normalizedHome.length + 1)}`;
  }
  return file;
}

export function normalizeArgv(argv) {
  const first = argv[0];
  if (!first || COMMANDS.has(first) || RESERVED.has(first)) {
    return argv;
  }
  if (first.startsWith("-")) {
    return argv.some((arg) => isHtmlPath(arg)) ? ["open", ...argv] : argv;
  }
  return ["open", ...argv];
}

export function telemetryCommandName(argv) {
  const normalized = normalizeArgv(argv);
  return normalized[0] && !normalized[0].startsWith("-") ? normalized[0] : "home";
}

export function createHomeOutput({ bin, sessions, includeSessions = true, agent = "generic" }) {
  return {
    bin: collapseHomeDirectory(bin, os.homedir()),
    description: DESCRIPTION,
    ...(includeSessions
      ? {
          sessions: sessions.map((session) => ({
            file: session.file,
            status: session.status,
            url: session.url,
            pending_prompts: session.pending_prompts || 0,
            listener: session.listener || "none",
          })),
        }
      : {}),
    visual_guidance: [
      "Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance",
      "Show, don't tell: explain concepts, flows, relationships, and comparisons with labeled illustrations - hand-authored inline SVG, per the diagram playbook - and show existing UI or state with screenshots of the real pages (run the app read-only if needed); reserve prose for what cannot be shown, such as rationale, trade-offs, and open questions",
      "Structure the prose that remains with sections, cards, tables, annotated snippets, and side-by-side comparisons instead of long paragraphs",
      "Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view",
      "Prevent horizontal overflow at every nesting level: nested grid/flex children also need minmax(0, 1fr) tracks and min-width: 0, especially when badges, labels, or status text use wide pixel or monospace fonts; wrap, truncate, or contain long unbreakable text deliberately",
    ],
    playbooks: listPlaybooks(),
    help: [
      "Run `liesel <html-file>` to open or resume a Liesel session. If the user explicitly ended the session from the browser, this refuses to reopen it and explains why instead of reopening uninvited - pass `--reopen` only when the user asks for further review or something important needs their visual attention",
      "Unless the user specifies another location, create HTML artifacts in the current working directory under `.liesel/`",
      "Liesel serves the html file through a local express.js server. If your html needs to reference other filesystem assets such as images, CSS, fonts, and local scripts, copy them into the same directory as the HTML file, then reference them with relative paths from that directory. Never prepend `/` to those asset paths - root paths won't work",
      `Run \`liesel poll <html-file>\` to wait for user feedback. It long-polls and stays silent until the user sends feedback, ends the session, or leaves every review window disconnected past the reconnect grace period, so leave it running - never kill it. Detected layout issues never return this poll: the browser files them in the user's Layout issues inbox in the Liesel top bar, and they arrive as an ordinary tag "layout-warnings" prompt only when the user selects them and queues the fixes. Never edit the artifact to chase a layout issue the user has not queued. The only exception is a fatal artifact_failures response, which means the review surface itself could not be used. ${pollExecutionGuidance({ agent })} ${POLL_SEND_AND_END_RULE}`,
      'Run `liesel reply <html-file> --agent-reply "<message>"` to show a concise reply and exit once Liesel accepts it, when you are handing a result back and are not about to long-poll. The board stops showing Working only after this command exits 0. Use `liesel poll <html-file> --agent-reply "<message>"` when that reply should be followed by another wait for feedback. A longer reply uses `--agent-reply-file <path>` (`-` reads stdin) on either command. Run `liesel reply --help` for the receipt contract',
      'Mermaid is the whiteboard opt-in, not the diagram default: only when the user asks for an editable whiteboard, author that diagram as Mermaid in a `.mermaid` container. Rendered Mermaid diagrams there become embedded, editable Excalidraw whiteboards in the browser (click a diagram to unlock editing; a Fullscreen action opens it over the whole viewport) - flowchart, sequence, class, ER, and state diagrams convert to editable shapes; other types embed as an image to draw on. Scenes autosave locally; an unmodified autosave silently re-converts when a reload changes the Mermaid source. If the reviewer edited the scene, they choose to re-convert and discard saved edits or keep editing the saved scene. Standalone and exported copies still render plain Mermaid. Queue feedback adds a prompt to the Conversation panel; when the user sends it, poll returns a tag "whiteboard" prompt carrying a bounded edit summary plus local scenePath (.excalidraw JSON) and previewPath (PNG) files - read the summary first, open the files only when needed, then apply the edits by updating the Mermaid source in the artifact (never try to write the scene back)',
      "Run `liesel end <html-file>` to end a session as the agent - ending it this way still allows a plain reopen later. When the user ends it from the browser instead, a later `liesel <html-file>` refuses to reopen it without `--reopen`",
      "Run `liesel export <html-file> [--out <path>]` to write a portable copy of the artifact - one HTML file with its LOCAL assets inlined - so it opens with no Liesel server and no sibling files. Remote CDN/font references are left as links, so it needs network to render those. Users can also export from the browser chrome's overflow menu",
      "Run `liesel share <html-file> [--private | --password <pw>]` to publish the artifact on ht-ml.app (https://ht-ml.app), a third-party hosting service not part of Liesel, and get back a visitable URL. Shares are PUBLIC by default, so anyone with the link can open them. Pass --private to publish a PRIVATE page behind a password Liesel generates and returns - hand the user that password with the URL and say it is a shared secret anyone they give it to can use; --password <pw> uses one you were already given instead. Local assets are inlined; remote refs load over the network. It also returns a secret update_key that can republish or lock the same URL later - run `liesel share --help` before using it. Users can also publish from the browser chrome's overflow menu",
      "A request under a hostname Liesel does not answer to (a reverse-proxy name, a LAN IP) gets 403 `forbidden host`. Set `LIESEL_ALLOWED_HOSTS` in the environment that starts the server, running `liesel stop` first if one is already up. See README's Allowed hosts section for the rules",
      `Liesel (this fork) also renders a whole directory of variants on one board: \`${CLI_NAME} board open <dir>\` prints the board URL, \`${CLI_NAME} poll <dir>\` waits for its feedback, and \`${CLI_NAME} board add <dir> <file.html>\` drops a new variant on the plane. Use a board instead of opening several artifacts when the user is comparing or tuning versions of the same design`,
      "Run `liesel stop` to shut down the background server (it also self-stops when idle or after the last session ends with nothing connected)",
      `Run \`liesel playbook <playbook_id>\` for focused artifact guidance. ${PLAYBOOK_ROUTER_HELP}`,
      DESIGN_SYSTEM_HINT,
      "Use liesel when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop",
    ],
  };
}

export function createPlaybookOutput(args) {
  const id = args[0];
  if (!id) {
    return {
      playbooks: listPlaybooks(),
      help: ["Run `liesel playbook <playbook_id>` for focused artifact guidance", PLAYBOOK_ROUTER_HELP],
    };
  }

  const playbook = findPlaybook(id);
  if (!playbook) {
    throw new AxiError(`Unknown playbook: ${id}`, "VALIDATION_ERROR", [
      `Run \`liesel playbook\` to list known IDs: ${playbookIds().join(", ")}`,
    ]);
  }

  return { playbook };
}

export function createOpenOutput({
  file,
  url,
  status,
  agent = "generic",
  selfPaintWarning = undefined,
  networkWarning = undefined,
}) {
  const selfPaintPrefix = selfPaintWarning
    ? `First fix the unpainted page surface flagged in self_paint_warning and save - Liesel live-reloads the artifact automatically, so you do not need to re-run \`liesel ${file}\`. `
    : "";
  // A failed bind is invisible to the person holding a review link at that address - the page
  // simply does not load - so the agent is told to pass it on rather than leave it in a field.
  const networkPrefix = networkWarning
    ? "Liesel could not serve every address it was asked to (see network_warning): when you next message the user, tell them, because review links at that address will not load until it clears. "
    : "";
  return {
    session: { file, url, status },
    ...(networkWarning ? { network_warning: networkWarning } : {}),
    ...(selfPaintWarning ? { self_paint_warning: selfPaintWarning } : {}),
    next_step: `${networkPrefix}${selfPaintPrefix}Do not respond to the user just yet. Now you must run \`liesel poll ${file}\`. This command long-polls until the user sends feedback, ends the session, or leaves every review window disconnected past the reconnect grace period, and it stays silent the whole time - that is normal, never kill it. Layout issues the browser detects do not return this poll; they wait in the user's Layout issues inbox until the user queues them, then arrive as an ordinary tag "layout-warnings" prompt. Do not pass --timeout-ms during normal agent use. ${pollExecutionGuidance({ agent })} After applying feedback, run \`liesel poll ${file} --agent-reply "<message for the user>"\` without --timeout-ms to show a concise response in Liesel and keep waiting for more feedback. If instead you are handing back a result without starting another long-poll, run \`liesel reply ${file} --agent-reply "<message for the user>"\` to get an acceptance receipt. ${POLL_AGENT_REPLY_RULE} ${POLL_AGENT_REPLY_NEXT_POINTER} If the user ends the session, stop polling and do not reopen it by re-running \`liesel ${file}\` unless the user asks for further review or something genuinely important needs their visual attention - deliver routine updates directly in this conversation instead. When reopening is warranted, run \`liesel ${file} --reopen\`.`,
  };
}

// Shown when a plain `liesel <file>` targets a session the user explicitly ended from the
// browser. Reviving it silently would reopen a browser window the human deliberately closed, so
// this refuses and requires the explicit --reopen opt-in instead of erroring - the session
// staying closed is the correct, idempotent outcome unless the agent has a real reason to reopen.
export function createUserEndedOpenOutput({ file, url, networkWarning = undefined }) {
  return {
    session: { file, url, status: "user-ended" },
    ...(networkWarning ? { network_warning: networkWarning } : {}),
    next_step: `The user explicitly ended this Liesel session from the browser, so \`liesel ${file}\` did not reopen it. Do not reopen unless the user asks for further review or something genuinely important needs their visual attention - deliver routine updates directly in this conversation instead. When reopening is warranted, run \`liesel ${file} --reopen\`.`,
  };
}

async function openCommand(args) {
  const file = firstPositionalArg(args);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `liesel <html-file>`"]);
  }
  await assertHtmlFile(file);
  const absolute = await canonicalFile(file);
  const selfPaintWarning = await selfPaintWarningForFile(absolute);
  const noGate = args.includes("--no-gate");
  const reopen = args.includes("--reopen");
  const baseUrl = await ensureServer({
    forceRestart: shouldForceRestartForLocalBuild(process.argv[1] || ""),
    reloadKey: sessionKey(absolute),
  });
  const response = await postJson(`${baseUrl}/api/sessions`, { file: absolute, noGate, reopen });
  if (response.status === "user-ended") {
    return createUserEndedOpenOutput({
      file: absolute,
      url: response.url,
      networkWarning: response.network_warning,
    });
  }
  if (shouldOpenBrowser(args, process.env)) {
    try {
      const open = (await import("open")).default;
      await open(response.url);
    } catch {
      response.status = "ready";
    }
  }
  return createOpenOutput({
    file: absolute,
    url: response.url,
    status: response.status || "opened",
    agent: detectInvokingAgent(process.env),
    selfPaintWarning,
    networkWarning: response.network_warning,
  });
}

// A read failure here must not break the open - the server reports unreadable artifacts
// through its own fatal path, and the self-paint check always fails open.
async function selfPaintWarningForFile(absolute) {
  try {
    return analyzeSelfPaint(await readFile(absolute, "utf8")).painted ? undefined : SELF_PAINT_WARNING;
  } catch {
    return undefined;
  }
}

export function shouldOpenBrowser(args, env) {
  return !args.includes("--no-open") && productEnv("NO_OPEN", env) !== "1";
}

async function pollCommand(args) {
  const file = firstPositionalArg(args, POLL_VALUE_FLAGS);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `liesel poll <html-file>`"]);
  }
  const ownerFlag = inspectValueFlag(args, "--owner");
  const owner = ownerFlag.present ? String(ownerFlag.value || "").trim() : null;
  if (ownerFlag.present && (!owner || owner.startsWith("-") || owner.toLowerCase() === "none")) {
    throw new AxiError(
      owner?.toLowerCase() === "none" ? "--owner none is reserved" : "--owner requires a non-empty label",
      "VALIDATION_ERROR",
      ["Pass `--owner <label>` to identify the process listening for feedback"],
    );
  }
  const takeover = args.includes("--takeover");
  const agentReply = await resolveAgentReply(args);
  const absolute = await canonicalFile(await resolveBoardTarget(file));
  const baseUrl = await ensureServer();
  const timeoutMs = flagValue(args, "--timeout-ms");
  const query = new URLSearchParams({ file: absolute });
  if (timeoutMs) query.set("timeoutMs", timeoutMs);
  if (owner) query.set("owner", owner);
  if (takeover) query.set("takeover", "1");
  // The indefinite poll looks hung from the agent's side (stdout stays empty until the user
  // acts), so narrate the wait on stderr and leave re-run guidance behind if the agent's
  // harness kills the process anyway. stderr keeps the stdout JSON contract intact.
  // The one-shot banner is that "not hung" signal and stays unconditional; only the recurring
  // ticks - one line per minute, unbounded - are gated on an interactive stderr so piped,
  // merged agent captures do not accumulate them.
  const onPollSignal = (signal) => {
    process.stderr.write(`\n${pollInterruptedText(absolute)}\n`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  if (!timeoutMs) {
    // Register before the banner write below: a harness that kills the poll as soon as the
    // banner appears can deliver the signal before the next statement runs, and without a
    // handler the default disposition exits silently with no re-run guidance.
    process.on("SIGINT", onPollSignal);
    process.on("SIGTERM", onPollSignal);
  }
  const waitReporter = timeoutMs
    ? null
    : startPollWaitReporter({
        file: absolute,
        narrateTicks: shouldNarratePollWaitTicks({ isTTY: process.stderr.isTTY }),
      });
  try {
    const request =
      agentReply || takeover
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(agentReply ? { agent_reply: agentReply } : {}),
          }
        : {};
    const response = await fetchJson(`${baseUrl}/api/poll?${query}`, {
      ...request,
      // Poll ownership is claimed before the response is available. Retrying a transport failure
      // can leave the first claim alive and make the retry reject itself as LISTENER_ACTIVE.
      retries: 0,
      onResponse: (pollResponse) => {
        if (pollResponse.headers.get(POLL_STATE_HEADER) === "listening") notifyHerdrPollReady();
      },
    });
    if (response.code === "LISTENER_REPLACED") {
      throw new AxiError("Liesel poll listener was replaced by a takeover", "LISTENER_REPLACED", [
        `Re-run liesel poll ${absolute} only if you intend to take over listening`,
      ]);
    }
    return createPollOutput({ file: absolute, response, agent: detectInvokingAgent(process.env) });
  } finally {
    waitReporter?.stop();
    if (!timeoutMs) {
      process.off("SIGINT", onPollSignal);
      process.off("SIGTERM", onPollSignal);
    }
  }
}

const REPLY_VALUE_FLAGS = ["--agent-reply", "--agent-reply-file", "--pending", "--thread"];
const REPLY_TOO_LARGE_HELP = "Shorten the reply, then retry `liesel reply <html-file>`";

async function replyCommand(args) {
  const file = firstPositionalArg(args, REPLY_VALUE_FLAGS);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", [
      'Run `liesel reply <html-file> --agent-reply "<message>"`',
    ]);
  }
  const inline = inspectValueFlag(args, "--agent-reply");
  const fromFile = inspectValueFlag(args, "--agent-reply-file");
  if (!inline.present && !fromFile.present) {
    throw new AxiError("An agent reply is required", "VALIDATION_ERROR", [
      'Pass exactly one of --agent-reply "<message>" or --agent-reply-file <path> (`-` reads stdin)',
      "Use `liesel poll <html-file> --agent-reply` when the reply should be followed by a wait for feedback",
    ]);
  }
  const text = await resolveAgentReply(args, { tooLargeHelp: REPLY_TOO_LARGE_HELP });
  if (!String(text || "").trim()) {
    throw new AxiError("Agent reply text was empty", "VALIDATION_ERROR", [
      'Pass --agent-reply "<message>" or --agent-reply-file <path> with a non-empty body',
    ]);
  }
  const target = await resolveBoardTarget(file);
  if (path.basename(target) !== BOARD_FILE_NAME) await assertHtmlFile(target);
  const absolute = await canonicalFile(target);
  const baseUrl = await ensureServer();
  await postAgentReply(`${baseUrl}/api/${sessionKey(absolute)}/agent-reply`, text, absolute);
  return createReplyOutput(absolute);
}

function createReplyOutput(file) {
  const isBoard = path.basename(file) === BOARD_FILE_NAME;
  const subject = isBoard ? "the board" : file;
  return {
    reply: { file, status: "sent" },
    next_step: `Liesel accepted the reply for ${subject} and is no longer showing Working; every note it had delivered now reads Done on the board. Run \`liesel poll ${file}\` when you are ready to wait for more feedback.`,
  };
}

export function pollWaitBannerText(file) {
  return (
    `[liesel] Long-polling for user feedback on ${file}. This stays silent until the user sends feedback, ends the session, or leaves every review window disconnected past the reconnect grace period - leave it running. ` +
    `Detected layout issues do NOT return this poll: they wait in the user's Layout issues inbox until the user queues them as ordinary feedback. ` +
    `If it gets killed or times out before feedback arrives, re-run \`liesel poll ${file}\` - feedback remains queued until delivery. Poll delivery consumes the response, so read it completely.`
  );
}

export function pollWaitTickText(elapsedMs) {
  const minutes = Math.round(elapsedMs / 60_000);
  return `[liesel] Still waiting for user feedback (${minutes}m). Leave this running until the user sends feedback, ends the session, or leaves every review window disconnected.`;
}

export function pollInterruptedText(file) {
  return (
    `[liesel] Poll interrupted before user feedback arrived. The user may still be reviewing - ` +
    `re-run \`liesel poll ${file}\` to keep waiting; feedback remains queued until delivery. Poll delivery consumes the response, so read it completely.`
  );
}

export function startPollWaitReporter({
  file,
  write = (line) => {
    process.stderr.write(line);
  },
  intervalMs = 60_000,
  narrateTicks = true,
}) {
  write(`${pollWaitBannerText(file)}\n`);
  if (!narrateTicks) return { stop: () => {} };
  let elapsedMs = 0;
  const timer = setInterval(() => {
    elapsedMs += intervalMs;
    write(`${pollWaitTickText(elapsedMs)}\n`);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * @returns {{
 *   session: { file: string, status: string, session_ended?: boolean, ended_by?: string },
 *   prompts?: any[],
 *   artifact_failures?: any[],
 *   next_step?: string,
 *   dom_snapshot?: string,
 * }}
 */
export function createPollOutput({ file, response, agent = "generic" }) {
  if (response.status === "missing") {
    throw new AxiError("No active Liesel session for this file", "NOT_FOUND", [`Run \`liesel ${file}\` first`]);
  }
  if (response.status === "feedback") {
    const artifactFailures = Array.isArray(response.artifact_failures) ? response.artifact_failures : [];
    const sessionEnded = Boolean(response.session_ended);
    const endedBy = typeof response.ended_by === "string" ? response.ended_by : undefined;
    return {
      session: {
        file,
        status: "feedback",
        ...(sessionEnded ? { session_ended: true, ...(endedBy ? { ended_by: endedBy } : {}) } : {}),
      },
      prompts: response.prompts || [],
      ...(artifactFailures.length > 0 ? { artifact_failures: artifactFailures } : {}),
      next_step: createFeedbackNextStep(file, artifactFailures, sessionEnded, endedBy, response.prompts || [], agent),
      dom_snapshot: response.dom_snapshot || "",
    };
  }
  if (response.status === "ended") {
    return {
      session: { file, status: "ended", ...(response.ended_by ? { ended_by: response.ended_by } : {}) },
      next_step: createEndedNextStep(file, response.ended_by),
    };
  }
  if (response.status === "browser_disconnected") {
    return {
      session: { file, status: "browser_disconnected" },
      next_step:
        "The Liesel review window was closed or disconnected. The session remains open and resumable; ask the user whether they want to reopen it or end the session. Do not reopen or end it without their direction.",
    };
  }
  return {
    session: { file, status: response.status || "waiting" },
    next_step: `No user feedback arrived before the optional timeout. Run \`liesel poll ${file}\` without --timeout-ms to wait indefinitely - feedback remains queued until delivery, so re-running the poll is safe while waiting. Poll delivery consumes the response, so read it completely.`,
  };
}

function createFeedbackNextStep(file, artifactFailures, sessionEnded, endedBy, prompts = [], agent = "generic") {
  const count = artifactFailures.length;
  const whiteboardNote = prompts.some((prompt) => prompt && prompt.tag === "whiteboard")
    ? `This feedback includes whiteboard edits (tag "whiteboard"): read the edit summary in the prompt text first, and only when it is not enough, open the target's scenePath (.excalidraw scene JSON) or previewPath (PNG) local files for detail. The artifact's Mermaid source stays authoritative - apply the edits by updating the Mermaid text in ${file} (Liesel live-reloads it); never try to write the .excalidraw scene back. `
    : "";
  const layoutNote = prompts.some((prompt) => prompt && prompt.tag === "layout-warnings")
    ? `This feedback includes layout issues the user selected from the Liesel Layout issues inbox (tag "layout-warnings"): the target lists the exact warning ids and targets. Apply every listed fix in one pass before saving so the user's review refreshes once. Queueing is a repair request, not a resolution - Liesel only marks a warning resolved after a newer artifact load and a complete check at the same viewport no longer detects it. `
    : "";
  const attachmentNote = prompts.some((prompt) => Array.isArray(prompt?.attachments) && prompt.attachments.length)
    ? `Some prompts carry image attachments the user added: each is an object in the prompt's \`attachments\` array with an absolute local \`path\` (plus id, mime, and dimensions). Open those image files to see what the user is referring to. `
    : "";
  if (sessionEnded) {
    const failureNote =
      count > 0
        ? endedBy === "user"
          ? `${count} fatal artifact failure${count === 1 ? "" : "s"} arrived alongside this final feedback - the review surface itself could not be used. Repair ${file}, then open it directly and confirm it renders without reopening this ended Liesel session. `
          : `${count} fatal artifact failure${count === 1 ? "" : "s"} arrived alongside this final feedback - the review surface itself could not be used. Repair ${file}, then run \`liesel ${file}\` to open a fresh session. `
        : "";
    if (endedBy === "user") {
      const reopenNote =
        count > 0
          ? ""
          : ` Only run \`liesel ${file} --reopen\` if the user explicitly asks for further review or something genuinely important needs their visual attention.`;
      return `${failureNote}${layoutNote}${whiteboardNote}${attachmentNote}This was the last feedback before the user ended the session. Stop polling ${file} and do not reopen it - deliver any remaining updates directly in this conversation instead.${reopenNote}`;
    }
    return `${failureNote}${layoutNote}${whiteboardNote}${attachmentNote}This was the last feedback before the Liesel session ended. Stop polling ${file}. Deliver any remaining updates directly in this conversation, or run \`liesel ${file}\` to open a fresh session if the user needs further visual review.`;
  }
  const isBoard = path.basename(file) === BOARD_FILE_NAME;
  const prefix =
    count > 0
      ? artifactFailuresPrefix(file, artifactFailures)
      : isBoard
        ? `This feedback is about items on the board in ${path.dirname(file)}. Apply each prompt to the HTML file of the item it names (its target carries the item id and label); board.json holds only positions, labels and notes, never an item's content. `
        : `Apply the requested changes to ${file}. `;
  return `${prefix}${layoutNote}${whiteboardNote}${attachmentNote}Do not respond to the user just yet. If you are continuing to wait for feedback, run \`liesel poll ${file} --agent-reply "<message for the user>"\` without --timeout-ms to reply and keep polling. If instead you are handing back a result without starting another long-poll, run \`liesel reply ${file} --agent-reply "<message for the user>"\` to post it and receive an acceptance receipt. ${POLL_AGENT_REPLY_RULE} ${POLL_AGENT_REPLY_NEXT_POINTER} The poll waits silently until the user sends more feedback, ends the session, or leaves every review window disconnected past the reconnect grace period - never kill it. ${pollExecutionGuidance({ agent })}`;
}

// The narrow fatal path. Ordinary layout findings never reach the poll: they wait in the user's
// Layout issues inbox. Only failures that make the review itself unusable - the artifact document
// not being servable, or one of its own local assets failing to load - arrive without user action.
function artifactFailuresPrefix(file, artifactFailures) {
  const count = artifactFailures.length;
  const plural = count === 1 ? "" : "s";
  const details = artifactFailures
    .map((failure) => `${failure.kind}: ${failure.detail}`)
    .slice(0, 5)
    .join("; ");
  return `${count} fatal artifact failure${plural} detected - the review surface could not be used (${details}). Repair ${file} so it renders with all of its local assets, then re-check in the browser. Liesel live-reloads the artifact automatically after you save, so you do not need to re-run \`liesel ${file}\` for this. `;
}

function createEndedNextStep(file, endedBy) {
  if (endedBy === "user") {
    return `The user ended this Liesel session. Stop polling ${file} - do not run \`liesel ${file}\` to reopen it. Deliver any remaining updates directly in this conversation instead. Only reopen with \`liesel ${file} --reopen\` if the user explicitly asks for further review or something genuinely important needs their visual attention.`;
  }
  return `This Liesel session for ${file} has ended. Stop polling. Deliver any remaining updates directly in this conversation, or run \`liesel ${file}\` to open a fresh session if the user needs further visual review.`;
}

async function endCommand(args) {
  const file = firstPositionalArg(args);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `liesel end <html-file>`"]);
  }
  const absolute = await canonicalFile(await resolveBoardTarget(file));
  const baseUrl = await ensureServer();
  const response = await postJson(`${baseUrl}/api/end`, { file: absolute });
  return { session: { file: absolute, status: response.status || "ended" } };
}

const BOARD_VALUE_FLAGS = ["--x", "--y", "--w", "--h", "--tab", "--label", "--status", "--name"];

function boardSummary(board, dir) {
  return {
    dir,
    name: board.name,
    tabs: board.tabs,
    items: board.items.map((item) => ({
      id: item.id,
      label: item.label,
      file: item.file,
      ...(item.page ? { page: item.page } : {}),
      tab: item.tab,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      status: item.status,
      notes: item.notes.length,
      pins: item.notes.map((note) => ({
        number: note.number,
        selector: note.selector,
        prompt_id: note.prompt_id || null,
      })),
      tune: Object.keys(item.tune).length > 0 ? item.tune : undefined,
      versions: item.versions.length,
      ...(item.copyOf ? { copy_of: item.copyOf } : {}),
    })),
    pairs: board.pairs,
  };
}

export function createBoardHelpOutput() {
  return {
    usage: [
      `${CLI_NAME} board open <dir> [--name "<board name>"] [--reopen] [--no-open]`,
      `${CLI_NAME} board add <dir> <file.html> [--label "<label>"] [--tab <tab>]`,
      `${CLI_NAME} board place <dir> <item> [--x <n>] [--y <n>] [--w <n>] [--h <n>] [--tab <tab>] [--label "<label>"] [--status <status>]`,
      `${CLI_NAME} board pair <dir> <item> <item> [--unlock]`,
      `${CLI_NAME} board status <dir>`,
    ],
    help: [
      "A board is a directory holding board.json plus one HTML file per item. board.json carries only where each item sits, which tab it is on, and what the reviewer said about it - never markup or a copy of an item's file",
      `Open a board with \`${CLI_NAME} board open <dir>\`; it prints the board URL. Poll feedback with \`${CLI_NAME} poll <dir>\`, which resolves the directory to its board.json`,
      `Add a variant with \`${CLI_NAME} board add <dir> <file.html>\`; the open board shows it within a few seconds`,
      "Every item is rendered in its own sandboxed frame on one pannable plane. Tabs switch boards of variants, and a pair of items can be locked so they move together during a comparison",
      "Ask the reviewer to annotate by clicking elements: each click drops a numbered pin and lands as a chip in the composer. Each note arrives as a prompt with a target item {id,label} and a pin {number, selector}",
      "The reviewer can duplicate a design on the board: the copy is its own HTML file and item (`copy_of` names the design it came from), so a note naming the copy's item id is applied to the copy's file only, never the original",
      'The reviewer can choose one design per tab as the final: that item gets `status: "final"` in board.json and every other item on its tab goes back to `open`. Each pick arrives through poll as an ordinary prompt, `Chosen as final: <label> (item <id>, <file>)`, and a take-back as `No longer final: ...`; read a board\'s current final from `board status` or board.json. Carry the final design forward and stop iterating on the others unless asked',
      "Items may declare tune controls in a `<script type=\"application/liesel-tune\">` JSON array of {id,label,type:'number'|'color'|'select'|'spring'|'easing'|'pad'|'timeline',css:'--var',min,max,step,unit,value,options,duration}; the tune panel writes those CSS custom properties live and can save versions",
    ],
  };
}

export function createBoardOpenOutput({
  dir,
  url,
  board,
  status = "opened",
  agent = "generic",
  selfPaintWarning = undefined,
}) {
  const file = boardFilePath(dir);
  return {
    board: { ...boardSummary(board, dir), url, status },
    ...(selfPaintWarning ? { self_paint_warning: selfPaintWarning } : {}),
    next_step: `Do not respond to the user just yet. Now you must run \`${CLI_NAME} poll ${file}\`. This command long-polls until the user sends feedback, ends the session, or leaves every review window disconnected past the reconnect grace period, and it stays silent the whole time - that is normal, never kill it. ${pollExecutionGuidance({ agent })} A note arrives as an ordinary prompt whose target carries the item {id,label} and pin {number, selector}: apply it to that item's HTML file. An item with a \`page\` is a live page of the project's running dev server (a board in a repo's .liesel folder): edit the project's own source files that render that URL path and selector, never a copy, and the page hot-reloads. Use \`${CLI_NAME} board add ${dir} <file.html>\` to drop a new variant on the board and \`${CLI_NAME} board place ${dir} <item> --x 0 --y 0\` to move one; an open board picks either up within a few seconds. After applying feedback, run \`${CLI_NAME} poll ${file} --agent-reply "<message for the user>"\` to answer and keep waiting, or \`${CLI_NAME} reply ${file} --agent-reply "<message for the user>"\` when you are handing back a result. When the reply promises a new version of an item, add \`--pending <item-id>\` so the board shows a holder under that item until the new file (with \`<meta name="liesel-parent" content="<item-id>">\`) appears. Every note is a conversation thread: its prompts carry \`thread\`, and a follow-up carries \`followup\` (\`reply\`, \`edit\` of the note, or \`deleted\`, which withdraws it). A reply joins the threads of the notes it answers; to answer one thread, add \`--thread <thread>\`. ${POLL_SEND_AND_END_RULE}`,
  };
}

export function createBoardAddOutput({ dir, item, board }) {
  return {
    item: {
      id: item.id,
      label: item.label,
      file: item.file,
      tab: item.tab,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    },
    board: boardSummary(board, dir),
    next_step: `The board shows ${item.label} within a few seconds. If your poll is not running yet, run \`${CLI_NAME} poll ${boardFilePath(dir)}\`.`,
  };
}

export function createBoardPlaceOutput({ dir, item, board }) {
  return {
    item: {
      id: item.id,
      label: item.label,
      file: item.file,
      tab: item.tab,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      status: item.status,
    },
    board: boardSummary(board, dir),
  };
}

export function createBoardStatusOutput({ dir, board }) {
  return {
    board: boardSummary(board, dir),
    help: [
      `Run \`${CLI_NAME} board open ${dir}\` to open or resume it in the browser`,
      `Move an item with \`${CLI_NAME} board place ${dir} <item> --x 0 --y 0\`; lock two items so they move together with \`${CLI_NAME} board pair ${dir} <item> <item>\``,
    ],
  };
}

function boardError(error) {
  if (!(error instanceof BoardError)) return error;
  return new AxiError(error.message, "VALIDATION_ERROR", [
    `Run \`${CLI_NAME} board open <dir>\` to create a board, or \`${CLI_NAME} board status <dir>\` to inspect one`,
  ]);
}

async function boardCommand(args) {
  const sub = String(args[0] || "").trim();
  const rest = args.slice(1);
  const positionals = positionalArgs(rest, BOARD_VALUE_FLAGS);
  if (!["open", "add", "place", "pair", "status"].includes(sub) || positionals.length === 0) {
    return createBoardHelpOutput();
  }
  const dir = boardDirPath(positionals[0]);
  try {
    if (sub === "open") return await boardOpenCommand(args, dir);
    if (sub === "add") return await boardAddCommand(positionals, args, dir);
    if (sub === "place") return await boardPlaceCommand(positionals, args, dir);
    if (sub === "pair") return await boardPairCommand(positionals, args, dir);
    return createBoardStatusOutput({ dir, board: await readBoard(dir) });
  } catch (error) {
    throw boardError(error);
  }
}

// Shadows the SDK's built-in self-update, which installs the latest npm release of the
// package name, and Liesel is not published on npm.
export function createUpdateOutput() {
  return {
    current: VERSION,
    install: `npm install -g ${INSTALL_SOURCE}`,
    help: [
      `Liesel is installed from GitHub, not npm. Run \`npm install -g ${INSTALL_SOURCE}\` to update to the latest version`,
      `Never run \`npm install liesel\` or \`npx liesel\`: Liesel is not published on npm, so anything under that name there is not Liesel`,
    ],
  };
}

async function updateCommand() {
  return createUpdateOutput();
}

const INIT_VALUE_FLAGS = ["--board", "--name"];

export function createInitOutput(result) {
  const board = result.board.arg;
  return {
    project: result.project,
    board: { dir: result.board.dir, name: result.board.name },
    files: result.files.map((entry) => ({ path: entry.path, action: entry.action })),
    next_step: `The project is ready. Open the board with \`${CLI_NAME} board open ${board}\` from ${result.project}, then wait for the reviewer's notes with \`${CLI_NAME} poll ${board}\` in the foreground. LIESEL.md in the project holds the whole loop: tell your agent to read it, or follow it yourself.`,
  };
}

async function initCommand(args) {
  const positionals = positionalArgs(args, INIT_VALUE_FLAGS);
  const boardFlag = inspectValueFlag(args, "--board");
  const nameFlag = inspectValueFlag(args, "--name");
  const boardDir = boardFlag.present ? String(boardFlag.value || "").trim() : DEFAULT_BOARD_DIR;
  if (!boardDir) {
    throw new AxiError("--board needs a folder name", "VALIDATION_ERROR", [
      `Run \`${CLI_NAME} init [dir] --board designs\``,
    ]);
  }
  try {
    const result = await initProject({
      projectDir: positionals[0] || process.cwd(),
      boardDir,
      name: nameFlag.present ? String(nameFlag.value || "") : undefined,
    });
    return createInitOutput(result);
  } catch (error) {
    if (error instanceof ProjectInitError) {
      throw new AxiError(error.message, "VALIDATION_ERROR", [`Run \`${CLI_NAME} init [dir] --board designs\``]);
    }
    throw boardError(error);
  }
}

async function boardOpenCommand(args, dir) {
  await mkdir(dir, { recursive: true });
  const nameFlag = inspectValueFlag(args, "--name");
  const name = nameFlag.present ? String(nameFlag.value || "").trim() : "";
  const board = await readOrCreateBoard(dir, { name: name || undefined });
  const file = await canonicalFile(boardFilePath(dir));
  const reopen = args.includes("--reopen");
  const baseUrl = await ensureServer({
    forceRestart: shouldForceRestartForLocalBuild(process.argv[1] || ""),
    reloadKey: sessionKey(file),
  });
  const response = await postJson(`${baseUrl}/api/boards`, { dir, reopen });
  if (response.status === "user-ended") {
    return {
      board: { ...boardSummary(board, dir), url: response.url, status: "user-ended" },
      next_step: `The user explicitly ended this board, so \`${CLI_NAME} board open ${dir}\` did not reopen it. Do not reopen unless the user asks for further review; when they do, run \`${CLI_NAME} board open ${dir} --reopen\`.`,
    };
  }
  if (shouldOpenBrowser(args, process.env)) {
    try {
      const open = (await import("open")).default;
      await open(response.url);
    } catch {
      // A browser that cannot be launched leaves the printed URL as the way in.
    }
  }
  return createBoardOpenOutput({
    dir,
    url: response.url,
    board,
    status: response.status || "opened",
    agent: detectInvokingAgent(process.env),
  });
}

async function boardAddCommand(positionals, args, dir) {
  const input = positionals[1];
  if (!input) {
    throw new AxiError("An HTML file is required", "VALIDATION_ERROR", [
      `Run \`${CLI_NAME} board add ${dir} <file.html>\``,
    ]);
  }
  await assertHtmlFile(input);
  await mkdir(dir, { recursive: true });
  const board = await readOrCreateBoard(dir);
  const source = await realpath(input);
  const boardReal = await realpath(dir);
  let fileName = path.basename(source);
  if (path.dirname(source) !== boardReal) {
    const extension = path.extname(source);
    let target = path.join(dir, fileName);
    let suffix = 2;
    while (existsSync(target) && (await realpath(target).catch(() => "")) !== source) {
      fileName = `${path.basename(source, extension)}-${suffix}${extension}`;
      target = path.join(dir, fileName);
      suffix += 1;
    }
    if (!existsSync(target)) await copyFile(source, target);
  }
  const labelFlag = inspectValueFlag(args, "--label");
  const tabFlag = inspectValueFlag(args, "--tab");
  const tab = tabFlag.present ? ensureTab(board, String(tabFlag.value || "")) : board.tabs[0].id;
  const item = addItem(board, {
    file: fileName,
    label: labelFlag.present ? String(labelFlag.value || "") : undefined,
    tab,
  });
  await writeBoard(dir, board);
  return createBoardAddOutput({ dir, item, board });
}

async function boardPlaceCommand(positionals, args, dir) {
  const itemId = positionals[1];
  if (!itemId) {
    throw new AxiError("A board item id is required", "VALIDATION_ERROR", [
      `Run \`${CLI_NAME} board status ${dir}\` to list item ids`,
    ]);
  }
  const board = await readBoard(dir);
  const changes = {};
  for (const [flag, key] of [
    ["--x", "x"],
    ["--y", "y"],
    ["--w", "w"],
    ["--h", "h"],
  ]) {
    const found = inspectValueFlag(args, flag);
    if (found.present) changes[key] = Number(found.value);
  }
  const tabFlag = inspectValueFlag(args, "--tab");
  if (tabFlag.present) changes.tab = ensureTab(board, String(tabFlag.value || ""));
  const labelFlag = inspectValueFlag(args, "--label");
  if (labelFlag.present) changes.label = String(labelFlag.value || "");
  const statusFlag = inspectValueFlag(args, "--status");
  if (statusFlag.present) changes.status = String(statusFlag.value || "");
  const item = placeItem(board, itemId, changes);
  await writeBoard(dir, board);
  return createBoardPlaceOutput({ dir, item, board });
}

async function boardPairCommand(positionals, args, dir) {
  const [a, b] = positionals.slice(1);
  if (!a || !b) {
    throw new AxiError("Two board item ids are required", "VALIDATION_ERROR", [
      `Run \`${CLI_NAME} board pair ${dir} <item> <item>\``,
    ]);
  }
  const board = await readBoard(dir);
  const pair = pairItems(board, a, b, !args.includes("--unlock"));
  await writeBoard(dir, board);
  return { pair, board: boardSummary(board, dir) };
}

function positionalArgs(args, valueFlags = []) {
  const flags = new Set(valueFlags);
  const positionals = [];
  let positionalMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!positionalMode && arg === "--") {
      positionalMode = true;
      continue;
    }
    if (!positionalMode && isValueFlagToken(arg, flags)) {
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (!positionalMode && arg.startsWith("-")) continue;
    positionals.push(arg);
  }
  return positionals;
}

// Produce a portable copy of an artifact: one HTML file with its LOCAL assets (relative-path
// stylesheets, scripts, images, fonts) inlined as data URIs. Remote CDN/font references are left
// as-is for the browser to load, so the export needs network to render those. Liesel makes no
// outbound requests - export is a pure local file transform, server-independent.
async function exportCommand(args) {
  const file = firstPositionalArg(args, ["--out"]);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `liesel export <html-file>`"]);
  }
  await assertHtmlFile(file);
  const absolute = await canonicalFile(file);
  const root = path.dirname(absolute);
  const output = path.resolve(flagValue(args, "--out") || path.join(root, exportFileName(absolute)));
  const source = await readFile(absolute, "utf8");
  const { html, warnings } = await buildSelfContainedHtml(source, {
    baseDir: root,
    confineDir: root,
    resolveAbsolute: resolveDesignAssetPath,
  });
  await writeFile(output, html);
  return createExportOutput({
    source: absolute,
    output,
    html,
    warnings,
    selfPaintWarning: analyzeSelfPaint(source).painted ? undefined : SELF_PAINT_WARNING,
  });
}

export function createExportOutput({ source, output, html, warnings, selfPaintWarning = undefined }) {
  const allWarnings = Array.isArray(warnings) ? warnings : [];
  const { unresolved, notices } = splitExportWarnings(allWarnings);
  const result = {
    export: {
      source,
      output,
      bytes: Buffer.byteLength(html),
      unresolved_local_assets: unresolved.length,
      notices: notices.length,
    },
  };
  if (allWarnings.length) result.warnings = exportWarningSummaries(allWarnings);
  if (unresolved.length) result.unresolved_local_assets = exportWarningSummaries(unresolved);
  if (notices.length) result.notices = exportWarningSummaries(notices);
  if (unresolved.length) {
    result.next_step =
      "Some LOCAL assets could not be inlined and were left as references (see unresolved_local_assets); they will break once the file is moved. Remote CDN/font references are intentionally left as links and render where there is network access.";
  } else if (notices.length) {
    result.next_step = `Wrote ${output} with export notices (see notices). Open it directly or host it anywhere - it needs no Liesel server. Local assets are inlined; remote CDN/font references are left as links, so it needs network to render those.`;
  } else {
    result.next_step = `Wrote ${output}. Open it directly or host it anywhere - it needs no Liesel server. Local assets are inlined; remote CDN/font references are left as links, so it needs network to render those.`;
  }
  if (selfPaintWarning) {
    result.self_paint_warning = selfPaintWarning;
    result.next_step = `Fix the unpainted page surface flagged in self_paint_warning and re-run the export before sharing the file - an exported page renders over whatever surface hosts it. ${result.next_step}`;
  }
  return result;
}

function assetWarningSummaries(warnings) {
  return exportWarningSummaries(warnings);
}

// Publish, republish, or unpublish a page on third-party ht-ml.app; `resolveShareRequest` owns
// which of the three the arguments describe. Creating POSTs the local-inlined HTML - built the same
// way as `export`, remote refs left as links - to `/v1/sites`, needs no account or API key, and
// returns the share URL plus the secret update_key. Republishing and unpublishing instead PUT to
// `/v1/sites/{site_id}` authorized by that update_key and mint no new one; unpublish reads no file
// at all and sends a placeholder page. Server-independent.
export async function shareCommand(args) {
  const request = resolveShareRequest(args);
  if (request.mode === "unpublish") {
    const site = await unpublishShareSite(request);
    return createShareUnpublishOutput({ site, siteId: request.siteId });
  }

  await assertHtmlFile(request.file);
  const absolute = await canonicalFile(request.file);
  const root = path.dirname(absolute);
  const source = await readFile(absolute, "utf8");
  const { html, warnings } = await buildSelfContainedHtml(source, {
    baseDir: root,
    confineDir: root,
    resolveAbsolute: resolveDesignAssetPath,
  });
  const selfPaintWarning = analyzeSelfPaint(source).painted ? undefined : SELF_PAINT_WARNING;

  if (request.mode === "update") {
    const site = await updateShareSite(request, html);
    return createShareUpdateOutput({
      source: absolute,
      site,
      warnings,
      password: request.generatedPassword ? request.password : undefined,
      passwordProtected: Boolean(request.password),
      selfPaintWarning,
    });
  }

  const site = await createShareSite(request, html);
  return createShareOutput({
    source: absolute,
    site,
    warnings,
    passwordProtected: Boolean(request.password),
    password: request.generatedPassword ? request.password : undefined,
    selfPaintWarning,
  });
}

// Every surface that tells the user how to republish prints this one command, because a hint the
// CLI itself rejects is worse than no hint: `--site`/`--update-key` alone parse to a usage error,
// and the HTML file positional is what makes the shape a command that runs.
//
// A suggested command may never carry a password PLACEHOLDER. Every other placeholder here fails
// loudly when an agent substitutes the real values and leaves one literal - `<html-file>` is not a
// file, `<key>` earns a 401 - but any non-empty string is a valid password, so a literal `<pw>`
// would be accepted and would rotate a live page to a secret nobody was told, with no way to clear
// it afterwards. `--private` is safe to name because it takes no value and Liesel reports what it
// minted; an explicit password is described in words instead.
function republishCommand(siteId, { privatePage = false } = {}) {
  return `liesel share <html-file> --site ${siteId} --update-key <key>${privatePage ? " --private" : ""}`;
}

function republishPrivateCommand(siteId) {
  return republishCommand(siteId, { privatePage: true });
}

function unpublishCommand(siteId) {
  return `liesel share --unpublish --site ${siteId} --update-key <key>`;
}

// A 200 the host answered with an unreadable body is not an unknown outcome - the page landed - and
// hedging it away discards the strongest honest report available. Whatever fields did arrive are
// handed over, because a url with no update_key names a live page whose write credential is gone.
function incompletePublishError(request, message, received) {
  const url = String(received.url || "").trim();
  const updateKey = String(received.updateKey || "").trim();
  const siteId = String(received.siteId || "").trim();
  const visibility = request.password
    ? `behind the password this run sent`
    : `PUBLICLY, readable by anyone who has the link`;
  const suggestions = [
    `ht-ml.app accepted this publish - the page IS live, hosted ${visibility} - but its response was malformed, so Liesel could not read the whole result back. Do not report this as a failed publish.`,
    url
      ? `Its address is ${url} - give the user that URL.`
      : `The response carried no url, so Liesel cannot name the page's address.`,
  ];
  if (updateKey) {
    suggestions.push(
      `Its update_key is ${updateKey}${siteId ? ` and its site_id is ${siteId}` : ""} - keep it, because ht-ml.app issues one only once and it is the only credential for changing or unpublishing the page.`,
    );
  } else {
    suggestions.push(
      `No update_key reached Liesel, and ht-ml.app issues one only once and has no delete endpoint, so this page can never be republished or unpublished. There is no recovery for it.`,
    );
  }
  suggestions.push(`Re-running this command publishes a SECOND page at a new URL; it does not replace the first.`);
  if (request.generatedPassword && request.password) {
    suggestions.push(`That page requires the password Liesel generated for it: ${request.password}`);
  }
  return new AxiError(message, "UNKNOWN", suggestions);
}

// Creating is the highest-consequence instance of the same split, because it is the one write with
// no way back. A 4xx means nothing was published. Anything else can follow a POST the origin
// already committed, and the response that was lost is the ONLY copy of the update_key - issued
// once, and the sole credential for a host with no delete endpoint - so a page that landed this way
// can never be republished or unpublished by anyone. Nothing here may suggest a recovery, because
// there is none: re-running mints a second page rather than replacing the first.
async function createShareSite(request, html) {
  try {
    return await publishToHtmlApp(html, { password: request.password, token: request.token });
  } catch (error) {
    if (hostRejectedShareWrite(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const landed = publishedDespiteError(error);
    if (landed) throw incompletePublishError(request, message, landed);
    const hosting = request.password
      ? `the artifact is now hosted on ht-ml.app behind the password this run sent`
      : `the artifact is now hosted PUBLICLY on ht-ml.app, readable by anyone who has the link`;
    const suggestions = [
      `ht-ml.app may or may not have published this page, so treat the outcome as unknown.`,
      `If it landed, ${hosting}, and the response carrying its url, site_id, and update_key was lost.`,
      `An update_key is issued once and ht-ml.app has no delete endpoint, so such a page can never be republished or unpublished - there is no recovery for it. Tell the user rather than implying the publish simply failed.`,
      `Re-running this command publishes a SECOND page at a new URL; it does not replace or reclaim the first.`,
    ];
    if (request.generatedPassword && request.password) {
      suggestions.push(`If it landed, that page requires the password Liesel generated for it: ${request.password}`);
    }
    throw new AxiError(message, "UNKNOWN", suggestions);
  }
}

// Whether the outcome is unknown is a property of the FAILURE, not of what the request carried: a
// 4xx the host answered means it wrote nothing, while a 5xx or no answer at all can follow a PUT
// the origin already committed, leaving the hosted page showing content Liesel reported as never
// sent. So every indeterminate republish reports that and names a re-run that converges.
// A generated password is an ADDITIONAL layer on that report, not its trigger: it only ever reaches
// the user through the success output, so an indeterminate failure could otherwise leave the page
// rotated to a secret nobody holds. A rejection must never carry it, because it gates nothing.
async function updateShareSite(request, html) {
  try {
    return await updateHtmlApp(request.siteId, html, {
      updateKey: request.updateKey,
      password: request.password,
    });
  } catch (error) {
    if (hostRejectedShareWrite(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const generated = Boolean(request.generatedPassword && request.password);
    const retry = generated ? republishPrivateCommand(request.siteId) : republishCommand(request.siteId);
    const samePassword = !generated && request.password ? `, passing the same --password value you supplied` : "";
    const suggestions = [
      `ht-ml.app may or may not have applied this republish, so treat the outcome as unknown: the hosted page may already show the new content.`,
      `Re-running \`${retry}\`${samePassword} is safe and converges on the same result either way.`,
    ];
    if (generated) {
      suggestions.push(
        `If it landed, the page now requires the password Liesel generated for it: ${request.password} - the re-run above rotates it to a fresh one Liesel reports on success.`,
      );
    }
    throw new AxiError(message, "UNKNOWN", suggestions);
  }
}

// ht-ml.app has no delete endpoint, so the closest honest thing is a republish: replace the content
// and lock the URL behind a password nobody is given. The update_key is the way back. The same
// indeterminate-outcome rule as a republish applies - a 5xx or a timeout can follow a PUT the
// origin already committed - so reporting a flat failure would tell the user the page is still
// readable when it may already be the locked placeholder. No password is offered here: the lock
// password is discarded by design, so there is nothing recoverable to hand back.
async function unpublishShareSite(request) {
  try {
    return await updateHtmlApp(request.siteId, createUnpublishedPageHtml(), {
      updateKey: request.updateKey,
      password: generateSharePassword(),
    });
  } catch (error) {
    if (hostRejectedShareWrite(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AxiError(message, "UNKNOWN", [
      `ht-ml.app may or may not have applied this unpublish, so treat the outcome as unknown: the page may already be the locked placeholder.`,
      `Re-running \`${unpublishCommand(request.siteId)}\` is safe and converges on the same result either way.`,
      `The update_key still works, so \`${republishPrivateCommand(request.siteId)}\` brings the page back behind a password you can see.`,
    ]);
  }
}

// Resolve which of `share`'s three shapes the arguments describe - publish, republish, or
// unpublish - and which password the host should be sent. Pure, so the conflict rules are
// testable without a network call or a file on disk. A password is never accepted from the artifact
// or the browser; this is the only place one is generated for a request, the sole exception being
// `--unpublish`, which mints its own directly because that value is discarded rather than reported.
export function resolveShareRequest(args) {
  const unpublish = args.includes("--unpublish");
  const generate = args.includes("--private");
  const explicitPassword = shareFlagValue(args, "--password");
  const siteId = shareFlagValue(args, "--site");
  const updateKey = shareFlagValue(args, "--update-key");
  const token = shareFlagValue(args, "--token");
  const file = firstPositionalArg(args, SHARE_VALUE_FLAGS);

  if (generate && explicitPassword) {
    throw new AxiError("--private generates a password, so it cannot be combined with --password", "VALIDATION_ERROR", [
      "Pass --private to have Liesel mint one, or --password <pw> to choose it yourself",
    ]);
  }
  // A republish authenticates as the page itself: the Authorization header carries the update_key,
  // so there is no room for a bearer token and silently accepting one would look like it applied.
  if (token && (unpublish || siteId || updateKey)) {
    throw new AxiError(
      "--token only applies when creating a page: a republish authenticates with the update_key, which is what the Authorization header carries",
      "VALIDATION_ERROR",
      ["Drop --token and keep --site <site_id> --update-key <key>"],
    );
  }

  if (unpublish) {
    if (file) {
      throw new AxiError("--unpublish replaces a published page and takes no HTML file", "VALIDATION_ERROR", [
        "Run `liesel share --unpublish --site <site_id> --update-key <key>`",
      ]);
    }
    if (generate || explicitPassword) {
      throw new AxiError(
        "--unpublish locks the page with its own password and takes no password flag",
        "VALIDATION_ERROR",
        ["Run `liesel share --unpublish --site <site_id> --update-key <key>`"],
      );
    }
    assertSiteCredential(siteId, updateKey);
    return {
      mode: "unpublish",
      file: null,
      siteId: assertShareSiteId(siteId),
      updateKey,
      password: undefined,
      generatedPassword: false,
      token,
    };
  }

  if (siteId || updateKey) {
    assertSiteCredential(siteId, updateKey);
    assertShareFile(file);
    return {
      mode: "update",
      file,
      siteId: assertShareSiteId(siteId),
      updateKey,
      ...resolveSharePassword({ generate, explicitPassword }),
      token,
    };
  }

  assertShareFile(file);
  return {
    mode: "create",
    file,
    siteId: null,
    updateKey: null,
    ...resolveSharePassword({ generate, explicitPassword }),
    token,
  };
}

// An absent password preserves whatever the page already has. There is no "clear" value: the host
// accepts an empty password and ignores it, so offering one would report a page as public while it
// is still gated.
function resolveSharePassword({ generate, explicitPassword }) {
  if (generate) return { password: generateSharePassword(), generatedPassword: true };
  if (explicitPassword) return { password: explicitPassword, generatedPassword: false };
  return { password: undefined, generatedPassword: false };
}

function assertSiteCredential(siteId, updateKey) {
  if (!siteId) {
    throw new AxiError("--site <site_id> is required to change a published page", "VALIDATION_ERROR", [
      "The site_id is in the share output from when the page was published",
    ]);
  }
  if (!updateKey) {
    throw new AxiError("--update-key <key> is required to change a published page", "VALIDATION_ERROR", [
      "The update_key was returned once when the page was published; there is no way to recover it",
    ]);
  }
}

// Read one of share's value-taking flags. `flagValue` takes the next token unconditionally, which
// every other command tolerates because its blast radius is a bad argument; here an empty unquoted
// shell variable makes `--password $PW --site abc` read "--site" as the password and ROTATE a live
// page to a literal nobody knows, and the host cannot clear a password afterwards. So share refuses
// the shapes that would be guesses rather than values. The `--password=<pw>` form stays permissive
// past the leading `--` because nothing can be swallowed there.
function shareFlagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === flag) return checkedShareFlagValue(flag, args[i + 1], { swallows: true });
    if (arg.startsWith(`${flag}=`)) return checkedShareFlagValue(flag, arg.slice(flag.length + 1), {});
  }
  return undefined;
}

function checkedShareFlagValue(flag, value, { swallows = false }) {
  const hint =
    flag === "--password"
      ? `Quote the value as ${flag} "<pw>" - an unquoted shell variable that is unset expands to nothing - or pass --private to have Liesel generate one`
      : `Quote the value as ${flag} "<value>"`;
  if (swallows && typeof value === "string" && value.startsWith("--")) {
    throw new AxiError(
      `${flag} was given no value: the next argument ${value} is another flag, so it would have been used as the value`,
      "VALIDATION_ERROR",
      [hint, `Use ${flag}=<value> if the value itself starts with --`],
    );
  }
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    const consequence =
      flag === "--password"
        ? ", and publishing a PUBLIC page while you believed it was gated is the worse failure"
        : "";
    throw new AxiError(`${flag} was given an empty value${consequence}`, "VALIDATION_ERROR", [hint]);
  }
  return trimmed;
}

// normalizeSiteId is the library-level guard and throws a plain Error for direct callers. At the
// CLI boundary a bad --site is a usage mistake like any other, and pasting the share URL is the
// likeliest one, so it gets the same VALIDATION_ERROR shape and a hint about where the id comes
// from - raised here rather than inside updateHtmlApp, which only runs after the whole artifact
// has been read and bundled.
function assertShareSiteId(siteId) {
  try {
    return normalizeSiteId(siteId);
  } catch (error) {
    throw new AxiError(error instanceof Error ? error.message : String(error), "VALIDATION_ERROR", [
      "The site_id is in the share output from when the page was published, and in the browser publish dialog's Site ID row",
    ]);
  }
}

function assertShareFile(file) {
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `liesel share <html-file>`"]);
  }
}

export function createShareOutput({
  source,
  site,
  warnings,
  passwordProtected = false,
  password = undefined,
  selfPaintWarning = undefined,
}) {
  const allWarnings = Array.isArray(warnings) ? warnings : [];
  const { unresolved, notices } = splitExportWarnings(allWarnings);
  const isPasswordProtected = Boolean(passwordProtected);
  // The host either returned no site_id or returned one `normalizeSiteId` refuses, which is the
  // same thing for the user: `--site` is half the republish credential, so without a usable one
  // the page can never be changed again even though its update_key is in hand. Emitting an empty
  // string beside guidance that says to keep it would hide that until `--site` rejected it.
  const republishableSiteId = String(site.site_id ?? "").trim();
  const result = {
    share: {
      source,
      url: site.url,
      ...(republishableSiteId ? { site_id: republishableSiteId } : {}),
      update_key: site.update_key,
      status: site.status || "active",
      public: !isPasswordProtected,
      visibility: isPasswordProtected ? "private" : "public",
      password_protected: isPasswordProtected,
      ...(password ? { password } : {}),
      unresolved_local_assets: unresolved.length,
      notices: notices.length,
    },
  };
  const passwordNote = isPasswordProtected ? " This page is PASSWORD-PROTECTED; viewers also need the password." : "";
  if (allWarnings.length) result.warnings = exportWarningSummaries(allWarnings);
  if (unresolved.length) result.unresolved_local_assets = assetWarningSummaries(unresolved);
  if (notices.length) result.notices = assetWarningSummaries(notices);
  const noticeNote = notices.length ? " Export notices are available in notices." : "";
  const hostNote =
    "ht-ml.app (https://ht-ml.app), a third-party host not part of Liesel, hosts the page, so it needs no Liesel server.";
  const updateKeyNote = republishableSiteId
    ? "The update_key is a secret shown only once; keep it to republish the page later with --site and --update-key (there is no recovery, and ht-ml.app has no delete). "
    : "The host did not return a site_id Liesel can use, and --site is half the republish credential, so this page can NEVER be republished or unpublished even though its update_key is in hand. Tell the user that now rather than letting them discover it later. ";
  if (unresolved.length) {
    result.next_step =
      `Published ${isPasswordProtected ? "a PASSWORD-PROTECTED page at " : ""}${site.url}, but some LOCAL assets could not be inlined and were left as references (see unresolved_local_assets); inspect the hosted page and fix missing local assets before sharing it.${passwordNote}${noticeNote} ` +
      `Remote CDN/font references are intentionally left as links and render where there is network access. ` +
      updateKeyNote +
      hostNote;
  } else if (isPasswordProtected) {
    result.next_step =
      `Published a PASSWORD-PROTECTED page: ${site.url} - share this URL with the user and provide the password separately; viewers also need the password. ` +
      `${noticeNote ? `${noticeNote} ` : ""}` +
      updateKeyNote +
      hostNote;
  } else {
    result.next_step =
      `Published a PUBLIC page that anyone with the link can view: ${site.url} - share this URL with the user. ` +
      `${noticeNote ? `${noticeNote} ` : ""}` +
      updateKeyNote +
      hostNote;
  }
  if (password) result.next_step = `${generatedPasswordNote(password)} ${result.next_step}`;
  if (selfPaintWarning) {
    result.self_paint_warning = selfPaintWarning;
    result.next_step = `Fix the unpainted page surface flagged in self_paint_warning, then re-run the share command and share only its replacement URL - the hosted page renders over ht-ml.app's own surface. ${result.next_step}`;
  }
  return result;
}

// Republish output. Visibility is "unchanged" unless this call set a password, because Liesel
// persists nothing about a published page and the host never reports its current password. So a
// plain republish reports what Liesel DID, never what the page IS: it cannot know whether the page
// is gated, and an authoritative guess either way is one the user would act on.
export function createShareUpdateOutput({
  source,
  site,
  warnings,
  password = undefined,
  passwordProtected = false,
  selfPaintWarning = undefined,
}) {
  const allWarnings = Array.isArray(warnings) ? warnings : [];
  const { unresolved, notices } = splitExportWarnings(allWarnings);
  const visibility = passwordProtected ? "private" : "unchanged";
  const url = String(site.url ?? "").trim();
  const result = {
    share: {
      source,
      url,
      site_id: site.site_id,
      status: site.status || "active",
      updated: true,
      visibility,
      ...(password ? { password } : {}),
      unresolved_local_assets: unresolved.length,
      notices: notices.length,
    },
  };
  if (allWarnings.length) result.warnings = exportWarningSummaries(allWarnings);
  if (unresolved.length) result.unresolved_local_assets = assetWarningSummaries(unresolved);
  if (notices.length) result.notices = assetWarningSummaries(notices);
  const noticeNote = notices.length ? " Export notices are available in notices." : "";
  const unresolvedNote = unresolved.length
    ? " Some LOCAL assets could not be inlined and were left as references (see unresolved_local_assets); inspect the hosted page."
    : "";
  const visibilityNote =
    visibility === "private"
      ? " It is PASSWORD-PROTECTED; viewers also need the password. That gate is NOT instant: if the page had been public, it was observed still answering uncredentialed requests from ht-ml.app's CDN cache for minutes afterwards, so do not tell the user it is gated right away; a page that was already private has no such cached copy and leaks nothing."
      : " This republish did not touch the page's password, so whatever it had when it was last published still applies. Liesel stores nothing about a published page, so this output cannot tell you whether that is a password or none - and a page published without one stays readable by anyone who has the link.";
  result.next_step = url
    ? `Republished ${source} to the same URL: ${url} - viewers see the new version immediately and no new link is needed.${visibilityNote}${unresolvedNote}${noticeNote} ` +
      `Keep the same update_key; it is still the only credential for this page.`
    : `Republished ${source} in place as site_id ${site.site_id} - viewers see the new version immediately and no new link is needed, but the host did not report a URL for the page, so use the one from when it was published rather than guessing.${visibilityNote}${unresolvedNote}${noticeNote} ` +
      `Keep the same update_key; it is still the only credential for this page.`;
  if (password) result.next_step = `${generatedPasswordNote(password)} ${result.next_step}`;
  if (selfPaintWarning) {
    result.self_paint_warning = selfPaintWarning;
    result.next_step = `Fix the unpainted page surface flagged in self_paint_warning, then republish - the hosted page renders over ht-ml.app's own surface. ${result.next_step}`;
  }
  return result;
}

// Unpublish output. The page is replaced and locked, never removed, and saying otherwise would
// leave the user believing content is gone from a URL that still resolves.
// `siteId` is the locally validated id the request was addressed to, and it - never the host's
// echo - is what the suggested republish command interpolates: that string is text an agent may
// run, so a host answering with `abc123 --password evil` must not be able to append flags to it.
export function createShareUnpublishOutput({ site, siteId = undefined }) {
  const url = String(site.url ?? "").trim();
  const commandSiteId = siteId || site.site_id;
  const target = url
    ? `Replaced the page at ${url} with an "unpublished" placeholder`
    : `Replaced the page published as site_id ${site.site_id} with an "unpublished" placeholder (the host did not report a URL for it, so use the one from when it was published rather than guessing)`;
  return {
    share: {
      url,
      site_id: site.site_id,
      status: site.status || "active",
      unpublished: true,
      visibility: "private",
    },
    next_step:
      `${target} and locked it behind a fresh random password that was discarded. The replacement itself is immediate: the previous content is gone from that URL, not merely hidden. ` +
      `The LOCK is what is not instant for a page that was public - its CDN copy was observed serving the new placeholder to uncredentialed requests for minutes afterwards - so the placeholder may be readable without the password until the edge cache turns over. Do not tell the user the URL is unreachable right away. ` +
      `ht-ml.app has NO delete endpoint: the page is not deleted, the URL still resolves, and the host still holds whatever was published. Tell the user that rather than saying it was deleted. ` +
      `The update_key is still the only credential for this page - republish with \`${republishPrivateCommand(commandSiteId)}\` to bring it back, then give the user the new password it returns. ` +
      `ht-ml.app cannot remove a page's password once it has one, so a republished page stays private.`,
  };
}

function generatedPasswordNote(password) {
  return (
    `The password is ${password} - Liesel generated it and does not store it anywhere. ` +
    `Give it to the user with the URL and tell them it is a SHARED SECRET: anyone they pass it to can read the page.`
  );
}

// Explicitly shut down the running Liesel server. Unlike `end` (which closes a single
// session), this stops the background process so it stops dangling between sessions.
export async function stopCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  // A server that fell back to loopback answers there rather than at the requested bind host, and
  // a `stop` that only dials the requested host reports "not-running" while leaving it running.
  // A same-port duplicate at another address is this installation's server too, so it stops as well.
  const { baseUrl, duplicates, foreign } = await findRunningServer(port);
  if (foreign) throw otherInstallationError(port, foreign);
  await stopDuplicateServers(duplicates, { reason: "stop" });
  return shutdownServerOnPort(port, { baseUrl, currentVersion: VERSION });
}

export async function shutdownServerOnPort(
  port,
  {
    baseUrl = `http://${hostForUrl(clientHost())}:${port}`,
    currentVersion = VERSION,
    fetchHealth: healthFetcher = fetchHealth,
    requestShutdown: shutdownRequester = requestShutdown,
    waitForPortFree: portFreeWaiter = waitForPortFree,
    killServerProcess = killLieselListener,
    processMatchesLiesel = listenerMatchesLiesel,
  } = {},
) {
  const health = await healthFetcher(baseUrl);
  if (!health) {
    return { server: { status: "not-running", port } };
  }
  if (!(await canControlServerOnPort(baseUrl, health, processMatchesLiesel))) {
    return { server: { status: "not-liesel", port } };
  }
  await shutdownRequester(baseUrl, { reason: "stop" });
  let freed = await portFreeWaiter(baseUrl, 3000);
  if (!freed && shouldKillProcessOnPort(currentVersion, health)) {
    if (!killServerProcess(baseUrl)) throw unidentifiedListenerError(baseUrl);
    freed = await portFreeWaiter(baseUrl, 3000);
  }
  return { server: { status: freed ? "stopped" : "stopping", port } };
}

const LIBRARY_ITEM_LIST_LIMIT = 50;

async function librariesCommand(args) {
  const dir = excalidrawLibrariesDir(path.dirname(stateFile()));
  const { libraries, skipped } = await loadExcalidrawLibraries(dir);
  return createLibrariesOutput({
    dir: collapseHomeDirectory(dir, os.homedir()),
    libraries,
    skipped,
    search: flagValue(args, "--search") || "",
    library: flagValue(args, "--library") || "",
  });
}

/**
 * @param {{ dir: string, libraries: { id: string, items: { ref: string, name: string }[] }[], skipped: { file: string, reason: string }[], search?: string, library?: string }} options
 */
export function createLibrariesOutput({ dir, libraries, skipped, search = "", library = "" }) {
  /** @type {Record<string, any>} */
  const output = {
    dir,
    libraries: libraries.map((entry) => ({ id: entry.id, items: entry.items.length })),
  };
  if (skipped.length > 0) {
    output.skipped = skipped.map((entry) => ({ file: path.basename(entry.file), reason: entry.reason }));
  }
  if (libraries.length === 0) {
    output.help = [
      `Copy Excalidraw library files (.excalidrawlib, for example from https://libraries.excalidraw.com) into ${dir}; every whiteboard's library panel then lists their items`,
    ];
    return output;
  }
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length > 0 || library) {
    const matches = libraries
      .filter((entry) => !library || entry.id === library.toLowerCase())
      .flatMap((entry) => entry.items)
      .filter((item) => terms.every((term) => item.ref.toLowerCase().includes(term)));
    output.items = matches.slice(0, LIBRARY_ITEM_LIST_LIMIT).map((item) => ({ ref: item.ref }));
    if (matches.length > LIBRARY_ITEM_LIST_LIMIT) output.more_items = matches.length - LIBRARY_ITEM_LIST_LIMIT;
  }
  output.help = [
    output.more_items
      ? "Narrow the list with `liesel libraries --search <text>`"
      : "Run `liesel libraries --search <text>` or `--library <id>` to list item refs",
    "To show an item as a node icon in a whiteboard flowchart, see `whiteboard_tooling.library_icons` in `liesel design`",
  ];
  return output;
}

async function playbookCommand(args) {
  return createPlaybookOutput(args);
}

async function designCommand() {
  return createDesignOutput();
}

async function setupCommand(args) {
  if (args.length !== 1 || (args[0] !== "hooks" && args[0] !== "plugin")) {
    throw new AxiError("Unknown setup action", "VALIDATION_ERROR", [
      "Run `liesel setup hooks`",
      "Run `liesel setup plugin`",
    ]);
  }

  if (args[0] === "plugin") return setupPluginCommand();

  const errors = [];
  installSessionStartHooks({
    marker: "liesel",
    binaryNames: ["liesel"],
    distEntrypoints: ["dist/cli.mjs", "bin/liesel.js"],
    homeDir: resolveHookHomeDir(),
    onError: (message) => errors.push(message),
  });
  installCopilotCliSessionStartHook({
    hookDir: resolveCopilotHookDir(process.env, resolveHookHomeDir()),
    onError: (message) => errors.push(message),
  });

  if (errors.length > 0) {
    throw new AxiError("Failed to install liesel agent hooks", "SERVER_ERROR", errors);
  }

  return {
    hooks: { status: "installed", integrations: "Claude Code, Codex, OpenCode, GitHub Copilot CLI" },
    help: [
      "Restart your agent session to receive liesel ambient context",
      "Run `liesel setup plugin` to also register the Agent Plugin in VS Code, Cursor, and GitHub Copilot CLI",
    ],
  };
}

/**
 * Register this installed package as an Agent Plugin in every supported client that is
 * present. The package directory itself is the plugin root, so nothing is downloaded and
 * no marketplace is involved - clients read the same files `npm install` already wrote.
 *
 * Like `setup hooks`, this only ever runs from an explicit user invocation.
 *
 * @returns {Promise<Record<string, unknown>>} structured per-client outcome
 */
async function setupPluginCommand() {
  const pluginRoot = resolvePluginRoot();
  const manifest = readPluginManifest(pluginRoot);
  if (!manifest) {
    throw new AxiError("No plugin.json found in the liesel package", "SERVER_ERROR", [
      `Expected a manifest at ${path.join(pluginRoot, "plugin.json")}`,
      "Reinstall liesel, or run `npm run build:plugin` when working from a source checkout",
    ]);
  }

  const clients = [
    registerVsCodePlugin(pluginRoot, manifest.name),
    registerCursorPlugin(pluginRoot, manifest.name),
    registerCopilotPlugin(pluginRoot, manifest.name),
  ];

  const help = ["Restart or reload each client so it discovers the plugin"];
  if (clients.some((client) => client.status === "absent")) {
    help.push("Absent clients are skipped; re-run `liesel setup plugin` after installing one");
  }
  if (clients.some((client) => client.status === "manual")) {
    help.push(`Register the plugin root manually where noted: ${pluginRoot}`);
  }

  return { plugin: { name: manifest.name, root: collapseHome(pluginRoot) }, clients, help };
}

/** @param {string} target absolute path @returns {string} path with $HOME collapsed to ~ */
function collapseHome(target) {
  const home = resolveHookHomeDir();
  return home && target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

/**
 * @param {string} pluginRoot absolute plugin root
 * @param {string} pluginName manifest name
 * @returns {{ client: string, status: string, detail: string }} outcome row
 */
function registerVsCodePlugin(pluginRoot, pluginName) {
  const settingsFile = resolveVsCodeSettingsFile(process.env, resolveHookHomeDir());
  const settingsDir = path.dirname(settingsFile);
  const hasSettingsFile = existsSync(settingsFile);
  if (!hasSettingsFile && !existsSync(settingsDir)) {
    return { client: "vscode", status: "absent", detail: "no VS Code user configuration found" };
  }

  let settings = {};
  if (hasSettingsFile) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    } catch {
      // VS Code settings may legally contain comments or trailing commas. Rewriting a file
      // we cannot faithfully parse would destroy the user's configuration, so we bail out
      // and tell them the one line to add instead.
      return {
        client: "vscode",
        status: "manual",
        detail: `add "chat.pluginLocations": {"${pluginRoot}": true} to ${collapseHome(settingsFile)}`,
      };
    }
  }

  const [updated, changed] = computeVsCodePluginLocationsUpdate(settings, pluginRoot, pluginName);
  if (!changed) return { client: "vscode", status: "current", detail: collapseHome(settingsFile) };

  try {
    const writeTarget = hasSettingsFile ? realpathSync(settingsFile) : settingsFile;
    writeTextFileAtomically(writeTarget, `${JSON.stringify(updated, null, 2)}\n`);
  } catch (error) {
    return { client: "vscode", status: "failed", detail: String(error instanceof Error ? error.message : error) };
  }
  return { client: "vscode", status: "registered", detail: collapseHome(settingsFile) };
}

/**
 * @param {string} pluginRoot absolute plugin root
 * @param {string} pluginName manifest name
 * @returns {{ client: string, status: string, detail: string }} outcome row
 */
function registerCursorPlugin(pluginRoot, pluginName) {
  const cursorDir = path.join(resolveHookHomeDir(), ".cursor");
  if (!existsSync(cursorDir)) {
    return { client: "cursor", status: "absent", detail: "no ~/.cursor directory found" };
  }

  try {
    const { status, target, reason } = linkCursorLocalPlugin(
      resolveCursorLocalPluginsDir(resolveHookHomeDir()),
      pluginRoot,
      pluginName,
    );
    if (status === "occupied") {
      return { client: "cursor", status: "manual", detail: `${collapseHome(target)} exists and is not a symlink` };
    }
    if (status === "unsupported") {
      // Windows without Developer Mode is the common case. Say what to do instead of
      // leaking a bare EPERM, and leave the other clients registered.
      return {
        client: "cursor",
        status: "manual",
        detail: `cannot link ${collapseHome(target)} (${reason}); link it to ${pluginRoot} manually, or enable Developer Mode on Windows`,
      };
    }
    return {
      client: "cursor",
      status: status === "current" ? "current" : "registered",
      detail: collapseHome(target),
    };
  } catch (error) {
    return { client: "cursor", status: "failed", detail: String(error instanceof Error ? error.message : error) };
  }
}

/**
 * @param {string} pluginRoot absolute plugin root
 * @param {string} pluginName manifest name
 * @returns {{ client: string, status: string, detail: string }} outcome row
 */
function registerCopilotPlugin(pluginRoot, pluginName) {
  const listed = spawnPluginClientSync("copilot", ["plugins", "list", "--scope", "user", "--kind", "plugin", "--json"]);
  if (listed.error) {
    return { client: "copilot", status: "absent", detail: "copilot CLI not found on PATH" };
  }
  if (listed.status !== 0) {
    const detail = String(listed.stderr || listed.stdout || `exit ${listed.status}`).trim();
    return {
      client: "copilot",
      status: "manual",
      detail: `could not verify installed plugins: ${detail.split("\n")[0]}`,
    };
  }

  const records = parseCopilotPluginRecords(listed.stdout);
  if (!records) {
    return { client: "copilot", status: "manual", detail: "could not parse installed plugin records" };
  }

  const existing = records.find((record) => record.name === pluginName && (!record.kind || record.kind === "plugin"));
  if (existing) {
    const source = copilotPluginSourcePath(existing) || installedCopilotPluginSourcePath(pluginName);
    if (!source) {
      return { client: "copilot", status: "manual", detail: "could not verify the installed plugin source" };
    }
    if (sameResolvedPath(source, pluginRoot)) {
      return { client: "copilot", status: "current", detail: collapseHome(pluginRoot) };
    }
  }

  const installed = spawnPluginClientSync("copilot", ["plugin", "install", pluginRoot]);
  if (installed.status !== 0) {
    const detail = String(installed.stderr || installed.stdout || `exit ${installed.status}`).trim();
    return { client: "copilot", status: "failed", detail: detail.split("\n")[0] };
  }
  return { client: "copilot", status: "registered", detail: "copilot plugin install" };
}

/** @param {unknown} output @returns {Record<string, any>[] | null} */
function parseCopilotPluginRecords(output) {
  try {
    const parsed = JSON.parse(String(output));
    const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.plugins) ? parsed.plugins : parsed?.items;
    return Array.isArray(records) && records.every((record) => record && typeof record === "object") ? records : null;
  } catch {
    return null;
  }
}

/** @param {string} pluginName @returns {string | null} */
function installedCopilotPluginSourcePath(pluginName) {
  const configDir = process.env.COPILOT_HOME || path.join(resolveHookHomeDir(), ".copilot");
  try {
    const config = JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8"));
    const record = Array.isArray(config.installedPlugins)
      ? config.installedPlugins.find((candidate) => candidate?.name === pluginName)
      : null;
    return record ? copilotPluginSourcePath(record) : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, any>} record @returns {string | null} */
function copilotPluginSourcePath(record) {
  const candidates = [
    record.sourcePath,
    record.source_path,
    record.pluginRoot,
    record.plugin_root,
    record.path,
    record.source?.path,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    if (candidate.startsWith("file:")) {
      try {
        return fileURLToPath(candidate);
      } catch {
        continue;
      }
    }
    if (path.isAbsolute(candidate)) return candidate;
  }
  return null;
}

/** @param {string} left @param {string} right @returns {boolean} */
function sameResolvedPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

export function resolveHookHomeDir(env = process.env, fallback = os.homedir()) {
  return env.HOME || fallback;
}

export function resolveCopilotHookDir(env = process.env, homeDir = resolveHookHomeDir(env)) {
  return path.join(env.COPILOT_HOME || path.join(homeDir, ".copilot"), "hooks");
}

export function createCopilotCliAmbientContextScript(command = "liesel") {
  return [
    'const { spawnSync } = require("node:child_process");',
    `const command = ${JSON.stringify(command)};`,
    'const result = spawnSync(command, [], { encoding: "utf8", shell: true });',
    'const detail = result.error ? result.error.message : (result.stderr || result.stdout || "exit " + (result.status ?? "unknown"));',
    "const text = String(result.status === 0 ? result.stdout : detail).trim();",
    'if (!text) { console.log("{}"); process.exit(0); }',
    'const prefix = result.status === 0 ? "## AXI ambient context: liesel\\n" : "## AXI ambient context: liesel\\nerror: liesel ambient context failed: ";',
    "console.log(JSON.stringify({ additionalContext: prefix + text }));",
  ].join(" ");
}

export function createCopilotCliSessionStartHook(command = "liesel", timeoutSec = 10) {
  const script = createCopilotCliAmbientContextScript(command);
  return {
    type: "command",
    bash: `node -e ${quoteForPosixShell(script)}`,
    powershell: `node -e ${quoteForPowerShell(script)}`,
    timeoutSec,
  };
}

export function computeCopilotCliHookUpdate(settings, hook = createCopilotCliSessionStartHook()) {
  const updated = structuredClone(settings && typeof settings === "object" ? settings : {});
  let changed = false;

  if (updated.version !== 1) {
    updated.version = 1;
    changed = true;
  }
  if (!updated.hooks || typeof updated.hooks !== "object" || Array.isArray(updated.hooks)) {
    updated.hooks = {};
    changed = true;
  }

  const current = Array.isArray(updated.hooks.sessionStart) ? updated.hooks.sessionStart : [];
  const unmanaged = current.filter((entry) => !isManagedCopilotCliHook(entry));
  const next = [...unmanaged, hook];

  if (!deepEqual(current, next)) {
    updated.hooks.sessionStart = next;
    changed = true;
  }

  return [changed ? updated : settings, changed];
}

export function installCopilotCliSessionStartHook({
  hookDir = resolveCopilotHookDir(),
  command = "liesel",
  timeoutSec = 10,
  onError = undefined,
} = {}) {
  const target = path.join(hookDir, "liesel.json");
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const current = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {};
    const [updated, changed] = computeCopilotCliHookUpdate(
      current,
      createCopilotCliSessionStartHook(command, timeoutSec),
    );
    if (changed) {
      writeFileSync(target, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onError?.(`${target}: ${message}`);
  }
}

function isManagedCopilotCliHook(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    (typeof entry.bash === "string" || typeof entry.powershell === "string" || typeof entry.command === "string") &&
    [entry.bash, entry.powershell, entry.command].some((value) => typeof value === "string" && value.includes("liesel"))
  );
}

function quoteForPosixShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteForPowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function serverCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const debug = args.includes("--verbose") || productEnv("DEBUG") === "1";
  const server = await serve({
    port,
    stateFile: stateFile(),
    version: VERSION,
    debug,
    extraListenHosts: flagValues(args, "--also-listen"),
  });
  await server.done;
  return "";
}

// `liesel mcp`: the board loop as MCP tools over stdio (src/mcp.js). stdout belongs to the
// protocol from here on, so this never returns an AXI result: it exits when stdin closes.
async function mcpCommand() {
  const { createLieselMcpTools, createMcpHandler, LIESEL_MCP_INSTRUCTIONS, runMcpStdio } = await import("./mcp.js");
  const boardFile = async (/** @type {string} */ input) => {
    if (!String(input || "").trim()) {
      throw new AxiError("A board folder is required", "VALIDATION_ERROR", [
        "Pass `board`: the board folder's absolute path",
      ]);
    }
    return canonicalFile(await resolveBoardTarget(path.resolve(input)));
  };
  const tools = createLieselMcpTools({
    openBoard: async ({ board, name }) => {
      const dir = boardDirPath(path.resolve(board));
      const output = await boardOpenCommand(["--no-open", ...(name ? ["--name", String(name)] : [])], dir);
      return {
        board: output.board,
        next_step: `Give the user the board URL. Then call liesel_poll with board "${dir}" to wait for their notes.`,
      };
    },
    boardStatus: async ({ board }) => {
      const dir = boardDirPath(path.resolve(board));
      return { board: boardSummary(await readBoard(dir), dir) };
    },
    poll: async ({ board, timeout_seconds, reply }) => {
      const file = await boardFile(board);
      const baseUrl = await ensureServer();
      const seconds = Number(timeout_seconds);
      const timeoutMs = Math.round(Math.min(600, Math.max(1, Number.isFinite(seconds) ? seconds : 50)) * 1000);
      const query = new URLSearchParams({ file, timeoutMs: String(timeoutMs), owner: "mcp" });
      const response = await fetchJson(`${baseUrl}/api/poll?${query}`, {
        retries: 0,
        ...(reply
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agent_reply: reply }),
            }
          : {}),
      });
      const output = createPollOutput({ file, response });
      return {
        ...output,
        next_step:
          output.session.status === "feedback"
            ? "Apply each prompt to the HTML file of the item it names (liesel_board_status maps item ids to files), then call liesel_reply with a short answer, or liesel_poll with `reply` to answer and keep waiting."
            : output.session.status === "waiting"
              ? "No notes yet. Call liesel_poll again to keep waiting."
              : output.next_step,
      };
    },
    reply: async ({ board, message, thread, pending }) => {
      const file = await boardFile(board);
      const text = await resolveAgentReply([
        "--agent-reply",
        message,
        ...(thread ? ["--thread", thread] : []),
        ...(pending ? ["--pending", pending] : []),
      ]);
      if (!String(text || "").trim()) {
        throw new AxiError("The reply was empty", "VALIDATION_ERROR", ["Pass a non-empty `message`"]);
      }
      const baseUrl = await ensureServer();
      await postAgentReply(`${baseUrl}/api/${sessionKey(file)}/agent-reply`, text, file);
      return { reply: { board: file, status: "sent" } };
    },
  });
  await runMcpStdio({
    handle: createMcpHandler({ tools, name: CLI_NAME, version: VERSION, instructions: LIESEL_MCP_INSTRUCTIONS }),
  });
  process.exit(0);
  return "";
}

async function visibleSessions() {
  const store = new SessionStore(stateFile());
  const sessions = (await store.listSessions()).filter((session) => session.status !== "ended");
  const { health } = await findRunningServer(defaultPort());
  const listeners = new Map(
    Array.isArray(health?.listeners)
      ? health.listeners
          .filter((listener) => listener && typeof listener.key === "string")
          .map((listener) => [listener.key, listener.label || "agent-listener"])
      : [],
  );
  return sessions.map((session) => ({ ...session, listener: listeners.get(session.key) || "none" }));
}

async function assertHtmlFile(file) {
  if (!isHtmlPath(file)) {
    throw new AxiError("Liesel expects an HTML file", "VALIDATION_ERROR", ["Run `liesel <html-file>`"]);
  }
  try {
    await access(file);
  } catch {
    throw new AxiError(`File not found: ${file}`, "NOT_FOUND", [
      "Create the HTML artifact first, then run `liesel <html-file>`",
    ]);
  }
}

const HEALTH_PROBE_TIMEOUT_MS = 500;
const DEFAULT_HEALTH_TIMEOUT_MS = 2000;
const MAX_HEALTH_BODY_BYTES = 256 * 1024;
// A reconcile asks the server to re-detect Tailscale and retry any unbound address before
// answering, which can take longer than a plain health read.
const HEALTH_RECONCILE_TIMEOUT_MS = 3000;

// Every address a Liesel server on this port could be answering at, in preference order: the host
// this CLI is configured for, loopback, then every other local interface address. Agents on one
// machine do not share LIESEL_HOST, and a CLI that only dialed its own host (plus loopback)
// concluded nothing was running while a server pinned to the tailnet address held the port, then
// spawned a second daemon beside it on the same port and the same state file.
function serverCandidateHosts() {
  const hosts = [clientHost(), LOOPBACK_HOST];
  for (const address of localInterfaceAddresses()) {
    if (!hosts.includes(address)) hosts.push(address);
  }
  return hosts;
}

function serverBaseUrl(host, port) {
  return `http://${hostForUrl(host)}:${port}`;
}

// A server is this installation's when it reports our state file. One from before `state_id`
// existed (0.1.77 and older) cannot say, so it counts as ours only at an address this CLI controls -
// its configured host or loopback - where replacing it is the upgrade path; anywhere else it may
// belong to another installation and is never adopted or stopped.
function isOwnedServer(entry, controlHosts) {
  if (entry.health.app !== SERVER_APP_ID) return false;
  if (typeof entry.health.state_id === "string") return entry.health.state_id === stateId();
  return controlHosts.has(entry.host);
}

// Another installation's Liesel server at an address this CLI controls is never used, replaced, or
// stopped: its sessions and state file are not ours.
function otherInstallationError(port, foreign) {
  const dir = typeof foreign.health.state_dir === "string" ? foreign.health.state_dir : "an unknown state directory";
  return new AxiError(
    `Port ${port} is served by another Liesel installation at ${foreign.host} (state directory ${dir})`,
    "SERVER_ERROR",
    [`Set LIESEL_PORT to another port, or set LIESEL_STATE_DIR to ${dir} to use that installation`],
  );
}

// Returns where a Liesel server actually answered, plus any OTHER Liesel daemon of this
// installation found on the same port at an address the chosen one does not serve. Every candidate
// is probed in parallel and each probe is bounded, so a hanging or foreign address cannot mask
// loopback, and a response whose app is liesel wins over a foreign /health. When nothing
// answers, the primary URL is still returned so callers have something to spawn against and report.
async function findRunningServer(port, { reconcileNetwork = false } = {}) {
  const controlHosts = new Set([clientHost(), LOOPBACK_HOST]);
  const probed = await Promise.all(
    serverCandidateHosts().map(async (host) => {
      const baseUrl = serverBaseUrl(host, port);
      const health = await probeHealth(baseUrl, { reconcileNetwork: false, timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
      return health ? { host, baseUrl, health } : null;
    }),
  );
  const found = probed.filter((entry) => entry !== null);
  const owned = found.filter((entry) => isOwnedServer(entry, controlHosts));
  const foreign =
    found.find(
      (entry) =>
        controlHosts.has(entry.host) && entry.health.app === SERVER_APP_ID && !isOwnedServer(entry, controlHosts),
    ) ?? null;
  const chosen = owned[0];
  if (!chosen) {
    const other = found.find((entry) => controlHosts.has(entry.host));
    return other
      ? { baseUrl: other.baseUrl, health: other.health, duplicates: [], foreign }
      : { baseUrl: serverBaseUrl(clientHost(), port), health: null, duplicates: [], foreign };
  }
  let health = chosen.health;
  if (reconcileNetwork) {
    health =
      (await probeHealth(chosen.baseUrl, { reconcileNetwork: true, timeoutMs: HEALTH_RECONCILE_TIMEOUT_MS })) ?? health;
  }
  return { baseUrl: chosen.baseUrl, health, duplicates: ownedDuplicates(owned, chosen), foreign };
}

// Other Liesel daemons of this installation on the same port. An address the chosen server itself
// reports as bound is the chosen server, not a duplicate. A server too old to report its addresses
// is about to be replaced by version, so every other address is retired with it: an old daemon left
// holding loopback would otherwise make the upgraded server refuse to start.
function ownedDuplicates(owned, chosen) {
  const covered = new Set([chosen.host, ...(Array.isArray(chosen.health.hosts) ? chosen.health.hosts : [])]);
  const duplicates = [];
  for (const entry of owned) {
    if (entry === chosen || covered.has(entry.host)) continue;
    duplicates.push(entry);
    for (const host of Array.isArray(entry.health.hosts) ? entry.health.hosts : [entry.host]) covered.add(host);
  }
  return duplicates;
}

// Duplicates are retired over their own /shutdown, never by process name or port-wide signal, so
// nothing but an identified Liesel server of this installation is ever stopped.
async function stopDuplicateServers(duplicates, { reloadKey = "", reason = "" } = {}) {
  for (const duplicate of duplicates) {
    await requestShutdown(duplicate.baseUrl, {
      reloadKey,
      reason: reason || serverReplacementReason(VERSION, duplicate.health),
    });
    await waitForPortFree(duplicate.baseUrl, 3000);
  }
}

// Keep the running server, retiring any same-port duplicate first. Only duplicates whose addresses
// the kept server already requests reach here (`hostsToServe`), and the reconcile afterwards makes
// it bind an address the duplicate was holding right away, instead of on its next background retry.
async function adoptServer(baseUrl, duplicates, reloadKey) {
  if (duplicates.length === 0) return baseUrl;
  await stopDuplicateServers(duplicates, { reloadKey });
  await probeHealth(baseUrl, { reconcileNetwork: true, timeoutMs: HEALTH_RECONCILE_TIMEOUT_MS });
  return baseUrl;
}

// The concrete addresses this CLI's own LIESEL_HOST needs a server to serve. Without an explicit
// host any running server will do: loopback is always served, and Tailscale is the server's to
// detect. A name that does not resolve right now is still required as the name, so the server is
// asked to serve it, retries it, and reports it as network_warning instead of it being dropped.
async function requiredServerHosts(env = process.env) {
  const envHost = env.LIESEL_HOST?.trim();
  if (!envHost || isWildcardHost(envHost)) return [];
  return resolveConcreteListenHosts([clientHost(env)], { keepUnresolved: true });
}

// Which required addresses a running server was never asked to serve. An address it was asked for
// but has not bound yet is NOT missing: that server is already retrying it, and a replacement could
// not bind it either. A server too old to report its requested addresses is judged by version.
export function missingServerHosts(healthBody, requiredHosts) {
  if (!healthBody || !Array.isArray(healthBody.requested_hosts)) return [];
  return requiredHosts.filter((host) => !healthBody.requested_hosts.includes(host));
}

// Every address the replaced servers were asked to serve, so a replacement - for an upgrade, a
// changed network, or a missing host - never drops another agent's address and its review links.
// This CLI's own hosts come from its environment. An address that is no longer on this machine (a
// Tailscale IP from a network that went away) is left out, so the replacement does not retry it
// forever; one still on a local interface is kept even when the network around it changed.
export function inheritedListenHosts(
  healthBodies,
  requiredHosts,
  inherited = [],
  localAddresses = localInterfaceAddresses(),
) {
  const hosts = [...inherited];
  for (const health of healthBodies) {
    if (!health || !Array.isArray(health.requested_hosts)) continue;
    for (const host of health.requested_hosts) {
      if (host === LOOPBACK_HOST || requiredHosts.includes(host)) continue;
      if (isIP(host) && !localAddresses.includes(host)) continue;
      if (!hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

// Every address a kept server has to be asked to serve: this CLI's own, and every address a
// same-port duplicate serves, so retiring that duplicate never takes its review links with it.
function hostsToServe(requiredHosts, duplicates) {
  return inheritedListenHosts(
    duplicates.map((duplicate) => duplicate.health),
    [],
    requiredHosts,
  );
}

async function probeHealth(baseUrl, { reconcileNetwork, timeoutMs }) {
  const health = await fetchHealth(baseUrl, { reconcileNetwork, timeoutMs });
  return health && typeof health === "object" ? health : null;
}

// `reloadKey` names the session this invocation is about to open. A version-driven replacement
// reloads that chrome only; every other open review page is told it is outdated and left alone.
async function ensureServer({ forceRestart = false, reloadKey = "" } = {}) {
  const port = defaultPort();
  const requiredHosts = await requiredServerHosts();
  const { baseUrl, health: existing, duplicates, foreign } = await findRunningServer(port, { reconcileNetwork: true });
  if (foreign) throw otherInstallationError(port, foreign);
  const missingHosts =
    existing?.app === SERVER_APP_ID ? missingServerHosts(existing, hostsToServe(requiredHosts, duplicates)) : [];
  if (existing && !shouldRestartServer(VERSION, existing, forceRestart) && missingHosts.length === 0) {
    return adoptServer(baseUrl, duplicates, reloadKey);
  }
  let alsoListen = inheritedListenHosts([existing, ...duplicates.map((duplicate) => duplicate.health)], requiredHosts);
  let unidentified = "";
  if (existing) {
    if (!(await canControlServerOnPort(baseUrl, existing, listenerMatchesLiesel))) {
      throw new AxiError(`Port ${port} is occupied by a non-Liesel server`, "SERVER_ERROR", [
        `Stop the process using port ${port}, or set LIESEL_PORT to another port`,
      ]);
    }
    await stopDuplicateServers(duplicates, { reloadKey });
    // Stale server from an older release is squatting on the port. Ask it to shut down
    // gracefully so the upgraded client doesn't keep handing users an old chrome.
    await requestShutdown(baseUrl, { reloadKey, reason: serverReplacementReason(VERSION, existing, forceRestart) });
    const freed = await waitForPortFree(baseUrl, 2000);
    if (!freed) {
      // Pre-handshake servers (any release older than this change) don't expose /shutdown
      // so the POST 404'd. Fall back to SIGTERM by PID so the very first upgrade still
      // works, then keep waiting.
      if (shouldKillProcessOnPort(VERSION, existing)) {
        if (killLieselListener(baseUrl)) await waitForPortFree(baseUrl, 3000);
        else unidentified = baseUrl;
      }
    }
  }
  await startServer(port, { alsoListen });
  const replacedForNetwork =
    Boolean(existing) &&
    existing.app === SERVER_APP_ID &&
    existing.network_stale === true &&
    !forceRestart &&
    typeof existing.version === "string" &&
    !isServerOlderThanCli(VERSION, existing.version);
  let networkRestarted = replacedForNetwork;
  let raceRestarted = false;
  let deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const {
      baseUrl: liveUrl,
      health,
      duplicates: liveDuplicates,
      foreign: liveForeign,
    } = await findRunningServer(port, { reconcileNetwork: true });
    if (liveForeign) throw otherInstallationError(port, liveForeign);
    const liveMissing =
      health?.app === SERVER_APP_ID ? missingServerHosts(health, hostsToServe(requiredHosts, liveDuplicates)) : [];
    // Once is the bound: every replacement carries the hosts of the server it replaces, so two CLIs
    // that each need their own address converge on one server instead of replacing each other.
    if (health && !shouldRestartServer(VERSION, health)) {
      if (liveMissing.length === 0) return adoptServer(liveUrl, liveDuplicates, reloadKey);
      if (raceRestarted) throw missingHostsError(port, liveMissing);
    }
    // Another daemon won the port while ours was starting (ours exits when a Liesel server already
    // owns loopback) - an older release, or one missing an address this CLI needs. Retire it and
    // start once more rather than wait it out.
    if (health?.app === SERVER_APP_ID && health.network_stale !== true && !raceRestarted) {
      raceRestarted = true;
      alsoListen = inheritedListenHosts(
        [health, ...liveDuplicates.map((duplicate) => duplicate.health)],
        requiredHosts,
        alsoListen,
      );
      await stopDuplicateServers(liveDuplicates, { reloadKey });
      await requestShutdown(liveUrl, { reloadKey, reason: serverReplacementReason(VERSION, health) });
      if (!(await waitForPortFree(liveUrl, 3000))) break;
      await startServer(port, { alsoListen });
      deadline = Date.now() + 5000;
      continue;
    }
    if (health?.network_stale === true && health.app === SERVER_APP_ID) {
      if (networkRestarted) {
        if (liveMissing.length > 0) throw missingHostsError(port, liveMissing);
        return adoptServer(liveUrl, liveDuplicates, reloadKey);
      }
      alsoListen = inheritedListenHosts([health], requiredHosts, alsoListen);
      await requestShutdown(liveUrl, { reloadKey, reason: "" });
      if (!(await waitForPortFree(liveUrl, 3000))) break;
      await startServer(port, { alsoListen });
      networkRestarted = true;
      deadline = Date.now() + 5000;
      continue;
    }
    await delay(100);
  }
  if (unidentified) throw unidentifiedListenerError(unidentified);
  throw new AxiError("Liesel server did not start", "SERVER_ERROR", [
    `Run \`liesel server --port ${port}\` to inspect server startup`,
  ]);
}

function missingHostsError(port, missingHosts) {
  return new AxiError(
    `The Liesel server on port ${port} does not serve ${missingHosts.join(", ")}, and replacing it did not stick`,
    "SERVER_ERROR",
    ["Run `liesel stop`, then retry"],
  );
}

// Pure helper so the upgrade-detection logic is unit-testable without spinning up HTTP.
// Returns true when the running server is a different (or pre-handshake) version than
// what this CLI was built with - i.e. the user just upgraded and the stale server needs
// to step aside.
export function shouldRestartServer(currentVersion, healthBody, forceRestart = false) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (forceRestart && healthBody.app === SERVER_APP_ID) return true;
  if (healthBody.network_stale === true && healthBody.app === SERVER_APP_ID) return true;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  return isServerOlderThanCli(currentVersion, healthBody.version);
}

// A running server newer than this CLI is adopted, never replaced: two installed versions on one
// machine would otherwise restart each other's server in turn. Numeric, so 0.1.9 is older than
// 0.1.10. A version that does not parse falls back to "different means replace".
function isServerOlderThanCli(currentVersion, runningVersion) {
  if (runningVersion === currentVersion) return false;
  const current = parseReleaseVersion(currentVersion);
  const running = parseReleaseVersion(runningVersion);
  if (!current || !running) return true;
  for (let index = 0; index < 3; index += 1) {
    if (running[index] !== current[index]) return running[index] < current[index];
  }
  return false;
}

function parseReleaseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// Which branch of `shouldRestartServer` actually fired, because that is what the other open
// review pages are told. A local-build force replaces a server of the SAME version, so calling it
// an upgrade would be false on both counts; only a version this CLI does not match is one.
export function serverReplacementReason(currentVersion, healthBody, forceRestart = false) {
  if (!shouldRestartServer(currentVersion, healthBody, forceRestart)) return "";
  const runningVersion = healthBody.version;
  if (
    typeof runningVersion !== "string" ||
    runningVersion === "" ||
    isServerOlderThanCli(currentVersion, runningVersion)
  ) {
    return "upgrade";
  }
  return forceRestart ? "local-build" : "";
}

export function shouldForceRestartForLocalBuild(executablePath, sourceServerExists = localSourceServerExists()) {
  const localBuildEntry = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  return sourceServerExists && path.resolve(executablePath) === path.resolve(localBuildEntry);
}

function localSourceServerExists() {
  return existsSync(fileURLToPath(new URL("../src/server.js", import.meta.url)));
}

export function shouldKillProcessOnPort(currentVersion, healthBody) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  if (healthBody.app !== SERVER_APP_ID) return false;
  return isServerOlderThanCli(currentVersion, healthBody.version);
}

async function canControlServerOnPort(baseUrl, healthBody, processMatchesLiesel) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (healthBody.app === SERVER_APP_ID) return true;
  if (typeof healthBody.version === "string" && healthBody.version !== "") return false;
  return processMatchesLiesel(baseUrl);
}

/**
 * @param {string} baseUrl
 * @param {{ reconcileNetwork?: boolean, timeoutMs?: number }} [options]
 */
// Plain node:http with the socket destroyed on every exit path, not fetch: an aborted fetch leaves
// its TCP connect running, and discovery dials every local address - including a Tailscale IPv6
// address that silently drops connections to itself - so each CLI invocation lingered for the OS
// connect timeout (~10s) after printing its result.
function fetchHealth(baseUrl, { reconcileNetwork = false, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {import("node:http").ClientRequest | null} */
    let request = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(value);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, timeoutMs);
    try {
      const url = new URL(`${baseUrl}/health${reconcileNetwork ? "?reconcile_network=1" : ""}`);
      request = httpGet(url, { agent: false }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > MAX_HEALTH_BODY_BYTES) finish(null);
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            finish(null);
            return;
          }
          try {
            finish(JSON.parse(body));
          } catch {
            finish(null);
          }
        });
        response.on("error", abort);
      });
      request.on("error", abort);
    } catch {
      abort();
    }
  });
}

// `reason` is what every other open review page is told: this CLI has exactly two callers, and
// each knows which of them it is.
async function requestShutdown(baseUrl, { reloadKey = "", reason = "" } = {}) {
  const body = {};
  if (reloadKey) body.reload_key = reloadKey;
  if (reason) body.reason = reason;
  try {
    await fetch(`${baseUrl}/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Best effort. If the server died before answering, the port will free up on its own.
  }
}

async function waitForPortFree(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchHealth(baseUrl))) return true;
    await delay(100);
  }
  return false;
}

// PIDs listening on exactly this server's address and port whose command is Liesel. Other
// processes can share the port at other addresses, so nothing is identified by port alone.
// macOS/Linux only (lsof) - liesel isn't shipped for Windows today.
function lieselListenerPids(baseUrl) {
  const { hostname, port } = new URL(baseUrl);
  try {
    const listing = spawnSync("lsof", ["-t", `-iTCP@${hostname}:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (listing.status !== 0) return [];
    const pids = [];
    for (const line of listing.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      if (command.status === 0 && /liesel/.test(command.stdout)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

function listenerMatchesLiesel(baseUrl) {
  return lieselListenerPids(baseUrl).length > 0;
}

// Last-resort fallback for the bootstrap upgrade case: a pre-handshake server is squatting on the
// port and doesn't expose /shutdown, so its PID is resolved and SIGTERM'd. Reports whether a Liesel
// process was found to signal.
function killLieselListener(baseUrl) {
  const pids = lieselListenerPids(baseUrl);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already gone or permission denied - either way nothing we can do.
    }
  }
  return pids.length > 0;
}

function unidentifiedListenerError(baseUrl) {
  const { host } = new URL(baseUrl);
  return new AxiError(
    `The server at ${host} did not shut down, and no Liesel process listening there could be identified`,
    "SERVER_ERROR",
    [`Stop the process listening on ${host} yourself, or set LIESEL_PORT to another port`],
  );
}

async function startServer(port, { alsoListen = [] } = {}) {
  await ensureStateDir();
  const entry = resolveServerEntry();
  let logFd = null;
  try {
    logFd = openSync(serverLogFile(), "a");
  } catch {
    // If logging cannot be initialized, keep the server behavior unchanged.
  }
  try {
    const args = [entry, "server", "--port", String(port)];
    for (const host of alsoListen) args.push("--also-listen", host);
    const child = spawn(process.execPath, args, createServerSpawnOptions(logFd));
    child.unref();
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
}

// The detached server child must stamp stdio before evaluating the CLI. In source layout that
// is `../bin/liesel-server.js`. In the published bundle only `dist/` ships, so the sibling
// `server.mjs` bootstrap is the entry. Ordinary user-facing commands still use `bin/liesel.js`
// / `dist/cli.mjs`.
function resolveServerEntry() {
  const sourceEntry = fileURLToPath(new URL("../bin/liesel-server.js", import.meta.url));
  if (existsSync(sourceEntry)) return sourceEntry;
  return fileURLToPath(new URL("./server.mjs", import.meta.url));
}

/**
 * @param {number | null} logFd
 * @returns {import("node:child_process").SpawnOptions}
 */
export function createServerSpawnOptions(logFd = null) {
  const stdio = /** @type {import("node:child_process").StdioOptions} */ (
    logFd === null ? "ignore" : ["ignore", logFd, logFd]
  );
  return {
    detached: true,
    stdio,
    env: { ...process.env, LIESEL_NO_OPEN: "1" },
  };
}

/**
 * @param {string} url
 * @param {{ retries?: number, retryDelayMs?: number, onResponse?: ((response: Response) => void) | null, method?: string, headers?: Record<string, string>, body?: string }} [options]
 */
export async function fetchJson(
  url,
  { retries = 0, retryDelayMs = 250, onResponse = null, method = "GET", headers, body } = {},
) {
  let response;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      response = await fetch(url, {
        method,
        ...(headers ? { headers } : {}),
        ...(body === undefined ? {} : { body }),
      });
      break;
    } catch (error) {
      if (error instanceof AxiError) throw error;
      if (attempt >= retries) throw serverConnectionError();
      await delay(retryDelayMs);
    }
  }

  if (!response) throw serverConnectionError();
  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Keep the generic transport error when the server did not send JSON.
    }
    if (payload?.code) {
      const holder = payload.code.startsWith("LISTENER_") && payload.holder;
      const holderDetail =
        holder && typeof holder.label === "string" && Number.isFinite(holder.age_ms)
          ? ` (current listener: ${holder.label}; active for ${Math.max(0, holder.age_ms)}ms)`
          : "";
      const error = new AxiError(
        `${payload.error || `Liesel request failed: ${response.status}`}${holderDetail}`,
        payload.code,
        ["Use --takeover only when you intend to displace the current listener"],
      );
      if (holder) Object.assign(error, { holder });
      throw error;
    }
    throw new AxiError(`Liesel request failed: ${response.status}`, "SERVER_ERROR");
  }
  onResponse?.(response);
  try {
    return await response.json();
  } catch {
    throw pollResponseInterruptedError();
  }
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw serverConnectionError();
  }
  if (!response.ok) {
    throw new AxiError(`Liesel request failed: ${response.status}`, "SERVER_ERROR");
  }
  return response.json();
}

const AGENT_REPLY_RECEIPT_TIMEOUT_MS = 10_000;

/**
 * @param {string} url
 * @param {string} text
 * @param {string} file
 * @param {{ timeoutMs?: number }} [options]
 */
export async function postAgentReply(url, text, file, { timeoutMs = AGENT_REPLY_RECEIPT_TIMEOUT_MS } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch {
    if (signal.aborted) throw agentReplyReceiptTimeoutError(file, timeoutMs);
    throw new AxiError("Liesel server connection failed", "SERVER_ERROR", [
      "Run `liesel server --verbose` or inspect `~/.liesel/server.log` (`LIESEL_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
      `Re-run \`liesel reply ${file} --agent-reply "<message>"\` after the server is reachable`,
    ]);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (signal.aborted) throw agentReplyReceiptTimeoutError(file, timeoutMs);
  }
  if (response.status === 404) {
    throw new AxiError("No active Liesel session for this file", "NOT_FOUND", [`Run \`liesel ${file}\` first`]);
  }
  if (response.status === 409 && payload?.status === "ended") {
    throw new AxiError("Liesel session has ended; reply was not sent", "SESSION_ENDED", [
      createEndedNextStep(file, payload.ended_by),
    ]);
  }
  if (!response.ok || payload?.status !== "sent") {
    throw new AxiError(`Liesel did not accept the agent reply (${response.status})`, "SERVER_ERROR", [
      `Confirm the session is open with \`liesel ${file}\`, then re-run \`liesel reply ${file}\``,
    ]);
  }
  return payload;
}

function agentReplyReceiptTimeoutError(file, timeoutMs) {
  return new AxiError(
    `Liesel did not confirm the agent reply within ${timeoutMs}ms, so acceptance is unknown`,
    "SERVER_ERROR",
    [
      "Run `liesel server --verbose` or inspect `~/.liesel/server.log` (`LIESEL_STATE_DIR/server.log` when set) for server diagnostics",
      `Check the Liesel conversation for the reply before re-running \`liesel reply ${file}\`, so it is not posted twice`,
    ],
  );
}

function serverConnectionError() {
  return new AxiError("Liesel server connection failed", "SERVER_ERROR", [
    "Run `liesel server --verbose` or inspect `~/.liesel/server.log` (`LIESEL_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
    "Re-run the last `liesel poll <html-file>` command after the server is healthy",
  ]);
}

function pollResponseInterruptedError() {
  return new AxiError(POLL_INTERRUPTED_MESSAGE, "SERVER_ERROR", [
    "Run `liesel server --verbose` or inspect `~/.liesel/server.log` (`LIESEL_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
    "Re-run the last `liesel poll <html-file>` command after the server is healthy",
  ]);
}

function firstPositionalArg(args, valueFlags = []) {
  const flags = new Set(valueFlags);
  let positionalMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!positionalMode && arg === "--") {
      positionalMode = true;
      continue;
    }
    if (!positionalMode && isValueFlagToken(arg, flags)) {
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (!positionalMode && arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return null;
}

function flagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg === flag) return args[i + 1] || null;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1) || null;
  }
  return null;
}

function flagValues(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === flag && args[i + 1]) {
      values.push(args[i + 1]);
      i += 1;
    } else if (arg.startsWith(`${flag}=`) && arg.length > flag.length + 1) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}

function inspectValueFlag(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") return { present: false };
    if (arg === flag) {
      return { present: true, value: i + 1 < args.length ? args[i + 1] : null, swallows: true };
    }
    if (arg.startsWith(`${flag}=`)) {
      return { present: true, value: arg.slice(flag.length + 1), swallows: false };
    }
  }
  return { present: false };
}

const AGENT_REPLY_FILE_HINT = "Pass --agent-reply-file <path>, or --agent-reply-file - to read stdin";

function agentReplyTooLargeError(suggestion) {
  return new AxiError(`Agent reply exceeds the ${AGENT_REPLY_LIMIT_LABEL}`, "VALIDATION_ERROR", [
    suggestion || "Shorten the reply, then retry the same poll command",
  ]);
}

/**
 * @param {import("node:stream").Readable} stream
 */
async function readAgentReplyStream(stream, tooLargeHelp) {
  const chunks = [];
  let bytes = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > AGENT_REPLY_INPUT_LIMIT_BYTES) {
      stream.destroy();
      throw agentReplyTooLargeError(tooLargeHelp);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks, bytes).toString("utf8");
  if (Buffer.byteLength(JSON.stringify({ agent_reply: text })) > AGENT_REPLY_JSON_LIMIT_BYTES) {
    throw agentReplyTooLargeError(tooLargeHelp);
  }
  return text;
}

/**
 * Resolve the agent-reply body from `--agent-reply` or `--agent-reply-file`.
 * File/stdin is the path for a longer Markdown body so newlines survive quoting.
 *
 * @param {string[]} args
 * @param {{
 *   createReadStreamFn?: typeof createReadStream,
 *   stdin?: import("node:stream").Readable,
 *   stdinIsTTY?: boolean,
 *   tooLargeHelp?: string,
 * }} [io]
 * @returns {Promise<string | null>}
 */
export async function resolveAgentReply(
  args,
  {
    createReadStreamFn = createReadStream,
    stdin = process.stdin,
    stdinIsTTY = process.stdin.isTTY === true,
    tooLargeHelp = undefined,
  } = {},
) {
  const inline = inspectValueFlag(args, "--agent-reply");
  const fromFile = inspectValueFlag(args, "--agent-reply-file");
  if (inline.present && fromFile.present) {
    throw new AxiError("--agent-reply and --agent-reply-file cannot be combined", "VALIDATION_ERROR", [
      "Pass --agent-reply for a concise quoted reply, or --agent-reply-file <path> (`-` for stdin) when a longer Markdown body is necessary",
    ]);
  }
  const text = fromFile.present
    ? await readAgentReplyFile(fromFile, { createReadStreamFn, stdin, stdinIsTTY, tooLargeHelp })
    : (inline.present && inline.value) || null;
  return withThreadMarker(args, withPendingMarker(args, text));
}

/**
 * `--thread <id>` on a board reply: file the reply under that conversation thread (the
 * `thread` a prompt carried). Without it a reply joins the threads of the notes it settles.
 *
 * @param {string[]} args
 * @param {string | null} text
 */
function withThreadMarker(args, text) {
  const thread = inspectValueFlag(args, "--thread");
  if (!thread.present) return text;
  const id = String(thread.value || "").trim();
  if (!/^[A-Za-z0-9:._-]{1,80}$/.test(id)) {
    throw new AxiError("--thread needs the thread id a prompt carried", "VALIDATION_ERROR", [
      'Pass --thread <thread-id>, the `thread` field of the prompt you are answering, with --agent-reply "<message>"',
    ]);
  }
  if (!text) {
    throw new AxiError("--thread needs a reply", "VALIDATION_ERROR", [
      'Pass --agent-reply "<message>" with --thread <id>',
    ]);
  }
  return `${text}\n\n[[thread: ${id}]]`;
}

/**
 * `--pending <item-id>` on a board reply: a new version of that item is on its way, so
 * the board shows a placeholder under it until the version's file appears.
 *
 * @param {string[]} args
 * @param {string | null} text
 */
function withPendingMarker(args, text) {
  const pending = inspectValueFlag(args, "--pending");
  if (!pending.present) return text;
  const id = String(pending.value || "").trim();
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(id)) {
    throw new AxiError("--pending needs the board item id the new version grows from", "VALIDATION_ERROR", [
      'Pass --pending <item-id>, for example --pending 02-why-card-today, with --agent-reply "<message>"',
    ]);
  }
  if (!text) {
    throw new AxiError("--pending needs a reply", "VALIDATION_ERROR", [
      'Pass --agent-reply "<message>" with --pending <item-id>',
    ]);
  }
  return `${text}\n\n[[pending: ${id}]]`;
}

/**
 * @param {{ present: boolean, value?: string | null, swallows?: boolean }} fromFile
 * @param {{
 *   createReadStreamFn: typeof createReadStream,
 *   stdin: import("node:stream").Readable,
 *   stdinIsTTY: boolean,
 *   tooLargeHelp?: string,
 * }} io
 */
async function readAgentReplyFile(fromFile, { createReadStreamFn, stdin, stdinIsTTY, tooLargeHelp }) {
  if (fromFile.swallows && typeof fromFile.value === "string" && fromFile.value.startsWith("--")) {
    throw new AxiError(
      `--agent-reply-file was given no value: the next argument ${fromFile.value} is another flag, so it would have been used as the path`,
      "VALIDATION_ERROR",
      [AGENT_REPLY_FILE_HINT, "Use --agent-reply-file=<path> if the path itself starts with --"],
    );
  }
  const spec = fromFile.value;
  if (spec == null || !String(spec).trim()) {
    throw new AxiError("--agent-reply-file was given an empty value", "VALIDATION_ERROR", [AGENT_REPLY_FILE_HINT]);
  }
  let text;
  if (spec === "-") {
    if (stdinIsTTY) {
      throw new AxiError("--agent-reply-file - cannot read stdin from a terminal", "VALIDATION_ERROR", [
        "Pipe a Markdown body into stdin, or pass --agent-reply-file <path>",
      ]);
    }
    try {
      text = await readAgentReplyStream(stdin, tooLargeHelp);
    } catch (error) {
      if (error instanceof AxiError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new AxiError(`Cannot read --agent-reply-file stdin: ${detail}`, "VALIDATION_ERROR", [
        "Pipe a Markdown body into stdin, or pass --agent-reply-file <path>",
      ]);
    }
  } else {
    try {
      text = await readAgentReplyStream(createReadStreamFn(spec), tooLargeHelp);
    } catch (error) {
      if (error instanceof AxiError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new AxiError(`Cannot read --agent-reply-file ${spec}: ${detail}`, "VALIDATION_ERROR", [
        "Pass a UTF-8 Markdown file, or `-` to read stdin",
      ]);
    }
  }
  if (!String(text || "").trim()) {
    throw new AxiError("--agent-reply-file was empty", "VALIDATION_ERROR", [
      'Write Markdown into the file, or pass --agent-reply "<message>" for a concise reply',
    ]);
  }
  return String(text);
}

function isValueFlagToken(arg, flags) {
  for (const flag of flags) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return true;
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getCommandHelp(command, { agent = "generic" } = {}) {
  return createCommandHelp({ agent })[command] || null;
}

function createTopLevelHelp({ agent = "generic" } = {}) {
  return `liesel - Liesel AXI\n\nUsage:\n  liesel\n  liesel <html-file> [--no-open] [--no-gate] [--reopen]\n  liesel poll <html-file> [--owner <label>] [--takeover] [--agent-reply "..."] [--agent-reply-file <path>]\n  liesel reply <html-file> (--agent-reply "..." | --agent-reply-file <path>) [--pending <item-id>] [--thread <thread>]\n  liesel end <html-file>\n  liesel export <html-file> [--out <path>]\n  liesel share <html-file> [--private | --password <pw>] [--token <t>]\n  liesel share <html-file> --site <site_id> --update-key <key> [--private | --password <pw>]\n  liesel share --unpublish --site <site_id> --update-key <key>\n  liesel stop\n  liesel playbook [playbook_id]\n  liesel design\n  liesel libraries [--search <text>] [--library <id>]\n  liesel setup hooks\n  liesel setup plugin\n  liesel mcp\n\n${DESIGN_SYSTEM_HINT}\n\nNote: poll long-polls until the user sends feedback, ends the session, or leaves every review window disconnected past the reconnect grace period, staying silent while it waits - never kill it. Layout issues the browser detects are passive: they collect in the user's Layout issues inbox in the Liesel top bar and reach the agent only when the user selects them and queues the fixes, as an ordinary tag "layout-warnings" prompt. Do not pass --timeout-ms during normal agent use; it is for tests and debugging only. ${pollExecutionGuidance({ agent })} ${POLL_SEND_AND_END_RULE} Use \`liesel reply\` when handing a result back without waiting for more feedback: it exits 0 only after the server accepts the reply, so the board stops showing Working. \`poll --agent-reply\` posts a reply and then keeps waiting.\n\n`;
}

function createCommandHelp({ agent = "generic" } = {}) {
  return {
    open: `Usage: liesel <html-file> [--no-open] [--no-gate] [--reopen]\n\nOpen or resume a Liesel review session for an HTML artifact. Use --no-open when you need to ensure the server/session exists without opening another browser window. Use --no-gate to skip the open-time layout curtain for this browser open. If the user explicitly ended the session from the browser, this refuses to reopen it and returns guidance instead - pass --reopen to force it open when the user asks for further review or something important needs their visual attention. Sessions ended by the agent (\`liesel end\`) reopen normally without the flag.\n`,
    poll: `Usage: liesel poll <html-file> [--owner <label>] [--takeover] [--agent-reply "..."] [--agent-reply-file <path>]\n\nThis command exclusively long-polls for queued user prompts. Pass --owner <label> to make the active listener visible in session listings; --takeover displaces an existing listener, which receives LISTENER_REPLACED. A second poll without --takeover fails with LISTENER_ACTIVE instead of silently returning waiting.\n\nThis command long-polls indefinitely for queued user prompts. It stays silent while it waits - that is normal, never kill it. Browser-detected layout issues do NOT return this poll: they are filed passively in the user's Layout issues inbox and arrive as an ordinary tag "layout-warnings" prompt only after the user selects them and queues the fixes. Warning lifecycle: an issue stays unresolved and counted while queued, becomes recurring if a newer artifact revision still shows it, and is resolved only after a newer artifact load plus a complete diagnostic pass at the same viewport no longer detects it. A failed or incomplete pass preserves it as unverified rather than clearing it. The only response that arrives without user action is artifact_failures - a fatal failure that made the review surface itself unusable. Do not pass --timeout-ms during normal agent use; it is for tests and debugging only. In a Herdr-managed pane, set LIESEL_HERDR_CHIME=1 to request attention when the poll has entered its waiting state; unset it or use any other value to keep the current silent behavior. Notification failures never interrupt the poll. ${pollExecutionGuidance({ agent })} Use --agent-reply after applying prior feedback to display a concise response in Liesel before waiting again. When you are handing a result back and are not about to long-poll, run \`liesel reply <html-file> --agent-reply "..."\` instead: that command exits 0 only after the server accepts the reply, so the board stops showing Working without this poll staying open. ${POLL_AGENT_REPLY_RULE} ${POLL_AGENT_REPLY_HELP_POINTER} Do not combine --agent-reply with --agent-reply-file.\n\nExamples:\n  liesel poll report.html --agent-reply "Renamed the payment step."\n  liesel poll report.html --agent-reply-file reply.md\n  liesel poll report.html --agent-reply-file -\n\n${POLL_SEND_AND_END_RULE}\n`,
    reply: `Usage: liesel reply <html-file> (--agent-reply "..." | --agent-reply-file <path>) [--pending <item-id>] [--thread <thread>]\n\nPost an agent reply to the open Liesel session and exit once the server confirms it was accepted. Exit 0 only when the server answers that the reply was sent, which is when the board stops showing Working. If that answer does not arrive within ${AGENT_REPLY_RECEIPT_TIMEOUT_MS / 1000} seconds, exit non-zero with a timeout error. Use this when you are handing a result back and are not about to wait for more feedback. A reply also marks every note the poll delivered to you as Done in the reviewer's panel, so reply once you have handled them.\n\nUse \`liesel poll <html-file> --agent-reply "..."\` instead when the reply should be followed by a long-poll. That command posts the reply and then keeps waiting, so it does not exit when the reply is accepted.\n\nPass exactly one of --agent-reply or --agent-reply-file. ${POLL_AGENT_REPLY_RULE} ${POLL_AGENT_REPLY_HELP_POINTER} Do not combine the two flags. An empty reply is refused. On a board, --pending <item-id> says a new version of that item is coming: the board shows a holder under it until the new file appears. On a board, --thread <thread> files the reply under that conversation thread (the \`thread\` a prompt carried).\n\nExamples:\n  liesel reply report.html --agent-reply "Renamed the payment step."\n  liesel reply report.html --agent-reply-file reply.md\n  liesel reply report.html --agent-reply-file -\n`,
    end: `Usage: liesel end <html-file>\n\nEnd a Liesel session as the agent. A session ended this way still reopens normally on the next \`liesel <html-file>\`, unlike a user ending it from the browser, which requires --reopen.\n`,
    export: `Usage: liesel export <html-file> [--out <path>]\n\nWrite a portable copy of an artifact: one HTML file with its LOCAL assets inlined (relative-path stylesheets, scripts, images, and fonts become inline <style>/<script> blocks and data URIs). Remote CDN/font references (https URLs) are left as links for the browser to load, so the file needs network to render those. Liesel makes no outbound requests - it only reads local files, confined to the artifact's directory. Defaults to writing <name>.export.html next to the source; pass --out to choose a path. The Liesel annotation SDK is never included in an export.\n`,
    share: `Usage:\n  liesel share <html-file> [--private | --password <pw>] [--token <t>]\n  liesel share <html-file> --site <site_id> --update-key <key> [--private | --password <pw>]\n  liesel share --unpublish --site <site_id> --update-key <key>\n\nPublish the artifact on ht-ml.app (https://ht-ml.app), a third-party hosting service not part of Liesel, and print a visitable URL. Shares are PUBLIC by default: anyone with the link can open the page, and it may be indexed or scraped. Pass --private to publish a PRIVATE page behind a generated password, returned once in the output - give it to the user with the URL and tell them it is a shared secret. Pass --password <pw> instead when the user chose the password; it is never echoed back. Builds the same local-inlined HTML as 'export' (local assets inlined; remote CDN/font URLs left as links and are not blocked by CSP on ht-ml.app, but still load over the viewer's network), then POSTs it to ht-ml.app's /v1 API. Creating a site needs no account or API key. The response includes the url plus a secret update_key (shown once) for changing the page later.\n\n--site <site_id> with --update-key <key> republishes an existing page in place: same URL, new HTML. On a republish the password is left alone unless you pass --private (rotate to a new generated one) or --password <pw> (set one). There is no way to make a private page public again: ht-ml.app accepts a request to clear a password and silently ignores it, so Liesel does not offer one rather than reporting a page as public while it is still gated. Locking a page that was PUBLIC is also not instant at ht-ml.app's CDN: it was observed still answering uncredentialed requests for minutes after the password was set, so do not tell the user a newly gated page is unreachable right away (a page that was already private has no such cached copy).\n\n--unpublish takes the same credentials and no file. ht-ml.app has NO delete endpoint, so this replaces the page with a short placeholder and locks it behind a random password that is immediately discarded; the URL still resolves and the host still holds what was published. Say that to the user rather than calling it deleted. The update_key still works, so republishing with --private brings the page back behind a new password.\n\nA value flag given an empty or whitespace-only value is REFUSED rather than acted on: an unquoted shell variable that is unset makes \`--password $PW\` an empty password, which the host treats as none and would publish a PUBLIC page while you believed it was gated. Quote the value, or pass --private to have Liesel generate one.\n\nSet LIESEL_HTML_APP_TOKEN (or pass --token) to attach an optional bearer token when CREATING a page; it is never required. A republish (--site/--update-key) or --unpublish rejects --token, because the update_key is what the Authorization header carries there. The annotation SDK is never included.\n`,
    stop: `Usage: liesel stop [--port <port>]\n\nShut down the background Liesel server. The server also stops itself when no browser or poll has been connected for a while (LIESEL_IDLE_TIMEOUT_MS, default 30m) and immediately when the last session ends with nothing connected.\n`,
    playbook: `Usage: liesel playbook [playbook_id]\n\nList focused artifact guidance playbooks, or show one playbook by ID. Known IDs: diagram, table, comparison, plan, code, input, explanation, slides.\n\n${PLAYBOOK_ROUTER_HELP}\n\nExamples:\n  liesel playbook\n  liesel playbook diagram\n  liesel playbook input\n`,
    libraries: `Usage: liesel libraries [--search <text>] [--library <id>]\n\nList the Excalidraw libraries (.excalidrawlib files) the user copied into ~/.liesel/excalidraw-libraries, or LIESEL_STATE_DIR/excalidraw-libraries when set. Their items appear in every whiteboard's library panel. --search lists item refs whose ref contains every search word; --library lists one library's item refs. Liesel only reads this directory and never downloads libraries.\n\nExamples:\n  liesel libraries\n  liesel libraries --search lambda\n  liesel libraries --library aws-architecture-icons\n`,
    design: `Usage: liesel design\n\nShow a copy-pasteable CDN snippet for Tailwind CSS browser runtime v4 + DaisyUI v5 + themes, the whiteboard (Mermaid) opt-in snippet, a content-to-playbook router, an optional layout safety CSS snippet, plus technical reference for DaisyUI components. ${PLAYBOOK_ROUTER_HELP} Liesel artifacts stay portable HTML. This CDN snippet is the design fallback, not the default: inspect the subject project before falling back, and paste the layout safety CSS only when useful for dense nested grid/flex layouts, badges, wide fonts, or local media. ${DESIGN_PRIORITY_RULE}\n`,
    init: `Usage: ${CLI_NAME} init [dir] [--board <folder>] [--name "<board name>"]\n\nSet a project up for design review with any coding agent. Creates a board folder (default \`${DEFAULT_BOARD_DIR}\`) holding board.json and a starter design, writes LIESEL.md with the review loop, and appends a short Liesel section pointing at LIESEL.md to AGENTS.md and CLAUDE.md (creating them when missing) and to GEMINI.md when the project has one. Existing files are never overwritten: a file that already carries the section, or a CLAUDE.md that imports AGENTS.md, is left alone, so running init again is safe. No server is started.\n\nExamples:\n  ${CLI_NAME} init\n  ${CLI_NAME} init ~/code/shop --board designs --name "Checkout"\n`,
    mcp: `Usage: ${CLI_NAME} mcp\n\nServe the board loop as Model Context Protocol tools over stdio, for chat apps and agents that speak MCP instead of running shell commands. Register it as a stdio server whose command is \`${CLI_NAME} mcp\`. Tools: liesel_board_open (open or create a board, returns its URL), liesel_board_status (items and their files), liesel_poll (wait up to timeout_seconds, default 50, for the user's notes; returns waiting when none arrive, so call it again), and liesel_reply (answer, settling the delivered notes; thread and pending as on \`${CLI_NAME} reply\`). It talks to the same local server as the CLI, so \`${CLI_NAME} poll\` and a board's built-in agent runner behave the same alongside it.\n`,
    board: `Usage:\n  ${CLI_NAME} board open <dir> [--name "<board name>"] [--reopen] [--no-open]\n  ${CLI_NAME} board add <dir> <file.html> [--label "<label>"] [--tab <tab>]\n  ${CLI_NAME} board place <dir> <item> [--x <n>] [--y <n>] [--w <n>] [--h <n>] [--tab <tab>] [--label "<label>"] [--status <status>]\n  ${CLI_NAME} board pair <dir> <item> <item> [--unlock]\n  ${CLI_NAME} board status <dir>\n\nA board is a directory holding board.json and one HTML file per item. Every item of the active tab renders as its own sandboxed frame on one pannable, zoomable plane, so versions of the same design can be compared side by side; a locked pair moves together. The reviewer presses Cmd to turn notes on and clicks an element to drop a numbered pin, and the selection lands as a chip in the single composer at the bottom - several notes, then one send. Each note reaches the agent as an ordinary prompt carrying the item {id,label} and the pin {number, selector}, and the pin turns green when the handler replies. Items can declare tune controls in a \`<script type="application/liesel-tune">\` JSON array of {id,label,type:'number'|'color'|'select'|'spring'|'easing'|'pad'|'timeline',css:'--var',min,max,step,unit,value,options,duration}: the tune panel writes those CSS custom properties live and saves versions with thumbnails, and Copy hands the values back to the agent. The reviewer can choose one design per tab as the final: its item's status becomes \`final\` (the others on that tab go back to \`open\`) and a \`Chosen as final: <label> (item <id>, <file>)\` prompt arrives through poll (\`No longer final: ...\` when taken back). board.json holds only positions, labels, status, notes and tune values - never markup. Poll the board with \`${CLI_NAME} poll <dir>\`, which resolves the directory to its board.json.\n\nExamples:\n  ${CLI_NAME} board open hero-directions --name "Hero directions"\n  ${CLI_NAME} board add hero-directions v5.html --label "Hero · E"\n  ${CLI_NAME} board place hero-directions v5 --x 640 --y 0\n  ${CLI_NAME} board pair hero-directions v1 v3\n  ${CLI_NAME} poll hero-directions\n`,
    setup: `Usage: liesel setup hooks\n       liesel setup plugin\n\nhooks: install or repair agent SessionStart hooks for liesel ambient context in Claude Code, Codex, OpenCode, and GitHub Copilot CLI. Restart your agent session afterward to receive the context. This is the primary integration - it carries live session state.\n\nplugin: register the installed liesel package as an Agent Plugin (agent-plugins.org) in VS Code, Cursor, and GitHub Copilot CLI. The installed package directory is itself the plugin root, so nothing is downloaded and no marketplace is involved. Reload each client afterward. Codex users should use \`setup hooks\` instead.\n\nBoth actions are explicit opt-in, idempotent, and repair a stale path after a reinstall.\n`,
    server: `Usage: liesel server [--port ${DEFAULT_PORT}] [--verbose] [--also-listen <host>...]\n\nRun the local Liesel server. Pass --verbose (or set LIESEL_DEBUG=1) to log session and watcher events to stderr. Detached server output is appended to ~/.liesel/server.log, or LIESEL_STATE_DIR/server.log when set, for startup and crash diagnostics.\n\nBy default Liesel binds to 127.0.0.1 and, when Tailscale is running, this machine's Tailscale IPv4. Any explicit LIESEL_HOST overrides automatic Tailscale binding; wildcard values such as 0.0.0.0 or :: are restricted to loopback. An explicit non-wildcard LIESEL_HOST sets the bind address, and the server also listens on 127.0.0.1 so every local CLI finds it; --also-listen adds further concrete addresses (the CLI passes it when it replaces a server, to keep every address the old one served). An address that cannot be bound is retried in the background and reported as network_warning. Binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to anything that can reach it, so only do so on a trusted network. With automatic binding enabled, a successfully bound Tailscale listener uses its MagicDNS name in generated session links; otherwise LIESEL_LINK_HOST can set the link hostname. See README's Allowed hosts section for Host allowlisting and LIESEL_ALLOWED_HOSTS. LIESEL_NO_OPEN=1 (or --no-open) suppresses the local browser launch.\n`,
  };
}

export { createDesignOutput };
