import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shared by the opt-in board browser suites; it defines no tests of its own.
/**
 * A trusted-input browser over raw CDP: synthetic DOM events would never prove the frame
 * gets the drag. Headless, with a throwaway profile and no keychain.
 * @param {string} chrome
 * @param {string} profile
 */
export async function launchChrome(chrome, profile) {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1600,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(200);
    try {
      port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
    } catch {
      // Chrome has not written it yet.
    }
  }
  if (!port) {
    child.kill("SIGKILL");
    throw new Error("Chrome did not open a DevTools port");
  }
  const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageTarget = (await list()).find((target) => target.type === "page");
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  /** @type {Map<number, (value: any) => void>} */
  const pending = new Map();
  ws.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)?.(data);
      pending.delete(data.id);
    }
  });
  /** @param {string} method @param {Record<string, unknown>} [params] @param {string} [sessionId] */
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (data) => (data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result)));
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  /** @param {string} expression @param {string} [sessionId] */
  const evaluate = async (expression, sessionId = undefined) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const close = () => {
    ws.close();
    child.kill("SIGKILL");
  };
  return { send, evaluate, list, close };
}
