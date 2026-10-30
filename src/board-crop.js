import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A pin note carries a picture of the place it points at, so the agent sees what the
 * reviewer saw. The picture is made by a local headless Chrome rendering a small page
 * that frames the item at the clicked spot. Chrome is optional: with none found, a
 * note goes out without its picture.
 */

export const CROP_MARGIN = 40;
export const CROP_MAX_HEIGHT = 1200;
const CAPTURE_TIMEOUT_MS = 20000;

/** @param {NodeJS.ProcessEnv} [env] */
export function findChrome(env = process.env) {
  const configured = String(env.EASEL_CHROME || env.LAVISH_AXI_CHROME || "").trim();
  if (configured) return existsSync(configured) ? configured : "";
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

/**
 * The clicked element's box in page pixels, grown by the margin and kept on the page.
 *
 * @param {unknown} value
 * @param {number} deviceWidth
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
export function cropBox(value, deviceWidth) {
  if (!value || typeof value !== "object") return null;
  const box = /** @type {Record<string, unknown>} */ (value);
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const left = Math.max(0, Math.floor(x - CROP_MARGIN));
  const top = Math.max(0, Math.floor(y - CROP_MARGIN));
  const right = Math.min(deviceWidth, Math.ceil(x + w + CROP_MARGIN));
  const bottom = Math.ceil(y + h + CROP_MARGIN);
  if (right - left < 8 || top > 200000) return null;
  return { x: left, y: top, width: right - left, height: Math.min(CROP_MAX_HEIGHT, Math.max(8, bottom - top)) };
}

/**
 * The page Chrome photographs: the item in a sandboxed frame, shifted so the crop
 * sits at the top left of a window exactly the crop's size.
 *
 * @param {{ src: string, deviceWidth: number, deviceHeight: number, box: { x: number, y: number, width: number, height: number } }} options
 */
export function cropFrameHtml({ src, deviceWidth, deviceHeight, box }) {
  const frameHeight = Math.max(deviceHeight, box.y + box.height);
  const escaped = src.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  // Like the board, this page reads the item's linked stylesheets for it (only under the
  // item's own path), so the picture has the same pinned viewport units.
  const itemBase = JSON.stringify(src.split("?")[0].replace(/[^/]*$/, "")).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; overflow: hidden; background: #ffffff; }
iframe { position: absolute; left: ${-box.x}px; top: ${-box.y}px; width: ${deviceWidth}px; height: ${frameHeight}px; border: 0; }
</style></head><body><iframe sandbox="allow-scripts" src="${escaped}"></iframe><script>
addEventListener("message", (event) => {
  const frame = document.querySelector("iframe");
  const data = event.data;
  if (!frame || event.source !== frame.contentWindow || !data || data.channel !== "easel" || data.type !== "stylesheet") return;
  const reply = (text) => frame.contentWindow.postMessage({ channel: "easel", type: "stylesheet", href: data.href, text }, "*");
  let url;
  try { url = new URL(String(data.href || ""), location.href); } catch { reply(null); return; }
  if (url.origin !== location.origin || !url.pathname.startsWith(${itemBase})) { reply(null); return; }
  fetch(url.pathname + url.search).then((response) => (response.ok ? response.text() : null)).then(reply, () => reply(null));
});
</script></body></html>`;
}

/**
 * Photograph `url` at `width` x `height` with headless Chrome. Resolves to PNG bytes,
 * or null when Chrome fails or takes too long.
 *
 * @param {{ chrome: string, url: string, width: number, height: number, timeoutMs?: number }} options
 * @returns {Promise<Buffer | null>}
 */
export async function captureCrop({ chrome, url, width, height, timeoutMs = CAPTURE_TIMEOUT_MS }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "easel-crop-"));
  const out = path.join(dir, "crop.png");
  try {
    const ok = await new Promise((resolve) => {
      const child = spawn(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--force-device-scale-factor=2",
          `--user-data-dir=${path.join(dir, "profile")}`,
          `--window-size=${width},${height}`,
          "--virtual-time-budget=4000",
          `--screenshot=${out}`,
          url,
        ],
        { stdio: "ignore" },
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    if (!ok) return null;
    return await readFile(out).catch(() => null);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// A version's thumbnail is the top screen of its desktop page, at a quarter size.
export const THUMB_SCALE = 0.25;

/**
 * The page Chrome photographs for a version's thumbnail: the saved page in a sandboxed
 * desktop-sized frame, scaled down so one screen of it fills a small window.
 *
 * @param {{ src: string, deviceWidth: number, deviceHeight: number }} options
 */
export function thumbFrameHtml({ src, deviceWidth, deviceHeight }) {
  const escaped = src.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; overflow: hidden; background: #ffffff; }
iframe { position: absolute; left: 0; top: 0; width: ${deviceWidth}px; height: ${deviceHeight}px; border: 0; transform: scale(${THUMB_SCALE}); transform-origin: 0 0; }
</style></head><body><iframe sandbox="allow-scripts" src="${escaped}"></iframe></body></html>`;
}
