import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A board's conversation is its own record, not the server's: the notes and the
 * answers that settle them have to survive a restart, a wiped state directory and a
 * different machine. So the transcript is mirrored into a sidecar beside board.json
 * and merged back in when the board opens.
 */
export const BOARD_HISTORY_FILE = ".easel-history.json";
const MAX_ENTRIES = 2000;
const MAX_TEXT = 8000;

/** @param {string} dir */
export function boardHistoryPath(dir) {
  return path.join(dir, BOARD_HISTORY_FILE);
}

/** @param {any} entry */
function entryKey(entry) {
  return createHash("sha1")
    .update(`${entry.role}\u0000${entry.at || ""}\u0000${entry.prompt_id || ""}\u0000${entry.text || ""}`)
    .digest("hex");
}

/** @param {unknown} value */
function normalizeEntry(value) {
  if (!value || typeof value !== "object") return null;
  const entry = /** @type {any} */ (value);
  const role = entry.role === "agent" ? "agent" : "user";
  const text = String(entry.text ?? "").slice(0, MAX_TEXT);
  if (!text) return null;
  const at = String(entry.at || "");
  const kept = { role, text, at };
  for (const field of ["prompt_id", "done_at", "delivered_at", "kind", "thread"]) {
    const raw = entry[field];
    if (typeof raw === "string" && raw) kept[field] = raw;
  }
  if (Array.isArray(entry.threads)) kept.threads = entry.threads.map(String).slice(0, 20);
  if (entry.anchor && typeof entry.anchor === "object") kept.anchor = entry.anchor;
  return kept;
}

/** @param {string} dir @returns {Promise<any[]>} */
export async function readBoardHistory(dir) {
  let raw;
  try {
    raw = await readFile(boardHistoryPath(dir), "utf8");
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") return [];
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed?.chat) ? parsed.chat : Array.isArray(parsed) ? parsed : [];
  return entries.slice(-MAX_ENTRIES).map(normalizeEntry).filter(Boolean);
}

/** @param {string} dir @param {any[]} chat */
export async function writeBoardHistory(dir, chat) {
  const file = boardHistoryPath(dir);
  const temporary = `${file}.${process.pid}.tmp`;
  const entries = (Array.isArray(chat) ? chat : []).slice(-MAX_ENTRIES);
  await writeFile(temporary, `${JSON.stringify({ format: 1, chat: entries }, null, 0)}\n`, "utf8");
  await rename(temporary, file);
}

/**
 * The live transcript wins on every entry the server still holds; anything the
 * sidecar kept that the session lost is folded back in the order it happened.
 * @param {any[]} stored
 * @param {any[]} live
 * @returns {any[]}
 */
export function mergeBoardHistory(stored, live) {
  const merged = [];
  const seen = new Set();
  for (const entry of [...(Array.isArray(live) ? live : []), ...(Array.isArray(stored) ? stored : [])]) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    const key = entryKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged.sort((left, right) => String(left.at || "").localeCompare(String(right.at || "")));
}

/** Only the entries a session is missing: the ones worth adopting. */
export function missingHistory(stored, live) {
  const liveKeys = new Set((Array.isArray(live) ? live : []).map((entry) => entryKey(normalizeEntry(entry) || {})));
  return mergeBoardHistory(stored, []).filter((entry) => !liveKeys.has(entryKey(entry)));
}
