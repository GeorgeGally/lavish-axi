import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, get as httpGet } from "node:http";
import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import chokidar from "chokidar";
import express from "express";

import {
  classifySevereTextOverflow,
  classifyMaterialRectEscape,
  createArtifactSdk,
  deriveAttachmentNoticeState,
  deriveLieselQueueKey,
  findStableLayoutFindings,
  isMaterialPageOverflow,
  isModeToggleHotkeyEvent,
  isNativeInteractiveControl,
  isNearTotalOcclusion,
  isTrustedAttachmentResult,
  attachmentSizeError,
  acceptedImageTypes,
  classifyAttachmentBatch,
  partitionDroppedFiles,
  planClipboardPaste,
  MODE_TOGGLE_HOTKEY_KEY,
} from "./artifact-sdk.js";
import {
  activeLayoutWarningCount,
  resolveDiagnosticViewportClasses,
  serializeLayoutWarnings,
} from "./layout-warnings.js";
import * as artifactRevisions from "./artifact-revisions.js";
import * as mermaidNode from "./mermaid-node.js";
import * as tableCellHelpers from "./table-cell.js";
import { extractMermaidSources, whiteboardSourceHash } from "./mermaid-source.js";
import { createExcalidrawLibraryCache, excalidrawLibrariesDir } from "./whiteboard-library-store.js";
import { parseLibraryIconDirectives } from "./whiteboard-libraries.js";
import {
  isValidDiagramIndex,
  isValidWhiteboardKey,
  loadWhiteboard,
  saveWhiteboard,
  writeWhiteboardFeedbackFiles,
} from "./whiteboard-store.js";
import {
  buildSelfContainedHtml,
  exportFileName,
  exportWarningSummaries,
  splitExportWarnings,
} from "./export-bundle.js";
import { hostRejectedShareWrite, publishedDespiteError, publishToHtmlApp } from "./html-app.js";
import { serializeChat, serializeChatAckIds, serializeChatSync } from "./chat-messages.js";
import { formatServerLogLine, serverStdioIsTimestamped } from "./server-log.js";
import { BOARD_FILE_NAME, PRODUCT_NAME, productEnv, SERVER_APP_ID } from "./brand.js";
import { injectLieselSdk } from "./html-transform.js";
import {
  BoardError,
  addLiveItem,
  boardDirPath,
  boardFilePath,
  duplicateFileName,
  duplicateItem,
  explanationFromHtml,
  extractTuneSpec,
  injectBoardSdk,
  normalizeBoard,
  pairInfo,
  scanBoardFiles,
  placeItem,
  readBoard,
  readOrCreateBoard,
  tuneCssValues,
  tuneInstruction,
  writeBoard,
} from "./board.js";
import { missingHistory, readBoardHistory, writeBoardHistory } from "./board-history.js";
import { createHomeHtml, folderLabels, listFolder } from "./home-page.js";
import { createBoardHtml } from "./board-page.js";
import { THUMB_SCALE, captureCrop, cropBox, cropFrameHtml, findChrome, thumbFrameHtml } from "./board-crop.js";
import { createBoardNotifier, newSubmissionId, resolveNotifyCommand, runNotifyCommand } from "./board-notify.js";
import {
  CUSTOM_AGENT,
  RUNNER_AGENTS,
  RUNNER_DEFAULT_TIMEOUT_MS,
  RUNNER_OUTPUT_KEEP,
  buildRunnerPrompt,
  createRunnerConfigStore,
  detectInstalledAgents,
  findExecutable,
  runAgent,
  runnerAgentLabel,
  validateRunnerConfig,
} from "./board-runner.js";
import {
  ProjectError,
  cloneGithubRepo,
  createDevServer,
  createStaticServer,
  devServerDetectIssue,
  createLiveProxy,
  createProjectConfigStore,
  detectDevServer,
  ensureGitExclude,
  findRunningServers,
  freePort,
  installCommand,
  portAnswers,
  normalizeLivePage,
  parseGithubRepoUrl,
  projectBoardDir,
  projectRootForBoardDir,
  resolveProjectFolder,
  validateDevConfig,
} from "./project.js";
import { crawlDevServer, discoverRoutes, fetchLocal, mergePages } from "./project-pages.js";
import {
  bindHost,
  extraAllowedHosts,
  hostForUrl,
  IPV6_LOOPBACK_HOST,
  isWildcardHost,
  LOOPBACK_HOST,
  resolveConcreteListenHosts,
  resolveLinkHost,
  resolveListenHosts,
  sanitizeListenHosts,
  stateId,
} from "./paths.js";
import { detectTailscale } from "./tailscale.js";
import { artifactTreeRoot, isArtifactPathError, isHtmlPath, resolveAllowedArtifactFile } from "./artifact-path.js";
import { canonicalFile, SessionStore, sessionKey } from "./session-store.js";
import { AsyncMutex } from "./async-mutex.js";
import { generateSharePassword } from "./share-password.js";
import {
  ACCEPTED_IMAGE_MIME,
  isValidAttachmentKey,
  removeAttachment,
  resolveAttachment,
  resolveAttachmentConfig,
  statAttachmentForServe,
  sweepAttachments,
  writeAttachment,
} from "./attachment-store.js";

const chromeClientUrl = new URL("./chrome-client.js", import.meta.url);
const chromeCssUrl = new URL("./chrome.css", import.meta.url);
const boardClientUrl = new URL("./board-client.js", import.meta.url);
const boardSdkUrl = new URL("./board-sdk.js", import.meta.url);
const boardCssUrl = new URL("./board.css", import.meta.url);
const dialkitUrl = new URL(import.meta.resolve("dialkit/vanilla"));
const designAssetUrls = {
  "daisyui.css": {
    packaged: new URL("./design/daisyui.css", import.meta.url),
    source: new URL("../node_modules/daisyui/daisyui.css", import.meta.url),
    type: "text/css",
  },
  "daisyui-themes.css": {
    packaged: new URL("./design/daisyui-themes.css", import.meta.url),
    source: new URL("../node_modules/daisyui/themes.css", import.meta.url),
    type: "text/css",
  },
  "tailwindcss-browser.js": {
    packaged: new URL("./design/tailwindcss-browser.js", import.meta.url),
    source: new URL("../node_modules/@tailwindcss/browser/dist/index.global.js", import.meta.url),
    type: "application/javascript",
  },
};

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const WHITEBOARD_CHANNEL_TOKEN_TTL_MS = 5 * 60_000;
const NETWORK_RECONCILE_CACHE_MS = 1_000;
// Every concrete address gets this retry budget, not just the Tailscale one: an interface that is
// still coming up fails the same way whichever host names it, and the single-pinned-host case has
// no second listener to fall back on.
const BIND_RETRY_DELAYS_MS = [100, 250, 500];
// A requested address that still has not bound after that budget is retried in the background for
// the life of the process (the last delay repeats), so a tailnet address held by a stale daemon or
// absent while Tailscale restarts comes back without anyone restarting Liesel.
const BIND_RECOVERY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const LOOPBACK_OWNER_PROBE_TIMEOUT_MS = 500;
const WEBSOCKET_CLOSE_GRACE_MS = 250;
// A half-open socket (a slept laptop, a dropped tailnet path) never emits `close`, so without an
// application-level ping the server keeps counting a reviewer who is gone - which silently
// suppresses idle shutdown and makes presence wrong. Reaped on the next heartbeat after one
// unanswered ping.
const LIVE_EVENT_HEARTBEAT_MS = 30_000;
const DEFAULT_BROWSER_DISCONNECT_GRACE_MS = 10_000;
// An escaped popup can navigate to an artifact-owned HTML or SVG asset on the
// server origin. Keep every artifact response sandboxed at the response layer
// so active documents stay opaque-origin even when they are top-level.
const ARTIFACT_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";
// Sweep orphaned/expired attachments periodically, not just at startup: a
// detached server can run for days, and an upload whose /prompts follow-up never
// arrived would otherwise linger until the next restart.
const ATTACHMENT_SWEEP_INTERVAL_MS = 60 * 60_000;
// The reasons a caller may name for shutting this server down. Each one drives a different line
// in the chrome's outdated banner, so an unknown value is dropped rather than passed through to
// text the user would read as a fact.
const SHUTDOWN_REASONS = new Set(["upgrade", "local-build", "stop"]);
const AGENT_LISTENER_LABEL = "agent-listener";

// Live-reload coalescing. A normal save is one reload after a short debounce. While a queued
// layout-warning batch is outstanding, the agent is applying several related edits, so widen the
// window: the user asked for one group of fixes and should get one artifact refresh for it.
export const RELOAD_DEBOUNCE_MS = 100;
export const BATCH_RELOAD_DEBOUNCE_MS = 900;

// The whiteboard frame bundle (Excalidraw + Mermaid converter + React) is
// produced by `scripts/build.js` into dist/whiteboard. Packaged runs find it
// next to the served bundle; source runs (node bin/liesel.js) fall back to
// the repo's dist output, so `pnpm run build` must have run at least once.
export function defaultWhiteboardAssetsDir() {
  const packaged = fileURLToPath(new URL("./whiteboard", import.meta.url));
  if (existsSync(packaged)) return packaged;
  return fileURLToPath(new URL("../dist/whiteboard", import.meta.url));
}

// Whiteboard scene saves carry full Excalidraw scenes (and, at queue time, a
// PNG preview data URL), which outgrow the default 2 MB JSON cap. Only the
// whiteboard write routes get the larger limit.
export function isWhiteboardWriteApiPath(pathname) {
  return /^\/api\/[0-9a-f]{16}\/whiteboard\/\d{1,3}(\/feedback-files)?$/.test(String(pathname || ""));
}

// The attachment upload carries raw image bytes, not JSON, so it bypasses both
// JSON body parsers and is read straight from the request stream by the route.
export function isAttachmentUploadApiPath(pathname) {
  return /^\/api\/[0-9a-f]{16}\/attachments$/.test(String(pathname || ""));
}

// Read the raw upload body, buffering at most `maxBytes` but always draining the
// stream to its end. If the body exceeds the cap it resolves `{ tooLarge: true }`
// (bytes discarded) rather than aborting mid-stream, so the caller can send a clean
// 413 the browser reliably receives even while it is still uploading a large file.
export function readAttachmentUploadBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overCap = false;
    let settled = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop buffering but keep consuming so the response is not sent while the
        // request body is still in flight.
        overCap = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(overCap ? { tooLarge: true, buffer: null } : { tooLarge: false, buffer: Buffer.concat(chunks) });
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = () => onError(new Error("attachment upload aborted"));
    // Safety net: if the socket closes before "end" (client aborted mid-upload),
    // reject rather than leaving the route awaiting a promise that never settles.
    const onClose = () => {
      if (!settled) onError(new Error("attachment upload connection closed"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
  });
}

// The signed payload carries the session key, so a token is a capability for
// exactly one session. Without that binding any token - including one minted by
// a request that named no session - authenticated an arbitrary session's
// whiteboard channel. The wire format stays `${issuedAt}.${nonce}.${signature}`;
// the key is signed over, never transmitted in the token.
function whiteboardChannelPayload(issuedAt, nonce, sessionKey) {
  return `${issuedAt}.${nonce}.${sessionKey}`;
}

export function createWhiteboardChannelToken(secret, sessionKey, now = Date.now()) {
  const nonce = crypto.randomBytes(24).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(whiteboardChannelPayload(now, nonce, String(sessionKey || "")))
    .digest("base64url");
  return `${now}.${nonce}.${signature}`;
}

export function isValidWhiteboardChannelToken(token, secret, sessionKey, now = Date.now()) {
  if (!isValidWhiteboardKey(sessionKey)) return false;
  const [issuedAtText, nonce, signature, extra] = String(token || "").split(".");
  if (extra !== undefined || !/^\d{13}$/.test(issuedAtText) || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) return false;
  const issuedAt = Number(issuedAtText);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now || now - issuedAt > WHITEBOARD_CHANNEL_TOKEN_TTL_MS)
    return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(whiteboardChannelPayload(issuedAtText, nonce, String(sessionKey)))
    .digest("base64url");
  const actualBuffer = Buffer.from(signature || "", "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

// A detached server should not live forever. When no browser chrome or agent poll
// are connected for this long, the server shuts itself down so it stops dangling. The next
// `liesel <file>` invocation re-spawns a fresh server and adopts resumable sessions from
// state.json. Browser-ended sessions still require the explicit --reopen opt-in. Set
// LIESEL_IDLE_TIMEOUT_MS to 0/off to disable, or to a custom millisecond budget.
export function resolveIdleTimeoutMs(env = process.env) {
  const raw = env.LIESEL_IDLE_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(value, 2147483647);
}

// How long an active poll waits for a review page to reconnect after the last one drops before it
// returns browser_disconnected. A phone that locks or backgrounds the tab drops its socket, so the
// 10s default can be too short there. Set LIESEL_DISCONNECT_GRACE_MS to a custom millisecond
// budget, or to 0/off so a disconnect never releases the poll (only feedback, an end, or its own
// timeout does). Both resolvers clamp to 2147483647 ms, setTimeout's maximum; a larger delay would
// overflow and fire after about 1 ms.
export function resolveBrowserDisconnectGraceMs(env = process.env) {
  const raw = env.LIESEL_DISCONNECT_GRACE_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_BROWSER_DISCONNECT_GRACE_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BROWSER_DISCONNECT_GRACE_MS;
  return Math.min(value, 2147483647);
}

/**
 * @param {{ [key: string]: any }} [options]
 */
export async function serve({
  env = process.env,
  port,
  stateFile,
  version = "",
  buildId = "",
  debug = false,
  log = null,
  pollHeartbeatMs = 15_000,
  liveEventHeartbeatMs = LIVE_EVENT_HEARTBEAT_MS,
  browserDisconnectGraceMs = resolveBrowserDisconnectGraceMs(env),
  idleTimeoutMs = resolveIdleTimeoutMs(),
  host = bindHost(env),
  hosts,
  linkHost: linkHostName,
  allowedHosts,
  detectTailscale: detectTailscaleFn,
  lookupHost,
  extraListenHosts = [],
  bindRecoveryDelaysMs = BIND_RECOVERY_DELAYS_MS,
  whiteboardAssetsDir = defaultWhiteboardAssetsDir(),
} = {}) {
  // Keep the transport dependency off fast metadata paths such as `--version`.
  const { WebSocket, WebSocketServer } = await import("ws");
  const extraHosts = allowedHosts ?? extraAllowedHosts(env);
  const envHost = productEnv("HOST", env)?.trim();
  const autoTailscale = !envHost;
  const detect = detectTailscaleFn === undefined ? detectTailscale : detectTailscaleFn;
  const tailscale = !hosts?.length && autoTailscale && typeof detect === "function" ? await detect() : null;
  const requestedListenHosts = sanitizeListenHosts(
    hosts?.length
      ? [...hosts, ...extraListenHosts]
      : resolveListenHosts({ host, env, tailscale, extraHosts: extraListenHosts }),
  );
  const lookupOptions = lookupHost ? { lookup: lookupHost } : {};
  const listenHosts = await resolveConcreteListenHosts(requestedListenHosts, {
    ...lookupOptions,
    keepUnresolved: true,
  });
  const activeTailscaleNetwork = tailscaleNetworkKey(tailscale);
  const serverStateId = stateId(stateFile);
  let tailscalePhoneReady = false;
  let tailscaleDetectionWarning = typeof tailscale?.warning === "string" ? tailscale.warning : "";
  // Requested addresses that have not bound yet, with the last error for each. Background recovery
  // keeps retrying them and every surface that reports network health reads them from here, so a
  // failed tailnet bind is never just one log line nobody sees.
  /** @type {Map<string, Error>} */
  const pendingBinds = new Map();
  let resolvedLinkHost = linkHostName ?? resolveLinkHost({ env, tailscale, fallbackHost: host });
  // Declared before anything listens: a live-event client or /shutdown can reach these handlers
  // the moment the first listener binds, while later addresses are still retrying. Declaring them
  // after the bind loop made that window a TDZ ReferenceError that crashed restarted servers.
  let idleTimer = null;
  let attachmentSweepTimer = null;
  let bindRecoveryTimer = null;
  const app = express();
  const store = new SessionStore(stateFile);
  const events = new EventEmitter();
  const watchers = new Map();
  const activePolls = new Map();
  const deliveredFeedback = new Set();
  const pollOwnershipLock = new AsyncMutex();
  // Keyed by session so a version-driven shutdown can reload the one chrome whose artifact is
  // being reopened and leave every other open review page on screen. Current chromes use a
  // WebSocket, while the legacy SSE route remains available during rolling local upgrades.
  const liveEventClients = new Map();
  const browserDisconnectTimers = new Map();
  const browserDisconnectPending = new Set();
  const whiteboardChannelSecret = crypto.randomBytes(32);
  // Sessions with at least one warning the user queued that has not been re-checked yet.
  const outstandingRepairBatches = new Set();
  const diagnosticViewportClasses = resolveDiagnosticViewportClasses();
  const verbose = debug || productEnv("DEBUG", env) === "1";
  // The detached server's stderr is appended to server.log across restarts, where an untimestamped
  // line cannot be dated or correlated with an outage. An injected logger formats its own lines.
  const writeLog =
    typeof log === "function"
      ? log
      : (line) => process.stderr.write(`${serverStdioIsTimestamped() ? line : formatServerLogLine(line)}\n`);
  const logEvent = verbose ? (line) => writeLog(`[liesel] ${line}`) : null;
  if (tailscaleDetectionWarning) writeLog(`[liesel] WARNING: ${tailscaleDetectionWarning}`);
  let publicPort = port;
  let serverReady = false;
  let networkReconcileCheckedAt = 0;
  let cachedNetworkStale = false;
  let shuttingDown = false;
  /** @type {Promise<boolean> | null} */
  let networkReconcilePromise = null;

  function broadcastLiveEvent(type, key, data = {}) {
    for (const [client, clientKey] of liveEventClients) {
      if (clientKey === key) client.sendEvent(type, data);
    }
  }

  // One listener per event scales independently of the number of open review tabs and avoids the
  // EventEmitter listener warning the former one-listener-per-SSE-client design reached at only a
  // few boards.
  events.on("reload", (key) => {
    broadcastLiveEvent("reload", key);
    // Working (docs/delivery-acks.md): a save after a delivery is the agent acting on what it was
    // handed. The store writes nothing when no delivered, unanswered note exists.
    store
      .markWorking(key)
      .then((session) => {
        if (session) events.emit("chat-sync", key, session);
      })
      .catch((error) => writeLog(`[liesel] working stamp after reload failed: ${error?.message || error}`));
  });
  // The transcript the chrome renders is computed here (src/chat-messages.js): agent text ships
  // with its rendered html, user entries ship as text with their anchor, never as html.
  events.on("agent-reply", (key, entry) => broadcastLiveEvent("agent-reply", key, entry));
  events.on("chat-sync", (key, session) => broadcastLiveEvent("chat-sync", key, serializeChatSync(session)));
  events.on("agent-presence", (key, state) =>
    broadcastLiveEvent("agent-presence", key, presenceEventData(key, state, activePolls, deliveredFeedback)),
  );
  events.on("layout-warnings", (key, warnings) => broadcastLiveEvent("layout-warnings", key, { warnings }));
  events.on("ended", (key, endedBy) => broadcastLiveEvent("ended", key, { ended_by: endedBy || null }));

  function hasLiveEventClient(key) {
    for (const clientKey of liveEventClients.values()) {
      if (clientKey === key) return true;
    }
    return false;
  }

  function clearBrowserDisconnectTimer(key) {
    const timer = browserDisconnectTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    browserDisconnectTimers.delete(key);
  }

  function scheduleBrowserDisconnect(key) {
    clearBrowserDisconnectTimer(key);
    if (browserDisconnectGraceMs === null) return;
    if (shuttingDown || hasLiveEventClient(key) || !activePolls.has(key)) return;
    const timer = setTimeout(() => {
      browserDisconnectTimers.delete(key);
      if (!hasLiveEventClient(key) && activePolls.has(key)) {
        browserDisconnectPending.add(key);
        events.emit("browser-disconnected", key);
      }
    }, browserDisconnectGraceMs);
    timer.unref?.();
    browserDisconnectTimers.set(key, timer);
  }

  function attachLiveEventClient(client, key, onClose) {
    clearBrowserDisconnectTimer(key);
    browserDisconnectPending.delete(key);
    liveEventClients.set(client, key);
    refreshIdleTimer();
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      liveEventClients.delete(client);
      scheduleBrowserDisconnect(key);
      refreshIdleTimer();
    };
    onClose(cleanup);
    return cleanup;
  }

  async function sendInitialLiveEventState(client, key, cleanup) {
    const session = await store.findByKey(key);
    if (client.isClosed()) {
      cleanup();
      return;
    }
    client.sendEvent("chat-sync", serializeChatSync(session));
    const presence = computePresence(key, activePolls, deliveredFeedback);
    client.sendEvent("agent-presence", presenceEventData(key, presence, activePolls, deliveredFeedback));
    // A connection that attaches after the live end event still needs the terminal snapshot.
    if (session?.status === "ended") client.sendEvent("ended", { ended_by: session.ended_by || null });
  }

  function networkWarningField() {
    const networkWarning = currentNetworkWarning();
    return networkWarning ? { network_warning: networkWarning } : {};
  }

  function describeBindFailure(listenHost, error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const why =
      code === "EADDRINUSE"
        ? "EADDRINUSE: another process is already listening there"
        : code === "EADDRNOTAVAIL"
          ? "EADDRNOTAVAIL: that address is not on this machine right now"
          : code === "ENOTFOUND" || code === "EAI_AGAIN"
            ? `${code}: that name does not resolve right now`
            : code || (error instanceof Error ? error.message : String(error));
    const address = `${hostForUrl(listenHost)}:${publicPort || port}`;
    const reachable = `Liesel remains available on ${boundHosts.map((bound) => hostForUrl(bound)).join(", ") || "loopback"}`;
    if (listenHost === tailscale?.ipv4) {
      return `Tailscale binding failed for ${address} (${why}); there is no phone access and tailnet review links do not load. ${reachable} and keeps retrying the tailnet address in the background.`;
    }
    const fellBack = boundHosts.length > 0 && boundHosts.every((bound) => bound === LOOPBACK_HOST);
    return `Could not bind ${address} (${why}); ${fellBack ? "Liesel fell back to loopback and is" : "Liesel is"} not reachable at that address. ${reachable} and keeps retrying ${hostForUrl(listenHost)} in the background.`;
  }

  // Everything that reports network health reads this, so the warning appears and clears with the
  // bind state instead of being stamped once at startup.
  function currentNetworkWarning() {
    return [
      tailscaleDetectionWarning,
      ...[...pendingBinds].map(([listenHost, error]) => describeBindFailure(listenHost, error)),
    ]
      .filter(Boolean)
      .join(" ");
  }

  // A requested address that failed to bind is recovered in this process (retried now, and in the
  // background), never by reporting the server stale: a restart cannot free a port another process
  // holds, and it would drop every live review connection for an address that comes back on its own.
  async function reconcileNetwork() {
    await retryPendingBinds();
    if (!(autoTailscale && typeof detect === "function")) return false;
    return reconcileTailscaleNetwork();
  }

  async function reconcileTailscaleNetwork() {
    if (Date.now() - networkReconcileCheckedAt < NETWORK_RECONCILE_CACHE_MS) return cachedNetworkStale;
    if (networkReconcilePromise) return networkReconcilePromise;
    networkReconcilePromise = (async () => {
      try {
        const detectedTailscale = await detect();
        const detectedNetwork = tailscaleNetworkKey(detectedTailscale);
        const stale = detectedNetwork !== activeTailscaleNetwork;
        if (stale) {
          tailscaleDetectionWarning = typeof detectedTailscale?.warning === "string" ? detectedTailscale.warning : "";
        }
        return stale;
      } catch {
        return false;
      }
    })();
    try {
      cachedNetworkStale = await networkReconcilePromise;
      networkReconcileCheckedAt = Date.now();
      return cachedNetworkStale;
    } finally {
      networkReconcilePromise = null;
    }
  }

  function finishFeedbackDelivery(key, result) {
    if (result.status !== "feedback") return;
    markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
    // The take already stamped the batch Seen in state.json (docs/delivery-acks.md); tell the open
    // tabs only now, on the path that is about to write the response, never from the destructive
    // take itself, so a tab is not told Seen for a batch a disconnect is about to put back.
    void publishChatSync(key);
  }

  async function publishChatSync(key) {
    try {
      const session = await store.findByKey(key);
      if (session) events.emit("chat-sync", key, session);
    } catch (error) {
      writeLog(`[liesel] chat-sync after delivery failed: ${error?.message || error}`);
    }
  }

  // What the agent receives. `delivery_seq` is the store's own bookkeeping for undoing a take's Seen
  // stamps on a closed poll; it means nothing to an agent and stays off the wire.
  function agentFacingFeedback(result) {
    if (!result || result.status !== "feedback" || !("delivery_seq" in result)) return result;
    const rest = { ...result };
    delete rest.delivery_seq;
    return rest;
  }

  // `takeFeedback` is destructive: it clears the batch from `state.json` before anything is
  // written to the response. A client that disconnected while that take was in flight would
  // otherwise lose the feedback for good, so put it back verbatim through the store's `restore`
  // mode and leave delivery unmarked - nothing reached an agent. A restore that comes back short
  // is logged, so a batch that could not be put back whole is visible instead of silently gone.
  // A restore that THROWS (the state write failed) is the same loss with no return value to
  // inspect, and the caller is a socket the client already closed, so it is logged and swallowed
  // here rather than escaping into an error path that has no one left to tell.
  // The re-queued batch also has to be announced: another poll can take "waiting" in the window
  // between the destructive take and this restore, and it would then long-poll forever over
  // feedback that is sitting in `state.json`. Emitting wakes it exactly like a fresh `/prompts`.
  async function restoreClosedFeedback(key, result) {
    if (result.status !== "feedback") return;
    const prompts = Array.isArray(result.prompts) ? result.prompts : [];
    let session = null;
    let restoreError = null;
    try {
      session = await store.queuePrompts(
        key,
        {
          dom_snapshot: result.dom_snapshot || "",
          prompts,
          ...(Array.isArray(result.artifact_failures) ? { artifact_failures: result.artifact_failures } : {}),
          // Lets the store take this take's Seen stamps off again (docs/delivery-acks.md).
          ...(Number.isInteger(result.delivery_seq) ? { delivery_seq: result.delivery_seq } : {}),
        },
        {
          restore: true,
          resolveAttachment: (sessionKeyValue, id) => resolveAttachment(attachmentStateRoot, sessionKeyValue, id),
          maxPerPrompt: attachmentConfig.maxPerPrompt,
          maxPromptBytes: attachmentConfig.maxPromptBytes,
        },
      );
    } catch (error) {
      restoreError = error;
    }
    const restoredPrompts =
      prompts.length === 0
        ? []
        : session && !session.rejected && !session.conflict && Array.isArray(session.prompts)
          ? session.prompts.slice(0, prompts.length)
          : null;
    const restoredFailures = session && Array.isArray(session.artifact_failures) ? session.artifact_failures : null;
    const failuresRestored =
      !Array.isArray(result.artifact_failures) ||
      (Array.isArray(restoredFailures) &&
        result.artifact_failures.every((failure) =>
          restoredFailures.some((restoredFailure) => JSON.stringify(restoredFailure) === JSON.stringify(failure)),
        ));
    const persistedNothing = !session || Boolean(session.rejected) || Boolean(session.conflict);
    if (restoreError) {
      writeLog(
        `[liesel] closed poll feedback restore failed; the batch was lost: ${restoreError?.message || restoreError}`,
      );
    } else if (persistedNothing) {
      writeLog("[liesel] closed poll feedback restore was refused; nothing was re-queued and the batch was lost");
    } else if (!restoredPrompts || JSON.stringify(restoredPrompts) !== JSON.stringify(prompts) || !failuresRestored) {
      writeLog("[liesel] closed poll feedback restore was incomplete; delivery was not marked");
    }
    const pendingAfterRestore =
      (Array.isArray(restoredPrompts) && restoredPrompts.length > 0) ||
      (Array.isArray(restoredFailures) && restoredFailures.length > 0);
    if (pendingAfterRestore) events.emit("feedback", key);
    // A tab that saw the batch stamped Seen between the take and this restore learns it is not -
    // a refused restore included, which still takes the stamps off.
    await publishChatSync(key);
  }
  // Whiteboard sidecar files live next to state.json, keyed by session + diagram.
  const whiteboardStateRoot = path.dirname(stateFile);
  const loadExcalidrawLibraries = createExcalidrawLibraryCache();
  const libraryDir = excalidrawLibrariesDir(whiteboardStateRoot);

  // DNS-rebinding guard. isSameOriginRequest (used on /share and the whiteboard
  // write routes) stops classic cross-origin CSRF but NOT DNS rebinding: a page
  // that rebinds its own domain to this loopback port sends that domain in both
  // Origin and Host, so the two still match. The robust defense is a Host-header
  // allowlist - a rebound browser carries the attacker's domain in Host, which is
  // never one of the hostnames this server answers to.
  //
  // Loopback names are always accepted. Binding to a concrete interface
  // (LIESEL_HOST) or naming a link host (LIESEL_LINK_HOST) adds that host,
  // so an operator who intentionally exposes the server on a specific interface
  // keeps rebinding protection while their chosen hostname works. Additional
  // names (a reverse-proxy hostname, extra interfaces) are an explicit opt-in via
  // LIESEL_ALLOWED_HOSTS; a lone "*" there disables the guard for operators
  // who front the server with their own authentication. When a reverse proxy sits
  // in front, X-Forwarded-Host is validated too (see isAllowedRequestHost).
  //
  // This guard is installed as the first middleware so every route - including the
  // attachment upload/fetch/remove endpoints below - is behind the Host allowlist.
  // The mutating-route origin/Referer guard is installed immediately after.
  const allowedHostnames = buildAllowedHostnames({
    host: requestedListenHosts[0],
    hosts: [...requestedListenHosts, ...listenHosts],
    linkHost: resolvedLinkHost,
    allowedHosts: extraHosts,
  });
  const allowAnyHostname = allowsAllHosts(extraHosts);

  function workingUrlFor(req, { includeSessionPath = true } = {}) {
    const origin = `http://${hostForUrl(resolvedLinkHost)}:${publicPort}`;
    if (includeSessionPath && typeof req.path === "string" && req.path.startsWith("/session/")) {
      return `${origin}${req.path}`;
    }
    return `${origin}/`;
  }

  function sendDenied(req, res, { status, error, title, message, workingUrl = undefined }) {
    const resolvedWorkingUrl = workingUrl || workingUrlFor(req);
    if (wantsHtml(req)) {
      res
        .status(status)
        .type("html")
        .send(createDeniedHtml({ title, message, workingUrl: resolvedWorkingUrl }));
      return;
    }
    res.status(status).json({ error });
  }

  function sendSessionNotFound(req, res) {
    sendDenied(req, res, {
      status: 404,
      error: "session not found",
      title: "Session not found",
      message: "This review session does not exist. Return to your agent and open the session URL it printed.",
      workingUrl: workingUrlFor(req, { includeSessionPath: false }),
    });
  }

  // Pre-fix state.json can still name a non-HTML path. Never read that file back to a caller.
  function refuseNonHtmlArtifact(session, res) {
    if (isHtmlPath(session.file)) return false;
    res.status(403).send("Forbidden");
    return true;
  }

  if (!allowAnyHostname) {
    app.use((req, res, next) => {
      const requestHost = { host: req.headers.host, forwardedHost: req.headers["x-forwarded-host"] };
      if (isAllowedRequestHost(requestHost, allowedHostnames)) {
        next();
        return;
      }
      logEvent?.(
        `rejected request with disallowed host host=${req.headers.host ?? ""} x-forwarded-host=${req.headers["x-forwarded-host"] ?? ""} path=${req.path}`,
      );
      sendDenied(req, res, {
        status: 403,
        error: "forbidden host",
        title: "Wrong address",
        message: tailscalePhoneReady
          ? "This Liesel review server does not accept that host. Open the working URL below on this computer or your phone through Tailscale."
          : "This Liesel review server does not accept that host. Open the working URL below on this computer. Phone access is unavailable.",
      });
    });
  }

  // CSRF defense-in-depth on top of the Host allowlist. A foreign page that
  // can reach 127.0.0.1 passes the Host check, but the browser attaches the
  // real Origin, so mutating requests with a present, non-matching Origin or
  // Referer are rejected. Header-less CLI control-channel requests have no
  // Origin and are allowed; the Host allowlist remains their gate. Routes that
  // already call isSameOriginRequest keep those checks - they also reject
  // header-less callers, and this middleware does not replace them.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    if (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
      res.status(403).json({ error: "cross-origin request rejected" });
      return;
    }
    next();
  });

  const attachmentConfig = resolveAttachmentConfig();
  // Attachment bytes are content-addressed on disk alongside the whiteboard sidecars.
  const attachmentStateRoot = path.dirname(stateFile);
  // The store owns the ONE shared lock covering BOTH state consistency AND the
  // attachment lifecycle. It serializes every state.json read-modify-write
  // internally (E1); the server routes its attachment disk sections - upload
  // finalize, delete, the reference-aware sweep - through the same lock via
  // `store.runExclusive`, so a reference can never be acquired in the window between
  // the sweeper's reference snapshot and its delete (D5), and `queuePrompts` cannot
  // interleave with a concurrent poll.

  const defaultJsonParser = express.json({ limit: "2mb" });
  const whiteboardJsonParser = express.json({ limit: "20mb" });
  app.use((req, res, next) => {
    // The attachment upload reads the raw request stream itself (see the route),
    // so no body parser runs for it - express.raw's limit aborts on Content-Length
    // WITHOUT draining the body, which leaves the browser's in-flight upload to be
    // reset mid-stream instead of receiving the 413.
    if (req.method === "POST" && isAttachmentUploadApiPath(req.path)) return next();
    if (isWhiteboardWriteApiPath(req.path)) return whiteboardJsonParser(req, res, next);
    return defaultJsonParser(req, res, next);
  });

  app.get("/", async (_req, res, next) => {
    try {
      const sessions = await store.listSessions();
      const found = [];
      for (const session of sessions) {
        if (path.basename(session.file) !== BOARD_FILE_NAME || session.status === "ended") continue;
        const dir = path.dirname(session.file);
        const board = await readBoard(dir).catch(() => null);
        // A project board is shown by its repository's name and folder, not .liesel.
        const root = projectRootForBoardDir(dir);
        found.push({
          key: session.key,
          dir: root || dir,
          name: board?.name || path.basename(root || dir),
          project: Boolean(root),
          updatedAt: boardUpdatedAt(session, board),
          agentReplies: (await boardChatForReading(dir, session)).filter((entry) => entry?.role === "agent").length,
          preview: board ? await boardPreview(dir, session.key, board) : null,
        });
      }
      found.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
      const labels = folderLabels(found.map((entry) => entry.dir));
      const boards = found.map(({ dir, ...entry }, index) => ({ ...entry, folder: labels[index], folderTitle: dir }));
      res.type("html").send(createHomeHtml(boards));
    } catch (error) {
      next(error);
    }
  });

  app.get("/health", async (req, res) => {
    if (!serverReady) {
      res.status(503).json({ ok: false, app: SERVER_APP_ID, version });
      return;
    }
    const networkStale = req.query.reconcile_network === "1" ? await reconcileNetwork() : false;
    const networkWarning = currentNetworkWarning();
    res.json({
      ok: true,
      app: SERVER_APP_ID,
      version,
      ...(buildId ? { build_id: buildId } : {}),
      state_id: serverStateId,
      state_dir: path.dirname(stateFile),
      // Where this process is listening and every address it was asked to serve (bound or still
      // retrying). The CLI uses both to find one daemon per port whatever host it was configured
      // with, and to tell a same-port daemon at another address apart from this one.
      hosts: [...boundHosts],
      // Configured names sit beside the addresses they resolved to, so a CLI that resolves the same
      // name finds it served whichever form it compares.
      requested_hosts: [...new Set([...listenHosts, ...requestedListenHosts])],
      ...(networkStale ? { network_stale: true } : {}),
      ...(networkWarning ? { network_warning: networkWarning } : {}),
      listeners: [...activePolls].map(([key, holder]) => ({
        key,
        label: listenerLabel(holder),
      })),
    });
  });

  let shutdownResolve;
  const done = new Promise((resolve) => {
    shutdownResolve = resolve;
  });

  app.post("/shutdown", (req, res) => {
    // The caller names the session it is about to reopen, and only that session's chrome is
    // reloaded. A call that names none reloads nothing. It also names why it is shutting this
    // server down, because the banner every other chrome shows has to be true for that reason;
    // an unrecognized or absent reason claims nothing beyond "this server is gone".
    const reloadKey = String(req.body?.reload_key || "");
    const reason = SHUTDOWN_REASONS.has(String(req.body?.reason || "")) ? String(req.body.reason) : "";
    res.json({ status: "shutting-down" });
    // Defer until after the response flushes so the client gets confirmation.
    setImmediate(() => shutdown(reloadKey, reason, "shutdown-request"));
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const file = await resolveAllowedArtifactFile(req.body?.file);
      const key = sessionKey(file);
      const reopen = Boolean(req.body.reopen);
      const existing = await store.findByKey(key);
      const sessionUrl = `http://${hostForUrl(resolvedLinkHost)}:${publicPort}/session/${key}`;
      // A user-initiated end (ending or send-and-ending from the browser) means the human
      // deliberately closed the review surface. Silently reopening it on the next
      // `liesel <file>` is the exact behavior this route exists to prevent - require an
      // explicit `reopen` opt-in instead of reviving it automatically. Agent-initiated ends
      // (`liesel end`) keep reviving on the next open, same as before this change.
      if (existing?.status === "ended" && existing.ended_by === "user" && !reopen) {
        logEvent?.(`session open blocked (user-ended) key=${key} file=${file}`);
        res.json({
          key,
          file,
          url: sessionUrl,
          status: "user-ended",
          ...networkWarningField(),
        });
        return;
      }
      const url = shouldDisableLayoutGateOpen(req.body || {}) ? appendNoGateParam(sessionUrl) : sessionUrl;
      const session = await store.upsertSession(file, sessionUrl);
      if (existing?.status === "ended") {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      }
      logEvent?.(`session opened key=${key} file=${file}`);
      await syncOutstandingRepairs(key);
      await watchSession(session, watchers, events, logEvent, reloadDebounceMs);
      res.json({
        key,
        file,
        url,
        status: "opened",
        ...networkWarningField(),
      });
    } catch (error) {
      if (isArtifactPathError(error)) {
        res.status(error.statusCode).json({
          status: "error",
          code: error.code,
          error: error.message,
        });
        return;
      }
      next(error);
    }
  });

  // A board is a directory of HTML files with positions. It registers as a session
  // under its own board.json, so polling, receipts, presence and the agent reply all
  // work on a board without a second copy of any of that machinery.
  /**
   * A board's transcript lives in its own folder as well as in the session store: a
   * restart, a wiped state directory or another machine must still show what was
   * asked and what was answered.
   */
  async function boardChat(dir, session) {
    const stored = await readBoardHistory(dir).catch(() => []);
    const live = Array.isArray(session.chat) ? session.chat : [];
    const missing = missingHistory(stored, live);
    let chat = live;
    if (missing.length > 0) {
      const adopted = await store.adoptChatHistory(session.key, missing).catch(() => null);
      chat = adopted?.chat || [...live, ...missing];
    }
    await writeBoardHistory(dir, chat).catch(() => {});
    return chat;
  }

  // The chat as the board shows it, without writing anything: the home page only counts it.
  async function boardChatForReading(dir, session) {
    const live = Array.isArray(session.chat) ? session.chat : [];
    const missing = missingHistory(await readBoardHistory(dir).catch(() => []), live);
    return missing.length > 0 ? [...live, ...missing] : live;
  }

  // When a board last changed: its session or the newest build of any design on it.
  function boardUpdatedAt(session, board) {
    let latest = Date.parse(String(session.updated_at || "")) || 0;
    for (const item of board?.items || []) {
      for (const build of item.builds) latest = Math.max(latest, Date.parse(build.at) || 0);
    }
    return latest > 0 ? new Date(latest).toISOString() : "";
  }

  // The design a board's home-page card shows: the top-left design on its first tab. A saved
  // thumbnail of its newest build is used when there is one; otherwise the card frames the
  // file itself, served as it is on disk.
  /** @returns {Promise<{ kind: "image" | "frame", src: string } | null>} */
  async function boardPreview(dir, key, board) {
    const firstTab = board.tabs[0]?.id;
    const ordered = [
      ...board.items.filter((item) => item.tab === firstTab).sort((a, b) => a.y - b.y || a.x - b.x),
      ...board.items.filter((item) => item.tab !== firstTab),
    ];
    for (const item of ordered) {
      const base = `/board/${encodeURIComponent(key)}/item/${encodeURIComponent(item.id)}`;
      // A live page previews as its last saved snapshot, script-free.
      const snapshot = item.page ? item.builds.at(-1) : null;
      if (snapshot) return { kind: "frame", src: `${base}/build/${snapshot.hash}` };
      if (!(await itemFileFor(dir, item))) continue;
      const latest = item.builds.at(-1);
      if (
        latest &&
        (await stat(path.join(dir, BOARD_BUILD_DIR, item.id, `${latest.hash}.png`)).catch(() => null))?.isFile()
      ) {
        return { kind: "image", src: `${base}/thumb/${latest.hash}` };
      }
      return { kind: "frame", src: `${base}/${encodeURIComponent(path.basename(item.file))}` };
    }
    return null;
  }

  async function mirrorBoardChat(session) {
    if (!session || path.basename(String(session.file || "")) !== BOARD_FILE_NAME) return;
    await writeBoardHistory(path.dirname(session.file), session.chat || []).catch(() => {});
  }

  async function boardForRequest(requestKey) {
    const session = await store.findByKey(String(requestKey || ""));
    if (!session || path.basename(session.file) !== BOARD_FILE_NAME) return null;
    const dir = path.dirname(session.file);
    const board = await readBoard(dir);
    return { session, dir, board };
  }

  // Absolute, because a page's <base> (a live snapshot's, or one a design brought to reach
  // its own assets) rewrites every relative URL in it, this tag included.
  function boardItemSdkSrc(req, resolved, item, device) {
    return `${requestOrigin(req)}/board-sdk.js?key=${encodeURIComponent(resolved.session.key)}&item=${encodeURIComponent(item.id)}&device=${device}&v=${encodeURIComponent(version)}`;
  }

  function publicBoard(board, specs = {}, captions = {}) {
    return {
      ...board,
      items: board.items.map((item) => {
        const spec = specs[item.id] || [];
        return {
          ...item,
          tuneSpec: spec,
          tuneInstruction: spec.length > 0 ? tuneInstruction(item, spec) : "",
          caption: captions[item.id]?.explain || "",
          title: captions[item.id]?.title || "",
          changed: captions[item.id]?.changed || "",
          parent: captions[item.id]?.parent || "",
          mtime: captions[item.id]?.mtime || 0,
          hash: captions[item.id]?.hash || "",
          created: captions[item.id]?.created || 0,
          pair: pairInfo(item.file),
        };
      }),
    };
  }

  function boardWriteGuard(req, res) {
    if (isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) return true;
    res.status(403).json({ status: "error", error: "cross-origin board write rejected" });
    return false;
  }

  function boardErrorResponse(error, res) {
    if (!(error instanceof BoardError)) return false;
    res.status(400).json({ status: "error", error: error.message });
    return true;
  }

  async function itemFileFor(dir, item) {
    if (!isHtmlPath(item.file)) return null;
    const file = await resolveArtifactAsset(dir, item.file);
    if (!file) return null;
    const info = await stat(file).catch(() => null);
    return info?.isFile() ? file : null;
  }

  /**
   * Every build of an item's file leaves a snapshot behind, so the board can show one
   * item as a timeline: a dot per change, a labelled tick when the build names itself
   * with `<meta name="liesel-build">`.
   */
  const BOARD_BUILD_DIR = ".liesel-builds";

  async function recordBuilds(dir, board) {
    let changed = false;
    for (const item of board.items) {
      const file = await itemFileFor(dir, item).catch(() => null);
      if (!file) continue;
      const html = await readFile(file, "utf8").catch(() => "");
      const hash = crypto.createHash("sha1").update(html).digest("hex");
      if (item.builds.some((build) => build.hash === hash)) continue;
      const label = /<meta[^>]+name=["']liesel-build["'][^>]*content=(?:"([^"]*)"|'([^']*)')/i.exec(html);
      const folder = path.join(dir, BOARD_BUILD_DIR, item.id);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, `${hash}.html`), html, { flag: "wx" }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      await snapshotStylesheets(file, html, path.join(folder, hash)).catch(() => {});
      item.builds.push({
        at: new Date().toISOString(),
        hash,
        label: String(label?.[1] || label?.[2] || "")
          .trim()
          .slice(0, 40),
      });
      if (item.builds.length > 60) item.builds = item.builds.slice(-60);
      changed = true;
    }
    return changed ? writeBoard(dir, board) : board;
  }

  /**
   * A build only looks as it did if its own stylesheets come with it: each local
   * stylesheet the file links is copied under `<hash>/` beside the snapshot, and the
   * build's asset route serves that copy before the item's live file.
   * @param {string} file
   * @param {string} html
   * @param {string} target
   */
  async function snapshotStylesheets(file, html, target) {
    for (const tag of (String(html).match(/<link\b[^>]*>/gi) || []).slice(0, 40)) {
      if (!/\brel=["']?stylesheet/i.test(tag)) continue;
      const href = /\bhref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const value = String(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").split(/[?#]/)[0];
      if (!value || /^([a-z][a-z0-9+.-]*:|[/\\])/i.test(value)) continue;
      const source = await resolveArtifactAsset(path.dirname(file), value);
      const info = source ? await stat(source).catch(() => null) : null;
      if (!source || !info?.isFile() || info.size > 2 * 1024 * 1024) continue;
      const destination = await resolveArtifactAsset(target, value);
      if (!destination) continue;
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
  }

  async function boardTuneSpecs(dir, board) {
    const meta = await boardItemMeta(dir, board);
    return meta.specs;
  }

  async function boardItemMeta(dir, board) {
    /** @type {Record<string, import("./board.js").TuneControl[]>} */
    const specs = {};
    /** @type {Record<string, { title: string, explain: string, changed: string, parent: string, mtime: number, hash: string, created: number }>} */
    const captions = {};
    for (const item of board.items) {
      const file = await itemFileFor(dir, item).catch(() => null);
      if (!file) continue;
      const html = await readFile(file, "utf8").catch(() => "");
      specs[item.id] = extractTuneSpec(html);
      // The file's modification time is how an open board notices an edit and reloads
      // just that frame.
      const info = await stat(file).catch(() => null);
      captions[item.id] = {
        ...explanationFromHtml(html),
        // The file's own bytes decide whether an open board reloads that frame: an
        // mtime can be preserved by a copy or a checkout, so content is the proof.
        hash: crypto.createHash("sha1").update(html).digest("hex"),
        mtime: info ? Math.round(info.mtimeMs) : 0,
        // When the file first appeared: a pending version's placeholder gives way to a
        // file created after the reply that announced it.
        created: info ? Math.round(info.birthtimeMs || info.ctimeMs) : 0,
      };
    }
    return { specs, captions };
  }

  /**
   * @param {string} dir
   * @param {import("./board.js").Board} board
   * @param {string} itemId
   * @param {(item: import("./board.js").BoardItem, board: import("./board.js").Board) => void} mutate
   */
  // Board writes are read-modify-write on one file, so they serialize through the store's
  // lock: two notes saved from different items at once would otherwise each rewrite
  // board.json from a stale read and drop the other's change.
  /**
   * @param {string} key
   * @param {import("express").Response} res
   * @param {(resolved: { session: any, dir: string, board: import("./board.js").Board }) => Promise<void>} mutate
   */
  async function withBoardWrite(key, res, mutate) {
    await store.runExclusive(async () => {
      // Read the session straight from state: `findByKey` takes this same lock, and
      // acquiring it again inside a critical section would deadlock.
      const state = await store.readState();
      const session = state.sessions[String(key || "")];
      const resolved =
        session && path.basename(session.file) === BOARD_FILE_NAME
          ? { session, dir: path.dirname(session.file), board: await readBoard(path.dirname(session.file)) }
          : null;
      if (!resolved) {
        res.status(404).json({ status: "error", error: "board not found" });
        return;
      }
      try {
        await mutate(resolved);
      } catch (error) {
        if (!boardErrorResponse(error, res)) throw error;
      }
    });
  }

  async function savedBoardItem(dir, board, itemId, mutate) {
    const next = {
      ...board,
      items: board.items.map((item) => ({ ...item, notes: [...item.notes], versions: [...item.versions] })),
    };
    const item = next.items.find((entry) => entry.id === itemId);
    if (!item) throw new BoardError(`Unknown board item: ${itemId}`);
    mutate(item, next);
    const saved = await writeBoard(dir, next);
    return saved.items.find((entry) => entry.id === itemId);
  }

  // Open (or create) the board in a folder and register its session. Shared by the CLI's
  // `board open` and the home page's New board form.
  async function openBoardSession(dirInput, { name = "", reopen = false } = {}) {
    const opened = await readOrCreateBoard(dirInput, { name });
    const dir = await realpath(boardDirPath(dirInput)).catch(() => boardDirPath(dirInput));
    const scanned = await scanBoardFiles(dir, opened);
    // The first build of every item is the start of its timeline, before anyone
    // even looks at the board.
    const board = await recordBuilds(dir, scanned);
    const file = await canonicalFile(boardFilePath(dir));
    const boardKey = sessionKey(file);
    const existing = await store.findByKey(boardKey);
    const boardUrl = `http://${hostForUrl(resolvedLinkHost)}:${publicPort}/board/${boardKey}`;
    if (existing?.status === "ended" && existing.ended_by === "user" && !reopen) {
      logEvent?.(`board open blocked (user-ended) key=${boardKey} dir=${dir}`);
      return { key: boardKey, dir, url: boardUrl, status: "user-ended" };
    }
    const session = await store.upsertSession(file, boardUrl);
    logEvent?.(`board opened key=${session.key} dir=${dir}`);
    const specs = await boardTuneSpecs(dir, board);
    return { key: session.key, dir, url: boardUrl, status: "opened", board: publicBoard(board, specs) };
  }

  app.post("/api/boards", async (req, res, next) => {
    try {
      const dirInput = String(req.body?.dir || "").trim();
      if (!dirInput) {
        res.status(400).json({ status: "error", error: "A board directory is required" });
        return;
      }
      const name = String(req.body?.name || "").trim();
      res.json(await openBoardSession(dirInput, { name, reopen: Boolean(req.body?.reopen) }));
    } catch (error) {
      if (boardErrorResponse(error, res)) return;
      next(error);
    }
  });

  // The home page's New board form. Browser-only: it needs this page's own origin, so
  // neither another site nor a sandboxed design can make folders on disk.
  app.post("/api/board-folders", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const folder = await prepareBoardFolder(req.body?.folder);
      const name = String(req.body?.name || "")
        .trim()
        .slice(0, 120);
      res.json(await openBoardSession(folder, { name, reopen: true }));
    } catch (error) {
      if (boardErrorResponse(error, res)) return;
      next(error);
    }
  });

  // The New board form's folder browser: one folder's subfolder names. Browser-only, like
  // making a folder, so neither another site nor a sandboxed design can list the disk.
  app.post("/api/folder-list", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      res.json(await listFolder(req.body?.path, { nearest: Boolean(req.body?.nearest) }));
    } catch (error) {
      if (boardErrorResponse(error, res)) return;
      next(error);
    }
  });

  // An HTML file dropped onto the board: written into the board folder under a name no
  // existing file has, then picked up the same way a file an agent writes is.
  app.post("/api/boards/:key/files", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const name = path.basename(String(req.body?.name || "").replaceAll("\\", "/")).slice(0, 160);
      if (!/\.html?$/i.test(name) || name.startsWith(".")) {
        throw new BoardError("Only .html files can be added to a board");
      }
      const html = req.body?.html;
      if (typeof html !== "string") throw new BoardError("An added file needs its HTML");
      await withBoardWrite(req.params.key, res, async ({ dir }) => {
        const real = await realpath(dir);
        const extension = path.extname(name);
        const stem = path.basename(name, extension);
        let candidate = name;
        for (let suffix = 2; ; suffix += 1) {
          try {
            await writeFile(path.join(real, candidate), html, { encoding: "utf8", flag: "wx" });
            break;
          } catch (error) {
            if (error?.code !== "EEXIST" || suffix > 500) throw error;
            candidate = `${stem}-${suffix}${extension}`;
          }
        }
        const board = await scanBoardFiles(real, await readBoard(real));
        const item = board.items.find((entry) => entry.file === candidate);
        logEvent?.(`board file added key=${req.params.key} file=${candidate}`);
        res.json({ status: "ok", item });
      });
    } catch (error) {
      if (boardErrorResponse(error, res)) return;
      next(error);
    }
  });

  app.get("/api/boards/:key", async (req, res, next) => {
    try {
      const resolved = await boardForRequest(req.params.key);
      if (!resolved) {
        res.status(404).json({ status: "error", error: "board not found" });
        return;
      }
      const scanned = await scanBoardFiles(resolved.dir, resolved.board);
      const board = await recordBuilds(resolved.dir, scanned);
      const { specs, captions } = await boardItemMeta(resolved.dir, board);
      res.json({
        ...publicBoard(board, specs, captions),
        chat: serializeChat(await boardChat(resolved.dir, resolved.session)),
        ended: resolved.session.status === "ended",
        endedBy: resolved.session.ended_by || null,
        pending_prompts: resolved.session.pending_prompts || 0,
        project: await projectViewFor(req.params.key, resolved.session),
      });
    } catch (error) {
      if (boardErrorResponse(error, res)) return;
      next(error);
    }
  });

  // The board's name, as the reviewer typed it over the old one. Its URL and key stay.
  app.post("/api/boards/:key/name", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const name = String(req.body?.name ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      if (!name) throw new BoardError("Give the board a name");
      await withBoardWrite(req.params.key, res, async ({ dir, board }) => {
        const saved = await writeBoard(dir, { ...board, name });
        logEvent?.(`board renamed key=${req.params.key}`);
        res.json({ status: "ok", name: saved.name });
      });
    } catch (error) {
      if (boardErrorResponse(error, res)) return;
      next(error);
    }
  });

  app.post("/api/boards/:key/place", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const changes = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : [];
      await withBoardWrite(req.params.key, res, async (resolved) => {
        if (changes.length === 0) {
          res.json({ status: "ok" });
          return;
        }
        const next = { ...resolved.board, items: resolved.board.items.map((item) => ({ ...item })) };
        for (const change of changes) {
          if (!change || typeof change !== "object") continue;
          placeItem(next, String(change.id || ""), change);
        }
        const saved = await writeBoard(resolved.dir, next);
        res.json({ status: "ok", board: publicBoard(saved) });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:key/notes", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const itemId = String(req.body?.item || "");
      const notes = Array.isArray(req.body?.notes) ? req.body.notes.slice(0, 300) : [];
      await withBoardWrite(req.params.key, res, async (resolved) => {
        const item = await savedBoardItem(resolved.dir, resolved.board, itemId, (entry) => {
          entry.notes = notes;
        });
        res.json({ status: "ok", notes: item.notes });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:key/tune", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const itemId = String(req.body?.item || "");
      const values = req.body?.values && typeof req.body.values === "object" ? req.body.values : {};
      // A tuned element keeps what it was given: the selector and only the properties
      // that changed, so closing the panel and coming back shows the tuned design.
      const selector = String(req.body?.selector || "").slice(0, 500);
      const element = req.body?.element && typeof req.body.element === "object" ? req.body.element : {};
      await withBoardWrite(req.params.key, res, async (resolved) => {
        const specs = await boardTuneSpecs(resolved.dir, resolved.board);
        const item = await savedBoardItem(resolved.dir, resolved.board, itemId, (entry) => {
          if (selector && req.body?.reset) {
            const rest = { ...entry.elementTune };
            delete rest[selector];
            entry.elementTune = rest;
          } else if (selector) {
            entry.elementTune = {
              ...entry.elementTune,
              [selector]: { ...(entry.elementTune?.[selector] || {}), ...element },
            };
          } else {
            entry.tune = values;
          }
        });
        res.json({
          status: "ok",
          tune: item.tune,
          elementTune: item.elementTune,
          css: tuneCssValues(resolved.board, itemId, specs[itemId] || [], item.tune),
        });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:key/versions", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const itemId = String(req.body?.item || "");
      const label = String(req.body?.label || "").trim();
      await withBoardWrite(req.params.key, res, async (resolved) => {
        const item = await savedBoardItem(resolved.dir, resolved.board, itemId, (entry) => {
          const number = entry.versions.length + 1;
          entry.versions.push({
            id: `v${number}`,
            label: label || `V${number}`,
            values: { ...entry.tune },
            at: new Date().toISOString(),
          });
        });
        res.json({ status: "ok", versions: item.versions });
      });
    } catch (error) {
      next(error);
    }
  });

  // Duplicate one design: its file is copied to a new file in the board folder and the
  // copy becomes its own item beside it, carrying the reviewer's tune values, element
  // tunes and image drops. The original's file and record are never written.
  app.post("/api/boards/:key/duplicate", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const itemId = String(req.body?.item || "");
      await withBoardWrite(req.params.key, res, async ({ dir, board }) => {
        const source = board.items.find((entry) => entry.id === itemId);
        if (!source) throw new BoardError(`Unknown board item: ${itemId}`);
        const sourceFile = await itemFileFor(dir, source);
        if (!sourceFile) throw new BoardError("That design's file is missing");
        const directory = await realpath(dir);
        const name = duplicateFileName(board, source.file, (candidate) => existsSync(path.join(directory, candidate)));
        // The bytes land under a name no scan picks up, and take their real name only
        // once the board already knows the item, so the copy never appears twice.
        const temporary = path.join(directory, `.liesel-copy-${crypto.randomBytes(6).toString("hex")}.tmp`);
        await copyFile(sourceFile, temporary);
        const next = {
          ...board,
          items: board.items.map((entry) => ({ ...entry })),
          pairs: board.pairs.map((pair) => ({ ...pair })),
        };
        let item;
        try {
          item = duplicateItem(next, source.id, name);
          await writeBoard(directory, next);
          if (existsSync(path.join(directory, name))) throw new BoardError(`${name} already exists`);
          await rename(temporary, path.join(directory, name));
        } catch (error) {
          await rm(temporary, { force: true });
          if (item) await writeBoard(directory, board);
          throw error;
        }
        const saved = await recordBuilds(directory, await readBoard(directory));
        const { specs, captions } = await boardItemMeta(directory, saved);
        const published = publicBoard(saved, specs, captions);
        logEvent?.(`board item duplicated key=${req.params.key} from=${source.id} to=${item.id}`);
        res.json({ status: "ok", item: published.items.find((entry) => entry.id === item.id), pairs: published.pairs });
      });
    } catch (error) {
      next(error);
    }
  });

  // Only a duplicate can be deleted from the board. Its file moves into the board's
  // trash folder with its record, so Undo puts back exactly what was there.
  const BOARD_TRASH_DIR = ".liesel-trash";
  /**
   * Moves an item's record (and a duplicate's file) into the board's trash.
   * @param {string} directory the board folder, already through realpath
   * @param {import("./board.js").Board} board
   * @param {import("./board.js").BoardItem} item
   * @returns {Promise<string>} the token Undo restores it by
   */
  async function trashItem(directory, board, item) {
    const token = crypto.randomBytes(8).toString("hex");
    const trash = path.join(directory, BOARD_TRASH_DIR, token);
    await mkdir(trash, { recursive: true });
    const pairs = board.pairs.filter((pair) => pair.a === item.id || pair.b === item.id);
    await writeFile(path.join(trash, "record.json"), `${JSON.stringify({ item, pairs }, null, 2)}\n`);
    const file = item.page ? null : await itemFileFor(directory, item);
    if (file) await rename(file, path.join(trash, path.basename(item.file)));
    return token;
  }
  app.post("/api/boards/:key/delete", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const itemId = String(req.body?.item || "");
      await withBoardWrite(req.params.key, res, async ({ dir, board }) => {
        const item = board.items.find((entry) => entry.id === itemId);
        if (!item) throw new BoardError(`Unknown board item: ${itemId}`);
        if (!item.copyOf && !item.page)
          throw new BoardError("Only a duplicate or a live page can be deleted from the board");
        const directory = await realpath(dir);
        const pairs = board.pairs.filter((pair) => pair.a === item.id || pair.b === item.id);
        const token = await trashItem(directory, board, item);
        const saved = await writeBoard(directory, {
          ...board,
          items: board.items.filter((entry) => entry.id !== item.id),
          pairs: board.pairs.filter((pair) => !pairs.includes(pair)),
        });
        logEvent?.(`board item deleted key=${req.params.key} item=${item.id}`);
        res.json({ status: "ok", token, pairs: saved.pairs });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:key/restore", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const token = String(req.body?.token || "");
      if (!/^[0-9a-f]{16}$/.test(token)) throw new BoardError("Nothing to restore");
      await withBoardWrite(req.params.key, res, async ({ dir, board }) => {
        const directory = await realpath(dir);
        const trash = path.join(directory, BOARD_TRASH_DIR, token);
        const record = JSON.parse(await readFile(path.join(trash, "record.json"), "utf8").catch(() => "null"));
        const restored = normalizeBoard({ tabs: board.tabs, items: [record?.item] }, board.name).items[0];
        if (!restored) throw new BoardError("Nothing to restore");
        const live = Boolean(restored.page);
        if (
          board.items.some(
            (entry) =>
              entry.id === restored.id ||
              (live ? entry.page === restored.page : !entry.page && entry.file === restored.file),
          )
        ) {
          throw new BoardError(`${restored.page || restored.file} is already on the board`);
        }
        const target = live ? "" : path.join(directory, restored.file);
        if (target && existsSync(target)) throw new BoardError(`${restored.file} already exists`);
        const kept = live ? "" : path.join(trash, path.basename(restored.file));
        // The record first, so a scan that sees the file back already knows the item.
        const known = new Set([...board.items.map((entry) => entry.id), restored.id]);
        const pairs = (Array.isArray(record.pairs) ? record.pairs : []).filter(
          (pair) => known.has(String(pair?.a || "")) && known.has(String(pair?.b || "")),
        );
        await writeBoard(directory, { ...board, items: [...board.items, restored], pairs: [...board.pairs, ...pairs] });
        if (kept && existsSync(kept)) await rename(kept, target);
        await rm(trash, { recursive: true, force: true });
        const saved = await recordBuilds(directory, await readBoard(directory));
        const { specs, captions } = await boardItemMeta(directory, saved);
        const published = publicBoard(saved, specs, captions);
        logEvent?.(`board item restored key=${req.params.key} item=${restored.id}`);
        res.json({
          status: "ok",
          item: published.items.find((entry) => entry.id === restored.id),
          pairs: published.pairs,
        });
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/board/:key", async (req, res, next) => {
    try {
      const resolved = await boardForRequest(req.params.key);
      if (!resolved) {
        res.status(404).type("text").send("Board not found");
        return;
      }
      const scanned = await scanBoardFiles(resolved.dir, resolved.board);
      const board = await recordBuilds(resolved.dir, scanned);
      const { specs, captions } = await boardItemMeta(resolved.dir, board);
      // Nothing frames the board itself: it is a top-level page, and framing it would
      // hand an attacker a clickjacking surface over the composer.
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("content-security-policy", "frame-ancestors 'none'");
      // The board page and its two assets carry behaviour, not content, so a cached
      // copy must never survive a server update: that is exactly how an old client
      // can sit behind a fresh page and make the buttons look dead.
      res.setHeader("cache-control", "no-store");
      const chat = await boardChat(resolved.dir, resolved.session);
      res.type("html").send(
        createBoardHtml(resolved.session, board, {
          tuneSpecs: specs,
          captions,
          chat: serializeChat(chat),
          ended: resolved.session.status === "ended",
          endedBy: resolved.session.ended_by || null,
          assetVersion: version,
          // Who answers on this board, for "<name> is replying…" (LIESEL_AGENT_NAME).
          agentName: String(productEnv("AGENT_NAME", env) || "Agent").slice(0, 40),
          project: await projectViewFor(req.params.key, resolved.session),
        }),
      );
    } catch (error) {
      if (boardErrorResponse(error, res)) return;
      next(error);
    }
  });

  app.get(/^\/board\/([^/]+)\/item\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      const resolved = await boardForRequest(req.params[0]);
      const item = resolved?.board.items.find((entry) => entry.id === req.params[1]);
      const file = resolved && item ? await itemFileFor(resolved.dir, item) : null;
      if (!file) {
        res.status(404).type("text").send("Item not found");
        return;
      }
      const device = ["ultrawide", "desktop", "ipad", "phone"].includes(String(req.query.device || ""))
        ? String(req.query.device)
        : "desktop";
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      res.setHeader("cache-control", "no-store");
      res.type("html").send(injectBoardSdk(await readFile(file, "utf8"), boardItemSdkSrc(req, resolved, item, device)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/board/:key/item/:id/build/:hash", async (req, res, next) => {
    try {
      const hash = String(req.params.hash || "");
      if (!/^[0-9a-f]{8,64}$/.test(hash)) {
        res.status(404).type("text").send("Build not found");
        return;
      }
      const resolved = await boardForRequest(req.params.key);
      const item = resolved?.board.items.find((entry) => entry.id === String(req.params.id || ""));
      if (!resolved || !item || !item.builds.some((build) => build.hash === hash)) {
        res.status(404).type("text").send("Build not found");
        return;
      }
      const file = path.join(resolved.dir, BOARD_BUILD_DIR, item.id, `${hash}.html`);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        res.status(404).type("text").send("Build not found");
        return;
      }
      // A saved build is the file as it was, sandboxed like any other page. Shown on the
      // board beside the current version (`?device=`), it carries the item SDK only so it
      // sizes itself and pins its viewport units exactly like the live frame; the board
      // never answers it, so it stays read-only.
      const device = String(req.query.device || "");
      const html = await readFile(file, "utf8");
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      res.setHeader("cache-control", "no-store");
      if (!Object.hasOwn(BOARD_DEVICE_SIZES, device)) {
        res.type("html").send(html);
        return;
      }
      res.type("html").send(injectBoardSdk(html, boardItemSdkSrc(req, resolved, item, device)));
    } catch (error) {
      next(error);
    }
  });

  // A version's thumbnail, once the board has asked for it to be taken.
  app.get("/board/:key/item/:id/thumb/:hash", async (req, res, next) => {
    try {
      const hash = String(req.params.hash || "");
      const resolved = /^[0-9a-f]{8,64}$/.test(hash) ? await boardForRequest(req.params.key) : null;
      const item = resolved?.board.items.find((entry) => entry.id === String(req.params.id || ""));
      if (!resolved || !item || !item.builds.some((build) => build.hash === hash)) {
        res.status(404).type("text").send("Thumbnail not found");
        return;
      }
      const file = path.join(resolved.dir, BOARD_BUILD_DIR, item.id, `${hash}.png`);
      if (!(await stat(file).catch(() => null))?.isFile()) {
        res.status(404).type("text").send("Thumbnail not found");
        return;
      }
      res.setHeader("cache-control", "no-cache");
      res.type("png").send(await readFile(file));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/board\/([^/]+)\/item\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      const resolved = await boardForRequest(req.params[0]);
      const item = resolved?.board.items.find((entry) => entry.id === req.params[1]);
      const file = resolved && item ? await itemFileFor(resolved.dir, item) : null;
      if (!file) {
        res.status(404).type("text").send("Item not found");
        return;
      }
      // A saved build is served from under `build/<hash>/`: its own stylesheets come from
      // the copies kept with it, and any other file it links from the item, as the live
      // page's do.
      const saved = /^build\/([0-9a-f]{8,64})\/(.+)$/.exec(req.params[2]);
      if (saved) {
        const copy = await resolveArtifactAsset(path.join(resolved.dir, BOARD_BUILD_DIR, item.id, saved[1]), saved[2]);
        if (copy && (await stat(copy).catch(() => null))?.isFile()) {
          res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
          res.sendFile(copy, { dotfiles: "allow" });
          return;
        }
      }
      const asset = await resolveArtifactAsset(
        path.dirname(file),
        req.params[2].replace(/^build\/[0-9a-f]{8,64}\//, ""),
      );
      if (!asset) {
        res.status(403).send("Forbidden");
        return;
      }
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      res.sendFile(asset, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  // Device sizes the board previews at; a pin's picture is taken at the same width.
  const BOARD_DEVICE_SIZES = {
    ultrawide: { width: 3440, height: 1440 },
    desktop: { width: 1440, height: 900 },
    ipad: { width: 834, height: 1194 },
    phone: { width: 390, height: 844 },
  };
  const boardDeviceOf = (value) => (Object.hasOwn(BOARD_DEVICE_SIZES, String(value || "")) ? String(value) : "desktop");

  // The page headless Chrome photographs for a pin's picture: the item, shifted so the
  // pinned spot fills the window. It frames only an item of this board, sandboxed.
  // An image dropped from the desktop replaces the one under the pointer: the bytes
  // are copied into the board folder so the swap survives a reload, and the item
  // records which selector now points at which file.
  app.post("/api/boards/:key/image-drop", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const itemId = String(req.body?.item || "");
      const selector = String(req.body?.selector || "").slice(0, 1000);
      if (!selector) throw new BoardError("An image drop needs a selector");
      const undo = Boolean(req.body?.undo);
      await withBoardWrite(req.params.key, res, async ({ dir, board }) => {
        const known = board.items.find((entry) => entry.id === itemId);
        if (!known) throw new BoardError(`Unknown board item: ${itemId}`);
        let drop = null;
        if (!undo) {
          const kind = req.body?.kind === "background" ? "background" : req.body?.kind === "img" ? "img" : "";
          if (!kind) throw new BoardError("An image drop needs an image");
          const attachment = await resolveAttachment(
            attachmentStateRoot,
            req.params.key,
            String(req.body?.attachment || ""),
          );
          if (!attachment) throw new BoardError("That image is no longer available");
          const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[attachment.mime];
          if (!extension) throw new BoardError("Only PNG, JPEG and WebP images can replace one");
          const bytes = await readFile(attachment.path);
          const directory = path.join(await realpath(dir), "assets", "drops");
          await mkdir(directory, { recursive: true });
          const canonical = await realpath(directory);
          if (!canonical.startsWith(`${await realpath(dir)}${path.sep}`)) {
            throw new BoardError("The board's image folder is outside it");
          }
          const name = `${crypto.createHash("sha256").update(bytes).digest("hex")}.${extension}`;
          await writeFile(path.join(canonical, name), bytes, { flag: "wx" }).catch((error) => {
            if (error?.code !== "EEXIST") throw error;
          });
          drop = {
            selector,
            kind,
            oldSource: String(req.body?.oldSource || "").slice(0, 2000),
            file: `assets/drops/${name}`,
          };
        }
        const item = await savedBoardItem(dir, board, itemId, (entry) => {
          entry.imageDrops = (entry.imageDrops || []).filter((entry) => entry.selector !== selector);
          if (drop) entry.imageDrops.push(drop);
        });
        res.json({ status: "ok", drop, imageDrops: item.imageDrops });
      });
    } catch (error) {
      if (boardErrorResponse(error, res)) return;
      next(error);
    }
  });

  // The frame loads a dropped image by the board's own key, not by a path: the file
  // lives in the board folder and nothing outside it can be named.
  app.get("/board/:key/drop/:file", async (req, res, next) => {
    try {
      const file = String(req.params.file || "");
      if (!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(file)) {
        res.status(404).type("text").send("Image not found");
        return;
      }
      const resolved = await boardForRequest(req.params.key);
      if (!resolved) {
        res.status(404).type("text").send("Board not found");
        return;
      }
      const directory = await realpath(path.join(resolved.dir, "assets", "drops")).catch(() => null);
      const target = directory ? await realpath(path.join(directory, file)).catch(() => null) : null;
      if (!directory || !target || !target.startsWith(`${directory}${path.sep}`)) {
        res.status(404).type("text").send("Image not found");
        return;
      }
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) {
        res.status(404).type("text").send("Image not found");
        return;
      }
      res.setHeader("cache-control", "private, max-age=300");
      res.sendFile(target);
    } catch (error) {
      next(error);
    }
  });

  app.get("/board/:key/crop-frame", async (req, res, next) => {
    try {
      const resolved = await boardForRequest(req.params.key);
      const item = resolved?.board.items.find((entry) => entry.id === String(req.query.item || ""));
      if (!resolved || !item) {
        res.status(404).type("text").send("Item not found");
        return;
      }
      const device = boardDeviceOf(req.query.device);
      const size = BOARD_DEVICE_SIZES[device];
      const box = {
        x: Math.max(0, Math.trunc(Number(req.query.x)) || 0),
        y: Math.max(0, Math.trunc(Number(req.query.y)) || 0),
        width: Math.max(1, Math.trunc(Number(req.query.w)) || 1),
        height: Math.max(1, Math.trunc(Number(req.query.h)) || 1),
      };
      // A live page is photographed on the project's proxy, at the path the note was on.
      const project = item.page ? await projectFor(resolved.session.key, resolved.session).catch(() => null) : null;
      const page = normalizeLivePage(req.query.page) || item.page || "";
      const src = project
        ? `${project.origin}${page}`
        : `/board/${encodeURIComponent(resolved.session.key)}/item/${encodeURIComponent(item.id)}/index.html?device=${device}`;
      const live = project ? `liesel:${item.id}:${device}` : "";
      res.setHeader("cache-control", "no-store");
      res.type("html").send(cropFrameHtml({ src, deviceWidth: size.width, deviceHeight: size.height, box, live }));
    } catch (error) {
      next(error);
    }
  });

  // Pictures are taken one at a time: each is a short-lived headless Chrome.
  let cropQueue = Promise.resolve();
  app.post("/api/boards/:key/crop", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const resolved = await boardForRequest(req.params.key);
      const item = resolved?.board.items.find((entry) => entry.id === String(req.body?.item || ""));
      if (!resolved || !item) {
        res.status(404).json({ status: "error", error: "item not found" });
        return;
      }
      const device = boardDeviceOf(req.body?.device);
      const size = BOARD_DEVICE_SIZES[device];
      const box = cropBox(req.body?.box, size.width);
      if (!box) {
        res.status(400).json({ status: "error", error: "a crop needs the pinned element's box" });
        return;
      }
      const chrome = findChrome();
      if (!chrome) {
        res.json({ status: "unavailable" });
        return;
      }
      const query = new URLSearchParams({
        item: item.id,
        device,
        x: String(box.x),
        y: String(box.y),
        w: String(box.width),
        h: String(box.height),
        ...(item.page ? { page: normalizeLivePage(req.body?.page) || item.page } : {}),
      });
      const url = `http://127.0.0.1:${req.socket.localPort}/board/${encodeURIComponent(resolved.session.key)}/crop-frame?${query}`;
      const capture = cropQueue.then(() => captureCrop({ chrome, url, width: box.width, height: box.height }));
      cropQueue = capture.then(
        () => {},
        () => {},
      );
      const png = await capture;
      if (!png) {
        res.json({ status: "failed" });
        return;
      }
      const attachment = await store.runExclusive(async () => {
        const referenced = await store.referencedAttachmentIds();
        return writeAttachment(attachmentStateRoot, resolved.session.key, png, {
          maxBytes: attachmentConfig.maxBytes,
          maxDiskBytes: attachmentConfig.maxDiskBytes,
          maxObjects: attachmentConfig.maxObjects,
          ttlMs: attachmentConfig.ttlMs,
          referenced,
          evictionGraceMs: attachmentConfig.evictionGraceMs,
        });
      });
      res.json({ status: "stored", attachment });
    } catch (error) {
      next(error);
    }
  });

  // The page Chrome photographs for a version's thumbnail: one desktop screen of the
  // saved build, scaled down.
  app.get("/board/:key/thumb-frame", async (req, res, next) => {
    try {
      const hash = String(req.query.hash || "");
      const resolved = await boardForRequest(req.params.key);
      const item = resolved?.board.items.find((entry) => entry.id === String(req.query.item || ""));
      if (!resolved || !item || !item.builds.some((build) => build.hash === hash)) {
        res.status(404).type("text").send("Build not found");
        return;
      }
      const size = BOARD_DEVICE_SIZES.desktop;
      const src = `/board/${encodeURIComponent(resolved.session.key)}/item/${encodeURIComponent(item.id)}/build/${hash}/`;
      res.setHeader("cache-control", "no-store");
      res.type("html").send(thumbFrameHtml({ src, deviceWidth: size.width, deviceHeight: size.height }));
    } catch (error) {
      next(error);
    }
  });

  // Thumbnails are taken when the board asks: when it sees a file change and when its
  // history opens. Each one goes through the same one-at-a-time Chrome queue as a pin's
  // picture, and a version Chrome could not photograph is not tried again this run.
  /** @type {Set<string>} */
  const thumbFailures = new Set();
  app.post("/api/boards/:key/thumbs", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const resolved = await boardForRequest(req.params.key);
      const item = resolved?.board.items.find((entry) => entry.id === String(req.body?.item || ""));
      if (!resolved || !item) {
        res.status(404).json({ status: "error", error: "item not found" });
        return;
      }
      const folder = path.join(resolved.dir, BOARD_BUILD_DIR, item.id);
      const has = async (hash) => Boolean((await stat(path.join(folder, `${hash}.png`)).catch(() => null))?.isFile());
      const chrome = findChrome(env);
      /** @type {string[]} */
      const thumbs = [];
      const only = String(req.body?.hash || "");
      for (const build of item.builds) {
        if (only && build.hash !== only) continue;
        if (await has(build.hash)) {
          thumbs.push(build.hash);
          continue;
        }
        const failure = `${resolved.dir}\u0000${item.id}\u0000${build.hash}`;
        if (!chrome || thumbFailures.has(failure)) continue;
        if (!(await stat(path.join(folder, `${build.hash}.html`)).catch(() => null))?.isFile()) continue;
        const query = new URLSearchParams({ item: item.id, hash: build.hash });
        const url = `http://127.0.0.1:${req.socket.localPort}/board/${encodeURIComponent(resolved.session.key)}/thumb-frame?${query}`;
        const size = BOARD_DEVICE_SIZES.desktop;
        const capture = cropQueue.then(() =>
          captureCrop({
            chrome,
            url,
            width: Math.round(size.width * THUMB_SCALE),
            height: Math.round(size.height * THUMB_SCALE),
          }),
        );
        cropQueue = capture.then(
          () => {},
          () => {},
        );
        const png = await capture.catch(() => null);
        if (!png) {
          thumbFailures.add(failure);
          continue;
        }
        await writeFile(path.join(folder, `${build.hash}.png`), png, { flag: "wx" }).catch((error) => {
          if (error?.code !== "EEXIST") throw error;
        });
        thumbs.push(build.hash);
      }
      res.json({ status: chrome ? "ok" : "unavailable", thumbs });
    } catch (error) {
      next(error);
    }
  });

  async function publishAgentReply(key, text, { requireOpen = false } = {}) {
    const session = await store.addAgentReply(key, text, { requireOpen });
    if (!session || (requireOpen && session.status === "ended")) return session;
    const lastEntry = session.chat?.at(-1);
    const entry = serializeChat([
      lastEntry?.role === "agent" ? lastEntry : { role: "agent", text, at: session.updated_at },
    ])[0];
    mirrorBoardChat(session);
    events.emit("agent-reply", key, entry);
    events.emit("chat-sync", key, session);
    // The reply concludes the delivered-feedback "working" state. Human sends remain available
    // while working because the server queues them for the next poll.
    clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
    return session;
  }

  const handlePoll = async (req, res, next) => {
    const takeover = req.query.takeover === "1";
    const agentReply =
      req.method === "POST" && req.body?.agent_reply !== undefined ? String(req.body.agent_reply) : null;
    if (takeover && req.method !== "POST") {
      res.status(405).json({ error: "poll takeover requires POST" });
      return;
    }
    if (req.method === "POST" && (agentReply === null ? !takeover : !agentReply.trim())) {
      res.status(405).json({ error: "POST /api/poll requires agent_reply or takeover=1" });
      return;
    }
    // `close` is subscribed before the first `await` and re-checked after the listeners are armed,
    // because a client that disconnects while `takeFeedback` is in flight would otherwise arrive
    // too late for its own cleanup: the handler marks the poll active afterwards and nothing left
    // would clear it, leaving presence stuck on "listening" for an agent that is already gone.
    let requestClosed = Boolean(req.aborted || (req.method !== "POST" && req.destroyed));
    let cleanupPoll = null;
    let claimedHolder = null;
    const onRequestClose = () => {
      // A POST request emits `close` when its JSON body stream ends, before the long-poll
      // response has been written. `aborted` distinguishes that normal parser lifecycle from a
      // client that actually went away.
      if (req.method === "POST" && !req.aborted) return;
      requestClosed = true;
      cleanupPoll?.();
    };
    const onResponseClose = () => {
      // Once the body has been parsed, a POST request's close event is no longer useful: the
      // response socket is the authoritative signal for a client that aborts its long-poll.
      if (req.method === "POST" && !res.writableEnded) {
        requestClosed = true;
        cleanupPoll?.();
      }
    };
    res.on("close", onResponseClose);
    const detachRequestClose = () => req.off("close", onRequestClose);
    req.on("close", onRequestClose);
    try {
      const file = await canonicalFile(String(req.query.file || ""));
      const key = sessionKey(file);
      const ownerValue = typeof req.query.owner === "string" ? req.query.owner.trim() : "";
      if (ownerValue.toLowerCase() === "none" || ownerValue.startsWith("-")) {
        detachRequestClose();
        res.status(400).json({
          status: "error",
          code: "VALIDATION_ERROR",
          error: "--owner none is reserved; pass a different listener label",
        });
        return;
      }
      const owner = ownerValue || null;
      if (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        detachRequestClose();
        res.status(403).json({ error: "cross-origin poll takeover rejected" });
        return;
      }
      const { holder, previousPresence, conflict, missing } = await pollOwnershipLock.runExclusive(async () => {
        const currentHolder = activePolls.get(key);
        if (currentHolder && !takeover) return { conflict: listenerConflict(currentHolder, "LISTENER_ACTIVE") };
        const nextHolder = { key, owner, startedAt: Date.now(), replaced: false, replace: null };
        claimedHolder = nextHolder;
        const priorPresence = presenceSignature(key, activePolls, deliveredFeedback);
        if (currentHolder) {
          // Install the successor before releasing the old response so its cleanup cannot emit a
          // transient "waiting" state or clear the successor's listener ownership.
          currentHolder.replaced = true;
          activePolls.set(key, nextHolder);
          currentHolder.replace?.();
        } else {
          activePolls.set(key, nextHolder);
        }
        // Attaching a fresh round retires the prior delivery marker; releasing a poll never does.
        deliveredFeedback.delete(key);
        if (agentReply !== null) {
          const session = await publishAgentReply(key, agentReply);
          if (!session) {
            activePolls.delete(key);
            return { missing: true };
          }
        }
        return { holder: nextHolder, previousPresence: priorPresence };
      });
      if (conflict) {
        detachRequestClose();
        res.status(409).json(conflict);
        return;
      }
      if (missing) {
        detachRequestClose();
        res.status(404).json({ error: "session not found" });
        return;
      }
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));
      const immediate = await store.takeFeedback(key);
      if (immediate.status !== "waiting") {
        if (holder.replaced) {
          await restoreClosedFeedback(key, immediate);
          detachRequestClose();
          res.json(listenerConflict(holder, "LISTENER_REPLACED"));
          releasePollListener(holder, activePolls, deliveredFeedback, events);
          return;
        }
        if (requestClosed || res.writableEnded) {
          await restoreClosedFeedback(key, immediate);
          releasePollListener(holder, activePolls, deliveredFeedback, events);
          detachRequestClose();
          return;
        }
        finishFeedbackDelivery(key, immediate);
        releasePollListener(holder, activePolls, deliveredFeedback, events);
        if (immediate.session_ended) clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
        detachRequestClose();
        res.json(agentFacingFeedback(immediate));
        return;
      }
      if (holder.replaced) {
        detachRequestClose();
        res.json(listenerConflict(holder, "LISTENER_REPLACED"));
        releasePollListener(holder, activePolls, deliveredFeedback, events);
        return;
      }
      if (requestClosed || res.writableEnded) {
        releasePollListener(holder, activePolls, deliveredFeedback, events);
        detachRequestClose();
        return;
      }
      const streamHeartbeat = timeoutMs === null;
      let heartbeat = null;
      if (streamHeartbeat) {
        res.status(200).type("application/json").set("Liesel-Poll-State", "listening");
        res.write(" ");
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(" ");
        }, pollHeartbeatMs);
        heartbeat.unref?.();
      }
      refreshIdleTimer();
      let timer = null;
      let cleaned = false;
      let responding = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        events.off("feedback", onFeedback);
        events.off("ended", onFeedback);
        events.off("browser-disconnected", onBrowserDisconnected);
        releasePollListener(holder, activePolls, deliveredFeedback, events);
        if (!activePolls.has(key)) {
          clearBrowserDisconnectTimer(key);
          browserDisconnectPending.delete(key);
        }
        refreshIdleTimer();
        cleanupPoll = null;
        detachRequestClose();
        res.off("close", onResponseClose);
      };
      const respondReplacement = () => {
        if (responding || res.writableEnded) return;
        responding = true;
        try {
          const replacement = listenerConflict(holder, "LISTENER_REPLACED");
          if (streamHeartbeat) res.end(JSON.stringify(replacement));
          else res.json(replacement);
        } finally {
          cleanup();
        }
      };
      holder.replace = respondReplacement;
      const respond = async (forcedResult = null) => {
        if (responding || res.writableEnded) return;
        responding = true;
        let finalSessionEnded = false;
        try {
          const result = await store.takeFeedback(key);
          // Feedback or an explicit end that raced the grace timer wins. The disconnect result
          // is only the non-terminal replacement for a poll that would otherwise keep waiting.
          const responseResult = forcedResult && result.status === "waiting" ? forcedResult : result;
          finalSessionEnded = responseResult?.session_ended === true;
          if (holder.replaced) {
            if (responseResult.status !== "waiting") await restoreClosedFeedback(key, responseResult);
            if (!requestClosed && !res.writableEnded) {
              if (streamHeartbeat) res.end(JSON.stringify(listenerConflict(holder, "LISTENER_REPLACED")));
              else res.json(listenerConflict(holder, "LISTENER_REPLACED"));
            }
            return;
          }
          if (requestClosed || res.writableEnded) {
            await restoreClosedFeedback(key, responseResult);
            return;
          }
          finishFeedbackDelivery(key, responseResult);
          const agentResponse = agentFacingFeedback(responseResult);
          if (streamHeartbeat) {
            res.end(JSON.stringify(agentResponse));
          } else {
            res.json(agentResponse);
          }
        } finally {
          cleanup();
          if (finalSessionEnded) clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
        }
      };
      function handleRespondError(error) {
        if (streamHeartbeat) {
          cleanup();
          if (!res.writableEnded) res.destroy(error);
          return;
        }
        next(error);
      }
      const onFeedback = (changedKey) => {
        if (changedKey !== key || res.writableEnded) {
          return;
        }
        respond().catch(handleRespondError);
      };
      const onBrowserDisconnected = (changedKey) => {
        if (changedKey !== key || res.writableEnded) return;
        respond({ status: "browser_disconnected" }).catch(handleRespondError);
      };
      events.on("feedback", onFeedback);
      events.on("ended", onFeedback);
      events.on("browser-disconnected", onBrowserDisconnected);
      cleanupPoll = cleanup;
      if (holder.replaced) {
        respondReplacement();
        return;
      }
      if (requestClosed || res.writableEnded) {
        cleanup();
        return;
      }
      // A browser can disappear while the initial take is in flight. The disconnect timer may
      // have fired before this request installed its event listeners, so reconcile that state now.
      if (browserDisconnectPending.has(key)) {
        browserDisconnectPending.delete(key);
        onBrowserDisconnected(key);
        return;
      }
      const nextPresence = presenceSignature(key, activePolls, deliveredFeedback);
      if (nextPresence !== previousPresence) {
        events.emit("agent-presence", key, computePresence(key, activePolls, deliveredFeedback));
      }
      timer = timeoutMs === null ? null : setTimeout(() => respond().catch(handleRespondError), timeoutMs);
    } catch (error) {
      cleanupPoll?.();
      if (claimedHolder) releasePollListener(claimedHolder, activePolls, deliveredFeedback, events);
      detachRequestClose();
      next(error);
    }
  };
  app.get("/api/poll", handlePoll);
  app.post("/api/poll", handlePoll);

  // The one route that puts words in the reviewer's mouth: whatever lands here
  // reaches the agent as the user's own instructions. The session key is derived
  // from the artifact path, not a secret, so knowing it must not be enough -
  // only this server's own chrome may queue prompts.
  // A board submission (a note sent from the composer, a pin, tune Send, an image drop,
  // Accept / Keep today, an end) runs the operator's notify command (LIESEL_NOTIFY_CMD, else
  // `notify_cmd` in the state directory's config.json) after the batch is queued, without
  // waiting on it, at most once per board per debounce window (see createBoardNotifier).
  const boardNotifier = createBoardNotifier({
    run: (key) => {
      runBoardNotify(key).catch((error) =>
        writeLog(`[liesel] board notify skipped key=${key}: ${error?.message || error}`),
      );
    },
  });
  async function runBoardNotify(key) {
    const command = await resolveNotifyCommand({
      envCommand: productEnv("NOTIFY_CMD", env),
      stateRoot: attachmentStateRoot,
    });
    if (!command) return;
    const resolved = await boardForRequest(key);
    if (!resolved) return;
    const submissionId = newSubmissionId();
    const noteCount = Number(resolved.session.pending_prompts) || 0;
    writeLog(`[liesel] board notify key=${key} submission=${submissionId} notes=${noteCount}`);
    runNotifyCommand({
      command,
      boardDir: resolved.dir,
      boardId: key,
      noteCount,
      board: resolved.board.name || path.basename(resolved.dir),
      boardJson: resolved.session.file,
      submissionId,
      log: (line) => writeLog(`[liesel] ${line}`),
    });
  }
  function notifyBoardSubmission(key, session) {
    if (path.basename(String(session?.file || "")) !== BOARD_FILE_NAME) return;
    resolveNotifyCommand({ envCommand: productEnv("NOTIFY_CMD", env), stateRoot: attachmentStateRoot })
      .then((command) => {
        if (command) boardNotifier.notify(key);
      })
      .catch(() => {});
  }

  // The built-in agent runner (src/board-runner.js). A board whose user picked an agent on
  // this machine gets its notes handled by that agent, launched headless by this server:
  // take the batch like a poll, run the agent in the chosen folder, post its last message as
  // the reply. One run per board; notes sent during a run wait for the next one. A poll that
  // is already listening on the board keeps the notes: an agent driving its own loop wins.
  const runnerConfigs = createRunnerConfigStore(attachmentStateRoot);
  /**
   * @typedef {{
   *   id: number, status: "running" | "finished" | "failed", agent: string, label: string,
   *   cwd: string, notes: number, started_at: string, ended_at: string, output: string,
   *   reply: string, error: string, queued: boolean, stop: null | (() => void),
   * }} BoardRun
   */
  /** @type {Map<string, BoardRun>} */
  const boardRuns = new Map();
  /** Boards whose trigger is between its check and its take, so a second trigger waits its turn. */
  const boardRunStarting = new Set();
  let boardRunSeq = 0;
  const runnerTimeoutMs = (() => {
    const value = Number(productEnv("RUNNER_TIMEOUT_MS", env));
    return Number.isFinite(value) && value >= 1000 ? Math.min(value, 2147483647) : RUNNER_DEFAULT_TIMEOUT_MS;
  })();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const runnerBroadcastTimers = new Map();

  function activeRunCount() {
    let count = 0;
    for (const run of boardRuns.values()) if (run.status === "running") count += 1;
    return count;
  }

  /** @param {BoardRun | undefined} run */
  function publicRun(run) {
    if (!run) return null;
    return {
      id: run.id,
      status: run.status,
      agent: run.agent,
      label: run.label,
      cwd: run.cwd,
      notes: run.notes,
      started_at: run.started_at,
      ended_at: run.ended_at,
      output: run.output,
      reply: run.reply,
      error: run.error,
      queued: run.queued,
    };
  }

  // Output streams in fast; the board hears about it at most every 250ms, and at once on a
  // status change.
  function broadcastRun(key, { now = false } = {}) {
    const send = () => {
      runnerBroadcastTimers.delete(key);
      // Snapshot the run before reading the queue, as runnerView does.
      const run = publicRun(boardRuns.get(key));
      store
        .findByKey(key)
        .catch(() => null)
        .then((session) =>
          broadcastLiveEvent("runner", key, {
            run,
            ...(session ? { pending_prompts: Number(session.pending_prompts) || 0 } : {}),
          }),
        );
    };
    if (now) {
      clearTimeout(runnerBroadcastTimers.get(key));
      send();
      return;
    }
    if (runnerBroadcastTimers.has(key)) return;
    const timer = setTimeout(send, 250);
    timer.unref?.();
    runnerBroadcastTimers.set(key, timer);
  }

  async function runnerExecutable(config) {
    if (config.agent === "custom") return "";
    const agent = RUNNER_AGENTS.find((entry) => entry.id === config.agent);
    return agent ? findExecutable(agent.bin, { env }) : "";
  }

  /** @param {string} key */
  function triggerBoardRunner(key) {
    if (shuttingDown) return;
    const current = boardRuns.get(key);
    if (current?.status === "running") {
      current.queued = true;
      broadcastRun(key);
      return;
    }
    if (boardRunStarting.has(key)) return;
    boardRunStarting.add(key);
    startBoardRun(key)
      .catch((error) => writeLog(`[liesel] runner failed key=${key}: ${error?.message || error}`))
      .finally(() => boardRunStarting.delete(key));
  }

  /** @param {string} key */
  async function startBoardRun(key) {
    if (activePolls.has(key)) return;
    const resolved = await boardForRequest(key);
    if (!resolved || resolved.session.status === "ended") return;
    const config = await runnerConfigs.get(resolved.session.file);
    if (!config) return;
    const label = runnerAgentLabel(config.agent);
    const executable = await runnerExecutable(config);
    if (config.agent !== "custom" && !executable) {
      boardRuns.set(key, {
        ...emptyRun(config, label),
        status: "failed",
        ended_at: new Date().toISOString(),
        error: `${label} is no longer installed on this machine`,
      });
      broadcastRun(key, { now: true });
      return;
    }
    // Another listener may have claimed the board while the config was read.
    if (activePolls.has(key)) return;
    const taken = await store.takeFeedback(key);
    if (taken.status !== "feedback") return;
    const prompts = Array.isArray(taken.prompts) ? taken.prompts : [];
    if (prompts.length === 0) {
      await restoreClosedFeedback(key, taken);
      return;
    }
    /** @type {BoardRun} */
    const run = { ...emptyRun(config, label), notes: prompts.length };
    boardRuns.set(key, run);
    finishFeedbackDelivery(key, taken);
    refreshIdleTimer();
    broadcastRun(key, { now: true });
    writeLog(`[liesel] runner start key=${key} agent=${config.agent} notes=${prompts.length} cwd=${config.cwd}`);
    const project = await projectFor(key, resolved.session).catch(() => null);
    const devPort = project ? project.dev.port() || project.config?.port || 0 : 0;
    const prompt = buildRunnerPrompt({
      boardDir: resolved.dir,
      boardName: resolved.board.name || path.basename(resolved.dir),
      items: resolved.board.items,
      prompts,
      cwd: config.cwd,
      project: project ? { root: project.root, url: devPort ? `http://localhost:${devPort}` : "" } : null,
    });
    const outcome = await runAgent({
      config,
      executable,
      prompt,
      boardDir: resolved.dir,
      env,
      extraEnv: {
        LIESEL_BOARD: resolved.board.name || path.basename(resolved.dir),
        LIESEL_BOARD_DIR: resolved.dir,
        LIESEL_BOARD_JSON: resolved.session.file,
        LIESEL_BOARD_ID: key,
        LIESEL_NOTE_COUNT: String(prompts.length),
      },
      timeoutMs: runnerTimeoutMs,
      onSpawn: (stop) => {
        run.stop = stop;
      },
      onOutput: (chunk) => {
        run.output = (run.output + chunk).slice(-RUNNER_OUTPUT_KEEP);
        broadcastRun(key);
      },
    }).catch((error) => ({
      ok: false,
      output: run.output,
      reply: "",
      error: error instanceof Error ? error.message : String(error),
      stopped: false,
    }));
    run.stop = null;
    run.output = outcome.output || run.output;
    run.ended_at = new Date().toISOString();
    // The status flips only after its side effect landed, so whoever reads "finished" sees the
    // reply and whoever reads "failed" sees the notes back on the queue.
    if (outcome.ok) {
      run.reply = outcome.reply || `${label} finished.`;
      await publishAgentReply(key, run.reply);
      run.status = "finished";
    } else {
      // Nothing was answered, so the notes go back on the queue as they were: a retry, the
      // next note, or a poll picks them up again.
      run.error = outcome.error || "Failed";
      await restoreClosedFeedback(key, taken);
      clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      void publishChatSync(key);
      run.status = "failed";
    }
    writeLog(`[liesel] runner ${run.status} key=${key} agent=${config.agent}${run.error ? `: ${run.error}` : ""}`);
    const queued = run.queued;
    run.queued = false;
    broadcastRun(key, { now: true });
    refreshIdleTimer();
    // A failed run does not chain: the same notes would fail the same way until the user acts.
    if (run.status === "finished" && !shuttingDown) {
      const session = await store.findByKey(key);
      // After this start has fully unwound, so the next one is not mistaken for it.
      if (queued || Number(session?.pending_prompts) > 0) setImmediate(() => triggerBoardRunner(key));
    }
  }

  function emptyRun(config, label) {
    boardRunSeq += 1;
    return {
      id: boardRunSeq,
      status: /** @type {const} */ ("running"),
      agent: config.agent,
      label,
      cwd: config.cwd,
      notes: 0,
      started_at: new Date().toISOString(),
      ended_at: "",
      output: "",
      reply: "",
      error: "",
      queued: false,
      stop: null,
    };
  }

  async function runnerView(key, session) {
    const installed = await detectInstalledAgents({ env });
    const config = await runnerConfigs.get(session.file);
    // The run first, then the queue: a run reads "failed" only after its notes are back, so
    // this order never shows a failed run with its notes missing.
    const run = publicRun(boardRuns.get(key));
    const current = (await store.findByKey(key)) || session;
    return {
      agents: [
        ...installed.map((agent) => ({ id: agent.id, label: agent.label })),
        { id: CUSTOM_AGENT.id, label: CUSTOM_AGENT.label },
      ],
      config,
      default_cwd: projectRootOfSession(session) || path.dirname(session.file),
      run,
      pending_prompts: Number(current.pending_prompts) || 0,
      listener: activePolls.has(key),
    };
  }

  app.get("/api/boards/:key/runner", async (req, res, next) => {
    try {
      if (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ status: "error", error: "cross-origin runner read rejected" });
        return;
      }
      const resolved = await boardForRequest(req.params.key);
      if (!resolved) {
        res.status(404).json({ status: "error", error: "board not found" });
        return;
      }
      res.json(await runnerView(req.params.key, resolved.session));
    } catch (error) {
      next(error);
    }
  });

  // Choosing the agent is the one place a board learns a command to run, so it takes the
  // same same-origin guard as a prompt: only this server's own board page can set it.
  app.post("/api/boards/:key/runner", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const resolved = await boardForRequest(req.params.key);
      if (!resolved) {
        res.status(404).json({ status: "error", error: "board not found" });
        return;
      }
      const agent = String(req.body?.agent || "").trim();
      if (!agent || agent === "off") {
        await runnerConfigs.set(resolved.session.file, null);
        res.json(await runnerView(req.params.key, resolved.session));
        return;
      }
      const installed = (await detectInstalledAgents({ env })).map((entry) => entry.id);
      const checked = await validateRunnerConfig(
        {
          ...req.body,
          cwd: String(req.body?.cwd || "").trim() || projectRootOfSession(resolved.session) || resolved.dir,
        },
        { installed },
      );
      if ("error" in checked) {
        res.status(400).json({ status: "error", error: checked.error });
        return;
      }
      await runnerConfigs.set(resolved.session.file, checked.config);
      writeLog(`[liesel] runner set key=${req.params.key} agent=${checked.config.agent} cwd=${checked.config.cwd}`);
      res.json(await runnerView(req.params.key, resolved.session));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:key/runner/run", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const resolved = await boardForRequest(req.params.key);
      if (!resolved) {
        res.status(404).json({ status: "error", error: "board not found" });
        return;
      }
      triggerBoardRunner(req.params.key);
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:key/runner/stop", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const run = boardRuns.get(req.params.key);
      if (run?.status === "running") {
        run.queued = false;
        run.stop?.();
      }
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  // Project boards (src/project.js): a board kept in a repository's `.liesel/` folder. Its
  // agent works in the repo root, and its live items show the project's own dev server
  // through a loopback proxy on a port of its own, so the app keeps its absolute URLs and
  // its own origin. Opening the board starts the dev server (`/project/start` with `auto`);
  // a Stop the user pressed holds until they start it again or Liesel restarts.
  const projectConfigs = createProjectConfigStore(attachmentStateRoot);
  /**
   * @typedef {{
   *   key: string, root: string, boardFile: string,
   *   config: { command: string, port: number, proxyPort: number } | null,
   *   dev: ReturnType<typeof createDevServer>, proxy: ReturnType<typeof createLiveProxy>,
   *   origin: string, watcher: import("chokidar").FSWatcher | null,
   *   sourceTimer: ReturnType<typeof setTimeout> | null, broadcastTimer: ReturnType<typeof setTimeout> | null,
   *   lastStatus: string, userStopped: boolean, issue: string,
   *   staticServer: ReturnType<typeof createStaticServer> | null, reusedPort: number,
   *   launching: Promise<void> | null, recoveryTimer: ReturnType<typeof setTimeout> | null,
   *   crashes: number[], handledExit: string, gaveUp: boolean, answered: boolean,
   * }} LiveProject
   */
  /** @type {Map<string, Promise<LiveProject>>} */
  const projects = new Map();
  let projectsClosed = Promise.resolve();
  const PROJECT_SOURCE_IGNORED =
    /(^|[\\/])(node_modules|\.git|\.liesel|\.next|\.nuxt|\.output|\.svelte-kit|\.astro|\.turbo|\.cache|\.vercel|dist|build|coverage|out)([\\/]|$)/;

  /** @param {any} session */
  function projectRootOfSession(session) {
    if (!session || path.basename(String(session.file || "")) !== BOARD_FILE_NAME) return null;
    return projectRootForBoardDir(path.dirname(session.file));
  }

  /**
   * The live project behind a project board, created on first use: its proxy listens from
   * then on, and its dev server runs once the board opens or the user presses Start.
   * @param {string} key
   * @param {any} session
   * @returns {Promise<LiveProject | null>}
   */
  function projectFor(key, session) {
    const root = projectRootOfSession(session);
    if (!root || shuttingDown) return Promise.resolve(null);
    const existing = projects.get(key);
    if (existing) return existing;
    const created = (async () => {
      const config = await projectConfigs.get(session.file);
      /** @type {LiveProject} */
      const project = {
        key,
        root,
        boardFile: session.file,
        config,
        dev: /** @type {any} */ (null),
        proxy: /** @type {any} */ (null),
        origin: "",
        watcher: null,
        sourceTimer: null,
        broadcastTimer: null,
        lastStatus: "stopped",
        userStopped: false,
        issue: "",
        staticServer: null,
        reusedPort: 0,
        launching: null,
        recoveryTimer: null,
        crashes: [],
        handledExit: "",
        gaveUp: false,
        answered: false,
      };
      project.dev = createDevServer({
        cwd: root,
        env,
        onChange: () => {
          scheduleProjectBroadcast(project);
          recoverFromCrash(project);
        },
      });
      const sdkSrc = `http://${LOOPBACK_HOST}:${publicPort}/board-sdk.js?key=${encodeURIComponent(key)}&live=1&v=${encodeURIComponent(version)}`;
      project.proxy = createLiveProxy({
        upstreamPort: () => upstreamPortOf(project),
        sdkSrc,
        reservedPorts: () => httpServers.map((entry) => entry.address()?.port).filter(Boolean),
        onAnswer: () => {
          project.answered = true;
          project.dev.markAnswering();
        },
        // A server that was already running, and has gone, is replaced by one of our own.
        onUnreachable: (port) => {
          if (!project.reusedPort || port !== project.reusedPort || project.launching) return;
          writeLog(`[liesel] reused dev server gone key=${key} port=${port}`);
          project.reusedPort = 0;
          void launchProject(project, { reuse: false });
        },
        statusMessage: () => liveStatusMessage(project),
      });
      project.origin = await project.proxy.listen(config?.proxyPort || 0);
      if (project.proxy.port() !== config?.proxyPort) {
        await projectConfigs.update(session.file, { proxyPort: project.proxy.port() }).catch(() => {});
      }
      watchProjectSource(project);
      writeLog(`[liesel] project proxy key=${key} root=${root} origin=${project.origin}`);
      return project;
    })();
    projects.set(key, created);
    created.catch(() => projects.delete(key));
    return created;
  }

  /** @param {LiveProject} project */
  function upstreamPortOf(project) {
    return project.dev.port() || project.reusedPort || project.staticServer?.port() || project.config?.port || 0;
  }

  // The server stays out of sight: a frame waiting for it shows a quiet spinner, and only a
  // real failure shows one plain sentence with a button. Detail lives in Settings, Advanced.
  /** @param {LiveProject} project */
  function liveStatusMessage(project) {
    const view = project.dev.view();
    const busy = { title: "Getting the page ready", message: "", busy: true };
    if (project.userStopped)
      return { title: "The project's server is stopped.", message: "", action: /** @type {const} */ ("start") };
    if (project.gaveUp)
      return {
        title: project.answered ? "The project's server stopped." : "The project's server could not start.",
        message: "",
        action: /** @type {const} */ ("restart"),
      };
    if (project.launching || project.recoveryTimer || view.status === "starting") return busy;
    if (project.issue)
      return {
        title: "Liesel could not find how to run this project.",
        message: "",
        action: /** @type {const} */ ("settings"),
      };
    const port = upstreamPortOf(project);
    if (!port || view.status === "running") return busy;
    return {
      title: `Nothing answers at localhost:${port}.`,
      message: "",
      action: project.config?.command ? /** @type {const} */ ("restart") : /** @type {const} */ ("settings"),
    };
  }

  /**
   * Gets the project's server going without asking: an already running server from the
   * repo is reused; otherwise the dev command (the user's, or the detected one) runs, after
   * installing missing dependencies and on a free port when the usual one is taken; a
   * folder with no dev script but HTML files is served as it is. One launch at a time.
   * @param {LiveProject} project
   * @param {{ reuse?: boolean }} [options]
   */
  function launchProject(project, { reuse = true } = {}) {
    if (project.launching) return project.launching;
    const run = (async () => {
      if (shuttingDown) return;
      if (project.dev.running() && project.dev.view().status !== "stopped") return;
      if (project.staticServer) return;
      if (project.reusedPort && (await portAnswers(project.reusedPort))) return;
      project.reusedPort = 0;
      project.issue = "";
      // A server the user runs themselves, named by its port only.
      if (!project.config?.command && project.config?.port) return;
      if (reuse) {
        const port = await reusableServer(project);
        if (port) {
          project.reusedPort = port;
          project.answered = true;
          writeLog(`[liesel] dev server reused key=${project.key} port=${port}`);
          return;
        }
      }
      const detected = await detectDevServer(project.root);
      let config = project.config?.command ? project.config : null;
      if (!config && detected) {
        await projectConfigs.update(project.boardFile, { command: detected.command, port: 0 });
        project.config = await projectConfigs.get(project.boardFile);
        config = project.config;
      }
      if (!config?.command) {
        const { routes } = await discoverRoutes(project.root).catch(() => ({ routes: [] }));
        if (routes.length > 0) {
          const server = createStaticServer(project.root);
          await server.listen();
          project.staticServer = server;
          project.answered = true;
          writeLog(`[liesel] serving folder key=${project.key} port=${server.port()}`);
          return;
        }
        project.issue = await devServerDetectIssue(project.root);
        return;
      }
      const install = await installCommand(project.root, detected?.packageManager);
      let port = config.port || 0;
      // The usual port is taken (often by another project): hand the server a free one.
      if (!port && detected?.port && (await portAnswers(detected.port))) port = await freePort();
      const command = install ? `${install} && ${config.command}` : config.command;
      writeLog(
        `[liesel] dev server start key=${project.key} cwd=${project.root} command=${command}${port ? ` port=${port}` : ""}`,
      );
      project.dev.start({ command, port, label: config.command });
    })()
      .catch((error) => {
        project.issue = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        if (project.launching === run) project.launching = null;
        scheduleProjectBroadcast(project, true);
      });
    project.launching = run;
    scheduleProjectBroadcast(project, true);
    return run;
  }

  /**
   * A server already running from inside the repo that answers HTTP, or 0.
   * @param {LiveProject} project
   */
  async function reusableServer(project) {
    const excludePorts = [...httpServers.map((entry) => entry.address()?.port).filter(Boolean), project.proxy.port()];
    const ports = await findRunningServers(project.root, { excludePorts }).catch(() => []);
    for (const port of ports.slice(0, 8)) {
      const answer = await fetchLocal(port, "/", { timeoutMs: 1500, maxBytes: 256 * 1024 });
      if (answer && answer.status > 0 && /html/i.test(answer.type)) return port;
    }
    return 0;
  }

  const CRASH_WINDOW_MS = 3 * 60_000;
  const CRASH_LIMIT = 3;
  /**
   * A dev server that exits without being told to is started again, a few times, a little
   * later each time. After that the frames say so, with Retry.
   * @param {LiveProject} project
   */
  function recoverFromCrash(project) {
    const view = project.dev.view();
    if (view.status !== "failed" && view.status !== "exited") return;
    if (project.userStopped || project.dev.running() || shuttingDown) return;
    if (project.handledExit === view.started_at) return;
    project.handledExit = view.started_at;
    const now = Date.now();
    project.crashes = project.crashes.filter((at) => now - at < CRASH_WINDOW_MS);
    if (project.crashes.length >= CRASH_LIMIT) {
      project.gaveUp = true;
      writeLog(`[liesel] dev server gave up key=${project.key} after ${project.crashes.length} restarts`);
      scheduleProjectBroadcast(project, true);
      return;
    }
    project.crashes.push(now);
    const delay = 500 * project.crashes.length;
    writeLog(`[liesel] dev server exited key=${project.key} (${view.error || view.status}); restarting in ${delay}ms`);
    if (project.recoveryTimer) clearTimeout(project.recoveryTimer);
    project.recoveryTimer = setTimeout(() => {
      project.recoveryTimer = null;
      if (project.userStopped || shuttingDown) return;
      void launchProject(project, { reuse: false });
    }, delay);
    project.recoveryTimer.unref?.();
    scheduleProjectBroadcast(project, true);
  }

  /** @param {LiveProject} project */
  function cancelRecovery(project) {
    if (project.recoveryTimer) clearTimeout(project.recoveryTimer);
    project.recoveryTimer = null;
    project.crashes = [];
    project.gaveUp = false;
  }

  // A saved source file is how the board knows a live page may have changed: the page
  // itself hot-reloads through the proxy, and a page that does not is reloaded by the board.
  /** @param {LiveProject} project */
  function watchProjectSource(project) {
    try {
      const watcher = chokidar.watch(project.root, {
        ignoreInitial: true,
        ignored: (file) => PROJECT_SOURCE_IGNORED.test(path.relative(project.root, file)),
        depth: 12,
      });
      watcher.on("all", (_event, file) => {
        if (project.sourceTimer) clearTimeout(project.sourceTimer);
        project.sourceTimer = setTimeout(() => {
          project.sourceTimer = null;
          broadcastLiveEvent("project-source", project.key, { file: path.relative(project.root, String(file || "")) });
        }, 300);
      });
      watcher.on("error", (error) =>
        logEvent?.(`project watch error key=${project.key}: ${error instanceof Error ? error.message : error}`),
      );
      project.watcher = watcher;
    } catch (error) {
      writeLog(`[liesel] project watch failed key=${project.key}: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** @param {LiveProject} project */
  function projectView(project) {
    return {
      root: project.root,
      name: path.basename(project.root),
      proxy: project.origin,
      config: project.config ? { command: project.config.command, port: project.config.port } : null,
      dev: project.dev.view(),
      issue: project.issue,
      user_stopped: project.userStopped,
      mode: project.reusedPort ? "reused" : project.staticServer ? "static" : "dev",
      port: upstreamPortOf(project),
      busy: Boolean(project.launching || project.recoveryTimer),
      gave_up: project.gaveUp,
    };
  }

  /** @param {LiveProject} project @param {boolean} [urgent] */
  function scheduleProjectBroadcast(project, urgent = false) {
    const status = project.dev.view().status;
    const now = urgent || status !== project.lastStatus;
    project.lastStatus = status;
    if (project.broadcastTimer && !now) return;
    if (project.broadcastTimer) clearTimeout(project.broadcastTimer);
    project.broadcastTimer = setTimeout(
      () => {
        project.broadcastTimer = null;
        broadcastLiveEvent("project", project.key, projectView(project));
      },
      now ? 0 : 400,
    );
  }

  /** The project view for a board, or null for an ordinary board. */
  async function projectViewFor(key, session) {
    const project = await projectFor(key, session).catch(() => null);
    return project ? projectView(project) : null;
  }

  async function closeProjects() {
    const all = [...projects.values()];
    projects.clear();
    await Promise.all(
      all.map((pending) =>
        pending
          .then(async (project) => {
            project.dev.stop();
            cancelRecovery(project);
            await project.staticServer?.close();
            if (project.sourceTimer) clearTimeout(project.sourceTimer);
            if (project.broadcastTimer) clearTimeout(project.broadcastTimer);
            await project.watcher?.close().catch(() => {});
            await project.proxy.close();
          })
          .catch(() => {}),
      ),
    );
  }

  // Open project: a local folder, or a GitHub URL cloned into ~/Liesel/<repo>. The board
  // lives in <repo>/.liesel/, which is kept out of git through .git/info/exclude, never
  // .gitignore. Browser-only, like New board.
  app.post("/api/projects", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const input = String(req.body?.path || "").trim();
      if (!input) throw new ProjectError("Choose a project folder or paste a GitHub URL");
      const github = parseGithubRepoUrl(input);
      const root = github
        ? (await cloneGithubRepo(input, { parent: path.join(homedir(), PRODUCT_NAME), env })).root
        : await resolveProjectFolder(input);
      const excluded = await ensureGitExclude(root);
      const dir = projectBoardDir(root);
      await mkdir(dir, { recursive: true });
      // A fresh project board starts on the project's home page, so there is something to
      // look at as soon as the dev server answers.
      const created = !existsSync(boardFilePath(dir));
      if (created) {
        const board = normalizeBoard({ name: path.basename(root) }, path.basename(root));
        addLiveItem(board, { page: "/" });
        await writeBoard(dir, board);
      }
      const opened = await openBoardSession(dir, { name: path.basename(root), reopen: true });
      writeLog(`[liesel] project opened key=${opened.key} root=${root}${github ? " (cloned)" : ""}`);
      // The server gets going now, while the reviewer picks pages.
      void boardForRequest(opened.key)
        .then((resolved) => (resolved ? projectFor(opened.key, resolved.session) : null))
        .then((project) => (project && !project.userStopped ? launchProject(project) : null))
        .catch(() => {});
      res.json({
        ...opened,
        root,
        created,
        git_exclude: excluded.file ? (excluded.added ? "added" : "present") : "no-git",
      });
    } catch (error) {
      if (projectErrorResponse(error, res) || boardErrorResponse(error, res)) return;
      next(error);
    }
  });

  function projectErrorResponse(error, res) {
    if (!(error instanceof ProjectError)) return false;
    res.status(400).json({ status: "error", error: error.message });
    return true;
  }

  /**
   * @param {import("express").Request} req
   * @param {import("express").Response} res
   */
  async function projectForRequest(req, res) {
    const resolved = await boardForRequest(req.params.key);
    const project = resolved ? await projectFor(req.params.key, resolved.session) : null;
    if (!resolved || !project) {
      res.status(404).json({ status: "error", error: "project board not found" });
      return null;
    }
    return { resolved, project };
  }

  app.get("/api/boards/:key/project", async (req, res, next) => {
    try {
      if (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ status: "error", error: "cross-origin project read rejected" });
        return;
      }
      const found = await projectForRequest(req, res);
      if (!found) return;
      res.json({ ...projectView(found.project), detected: await detectDevServer(found.project.root) });
    } catch (error) {
      next(error);
    }
  });

  // The dev server command and port are the one thing a project board runs, so they are
  // set only from this server's own board page and kept on this machine, never in the repo.
  app.post("/api/boards/:key/project/dev", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const found = await projectForRequest(req, res);
      if (!found) return;
      const reservedPorts = [
        ...httpServers.map((entry) => entry.address()?.port).filter(Boolean),
        found.project.proxy.port(),
      ];
      const checked = validateDevConfig(req.body, { reservedPorts });
      if ("error" in checked) {
        res.status(400).json({ status: "error", error: checked.error });
        return;
      }
      await projectConfigs.update(found.project.boardFile, checked.config);
      found.project.config = await projectConfigs.get(found.project.boardFile);
      found.project.issue = "";
      scheduleProjectBroadcast(found.project);
      res.json({ ...projectView(found.project), detected: await detectDevServer(found.project.root) });
    } catch (error) {
      next(error);
    }
  });

  // Start runs the project's server. `auto` is the board asking as it opens: it does
  // nothing when a server is already up or the user stopped it.
  app.post("/api/boards/:key/project/start", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const found = await projectForRequest(req, res);
      if (!found) return;
      const { project } = found;
      const auto = req.body?.auto === true;
      if (auto && (project.userStopped || project.gaveUp)) {
        res.json(projectView(project));
        return;
      }
      if (!auto) {
        project.userStopped = false;
        cancelRecovery(project);
      }
      // A server still winding down from a Stop starts again once it has gone.
      if (project.dev.running() && project.dev.view().status === "stopped") await project.dev.stopAndWait();
      await launchProject(project);
      res.json(projectView(project));
    } catch (error) {
      next(error);
    }
  });

  // Restart (and a frame's Retry) starts the project's own server afresh.
  app.post("/api/boards/:key/project/restart", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const found = await projectForRequest(req, res);
      if (!found) return;
      const { project } = found;
      project.userStopped = false;
      project.issue = "";
      cancelRecovery(project);
      writeLog(`[liesel] dev server restart key=${project.key} cwd=${project.root}`);
      await project.dev.stopAndWait();
      await project.staticServer?.close();
      project.staticServer = null;
      project.reusedPort = 0;
      await launchProject(project, { reuse: false });
      res.json(projectView(project));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:key/project/stop", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const found = await projectForRequest(req, res);
      if (!found) return;
      const { project } = found;
      project.userStopped = true;
      cancelRecovery(project);
      project.dev.stop();
      // A server Liesel did not start is never stopped; the board just stops showing it.
      project.reusedPort = 0;
      const served = project.staticServer;
      project.staticServer = null;
      await served?.close();
      scheduleProjectBroadcast(project, true);
      res.json(projectView(project));
    } catch (error) {
      next(error);
    }
  });

  // The pages the picker offers: routes read from the project's files, plus the sitemap
  // and home page links of the running site, plus the pages already on the board.
  app.get("/api/boards/:key/project/pages", async (req, res, next) => {
    try {
      if (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ status: "error", error: "cross-origin project read rejected" });
        return;
      }
      const found = await projectForRequest(req, res);
      if (!found) return;
      const { project, resolved } = found;
      const port = upstreamPortOf(project);
      const [{ framework, routes }, crawled] = await Promise.all([
        discoverRoutes(project.root).catch(() => ({ framework: "", routes: [] })),
        port ? crawlDevServer(port).catch(() => []) : Promise.resolve([]),
      ]);
      const board = resolved.board.items.filter((item) => item.page).map((item) => String(item.page));
      const merged = mergePages({ routes, crawled, board });
      res.json({
        status: "ok",
        framework,
        pages: merged.pages,
        skipped: merged.skipped,
        site_read: crawled.length > 0,
      });
    } catch (error) {
      next(error);
    }
  });

  // A live page joins the board by its URL path on the dev server.
  app.post("/api/boards/:key/pages", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const found = await projectForRequest(req, res);
      if (!found) return;
      await withBoardWrite(req.params.key, res, async ({ dir, board }) => {
        const item = addLiveItem(board, { page: req.body?.page, label: req.body?.label, tab: req.body?.tab });
        const saved = await writeBoard(dir, board);
        const published = publicBoard(saved);
        logEvent?.(`board live page added key=${req.params.key} page=${item.page}`);
        res.json({ status: "ok", item: published.items.find((entry) => entry.id === item.id) });
      });
    } catch (error) {
      next(error);
    }
  });

  // The page picker's choice: the board's live pages become exactly `pages`. A page left
  // out moves to the board's trash with its notes, so Undo brings it back as it was.
  app.post("/api/boards/:key/pages/set", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const found = await projectForRequest(req, res);
      if (!found) return;
      const wanted = Array.isArray(req.body?.pages) ? req.body.pages.slice(0, 400) : null;
      if (!wanted) throw new BoardError("Choose the pages to show");
      const pages = [...new Set(wanted.map((page) => normalizeLivePage(page)).filter(Boolean))];
      await withBoardWrite(req.params.key, res, async ({ dir, board }) => {
        const directory = await realpath(dir);
        const keep = new Set(pages);
        let next = board;
        /** @type {Array<{ id: string, page: string, token: string }>} */
        const removed = [];
        for (const item of board.items.filter((entry) => entry.page && !keep.has(entry.page))) {
          const token = await trashItem(directory, next, item);
          next = {
            ...next,
            items: next.items.filter((entry) => entry.id !== item.id),
            pairs: next.pairs.filter((pair) => pair.a !== item.id && pair.b !== item.id),
          };
          removed.push({ id: item.id, page: String(item.page), token });
        }
        next = { ...next, items: [...next.items] };
        /** @type {string[]} */
        const added = [];
        for (const page of pages) {
          if (next.items.some((entry) => entry.page === page)) continue;
          added.push(addLiveItem(next, { page, tab: req.body?.tab }).id);
        }
        const saved = await writeBoard(directory, next);
        const published = publicBoard(saved);
        logEvent?.(`board live pages set key=${req.params.key} added=${added.length} removed=${removed.length}`);
        res.json({
          status: "ok",
          added: published.items.filter((entry) => added.includes(entry.id)),
          removed,
        });
      });
    } catch (error) {
      if (boardErrorResponse(error, res)) return;
      next(error);
    }
  });

  // A live page's history: the board hands over the page as the frame rendered it (no
  // scripts, so a saved round never re-runs the app), stored like a file item's build.
  const LIVE_SNAPSHOT_MAX = 1_900_000;
  app.post("/api/boards/:key/live-snapshot", async (req, res, next) => {
    try {
      if (!boardWriteGuard(req, res)) return;
      const itemId = String(req.body?.item || "");
      const html = typeof req.body?.html === "string" ? req.body.html : "";
      if (!html || html.length > LIVE_SNAPSHOT_MAX)
        throw new BoardError("A snapshot needs the page's HTML, under 2 MB");
      const found = await projectForRequest(req, res);
      if (!found) return;
      const page = normalizeLivePage(req.body?.page);
      await withBoardWrite(req.params.key, res, async ({ dir, board }) => {
        const item = board.items.find((entry) => entry.id === itemId);
        if (!item?.page) throw new BoardError(`Not a live page: ${itemId}`);
        const pathname = (page || item.page).split(/[?#]/)[0];
        // Scripts never survive into a snapshot, and its links resolve on the proxy.
        const stripped = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
        const base = `<base href="${escapeHtml(`${found.project.origin}${pathname}`)}">`;
        const snapshot = /<head\b[^>]*>/i.test(stripped)
          ? stripped.replace(/<head\b[^>]*>/i, (head) => `${head}${base}`)
          : `${base}${stripped}`;
        const hash = crypto.createHash("sha1").update(snapshot).digest("hex");
        if (item.builds.at(-1)?.hash === hash || item.builds.some((build) => build.hash === hash)) {
          res.json({ status: "ok", recorded: false, builds: item.builds });
          return;
        }
        const folder = path.join(dir, BOARD_BUILD_DIR, item.id);
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, `${hash}.html`), snapshot, { flag: "wx" }).catch((error) => {
          if (error?.code !== "EEXIST") throw error;
        });
        item.builds.push({ at: new Date().toISOString(), hash, label: "" });
        const saved = await writeBoard(dir, board);
        const builds = saved.items.find((entry) => entry.id === item.id)?.builds || [];
        res.json({ status: "ok", recorded: true, builds });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin prompt submission rejected" });
        return;
      }
      const shouldEndSession = Boolean(req.body?.endSession || req.body?.end_session);
      const hasLayoutWarningPrompt = Array.isArray(req.body?.prompts)
        ? req.body.prompts.some((prompt) => prompt?.tag === "layout-warnings")
        : false;
      const result = await store.queuePrompts(req.params.key, req.body || {}, {
        resolveAttachment: (sessionKeyValue, id) => resolveAttachment(attachmentStateRoot, sessionKeyValue, id),
        maxPerPrompt: attachmentConfig.maxPerPrompt,
        maxPromptBytes: attachmentConfig.maxPromptBytes,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      // The session was already ended by someone else before this batch arrived - no agent will
      // ever poll it again, so a 200 here would be a lie. Nothing was persisted; the chrome keeps
      // its queue and goes read-only itself in case it missed the live `ended` event.
      if (result.ended) {
        res.status(409).json({ status: "ended", error: "session already ended", ended_by: result.ended_by });
        return;
      }
      // Atomic attachment rejection (C4): the batch resolved-and-persisted nothing
      // because one or more images could not be honored. Return 400 with the
      // rejected refs and the caps so the chrome keeps its queue and can surface
      // exactly what to fix, instead of silently dropping the images.
      if (result.rejected) {
        res.status(400).json({
          error: "some attachments could not be delivered",
          rejected: result.rejected,
          caps: result.caps,
        });
        return;
      }
      const session = result;
      if (session.conflict) {
        res.status(409).json({
          status: "conflict",
          error: "a layout warning changed before it was sent; review the warning again",
          warning_ids: session.warning_ids,
          warnings: session.warnings,
        });
        return;
      }
      const freshFeedback = session.fresh_feedback === true;
      if (shouldEndSession) clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      let publishedSession = session;
      if (hasLayoutWarningPrompt) {
        await syncOutstandingRepairs(req.params.key);
        publishedSession = (await store.findByKey(req.params.key)) || session;
        events.emit("layout-warnings", req.params.key, serializeLayoutWarnings(publishedSession.layout_warnings));
      }
      if (shouldEndSession) events.emit("ended", req.params.key, publishedSession.ended_by);
      else if (freshFeedback) events.emit("feedback", req.params.key, publishedSession.ended_by);
      // The accepted batch is part of the conversation now: answer with the transcript so the
      // sending chrome can settle its queued bubbles in place, and sync every other tab of this
      // session at send time rather than when a poll happens to take the batch.
      await mirrorBoardChat(publishedSession);
      events.emit("chat-sync", req.params.key, publishedSession);
      res.json({
        status: "queued",
        pending_prompts: publishedSession.pending_prompts,
        ...serializeChatSync(publishedSession),
      });
      if (freshFeedback || shouldEndSession) notifyBoardSubmission(req.params.key, publishedSession);
      if (
        freshFeedback &&
        !shouldEndSession &&
        path.basename(String(publishedSession.file || "")) === BOARD_FILE_NAME
      ) {
        triggerBoardRunner(req.params.key);
      }
      if (shouldEndSession) await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  // Passive detection. A diagnostic pass updates the warning inbox and notifies open browser
  // chromes - it never emits "feedback", so it can never make `liesel poll` return and can
  // never wake an agent. Only the user's explicit "Queue selected fixes" does that, through the
  // ordinary prompt queue.
  app.post("/api/:key/layout-diagnostics", async (req, res, next) => {
    try {
      const result = await store.recordLayoutDiagnostics(req.params.key, req.body || {}, {
        viewportClasses: diagnosticViewportClasses,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const activeCount = activeLayoutWarningCount(result.session.layout_warnings);
      if (!result.stale) {
        await syncOutstandingRepairs(req.params.key);
        if (result.changed) events.emit("layout-warnings", req.params.key, result.warnings);
      }
      res.json({ status: result.stale ? "stale" : "recorded", active_count: activeCount, warnings: result.warnings });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/layout-warnings", async (req, res, next) => {
    try {
      const result = await store.listLayoutWarnings(req.params.key);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({ warnings: result.warnings, revision: result.revision });
    } catch (error) {
      next(error);
    }
  });

  // Prepare the user's selected warnings. The prompt commits the repair request through
  // /api/:key/prompts with the rest of the ordinary feedback queue.
  app.post("/api/:key/layout-warnings/queue", async (req, res, next) => {
    try {
      const result = await store.prepareLayoutWarningFixes(req.params.key, req.body?.ids);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({
        status: result.queued.length > 0 ? "prepared" : "unchanged",
        queued_count: result.queued.length,
        prompt: result.prompt,
        warnings: result.warnings,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/layout-warnings/dismiss", async (req, res, next) => {
    try {
      const result = await store.dismissLayoutWarning(req.params.key, req.body?.id);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.changed) events.emit("layout-warnings", req.params.key, result.warnings);
      res.json({ status: result.changed ? "dismissed" : "unchanged", warnings: result.warnings });
    } catch (error) {
      next(error);
    }
  });

  // The narrow fatal path: the artifact cannot be served, or one of its own local assets failed
  // to load. There is no usable review to triage from, so this still reaches the agent directly.
  app.post("/api/:key/artifact-failures", async (req, res, next) => {
    try {
      const result = await store.recordArtifactFailures(req.params.key, req.body || {});
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.stale) {
        res.status(409).json({ status: "stale" });
        return;
      }
      if (result.changed) events.emit("feedback", req.params.key);
      res.json({ status: "recorded" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      const session = await store.endSession(req.params.key, "user");
      clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      events.emit("ended", req.params.key, session?.ended_by);
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const session = await publishAgentReply(req.params.key, String(req.body?.text || ""), {
        requireOpen: true,
      });
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (session.status === "ended") {
        res.status(409).json({ status: "ended", ended_by: session.ended_by });
        return;
      }
      res.json({ status: "sent" });
    } catch (error) {
      next(error);
    }
  });

  // Static export: inline the artifact's local assets into one portable HTML file the user can
  // open from disk or host anywhere, with no dependency on this server. Remote CDN/font URLs are
  // left as references for the browser to load, so the export needs network to render those.
  app.get("/api/:key/export", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (refuseNonHtmlArtifact(session, res)) return;
      const source = await readFile(session.file, "utf8");
      const root = path.dirname(session.file);
      const { html, warnings } = await buildSelfContainedHtml(source, {
        baseDir: root,
        confineDir: root,
        resolveAbsolute: resolveDesignAssetPath,
      });
      const { unresolved, notices } = splitExportWarnings(warnings);
      // Although this response downloads in normal chrome usage, an escaped artifact popup can
      // navigate to it directly. Preserve the artifact's opaque-origin boundary if the browser
      // renders the exported HTML instead of saving it.
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      res.setHeader("content-disposition", exportContentDisposition(session.file));
      res.setHeader("x-liesel-export-warning-count", String(unresolved.length));
      res.setHeader("x-liesel-export-notice-count", String(notices.length));
      res.type("html").send(html);
    } catch (error) {
      next(error);
    }
  });

  // Hosted share: build the local-inlined artifact and publish it to ht-ml.app, a third-party
  // hosting service not part of Liesel, returning the share URL. Publishing sends the artifact
  // to ht-ml.app's servers. Remote CDN/font references are left intact for the viewer's browser
  // to load.
  // Publishing creates a public third-party page unless a password is supplied, so this is gated
  // behind a same-origin check - a cross-origin page must not be able to drive a publish via the
  // loopback server.
  app.post("/api/:key/share", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin share request rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (refuseNonHtmlArtifact(session, res)) return;
      const body = req.body || {};
      // The password is generated here rather than in the chrome because chrome-client.js is
      // served raw and cannot import modules: a browser-side generator would be a second copy of
      // the alphabet and length rules, free to drift from the one the CLI uses.
      const generatePassword = body.generate_password === true;
      const password = generatePassword ? generateSharePassword() : optionalBodyString(body.password);
      const source = await readFile(session.file, "utf8");
      const root = path.dirname(session.file);
      const { html, warnings } = await buildSelfContainedHtml(source, {
        baseDir: root,
        confineDir: root,
        resolveAbsolute: resolveDesignAssetPath,
      });
      let site;
      try {
        site = await publishToHtmlApp(html, { password });
      } catch (error) {
        // Same three-way split the CLI makes, from the same shared classifiers, and the stakes
        // here are higher: the password was minted in this request, so a failure that discards it
        // can leave the page live behind a secret nobody was ever shown.
        const message = error instanceof Error ? error.message : String(error);
        // A 200 the host answered with an unreadable body is not an unknown outcome - the page
        // landed - so whatever fields did arrive go back rather than being hedged away.
        const landed = publishedDespiteError(error);
        if (landed) {
          res.status(502).json({
            error: message,
            outcome: "published-incomplete",
            public: !password,
            ...(landed.url ? { url: landed.url } : {}),
            ...(landed.siteId ? { site_id: landed.siteId } : {}),
            ...(landed.updateKey ? { update_key: landed.updateKey } : {}),
            ...(generatePassword ? { password } : {}),
          });
          return;
        }
        // Only a 4xx proves nothing was published.
        const rejected = hostRejectedShareWrite(error);
        res.status(502).json({
          error: message,
          outcome: rejected ? "rejected" : "indeterminate",
          ...(rejected
            ? {}
            : {
                public: !password,
                // A rejection gates nothing, so it must never carry the password.
                ...(generatePassword ? { password } : {}),
              }),
        });
        return;
      }
      const { unresolved, notices } = splitExportWarnings(warnings);
      res.json({
        ...site,
        // Only a password Liesel minted goes back to the browser; one the user typed is already
        // theirs, and echoing it would put it in a field they did not ask to have filled.
        ...(generatePassword ? { password } : {}),
        ...(warnings.length ? { warnings: exportWarningSummaries(warnings) } : {}),
        ...(unresolved.length ? { unresolved_local_assets: exportWarningSummaries(unresolved) } : {}),
        ...(notices.length ? { notices: exportWarningSummaries(notices) } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/end", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      const session = await store.endSession(key, "agent");
      clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      events.emit("ended", key, session?.ended_by);
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      const chromeLoad = await store.issueReviewerHandoff(req.params.key);
      if (!chromeLoad) {
        sendSessionNotFound(req, res);
        return;
      }
      const session = chromeLoad.session;
      if (refuseNonHtmlArtifact(session, res)) return;
      await watchSession(session, watchers, events, logEvent, reloadDebounceMs);
      const artifactHtml = await readFile(session.file, "utf8").catch(() => "");
      const { faviconTag, title } = extractArtifactHead(artifactHtml);
      // Nothing legitimately frames the review chrome - it is the top-level
      // page, and shares/exports ship standalone HTML rather than embedding it.
      // Refusing to be framed denies an attacker page both a window handle to
      // this chrome and a clickjacking surface over Send. Scoped to this route:
      // /artifact/* is framed by this page and /whiteboard-frame is framed by
      // that artifact document, whose sandbox gives it an opaque origin no
      // frame-ancestors expression can name.
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("content-security-policy", "frame-ancestors 'none'");
      res.type("html").send(
        createChromeHtml(session, {
          layoutGateEnabled: shouldEnableLayoutGate(req.query || {}),
          faviconTag,
          title: title ? `${title} · ${PRODUCT_NAME}` : PRODUCT_NAME,
          artifactRevision: chromeLoad.artifact_revision,
          artifactLoadToken: chromeLoad.artifact_load_token,
          artifactLoadSequence: chromeLoad.artifact_load_sequence,
          chromeLoadToken: chromeLoad.chrome_load_token,
          attachmentMaxBytes: attachmentConfig.maxBytes,
          attachmentMaxCount: attachmentConfig.maxPerPrompt,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact/:key", (req, res) => {
    res.redirect(`/artifact/${req.params.key}/index.html`);
  });

  app.post("/api/:key/chrome-loads/begin", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin chrome handoff rejected" });
        return;
      }
      const handoff = await store.issueReviewerHandoff(req.params.key);
      if (!handoff) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({
        chrome_load_token: handoff.chrome_load_token,
        artifact_revision: handoff.artifact_revision,
        artifact_load_token: handoff.artifact_load_token,
        artifact_load_sequence: handoff.artifact_load_sequence,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/artifact-loads/begin", async (req, res, next) => {
    try {
      const result = await store.beginArtifactLoad(req.params.key, {
        requestId: req.body?.request_id,
        requestSequence: req.body?.request_sequence,
        handoffToken: req.body?.chrome_load_token,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.stale) {
        res.status(409).json({ status: result.stale });
        return;
      }
      res.json({ artifact_revision: result.artifact_revision, artifact_load_token: result.artifact_load_token });
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      const key = req.params[0];
      const token = String(req.query.artifact_load_token || "");
      const revision = req.query.artifact_revision;
      const beforeRead = await store.verifyArtifactLoad(key, token, revision);
      if (!beforeRead) {
        sendSessionNotFound(req, res);
        return;
      }
      if (refuseNonHtmlArtifact(beforeRead.session, res)) return;
      if (!beforeRead.valid) {
        res
          .status(409)
          .type("html")
          .send(
            "<!doctype html><title>Artifact load expired</title><p>This artifact load is no longer current. Reload Liesel to continue.</p>",
          );
        return;
      }
      const html = await readFile(beforeRead.session.file, "utf8");
      const verified = await store.verifyArtifactLoad(key, token, revision);
      if (!verified?.valid) {
        res
          .status(409)
          .type("html")
          .send(
            "<!doctype html><title>Artifact load expired</title><p>This artifact load is no longer current. Reload Liesel to continue.</p>",
          );
        return;
      }
      res.type("html").send(injectLieselSdk(html, key, verified.artifact_revision, verified.artifact_load_token));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      const key = req.params[0];
      const assetPath = req.params[1];
      const session = await store.findByKey(key);
      if (!session) {
        sendSessionNotFound(req, res);
        return;
      }
      if (refuseNonHtmlArtifact(session, res)) return;
      const root = artifactTreeRoot(session.file);
      const file = await resolveArtifactAsset(root, assetPath);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/events/:key", (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close",
    });
    res.end(`event: chrome-reload\ndata: ${JSON.stringify({ reason: "server-restarted" })}\n\n`);
  });

  app.get("/board-client.js", async (req, res, next) => {
    try {
      res.setHeader("cache-control", "no-store");
      res.type("application/javascript").send(await readFile(boardClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/dialkit/:asset", async (req, res, next) => {
    if (req.params.asset !== "styles.css" && req.params.asset !== "browser.global.js") return res.sendStatus(404);
    try {
      res.type(req.params.asset.endsWith(".css") ? "text/css" : "application/javascript");
      res.send(await readFile(new URL(req.params.asset, dialkitUrl), "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/board-sdk.js", async (req, res, next) => {
    try {
      res.setHeader("cache-control", "no-store");
      res.type("application/javascript").send(await readFile(boardSdkUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/board.css", async (req, res, next) => {
    try {
      res.setHeader("cache-control", "no-store");
      res.type("text/css").send(await readFile(boardCssUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome-client.js", async (req, res, next) => {
    try {
      res.type("application/javascript").send(await readFile(chromeClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome.css", async (req, res, next) => {
    try {
      res.type("text/css").send(await readFile(chromeCssUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/design/:asset", async (req, res, next) => {
    try {
      const asset = designAssetUrls[req.params.asset];
      if (!asset) {
        res.status(404).send("Not found");
        return;
      }
      res.type(asset.type).send(await readDesignAsset(asset));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sdk.js", async (req, res, next) => {
    try {
      const verified = await store.verifyArtifactLoad(
        String(req.query.key || ""),
        req.query.artifact_load_token,
        req.query.artifact_revision,
      );
      if (!verified) {
        sendSessionNotFound(req, res);
        return;
      }
      if (!verified.valid) {
        res.status(409).json({ status: "stale" });
        return;
      }
      res.type("application/javascript").send(
        createSdkJs(String(req.query.key || ""), verified.artifact_revision, verified.artifact_load_token, {
          maxAttachmentCount: attachmentConfig.maxPerPrompt,
          maxAttachmentBytes: attachmentConfig.maxBytes,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // The whiteboard frame page. Hosted by the chrome in a dedicated sandboxed
  // iframe (allow-scripts allow-popups, no allow-same-origin) so untrusted
  // Mermaid text renders - and the Excalidraw editor runs - inside an opaque
  // origin, matching the artifact iframe's trust posture. The chrome passes
  // the diagram source and saved scene over postMessage after the frame
  // reports ready.
  app.get("/whiteboard-frame", (req, res) => {
    res.setHeader("cache-control", "no-store");
    // The frame's channel token is minted for one session, so the caller must
    // name it. Both call sites (the chrome overlay and the artifact SDK's
    // inline embed) know their own key; a request without one could only
    // produce a token that authenticates nothing, so reject it outright.
    const sessionKey = String(req.query.key || "");
    if (!isValidWhiteboardKey(sessionKey)) {
      res.status(400).type("text/plain").send("Missing session key");
      return;
    }
    res.type("html").send(createWhiteboardFrameHtml(createWhiteboardChannelToken(whiteboardChannelSecret, sessionKey)));
  });

  // Whiteboard bundle, stylesheet, and vendored Excalidraw fonts. The frame
  // runs in an opaque origin, and font fetches from an opaque origin are
  // CORS-gated, so this static, public-content route must answer with
  // Access-Control-Allow-Origin: * or every canvas font falls back.
  app.get(/^\/whiteboard-assets\/(.+)$/, async (req, res, next) => {
    try {
      const file = await resolveArtifactAsset(whiteboardAssetsDir, req.params[0]);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      if (!existsSync(file)) {
        res
          .status(404)
          .send(existsSync(whiteboardAssetsDir) ? "Not found" : "Whiteboard bundle missing - run `pnpm run build`");
        return;
      }
      res.setHeader("access-control-allow-origin", "*");
      // Revalidate on every use (304 via Last-Modified/ETag): the bundle URL
      // is unversioned, and a memory-cached stale bundle after an upgrade or
      // local rebuild is far worse than cheap loopback revalidations.
      res.setHeader("cache-control", "no-cache");
      // Traversal is already rejected by resolveArtifactAsset; "allow" keeps
      // dot components in the assets dir's own absolute path (e.g. a checkout
      // under a dot-directory) from 403ing every asset.
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  // Mermaid sources for a session's artifact, extracted from the HTML on disk
  // in document order so `index` matches the browser's `.mermaid` element
  // order. The hash feeds whiteboard staleness detection.
  app.get("/api/:key/mermaid-sources", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (refuseNonHtmlArtifact(session, res)) return;
      const html = await readFile(session.file, "utf8").catch(() => "");
      const extracted = extractMermaidSources(html);
      const usesLibraries = extracted.some(({ source }) => parseLibraryIconDirectives(source).length > 0);
      const snapshot = usesLibraries ? await loadExcalidrawLibraries(libraryDir) : null;
      const libraries = snapshot ? snapshot.libraries : [];
      const sources = extracted.map(({ index, source }) => ({
        index,
        source,
        hash: whiteboardSourceHash(source, libraries),
      }));
      // The chrome compares this with /api/whiteboard-libraries' version: a
      // library file that changed between the two requests means the frame's
      // libraries do not match these hashes.
      res.json(snapshot ? { sources, libraries_version: snapshot.version } : { sources });
    } catch (error) {
      next(error);
    }
  });

  // User-supplied Excalidraw libraries for every whiteboard's library panel and
  // for `%% liesel-icon` nodes. Read-only: Liesel never writes that directory.
  app.get("/api/whiteboard-libraries", async (req, res, next) => {
    try {
      if (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard library request rejected" });
        return;
      }
      const { libraries, version } = await loadExcalidrawLibraries(libraryDir);
      res.setHeader("cache-control", "no-store");
      res.json({ libraries: libraries.map(({ id, items }) => ({ id, items })), version });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/whiteboard/:index", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session || !isValidDiagramIndex(req.params.index)) {
        res.status(404).json({ error: "whiteboard not found" });
        return;
      }
      const whiteboard = await loadWhiteboard(whiteboardStateRoot, req.params.key, Number(req.params.index));
      res.json({ whiteboard });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/whiteboard-channel", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard channel request rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (!isValidWhiteboardChannelToken(req.body?.token, whiteboardChannelSecret, req.params.key)) {
        res.status(403).json({ error: "invalid whiteboard channel" });
        return;
      }
      res.json({ status: "authenticated" });
    } catch (error) {
      next(error);
    }
  });

  // Writing to the local state directory is a state-changing action, so both
  // whiteboard write routes are same-origin guarded like /share - a hostile
  // cross-origin page must not be able to fill the state dir through the
  // loopback server.
  app.put("/api/:key/whiteboard/:index", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard write rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session || !isValidWhiteboardKey(req.params.key) || !isValidDiagramIndex(req.params.index)) {
        res.status(404).json({ error: "whiteboard not found" });
        return;
      }
      const body = req.body || {};
      await saveWhiteboard(whiteboardStateRoot, req.params.key, Number(req.params.index), {
        sourceHash: String(body.source_hash || body.sourceHash || ""),
        textMetricsVersion: Number(body.text_metrics_version || body.textMetricsVersion) || 0,
        scene: body.scene ?? null,
        baseline: body.baseline ?? null,
      });
      res.json({ status: "saved" });
    } catch (error) {
      next(error);
    }
  });

  // Publish the agent-facing feedback files (.excalidraw scene + PNG preview)
  // for a diagram, returning their absolute paths for the queued prompt's
  // target. Files stay on this machine; the prompt carries only the paths.
  app.post("/api/:key/whiteboard/:index/feedback-files", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard write rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session || !isValidWhiteboardKey(req.params.key) || !isValidDiagramIndex(req.params.index)) {
        res.status(404).json({ error: "whiteboard not found" });
        return;
      }
      const body = req.body || {};
      const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(
        whiteboardStateRoot,
        req.params.key,
        Number(req.params.index),
        { scene: body.scene ?? null, pngDataUrl: String(body.pngDataUrl || body.png_data_url || "") },
      );
      res.json({ scene_path: scenePath, preview_path: previewPath });
    } catch (error) {
      next(error);
    }
  });

  // Annotation image attachments. Upload writes raw bytes to the state dir and
  // returns server-vetted metadata (content-hash id + absolute path); the prompt
  // later references the id and the server re-resolves it (see queuePrompts).
  // Upload and delete write/remove local files, so they are same-origin guarded
  // like the whiteboard writes - a hostile cross-origin page must not drive them.
  app.post("/api/:key/attachments", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin attachment upload rejected" });
        return;
      }
      if (!isValidAttachmentKey(req.params.key) || !(await store.findByKey(req.params.key))) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      // Read the raw stream ourselves, draining past the cap to end-of-body before
      // responding. That guarantees the browser receives the 413 for an over-cap
      // upload instead of a mid-stream connection reset (only the same-origin chrome
      // can reach this route, so draining a rejected body is bounded and trusted).
      const { tooLarge, buffer } = await readAttachmentUploadBody(req, attachmentConfig.maxBytes);
      if (tooLarge) {
        res.status(413).json({ error: `attachment exceeds the ${attachmentConfig.maxBytes} byte limit` });
        return;
      }
      // Finalize under the lifecycle lock so the dedup mtime refresh (B3), the dims
      // sidecar write, AND the disk-cap admission (reference snapshot + reclaim +
      // write) are one atomic critical section. Admission is a HARD cap: a new object
      // that can't fit after reclaiming unreferenced files is refused with 507, so
      // concurrent pages can never push committed storage past `maxDiskBytes` via
      // queued references (the sweep alone never evicts referenced files). The
      // eviction grace keeps a just-uploaded ready card off the reclaim list so it
      // survives until the user sends it.
      const attachment = await store.runExclusive(async () => {
        const referenced = await store.referencedAttachmentIds();
        return writeAttachment(attachmentStateRoot, req.params.key, buffer, {
          maxBytes: attachmentConfig.maxBytes,
          maxDiskBytes: attachmentConfig.maxDiskBytes,
          maxObjects: attachmentConfig.maxObjects,
          ttlMs: attachmentConfig.ttlMs,
          referenced,
          evictionGraceMs: attachmentConfig.evictionGraceMs,
        });
      });
      res.json({ status: "stored", attachment });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/attachments/:id", async (req, res, next) => {
    try {
      // D6: a render is one stat + one streamed read. `statAttachmentForServe`
      // confirms existence and derives the mime from the validated id extension
      // WITHOUT re-parsing the image to recover dimensions the route never uses.
      const serve = await statAttachmentForServe(attachmentStateRoot, req.params.key, req.params.id);
      if (!serve) {
        res.status(404).json({ error: "attachment not found" });
        return;
      }
      res.setHeader("cache-control", "private, max-age=300");
      res.type(serve.mime);
      res.sendFile(serve.file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/:key/attachments/:id", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin attachment delete rejected" });
        return;
      }
      // Reference-counted delete under the lifecycle lock: a content-addressed file
      // shared by an already-queued prompt (the same image attached twice, deduped
      // to one id) must survive a chip removal, or the queued prompt's thumbnail and
      // path break. `referencedAttachmentIds` also covers attachments delivered
      // within the read grace, so a poll's images are not deletable out from under
      // the agent. The chrome never drives this route (see chrome-client's note on
      // the removed eager delete); it remains a same-origin-guarded server API.
      const status = await store.runExclusive(async () => {
        const referenced = await store.referencedAttachmentIds();
        if (referenced.has(`${req.params.key}/${req.params.id}`)) return "referenced";
        return (await removeAttachment(attachmentStateRoot, req.params.key, req.params.id)) ? "removed" : "absent";
      });
      res.json({ status });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, _next) => {
    // Body-parser errors carry a meaningful HTTP status (413 payload-too-large,
    // 400 malformed JSON); surface it instead of flattening everything to 500.
    const status = Number(error?.statusCode || error?.status) || 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const eventWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  function rejectEventUpgrade(socket, status, message) {
    const body = `${message}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }

  function handleEventUpgrade(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(String(req.url || ""), "http://liesel.local").pathname;
    } catch {
      rejectEventUpgrade(socket, 400, "Bad Request");
      return;
    }
    const match = pathname.match(/^\/events\/([^/]+)$/);
    if (!match) {
      rejectEventUpgrade(socket, 404, "Not Found");
      return;
    }

    const hostAllowed = allowAnyHostname
      ? parseHostAuthority(req.headers.host) !== null
      : isAllowedRequestHost(
          { host: req.headers.host, forwardedHost: req.headers["x-forwarded-host"] },
          allowedHostnames,
        );
    // WebSocket reads are not protected by CORS. Require the chrome page's exact Origin as well
    // as the normal Host allowlist so a foreign site cannot read a known session's live events.
    if (!hostAllowed || !req.headers.origin || !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
      rejectEventUpgrade(socket, 403, "Forbidden");
      return;
    }

    let key;
    try {
      key = decodeURIComponent(match[1]);
    } catch {
      rejectEventUpgrade(socket, 400, "Bad Request");
      return;
    }
    eventWebSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
      const client = {
        sendEvent(type, data) {
          if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify({ type, data }));
        },
        close(code = 1001, reason = "Liesel server shutdown") {
          webSocket.close(code, reason);
          const terminateTimer = setTimeout(() => {
            if (webSocket.readyState !== WebSocket.CLOSED) webSocket.terminate();
          }, WEBSOCKET_CLOSE_GRACE_MS);
          terminateTimer.unref?.();
          webSocket.once("close", () => clearTimeout(terminateTimer));
        },
        isClosed() {
          return webSocket.readyState === WebSocket.CLOSING || webSocket.readyState === WebSocket.CLOSED;
        },
      };
      webSocket.on("error", () => {});
      // Liveness, not latency: a reviewer whose machine slept leaves a socket that never emits
      // `close`, so only an unanswered ping proves they are gone. `terminate()` emits `close`,
      // which runs the same cleanup a graceful disconnect does - dropping the client from
      // liveEventClients and re-arming the idle timer.
      if (liveEventHeartbeatMs != null && liveEventHeartbeatMs > 0) {
        let awaitingPong = false;
        const heartbeat = setInterval(() => {
          if (awaitingPong) {
            logEvent?.(`event WebSocket heartbeat missed session=${key}, terminating`);
            webSocket.terminate();
            return;
          }
          awaitingPong = true;
          try {
            webSocket.ping();
          } catch {
            webSocket.terminate();
          }
        }, liveEventHeartbeatMs);
        heartbeat.unref?.();
        webSocket.on("pong", () => {
          awaitingPong = false;
        });
        webSocket.once("close", () => clearInterval(heartbeat));
      }
      const cleanup = attachLiveEventClient(client, key, (remove) => webSocket.once("close", remove));
      sendInitialLiveEventState(client, key, cleanup).catch((error) => {
        client.close(1011, "Failed to initialize live events");
        cleanup();
        logEvent?.(`event WebSocket initialization failed session=${key}: ${error?.message || error}`);
      });
    });
  }

  const httpServers = [];
  const boundHosts = [];
  let boundPort = port;
  let lastBindError = null;

  // One listen attempt. A listener that finishes binding after shutdown began is closed at once,
  // or it would keep the process alive with nothing left to serve.
  // A configured name is resolved here, through the same lookup and all-interfaces refusal as at
  // startup, so one that only resolves later is served at its address and reported by it. A name
  // that resolves to an address already bound is served by that listener.
  async function listenOnce(listenHost) {
    const address = isIP(listenHost) ? listenHost : (await resolveConcreteListenHosts([listenHost], lookupOptions))[0];
    if (address !== listenHost) {
      if (!listenHosts.includes(address)) listenHosts.push(address);
      if (boundHosts.includes(address)) {
        boundHosts.push(listenHost);
        return;
      }
    }
    const httpServer = await listenHttp(app, boundPort, address, (error) => {
      writeLog(`[liesel] HTTP server error: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (shuttingDown) {
      httpServer.close();
      throw new Error("Liesel server is shutting down");
    }
    httpServer.on("upgrade", handleEventUpgrade);
    if (boundPort === 0) boundPort = httpServer.address().port;
    if (!publicPort) publicPort = boundPort;
    httpServers.push(httpServer);
    boundHosts.push(listenHost);
    if (address !== listenHost) boundHosts.push(address);
  }

  // Bind one address, retrying a transient failure. Whether anything else has bound yet is
  // deliberately NOT consulted here: that check used to run before the retry, which made both the
  // retry and the loopback fallback unreachable whenever the first (or only) host failed - exactly
  // the single pinned-host case, where the process then exited with no listener at all.
  async function bindListener(listenHost) {
    let retryIndex = 0;
    while (true) {
      try {
        await listenOnce(listenHost);
        return null;
      } catch (error) {
        if (!shuttingDown && retryIndex < BIND_RETRY_DELAYS_MS.length) {
          await new Promise((resolve) => setTimeout(resolve, BIND_RETRY_DELAYS_MS[retryIndex]));
          retryIndex += 1;
          continue;
        }
        return error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  // Session URLs, the Host allowlist, and phone readiness all follow what is actually bound, so
  // they are recomputed whenever a listener comes up rather than frozen at startup.
  function applyNetworkState() {
    tailscalePhoneReady = Boolean(tailscale?.ipv4 && boundHosts.includes(tailscale.ipv4));
    if (linkHostName != null) {
      resolvedLinkHost = linkHostName;
    } else if (tailscalePhoneReady) {
      resolvedLinkHost = resolveLinkHost({ env, tailscale, fallbackHost: host });
    } else if (boundHosts.includes(listenHosts[0])) {
      resolvedLinkHost = resolveLinkHost({ env, tailscale: null, fallbackHost: host });
    } else {
      // Session URLs must name somewhere that is actually listening, so while the requested host
      // is unbound the link host moves to loopback unless the operator named one explicitly.
      resolvedLinkHost = resolveLinkHost({ env, tailscale: null, fallbackHost: LOOPBACK_HOST });
    }
    const servesHost = (candidate) => candidate !== tailscale?.ipv4 || tailscalePhoneReady;
    const nextAllowedHostnames = buildAllowedHostnames({
      host: requestedListenHosts[0],
      hosts: [...requestedListenHosts.filter(servesHost), ...listenHosts.filter(servesHost), ...boundHosts],
      linkHost: resolvedLinkHost,
      allowedHosts: extraHosts,
    });
    allowedHostnames.clear();
    for (const allowedHostname of nextAllowedHostnames) allowedHostnames.add(allowedHostname);
  }

  // A later attempt for every requested address still unbound. Shared by the background schedule
  // and by /health?reconcile_network=1, so a CLI invocation right after the address frees up binds
  // it immediately instead of waiting for the next tick.
  let bindRecoveryInFlight = null;
  async function retryPendingBinds() {
    if (pendingBinds.size === 0 || shuttingDown) return;
    if (!bindRecoveryInFlight) {
      bindRecoveryInFlight = (async () => {
        let bound = false;
        for (const listenHost of [...pendingBinds.keys()]) {
          if (shuttingDown) return;
          try {
            await listenOnce(listenHost);
            pendingBinds.delete(listenHost);
            bound = true;
            writeLog(`[liesel] now listening on ${hostForUrl(listenHost)}:${boundPort} after an earlier bind failure.`);
          } catch (error) {
            if (!shuttingDown) pendingBinds.set(listenHost, error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (bound) applyNetworkState();
      })().finally(() => {
        bindRecoveryInFlight = null;
      });
    }
    await bindRecoveryInFlight;
  }

  let bindRecoveryAttempt = 0;
  function scheduleBindRecovery() {
    if (shuttingDown || pendingBinds.size === 0 || bindRecoveryTimer || !bindRecoveryDelaysMs.length) return;
    const delay = bindRecoveryDelaysMs[Math.min(bindRecoveryAttempt, bindRecoveryDelaysMs.length - 1)];
    bindRecoveryAttempt += 1;
    bindRecoveryTimer = setTimeout(() => {
      bindRecoveryTimer = null;
      retryPendingBinds()
        .catch(() => {})
        .finally(() => scheduleBindRecovery());
    }, delay);
    bindRecoveryTimer.unref?.();
  }

  // Loopback is bound first because it is this port's control address: every CLI probes it
  // whatever its own LIESEL_HOST says. Whoever holds it owns the port, so a second Liesel
  // server started concurrently (two agents with different host settings) loses here and exits
  // instead of taking the remaining addresses and splitting one port across two daemons that share
  // one state file.
  const bindOrder = listenHosts.includes(LOOPBACK_HOST)
    ? [LOOPBACK_HOST, ...listenHosts.filter((listenHost) => listenHost !== LOOPBACK_HOST)]
    : listenHosts;
  for (const listenHost of bindOrder) {
    const error = await bindListener(listenHost);
    if (!error) continue;
    lastBindError = error;
    if (listenHost === LOOPBACK_HOST && isAddressInUseBindError(error)) {
      const owner = await probeLieselHealth(LOOPBACK_HOST, boundPort);
      throw new Error(
        owner
          ? `Another Liesel server (version ${owner.version || "unknown"}) already owns port ${boundPort} on ${LOOPBACK_HOST}; not starting a second one.`
          : `Loopback ${LOOPBACK_HOST}:${boundPort} is already in use; not starting a Liesel server on another address.`,
        { cause: error },
      );
    }
    pendingBinds.set(listenHost, error);
  }

  // Loopback floor. A server that cannot reach its requested address is still far more useful on
  // loopback than absent: the local agent CLI keeps working, and the next invocation finds THIS
  // server instead of spawning a duplicate beside it. Only reached when nothing else bound and
  // loopback was not requested, so a healthy multi-listener startup is untouched.
  if (httpServers.length === 0 && !listenHosts.includes(LOOPBACK_HOST)) {
    const error = await bindListener(LOOPBACK_HOST);
    if (error) lastBindError = error;
  }
  if (httpServers.length === 0) {
    throw new Error(
      `Liesel server failed to bind any address${lastBindError ? `: ${lastBindError.message}` : ""}`,
      lastBindError ? { cause: lastBindError } : undefined,
    );
  }
  // The CLI control channel only probes the primary requested host and loopback. A process that
  // bound neither is alive and unreachable, so close every listener already taken in this call.
  if (!boundHosts.includes(LOOPBACK_HOST) && !boundHosts.includes(listenHosts[0])) {
    const error = new Error(
      `Liesel server failed to bind a control-channel address${lastBindError ? `: ${lastBindError.message}` : ""}`,
      lastBindError ? { cause: lastBindError } : undefined,
    );
    await Promise.all(
      httpServers.splice(0).map(
        (httpServer) =>
          new Promise((resolve) => {
            httpServer.close(() => resolve(undefined));
          }),
      ),
    );
    boundHosts.length = 0;
    throw error;
  }
  applyNetworkState();
  publicPort = httpServers[0].address().port;
  // Always logged, not only under --verbose: an address that silently stopped serving is what left
  // tailnet review links dead for most of an hour with nothing but a debug line to show for it.
  for (const [listenHost, error] of pendingBinds) {
    writeLog(`[liesel] WARNING: ${describeBindFailure(listenHost, error)}`);
  }
  serverReady = true;
  scheduleBindRecovery();

  // `cause` is log-only and never reaches a chrome: `reason` is the user-facing SHUTDOWN_REASONS
  // value, and widening it here would let an internal cause render as a banner line that claims
  // something untrue. Without the log line, server.log records an exit with no explanation at all.
  function shutdown(reloadKey = "", reason = "", cause = "requested") {
    if (shuttingDown) return;
    shuttingDown = true;
    writeLog(`[liesel] shutting down: ${cause}${reason ? ` (reason=${reason})` : ""}`);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (attachmentSweepTimer) {
      clearInterval(attachmentSweepTimer);
      attachmentSweepTimer = null;
    }
    if (bindRecoveryTimer) {
      clearTimeout(bindRecoveryTimer);
      bindRecoveryTimer = null;
    }
    boardNotifier.close();
    projectsClosed = closeProjects();
    for (const run of boardRuns.values()) run.stop?.();
    for (const timer of runnerBroadcastTimers.values()) clearTimeout(timer);
    runnerBroadcastTimers.clear();
    // Only the chrome whose artifact is being reopened is reloaded: the replacement server
    // adopts that session via state.json once it binds, and the caller named it. Every other
    // open review page is told why this server went away and left alone - a forced reload of a
    // page the user is reading or writing in is exactly what this avoids.
    // Both events carry the same reason: the reloaded page can end up showing a line from it too,
    // and two pages describing one shutdown differently is how a false claim gets in.
    const shutdownData = { reason };
    for (const [client, clientKey] of liveEventClients) {
      try {
        if (reloadKey && clientKey === reloadKey) {
          client.sendEvent("chrome-reload", shutdownData);
        } else {
          client.sendEvent("chrome-outdated", shutdownData);
        }
        client.close();
      } catch {
        // best effort
      }
    }
    liveEventClients.clear();
    for (const timer of browserDisconnectTimers.values()) clearTimeout(timer);
    browserDisconnectTimers.clear();
    for (const w of watchers.values()) {
      w.close().catch(() => {});
    }
    watchers.clear();
    let remaining = httpServers.length;
    const closed = () => {
      remaining -= 1;
      if (remaining === 0) shutdownResolve();
    };
    for (const httpServer of httpServers) {
      httpServer.close(closed);
      // Force-close keep-alive sockets so legacy SSE / long-polls don't keep us alive.
      if (typeof httpServer.closeAllConnections === "function") {
        httpServer.closeAllConnections();
      }
    }
  }

  // Idle self-shutdown: the timer only runs while nothing is connected. Any live event chrome or
  // active long-poll cancels it; losing the last connection (re)arms it.
  function refreshIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (shuttingDown || idleTimeoutMs == null) return;
    // A running board agent is a live connection too: its reply has nowhere to go if the
    // server steps down under it.
    if (liveEventClients.size > 0 || activePolls.size > 0 || activeRunCount() > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!shuttingDown && liveEventClients.size === 0 && activePolls.size === 0 && activeRunCount() === 0) {
        shutdown("", "", `idle-timeout after ${idleTimeoutMs}ms with no connections`);
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  // When the final open session ends with nothing connected, there is nothing left to serve,
  // so step down immediately rather than waiting out the idle timeout. If a browser chrome or
  // poll is still attached (e.g. the user is about to reopen), leave the server up and let the
  // idle timer reap it once those connections drop. Best-effort: never let a read failure
  // block the end response.
  async function shutdownIfNoLiveSessions() {
    if (liveEventClients.size > 0 || activePolls.size > 0 || activeRunCount() > 0) return;
    try {
      const sessions = await store.listSessions();
      if (sessions.every((session) => session.status === "ended")) {
        setImmediate(() => shutdown("", "", "last open session ended with no live connections"));
      }
    } catch {
      // ignore - the idle timer remains as a backstop
    }
  }

  // A queued repair batch is outstanding until a diagnostic pass re-checks it. While it is, the
  // agent's related saves coalesce into one artifact refresh for that group.
  async function syncOutstandingRepairs(key) {
    try {
      if (await store.hasOutstandingLayoutRepairs(key)) {
        outstandingRepairBatches.add(key);
      } else {
        outstandingRepairBatches.delete(key);
      }
    } catch {
      // Best effort - the normal debounce still applies.
    }
  }

  function reloadDebounceMs(key) {
    return outstandingRepairBatches.has(key) ? BATCH_RELOAD_DEBOUNCE_MS : RELOAD_DEBOUNCE_MS;
  }

  // Reference-aware attachment cleanup: reap files that are both past their TTL
  // and unreferenced, plus the optional disk-cap backstop. Runs once at startup
  // and then on a fixed interval; skipped entirely when neither a TTL nor a disk
  // cap is configured. Never touches attachments referenced by pending prompts.
  const attachmentSweepEnabled = attachmentConfig.ttlMs != null || attachmentConfig.maxDiskBytes != null;
  async function sweepAttachmentsNow() {
    try {
      // The reference snapshot AND the enumerate/delete run as one critical section
      // so a reference acquired mid-sweep (a concurrent upload finalize or /prompts
      // resolve) can never point at a file this sweep is about to remove (D5).
      const result = await store.runExclusive(async () => {
        const referenced = await store.referencedAttachmentIds();
        return sweepAttachments(attachmentStateRoot, {
          ttlMs: attachmentConfig.ttlMs,
          maxDiskBytes: attachmentConfig.maxDiskBytes,
          maxObjects: attachmentConfig.maxObjects,
          referenced,
          evictionGraceMs: attachmentConfig.evictionGraceMs,
        });
      });
      if (result.deleted > 0) {
        logEvent?.(`attachment sweep removed ${result.deleted} file(s), freed ${result.freedBytes} bytes`);
      }
    } catch (error) {
      logEvent?.(`attachment sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (attachmentSweepEnabled) {
    sweepAttachmentsNow();
    attachmentSweepTimer = setInterval(() => {
      sweepAttachmentsNow();
    }, ATTACHMENT_SWEEP_INTERVAL_MS);
    attachmentSweepTimer.unref?.();
  }

  // Arm the idle timer for a server that is spawned but never opens a session.
  refreshIdleTimer();

  return {
    port: publicPort,
    hosts: boundHosts,
    addresses: httpServers.map((server) => server.address()),
    close: async () => {
      shutdown("", "", "close() called");
      await done;
      await projectsClosed;
    },
    done,
  };
}

function listenHttp(app, port, host, onRuntimeError) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    let listening = false;
    const onError = (error) => {
      if (!listening) {
        server.off("listening", onListening);
        reject(error);
        return;
      }
      onRuntimeError?.(error);
    };
    const onListening = () => {
      listening = true;
      const address = server.address();
      if (address && typeof address === "object" && isWildcardHost(address.address)) {
        server.close(() => reject(new Error(`Refusing all-interfaces listener at ${address.address}`)));
        return;
      }
      resolve(server);
    };
    // Keep this listener after startup: removing it when `listening` fires turns any later server
    // error into an unhandled EventEmitter error that terminates the detached process silently.
    server.on("error", onError);
    server.once("listening", onListening);
    // `host` has already been sanitized by resolveListenHosts. Keeping this helper
    // concrete is an important defense: Tailscale reachability must never turn into
    // an all-interfaces wildcard listener.
    server.listen({ port, host });
  });
}

function tailscaleNetworkKey(tailscale) {
  if (!tailscale) return "down";
  if (tailscale.warning) return "incomplete";
  if (!tailscale.ipv4 || !tailscale.magicDnsName) return "incomplete";
  return `up\n${tailscale.ipv4}\n${tailscale.magicDnsName}`;
}

function isAddressInUseBindError(error) {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

// Whether a Liesel server answers /health at this address. Bounded, because a foreign process
// that accepts the connection and never answers must not stall startup, and the socket is
// destroyed on every exit path: a lingering probe connection keeps a failed server process alive
// and holds the other process's close() open.
function probeLieselHealth(host, port) {
  return new Promise((resolve) => {
    const request = httpGet({ host, port, path: "/health", agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy();
      });
      response.on("end", () => {
        request.destroy();
        try {
          const parsed = JSON.parse(body);
          resolve(parsed && typeof parsed === "object" && parsed.app === SERVER_APP_ID ? parsed : null);
        } catch {
          resolve(null);
        }
      });
      response.on("error", () => resolve(null));
    });
    request.setTimeout(LOOPBACK_OWNER_PROBE_TIMEOUT_MS, () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
    request.on("close", () => resolve(null));
  });
}

function wantsHtml(req) {
  const accept = String(req.get("accept") || "");
  return accept.toLowerCase().includes("text/html");
}

/**
 * The folder a New board form names: absolute, or under the home folder with `~/`. The
 * folder is created when missing. A file, the filesystem root and the home folder itself
 * are refused, since every HTML file in a board folder becomes an item.
 * @param {unknown} input
 * @returns {Promise<string>}
 */
export async function prepareBoardFolder(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new BoardError("Choose a folder for the board");
  const home = homedir();
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) {
    throw new BoardError("Give the folder as a full path, such as ~/Liesel/my-board");
  }
  const folder = path.resolve(expanded);
  if (path.parse(folder).root === folder || folder === path.resolve(home)) {
    throw new BoardError("Choose a folder of its own for the board");
  }
  const existing = await stat(folder).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing && !existing.isDirectory()) throw new BoardError("That path is a file, not a folder");
  if (!existing) await mkdir(folder, { recursive: true });
  return folder;
}

function createDeniedHtml({ title, message, workingUrl }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeUrl = escapeHtml(workingUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle} - Liesel</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f4ef;color:#25221f;font:16px/1.5 system-ui,sans-serif}.card{width:min(560px,calc(100% - 40px));padding:32px;border:1px solid #d9d0c5;border-radius:16px;background:#fffdf9;box-shadow:0 12px 40px #25221f18}h1{margin:0 0 12px;font-size:26px}p{margin:0 0 18px}.url{display:block;padding:12px 14px;border-radius:10px;background:#f0ebe4;color:#25221f;overflow-wrap:anywhere}a{color:inherit;font-weight:700}</style></head><body><main class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p><p>Open this working URL:</p><a class="url" href="${safeUrl}">${safeUrl}</a></main></body></html>`;
}

async function readDesignAsset(asset) {
  try {
    return await readFile(asset.packaged, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    return readFile(asset.source, "utf8");
  }
}

// Map a legacy root-absolute `/design/<asset>` reference to the packaged design file on disk
// (falling back to the node_modules source for source runs) so an export can inline it instead
// of pointing back at this server's `/design` route.
export function resolveDesignAssetPath(refPath) {
  const match = /^\/design\/([^/?#]+)(?:[?#].*)?$/.exec(refPath);
  if (!match) return null;
  const asset = designAssetUrls[match[1]];
  if (!asset) return null;
  const packaged = fileURLToPath(asset.packaged);
  if (existsSync(packaged)) return packaged;
  const source = fileURLToPath(asset.source);
  return existsSync(source) ? source : null;
}

export function exportContentDisposition(file) {
  const filename = exportFileName(file);
  return `attachment; filename="${sanitizeDispositionFilename(filename)}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function sanitizeDispositionFilename(filename) {
  const fallback = Array.from(String(filename || ""), (char) => {
    const codePoint = char.codePointAt(0) || 0;
    if (codePoint < 0x20 || codePoint > 0x7e || char === '"' || char === "\\") return "_";
    return char;
  }).join("");
  return fallback || "artifact.export.html";
}

function encodeRfc5987Value(value) {
  return encodeURIComponent(String(value)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// The set of Host header hostnames this server answers to: loopback names plus
// every concrete listener and the resolved link host. Wildcard bind values and the
// explicit "*" opt-out never become hostnames. Lowercased for case-insensitive
// comparison against the incoming Host.
export function buildAllowedHostnames({ host, hosts = [], linkHost: linkHostName, allowedHosts = [] }) {
  return new Set(
    [LOOPBACK_HOST, IPV6_LOOPBACK_HOST, "localhost", host, ...hosts, linkHostName, ...allowedHosts]
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .filter((value) => value && value !== "*" && !isWildcardHost(value)),
  );
}

// A lone "*" in LIESEL_ALLOWED_HOSTS is an explicit opt-out of the Host
// allowlist, for operators who front the server with their own auth/proxy.
export function allowsAllHosts(allowedHosts = []) {
  return allowedHosts.some((value) => String(value).trim() === "*");
}

function parseHostAuthority(value) {
  const raw = String(value).trim();
  if (!raw || /[@/\\?#\s]/.test(raw)) return null;

  let hostname;
  let port;
  let bracketed = false;
  if (raw.startsWith("[")) {
    const match = /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/.exec(raw);
    if (!match || isIP(match[1]) !== 6) return null;
    [, hostname, port = ""] = match;
    bracketed = true;
  } else {
    const match = /^([A-Za-z0-9._-]+)(?::(\d+))?$/.exec(raw);
    if (!match) return null;
    [, hostname, port = ""] = match;
  }
  if (port && Number(port) > 65535) return null;

  hostname = hostname.toLowerCase();
  const authority = `${bracketed ? `[${hostname}]` : hostname}${port ? `:${port}` : ""}`;
  try {
    const parsed = new URL(`http://${authority}`);
    if (!parsed.origin || parsed.origin === "null") return null;
  } catch {
    return null;
  }
  return { hostname, port, authority };
}

// Extract the hostname (without port) from a Host header value, honoring
// bracketed IPv6 literals ("[::1]:4387"). Returns null for a malformed authority.
export function hostnameFromHostHeader(value) {
  return parseHostAuthority(value)?.hostname ?? null;
}

// DNS-rebinding defense: a loopback-bound server answers only to its own known
// hostnames. A rebound browser carries the attacker's domain in Host and is
// rejected. Host is mandatory in HTTP/1.1 and every browser sends it, so a
// missing or blank value is never a legitimate client - reject it rather than
// fail open.
export function isAllowedHostHeader(hostHeader, allowedHostnames) {
  if (hostHeader === undefined || hostHeader === null) return false;
  const authority = parseHostAuthority(hostHeader);
  return authority !== null && allowedHostnames.has(authority.hostname);
}

// Validate a request's effective host for DNS-rebinding protection. The Host
// header is required and must be allowlisted. When an X-Forwarded-Host is present
// - a reverse proxy in front of the loopback server - its outermost (last) value
// must ALSO be allowlisted, so a proxy works once its public hostname is added to
// LIESEL_ALLOWED_HOSTS. This is an AND check: a client-spoofed forwarded host
// can only narrow access (Host is still checked), never widen it into a bypass. A
// blank forwarded host is treated as absent, matching how proxies omit it.
/**
 * @param {{ host?: string|undefined|null, forwardedHost?: string|undefined|null }} headers
 * @param {Set<string>} allowedHostnames
 */
export function isAllowedRequestHost({ host, forwardedHost }, allowedHostnames) {
  if (!isAllowedHostHeader(host, allowedHostnames)) return false;
  const forwarded = forwardedHost === undefined || forwardedHost === null ? "" : String(forwardedHost).trim();
  if (forwarded === "") return true;
  return isAllowedHostHeader(forwarded.split(",").pop(), allowedHostnames);
}

function hasPresentOriginOrReferer(req) {
  return Boolean(req.get("origin") || req.get("referer"));
}

/** The origin the browser reached this server on, forwarding proxy included. */
function requestOrigin(req) {
  const lastValue = (header) =>
    String(header || "")
      .split(",")
      .pop()
      .trim();
  const forwarded = parseHostAuthority(lastValue(req.headers["x-forwarded-host"]));
  const host = forwarded ?? parseHostAuthority(req.headers.host);
  if (!host) return "";
  const forwardedProtocol = forwarded ? lastValue(req.headers["x-forwarded-proto"]).toLowerCase() : "";
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : req.protocol;
  return `${protocol}://${host.authority}`;
}

// Guard state-changing, outward-facing routes (publishing to a third-party host) against CSRF: a
// browser attaches an Origin/Referer that must match this server's own origin. The global
// mutating-route middleware reuses this helper so forwarded Host/Proto stay in lockstep; that
// middleware is lenient (absent headers pass) while per-route callers still reject header-less
// requests.
function isSameOriginRequest(req, allowedHostnames, allowAnyHostname = false) {
  const host = parseHostAuthority(req.headers.host);
  if (!host) return false;

  let protocol = req.protocol || "http";
  let authority = host;
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")
    .pop()
    .trim();
  if (forwardedHost) {
    const forwardedAuthority = parseHostAuthority(forwardedHost);
    if (
      !forwardedAuthority ||
      (!allowAnyHostname &&
        (!allowedHostnames.has(host.hostname) || !allowedHostnames.has(forwardedAuthority.hostname)))
    )
      return false;
    protocol = String(req.headers["x-forwarded-proto"] || protocol)
      .split(",")
      .pop()
      .trim()
      .toLowerCase();
    if (protocol !== "http" && protocol !== "https") return false;
    authority = forwardedAuthority;
  }
  const expectedOrigin = normalizeOrigin(`${protocol}://${authority.authority}`);
  if (!expectedOrigin) return false;
  const origin = req.headers.origin;
  if (origin) {
    return normalizeOrigin(origin) === expectedOrigin;
  }
  const referer = req.headers.referer;
  return Boolean(referer) && normalizeOrigin(referer) === expectedOrigin;
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function optionalBodyString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}

// Confines an asset request lexically first, then - like export-bundle.js's guardedRead -
// resolves the real (symlink-followed) path and refuses anything that escapes the session's
// artifact tree (the HTML file's directory), so a symlink placed beside the artifact can't
// make this route serve an outside file (e.g. ~/.ssh/id_rsa).
export async function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  let real;
  try {
    real = await realpath(file);
  } catch (error) {
    // Nonexistent path (e.g. an asset that hasn't been built yet): nothing to read, so the
    // lexical confinement above is enough - the caller's existsSync/sendFile handles the 404.
    // Every other realpath failure fails closed, like guardedRead.
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return file;
    }
    throw error;
  }
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const relativeReal = path.relative(realRoot, real);
  if (relativeReal === ".." || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
    return null;
  }
  // Hand back the resolved path, not the requested one: a real path contains no symlinks, so
  // sendFile re-opening it cannot be redirected by a link swapped in after this check.
  return real;
}

/**
 * @param {(key: string) => number} reloadDebounceMs
 */
async function watchSession(session, watchers, events, logEvent, reloadDebounceMs = () => RELOAD_DEBOUNCE_MS) {
  if (watchers.has(session.key)) {
    return;
  }
  const target = await resolveWatchTarget(session);
  if (watchers.has(session.key)) {
    return;
  }
  logEvent?.(`watch session=${session.key} scope=${target.scope} path=${target.path}`);
  const watcher = chokidar.watch(target.path, target.options);
  let timer = null;
  watcher.on("all", (event, file) => {
    logEvent?.(`watch event=${event} session=${session.key} file=${file ?? ""}`);
    clearTimeout(timer);
    timer = setTimeout(() => events.emit("reload", session.key), reloadDebounceMs(session.key));
  });
  watcher.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logEvent?.(`watch error session=${session.key} message=${message}`);
  });
  watchers.set(session.key, watcher);
}

// Watching the artifact's parent directory recursively can stall the event loop when the
// artifact lives in a large tree (e.g. ~/Downloads). Default to watching only the artifact
// itself; an artifact opts back into directory-wide live reload via either a
// `data-liesel-live-reload-root` attribute on its root element or
// `<meta name="liesel-live-reload" content="root">`.
export async function resolveWatchTarget(session) {
  const baseOptions = {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  };
  try {
    const html = await readFile(session.file, "utf8");
    if (hasLiveReloadRootOptIn(html)) {
      return {
        path: path.dirname(session.file),
        scope: "directory",
        options: {
          ...baseOptions,
          ignored: /(^|[/\\])(\.git|node_modules|dist|build|\.liesel)([/\\]|$)/,
        },
      };
    }
  } catch {
    // Fall through to file-only watching when the artifact can't be read.
  }
  return { path: session.file, scope: "file", options: baseOptions };
}

export function hasLiveReloadRootOptIn(html) {
  if (typeof html !== "string") return false;
  const searchableHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  if (/<html\b[^>]*\sdata-liesel-live-reload-root(?:[\s=>/]|$)[^>]*>/i.test(searchableHtml)) return true;
  return /<meta\b(?=[^>]*name=["']liesel-live-reload["'])(?=[^>]*content=["']root["'])[^>]*>/i.test(searchableHtml);
}

function releasePollListener(holder, activePolls, deliveredFeedback, events) {
  if (activePolls.get(holder.key) !== holder) return;
  const previousPresence = computePresence(holder.key, activePolls, deliveredFeedback);
  activePolls.delete(holder.key);
  const nextPresence = computePresence(holder.key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", holder.key, nextPresence);
}

function listenerLabel(holder) {
  return holder.owner || AGENT_LISTENER_LABEL;
}

function listenerConflict(holder, code) {
  return {
    status: "error",
    code,
    error:
      code === "LISTENER_ACTIVE" ? "Liesel already has an active poll listener" : "Liesel poll listener was replaced",
    holder: { label: listenerLabel(holder), age_ms: Math.max(0, Date.now() - holder.startedAt) },
  };
}

function markFeedbackDelivered(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.add(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) {
    events.emit("agent-presence", key, nextPresence);
  }
}

function clearFeedbackDelivery(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.delete(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) {
    events.emit("agent-presence", key, nextPresence);
  }
}

export function computePresence(key, activePolls, deliveredFeedback) {
  if (deliveredFeedback.has(key)) return "working";
  return activePolls.has(key) ? "listening" : "waiting";
}

function presenceSignature(key, activePolls, deliveredFeedback) {
  return `${computePresence(key, activePolls, deliveredFeedback)}:${presenceMode(key, activePolls, deliveredFeedback)}`;
}

export function presenceMode(key, activePolls, deliveredFeedback) {
  if (deliveredFeedback.has(key)) return "agent-busy";
  const holder = activePolls.get(key);
  if (!holder) return "waiting-on-captain";
  // --owner is used by a supervisor process listening on behalf of a worker. A bare poll is the
  // agent's own waiting round; an identified holder must not make the composer invite captain
  // input while the owning worker is busy elsewhere.
  return holder.owner ? "external-listener" : "agent-listener";
}

function presenceEventData(key, state, activePolls, deliveredFeedback) {
  const mode = presenceMode(key, activePolls, deliveredFeedback);
  return mode === "waiting-on-captain" ? { state } : { state, mode };
}

function chromeIcon(paths, size = 16, strokeWidth = 1.7) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const chromeIcons = {
  more: chromeIcon(
    '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  ),
  file: chromeIcon(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    13,
  ),
  copy: chromeIcon(
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    12,
  ),
  check: chromeIcon('<polyline points="20 6 9 17 4 12"/>', 12),
  refresh: chromeIcon(
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    15,
  ),
  camera: chromeIcon(
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    15,
  ),
  download: chromeIcon(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    15,
  ),
  globe: chromeIcon(
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14.5 14.5 0 0 1 0 18a14.5 14.5 0 0 1 0-18z"/>',
    15,
  ),
  exit: chromeIcon(
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    15,
  ),
  warning: chromeIcon(
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    16,
  ),
  reveal: chromeIcon('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>', 13),
  dismiss: chromeIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 13),
  // The desktop conversation-panel toggle: a window with its right-hand column marked off.
  sidebar: chromeIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/>'),
  // The mobile conversation sheet's only chevron: CSS rotates it when the sheet is open.
  chevronUp: chromeIcon('<polyline points="6 15 12 9 18 15"/>', 18, 2),
};

// Display the path with the home directory shortened to "~", split so the directory part can
// ellipsize in the menu while the file name itself always stays visible.
export function displayPathParts(file, home = homedir()) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");
  const display =
    normalizedHome && normalizedFile.startsWith(`${normalizedHome}/`)
      ? `~/${normalizedFile.slice(normalizedHome.length + 1)}`
      : normalizedFile;
  const tailStart = display.lastIndexOf("/") + 1;
  return { head: display.slice(0, tailStart), tail: display.slice(tailStart) };
}

export function shouldEnableLayoutGate(query = {}) {
  const noGate = query["no-gate"] ?? query.noGate ?? query.no_gate;
  if (isTruthyFlag(noGate)) return false;

  const gate = query.gate ?? query.layoutGate ?? query.layout_gate;
  if (isFalseyFlag(gate)) return false;

  return true;
}

function shouldDisableLayoutGateOpen(body = {}) {
  const noGate = body["no-gate"] ?? body.noGate ?? body.no_gate;
  if (isTruthyFlag(noGate)) return true;

  const gate = body.gate ?? body.layoutGate ?? body.layout_gate;
  return isFalseyFlag(gate);
}

function appendNoGateParam(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("no-gate", "1");
  return parsed.toString();
}

function isTruthyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isFalseyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function normalizeFlagValue(value) {
  if (Array.isArray(value)) return normalizeFlagValue(value[0]);
  return value === undefined || value === null ? "" : String(value).trim().toLowerCase();
}

const LIESEL_DEFAULT_FAVICON =
  "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F48E}</text></svg>\">";

function readTagAttr(tag, name) {
  // Tokenize real attributes rather than searching for the bare name anywhere in
  // the tag: a `\b`-anchored name matches attribute-name suffixes (e.g. `href`
  // inside `data-href`) and names that appear inside another attribute's quoted
  // value (e.g. `href=` inside a `title="... href=x"`), both of which would make
  // us adopt the wrong href. Walking whole `name="value"` pairs consumes each
  // value as one unit, so only genuine attribute names are matched.
  const attrRe = /([a-z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const target = name.toLowerCase();
  let match;
  while ((match = attrRe.exec(tag)) !== null) {
    if (match[1].toLowerCase() === target) {
      return (match[3] ?? match[4] ?? match[5] ?? "").trim();
    }
  }
  return "";
}

// Pull a tab favicon + title out of the artifact's own <head>. Liesel renders the
// artifact in a sandboxed iframe, so the artifact's own <link rel="icon"> and
// <title> never reach the browser tab; surfacing them here makes a wall of Liesel
// tabs identifiable. Falls back to the Liesel default favicon. Only data: and
// absolute (http/https/protocol-relative) icon hrefs are adopted verbatim;
// artifact-relative hrefs would not resolve against the chrome page, so they fall
// back to the default.
export function extractArtifactHead(html) {
  const head = String(html || "").slice(0, 10000);
  let faviconTag = LIESEL_DEFAULT_FAVICON;
  const linkTags = head.match(/<link\b(?:"[^"]*"|'[^']*'|[^"'>])*>/gi) || [];
  const iconTag = linkTags.find((tag) => /(^|\s)icon(\s|$)/i.test(readTagAttr(tag, "rel")));
  const iconHref = iconTag ? readTagAttr(iconTag, "href") : "";
  if (iconHref && /^(data:|https?:|\/\/)/i.test(iconHref)) {
    const safeHref = iconHref.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    faviconTag = `<link rel="icon" href="${safeHref}">`;
  }
  let title = "";
  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = titleMatch[1].replace(/\s+/g, " ").trim();
  return { faviconTag, title };
}

// The chrome page ships with the layout-gate overlay already covering the artifact area. Install
// its bounded escape and manual bypass inline before `chrome-client.js`, so they still work if the
// shared server shuts down between serving the page and serving that script. This block also arms
// the boot-failure card before the external script tag, surviving a request that hangs instead of
// erroring; `chrome-client.js` cancels that boot timer once it has run to completion and reuses the
// gate escape for every later overlay state.
export const CHROME_BOOT_FAILSAFE_MS = 15000;
export const CHROME_LAYOUT_GATE_MAX_HOLD_MS = 12000;
// The failsafe's button is the only control on a page whose client script is dead, so its own
// probe is bounded too: a port that accepts and never answers must not disable it for good.
const CHROME_BOOT_FAILSAFE_PROBE_TIMEOUT_MS = 4000;
const CHROME_BOOT_FAILSAFE_JS = `(function(){
var t=setTimeout(fail,${CHROME_BOOT_FAILSAFE_MS});
var o=document.getElementById("layoutGateOverlay"),h,c,a,b,gt=0,manual=false,ended=false;
try{ended=JSON.parse(document.getElementById("liesel-session").textContent).initialEnded===true;}catch(e){}
function cancelGate(){if(gt)clearTimeout(gt);gt=0;}
function reveal(){cancelGate();if(o)o.hidden=true;if(document.body)document.body.classList.remove("layout-gate-active");}
function manualReveal(){if(ended)return false;manual=true;reveal();return true;}
function armGate(ms,onTimeout){cancelGate();if(!ended)gt=setTimeout(function(){if(ended)return;if(onTimeout)onTimeout();else reveal();},ms);}
function showBypass(){b=document.getElementById("layoutGateBypass");if(b){b.hidden=false;b.onclick=manualReveal;}}
window.__lieselLayoutGateEscape={arm:armGate,cancel:cancelGate,reveal:reveal,manualReveal:manualReveal,showBypass:showBypass,end:function(){ended=true;cancelGate();},isEnded:function(){return ended;},isManuallyBypassed:function(){return manual;}};
a=document.getElementById("layoutGateAction");
if(ended){reveal();b=document.getElementById("endedOverlay");if(b)b.hidden=false;}
if(a&&!ended)a.onclick=manualReveal;
if(o&&!o.hidden&&!ended)armGate(${CHROME_LAYOUT_GATE_MAX_HOLD_MS});
window.__lieselCancelChromeBootFailsafe=function(){clearTimeout(t);};
window.__lieselChromeBootFailed=function(){clearTimeout(t);fail();};
function fail(){
if(window.__lieselChromeReady||ended)return;
h=document.getElementById("layoutGateTitle");
c=document.getElementById("layoutGateCopy");
a=document.getElementById("layoutGateAction");
if(h)h.textContent="Liesel could not finish loading.";
if(c)c.textContent="The Liesel editor script did not load. The server usually restarted while this page was opening. Check and reload to reconnect.";
if(a){a.textContent="Check and reload";a.disabled=false;a.onclick=check;}
showBypass();
if(o)o.hidden=false;
if(document.body)document.body.classList.add("layout-gate-active");
armGate(${CHROME_LAYOUT_GATE_MAX_HOLD_MS});
}
function check(){
if(a)a.disabled=true;
var ctl=new AbortController();
var pt=setTimeout(function(){ctl.abort();},${CHROME_BOOT_FAILSAFE_PROBE_TIMEOUT_MS});
fetch("/health",{cache:"no-store",signal:ctl.signal}).then(function(r){return r&&r.ok?"running":"not-running";},function(){return ctl.signal.aborted?"no-answer":"not-running";}).then(function(outcome){
clearTimeout(pt);
if(outcome==="running"){location.reload();return;}
if(a)a.disabled=false;
if(c)c.textContent=outcome==="no-answer"?"Liesel did not answer the check, so this page cannot tell whether it is running. Try again in a moment.":"Liesel is still not running. Start it again with your agent, then use Check and reload.";
});
}
})();`;

export function createChromeHtml(
  session,
  {
    layoutGateEnabled = true,
    faviconTag = LIESEL_DEFAULT_FAVICON,
    title = PRODUCT_NAME,
    artifactRevision = 0,
    artifactLoadToken = "",
    artifactLoadSequence = 0,
    chromeLoadToken = "",
    attachmentMaxBytes = 0,
    attachmentMaxCount = 0,
    attachmentAcceptedMime = ACCEPTED_IMAGE_MIME,
  } = {},
) {
  const acceptedMime = attachmentAcceptedMime.map(String);
  const sessionJson = jsonScript({
    key: session.key,
    file: session.file,
    // A page loaded (or reloaded) after the session already ended has no future live `ended`
    // event to wait for - it must start read-only instead of looking live until the user tries
    // to send and gets refused (#171).
    initialEnded: session.status === "ended",
    initialEndedBy: session.ended_by || null,
    initialChat: serializeChat(session.chat || []),
    initialChatAckIds: serializeChatAckIds(session.chat_ack_ids),
    initialChatRevision:
      Number.isSafeInteger(session.chat_revision) && session.chat_revision >= 0 ? session.chat_revision : 0,
    // Bootstrapping the inbox from the server is what makes it survive a browser refresh or a
    // reconnect: the chrome never owns warning state, it only renders it.
    initialLayoutWarnings: serializeLayoutWarnings(session.layout_warnings),
    initialArtifactRevision: artifactRevision,
    initialArtifactLoadToken: artifactLoadToken,
    initialArtifactLoadSequence: artifactLoadSequence,
    chromeLoadToken,
    layoutGateEnabled,
    modeToggleHotkeyKey: MODE_TOGGLE_HOTKEY_KEY,
    attachmentMaxBytes,
    attachmentMaxCount,
    attachmentAcceptedMime: acceptedMime,
    // The legend's swatches are server-owned, not artifact-owned. The chrome
    // derives every swatch from this palette by registry position, so an
    // artifact cannot hand all its revisions the same colour and pattern and
    // collapse the one signal that tells the rounds apart.
    revisionPalette: artifactRevisions.revisionPalette(),
  });
  const { head: pathHead, tail: pathTail } = displayPathParts(session.file);
  const bodyClass = layoutGateEnabled ? "liesel layout-gate-active" : "liesel";
  const layoutGateHidden = layoutGateEnabled ? "" : " hidden";
  const modeHotkeyUpper = MODE_TOGGLE_HOTKEY_KEY.toUpperCase();
  const modeToggleHint = `Toggle annotate/explore mode (⌘${modeHotkeyUpper} / Ctrl+${modeHotkeyUpper})`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${escapeHtml(title)}</title>
${faviconTag}
<link rel="stylesheet" href="/chrome.css">
</head>
<body class="${bodyClass}">
<div class="bar"><div class="brand"><span class="brand-mark">Liesel</span><span class="brand-support">Board</span></div><div class="spacer" aria-hidden="true"></div><div class="warnings-wrap" id="warningsWrap" hidden><button class="warnings-button" id="warningsButton" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="warningsDrawer">${chromeIcons.warning}<span class="warnings-count" id="warningsCount">0</span></button><div class="menu warnings-drawer" id="warningsDrawer" role="dialog" aria-labelledby="warningsTitle" aria-describedby="warningsSummary" hidden><div class="warnings-head"><h2 class="warnings-title" id="warningsTitle">Layout issues</h2><p class="warnings-summary" id="warningsSummary"></p></div><div class="warnings-toolbar"><label class="warnings-selectall"><input type="checkbox" id="warningsSelectAll"><span>Select all</span></label><span class="warnings-selected" id="warningsSelected" role="status" aria-live="polite"></span></div><div class="warnings-list" id="warningsList"></div><div class="warnings-foot"><p class="warnings-note">Queueing sends a repair request with your next feedback. An issue is marked resolved only after a newer artifact load and a complete check at the same viewport no longer finds it.</p><button class="button" id="warningsQueueButton" type="button" disabled>Queue selected fixes</button></div></div></div><div class="revisions-wrap" id="revisionsWrap" hidden><button class="revisions-button" id="revisionsButton" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="revisionsDrawer"><span class="revisions-button-text">Revisions</span><span class="revisions-count" id="revisionsCount">0</span></button><div class="menu revisions-drawer" id="revisionsDrawer" role="dialog" aria-labelledby="revisionsTitle" aria-describedby="revisionsSummary" hidden><div class="revisions-head"><h2 class="revisions-title" id="revisionsTitle">Revisions</h2><p class="revisions-summary" id="revisionsSummary"></p></div><div class="revisions-list" id="revisionsList"></div><div class="revisions-foot"><p class="revisions-note">The agent declares these in the artifact itself. Reveal flashes the next block it marked for that revision; nothing about the page is restyled, so the saved file still looks the way it does here.</p></div></div></div><button class="annotate-switch" id="annotation" type="button" aria-pressed="true" title="${escapeHtml(modeToggleHint)}"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span><span>Annotate</span></button><button class="sidebar-toggle" id="sidebarToggle" type="button" aria-controls="panel" aria-expanded="true" aria-label="Hide conversation" title="Hide conversation">${chromeIcons.sidebar}<span class="sidebar-toggle-count" id="sidebarToggleCount" aria-hidden="true" hidden></span></button><div class="more-wrap" id="moreWrap"><button class="more-button" id="moreButton" type="button" title="More" aria-haspopup="menu" aria-expanded="false">${chromeIcons.more}</button><div class="menu more-menu" id="moreMenu" hidden><div class="menu-head"><div class="menu-label">Editing</div><button class="menu-file" id="copyPath" type="button" title="Copy path · ${escapeHtml(session.file)}">${chromeIcons.file}<span class="menu-file-text"><span class="path-head">${escapeHtml(pathHead)}</span><span class="path-tail">${escapeHtml(pathTail)}</span></span><span class="copy-hint" id="copyHint"><span class="icon-copy">${chromeIcons.copy}</span><span class="icon-check">${chromeIcons.check}</span><span id="copyHintText">Copy</span></span></button></div><div class="menu-rule"></div><button class="menu-item" id="reloadArtifact" type="button">${chromeIcons.refresh}<span>Reload artifact</span></button><button class="menu-item" id="copySnapshot" type="button">${chromeIcons.camera}<span>Copy DOM snapshot</span></button><button class="menu-item" id="exportArtifact" type="button">${chromeIcons.download}<span>Export standalone HTML</span></button><button class="menu-item" id="shareArtifact" type="button">${chromeIcons.globe}<span>Publish link</span></button><div class="menu-rule"></div><button class="menu-item danger" id="end" type="button">${chromeIcons.exit}<span>End session</span></button></div></div></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" data-artifact-src="/artifact/${session.key}/index.html"></iframe></div><div class="panel-scrim" id="panelScrim"></div><aside class="panel" id="panel"><div class="panel-head" id="panelHead"><span class="panel-handle" aria-hidden="true"></span><div class="panel-head-row"><h2>Conversation</h2><span class="panel-summary" id="panelSummary" role="status" aria-live="polite"></span><button class="panel-toggle" id="panelToggle" type="button" aria-expanded="false" aria-controls="panel" aria-label="Show conversation">${chromeIcons.chevronUp}</button></div></div><div class="panel-scroll" id="panelScroll"><div class="chat" id="chatLog"></div><div class="chat chat-queued" id="queuedLog"></div></div><div class="composer" id="chatComposer"><div class="presence-banner handoff-banner" id="handoffBanner" hidden><span>This review is open in another Liesel tab. Unsent answers stay in the tab or window where you entered them; taking over in another window does not bring them along.</span><button class="handoff-takeover" id="handoffTakeover" type="button">Take over here</button></div><div class="presence-banner handoff-banner" id="outdatedBanner" hidden><span id="outdatedText">The Liesel server this page was connected to is no longer running. Reloading will work once it is running again.</span><span class="outdated-actions"><button class="handoff-takeover" id="outdatedReload" type="button">Check and reload</button><button class="handoff-takeover" id="outdatedDismiss" type="button">Dismiss</button></span></div><div class="presence-banner" id="presenceBanner" hidden>Your agent is not listening. If this persists, ask your agent to poll for updates from Liesel.</div><textarea id="chatInput" placeholder="Write a message for the agent..."></textarea><div class="chat-attachments" id="chatAttachments"></div><div class="chat-attachment-toolbar"><button class="chat-attach" id="chatAttach" type="button">Attach images</button><input id="chatAttachInput" type="file" accept="${escapeHtml(acceptedMime.join(","))}" multiple hidden><span class="chat-attachment-notice" id="chatAttachmentNotice" role="status"></span></div><div class="send-hint" id="sendHint" hidden>Nothing queued in this tab. Unsent answers stay in the tab or window where you entered them; taking over in another window does not bring them along.</div><div class="actions" id="sendActions"><button class="button button-danger" id="sendAndEnd" type="button">${chromeIcons.exit}<span>Send &amp; End</span></button><button class="button" id="send">Send to Agent</button></div></div></aside></div>
<div class="share-overlay" id="shareDialog" role="dialog" aria-modal="true" aria-labelledby="shareTitleText" hidden><form class="share-card" id="shareForm"><div class="share-head"><div><div class="share-kicker">Publish to <a class="share-link" href="https://ht-ml.app" target="_blank" rel="noopener noreferrer">ht-ml.app</a></div><h2 id="shareTitleText">Publish artifact</h2></div><button class="share-close" id="shareClose" type="button" aria-label="Close publish dialog"><svg width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><p class="share-note">ht-ml.app is a separate, third-party hosting service, not part of Liesel. Publishing sends this artifact to its servers.</p><p class="share-copy">This uploads this artifact to ht-ml.app with local assets inlined. Without a password, the page is PUBLIC and anyone with the link can open it. With a password, the page is PRIVATE and viewers must supply the password to view.</p><p class="share-note">Do not publish secrets. The Liesel annotation SDK is not included.</p><div class="share-grid"><label class="share-check"><input id="shareGenerate" type="checkbox"><span>Generate a password (makes this page private)</span></label><label>Password (optional)<input id="sharePassword" name="password" type="password" autocomplete="new-password" placeholder="Leave blank for a public page"></label></div><div class="share-status" id="shareStatus" role="status"></div><div class="share-result" id="shareResult" hidden><label id="shareUrlResult">Share URL<div class="share-copy-row"><input id="shareUrl" readonly><button class="share-copy-btn" id="copyShareUrl" type="button">Copy URL</button></div></label><label id="sharePasswordResult" hidden>Password (shared secret)<div class="share-copy-row"><input id="sharePasswordOut" readonly><button class="share-copy-btn" id="copySharePassword" type="button">Copy password</button></div></label><label id="shareSiteIdResult" hidden>Site ID<div class="share-copy-row"><input id="shareSiteId" readonly><button class="share-copy-btn" id="copyShareSiteId" type="button">Copy site ID</button></div></label><label id="shareUpdateKeyResult">Update key (secret)<div class="share-copy-row"><input id="shareUpdateKey" readonly><button class="share-copy-btn" id="copyUpdateKey" type="button">Copy key</button></div></label><p class="share-note" id="shareUpdateKeyNote">Keep the update key private. ht-ml.app returns it once and it is the only way to update this page later; the service has no delete. Republish this page&#39;s HTML with <code>liesel share &lt;file&gt; --site &lt;site id&gt; --update-key &lt;key&gt;</code>, and add <code>--private</code> to also lock it behind a new generated password.</p></div><div class="share-actions"><button class="share-cancel" id="shareCancel" type="button">Cancel</button><button class="button" id="sharePublish" type="submit">Publish</button></div></form></div>
<div class="ended-overlay layout-gate-overlay" id="layoutGateOverlay"${layoutGateHidden}><div class="ended-card"><div class="ended-title" id="layoutGateTitle">Checking layout.<br>One moment.</div><p class="ended-copy" id="layoutGateCopy">Liesel is waiting for fonts and final geometry before revealing this artifact.</p><button class="button ended-action" id="layoutGateAction" type="button">Show anyway</button><button class="button ended-action layout-gate-bypass" id="layoutGateBypass" type="button" hidden>Show anyway</button></div></div>
<div class="ended-overlay" id="endedOverlay" hidden><div class="ended-card"><div class="ended-title">Session ended.<br>Return to your agent to continue.</div><p class="ended-copy">${escapeHtml(session.file)}</p></div></div>
<div class="whiteboard-overlay" id="whiteboardOverlay" hidden><div class="whiteboard-shell"><div class="whiteboard-error" id="whiteboardError" hidden></div><button class="whiteboard-close" id="whiteboardClose" type="button" aria-label="Close whiteboard"><svg width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><iframe id="whiteboardFrame" title="Excalidraw whiteboard" sandbox="allow-scripts allow-popups"></iframe></div></div>
<script id="liesel-session" type="application/json">${sessionJson}</script>
<script>${CHROME_BOOT_FAILSAFE_JS}</script>
<script src="/chrome-client.js" onerror="window.__lieselChromeBootFailed()"></script>
</body>
</html>`;
}

export function createWhiteboardFrameHtml(channelToken = "") {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Liesel Whiteboard</title>
<link rel="stylesheet" href="/whiteboard-assets/whiteboard.css">
</head>
<body>
<script>window.__lieselWhiteboardChannelToken=${JSON.stringify(channelToken)};</script>
<script src="/whiteboard-assets/whiteboard.js"></script>
</body>
</html>`;
}

// Serialize every helper a shared module exports as a same-scope const so cross-helper calls
// (e.g. mermaidNodeFrom → mermaidNodeElement) resolve in the browser. Deriving these from the
// module's exports — rather than a hand-kept list — means adding a helper can never silently
// ReferenceError at runtime.
// Only functions survive `toString()` round-tripping: a Set, Map, or RegExp would serialize to a
// valid-looking `{}` and reach the browser semantically empty, which is far harder to find than
// this throw. A shared module must therefore export nothing but helpers.
function serializeModuleHelpers(module) {
  const entries = Object.entries(module);
  const unsupported = entries.filter(([, value]) => typeof value !== "function").map(([name]) => name);
  if (unsupported.length > 0) {
    throw new TypeError(
      `Cannot serialize non-function SDK helper export(s) into the artifact bundle: ${unsupported.join(", ")}`,
    );
  }
  return {
    declarations: entries.map(([name, fn]) => `const ${name}=${fn.toString()};`).join("\n"),
    names: entries.map(([name]) => name),
  };
}

/**
 * @param {string} key
 * @param {number} [artifactRevision]
 * @param {string} [artifactLoadToken]
 * @param {{ maxAttachmentCount?: number, maxAttachmentBytes?: number, acceptedImageMime?: string[] }} [options]
 */
export function createSdkJs(
  key,
  artifactRevision = 0,
  artifactLoadToken = "",
  { maxAttachmentCount, maxAttachmentBytes, acceptedImageMime = ACCEPTED_IMAGE_MIME } = {},
) {
  const mermaidHelperSource = serializeModuleHelpers(mermaidNode);
  const tableHelperSource = serializeModuleHelpers(tableCellHelpers);
  const revisionHelperSource = serializeModuleHelpers(artifactRevisions);
  const revisionNumber = Number(artifactRevision);
  const revision = Number.isFinite(revisionNumber) && revisionNumber >= 0 ? Math.trunc(revisionNumber) : 0;
  const loadToken = String(artifactLoadToken || "").slice(0, 200);
  // The per-prompt attachment cap is authoritative on the server (attachment-store.js);
  // pass it to the SDK so the annotation card's local count guard matches the server
  // limit instead of a hardcoded literal (W1). The card is still only a UX guide - the
  // server re-enforces the cap on /prompts and rejects the whole batch on a mismatch.
  const sdkOptions = {
    maxAttachmentCount: Number.isFinite(maxAttachmentCount) ? maxAttachmentCount : undefined,
    maxAttachmentBytes: Number.isFinite(maxAttachmentBytes) ? maxAttachmentBytes : undefined,
    acceptedImageMime: acceptedImageMime.map(String),
  };
  return `(() => {
const key=${JSON.stringify(key)};
const artifactRevision=${revision};
const artifactLoadToken=${JSON.stringify(loadToken)};
const deriveQueueKey=${deriveLieselQueueKey.toString()};
const isNativeInteractiveControl=${isNativeInteractiveControl.toString()};
const MODE_TOGGLE_HOTKEY_KEY=${JSON.stringify(MODE_TOGGLE_HOTKEY_KEY)};
const isModeToggleHotkeyEvent=${isModeToggleHotkeyEvent.toString()};
const classifySevereTextOverflow=${classifySevereTextOverflow.toString()};
const classifyMaterialRectEscape=${classifyMaterialRectEscape.toString()};
const isMaterialPageOverflow=${isMaterialPageOverflow.toString()};
const findStableLayoutFindings=${findStableLayoutFindings.toString()};
const isNearTotalOcclusion=${isNearTotalOcclusion.toString()};
const attachmentSizeError=${attachmentSizeError.toString()};
const classifyAttachmentBatch=${classifyAttachmentBatch.toString()};
const partitionDroppedFiles=${partitionDroppedFiles.toString()};
const planClipboardPaste=${planClipboardPaste.toString()};
const acceptedImageTypes=${acceptedImageTypes.toString()};
const isTrustedAttachmentResult=${isTrustedAttachmentResult.toString()};
const deriveAttachmentNoticeState=${deriveAttachmentNoticeState.toString()};
${mermaidHelperSource.declarations}
const mermaidHelpers={ ${mermaidHelperSource.names.join(", ")} };
${tableHelperSource.declarations}
${revisionHelperSource.declarations}
(${createArtifactSdk.toString()})(deriveQueueKey, isNativeInteractiveControl, mermaidHelpers, artifactRevision, artifactLoadToken, key, ${JSON.stringify(sdkOptions)});
})();`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
