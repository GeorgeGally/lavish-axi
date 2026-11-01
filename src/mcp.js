import readline from "node:readline";

/**
 * `liesel mcp`: a Model Context Protocol server over stdio, for chat apps and agents that
 * speak MCP instead of running shell commands. It exposes the same loop `liesel poll` and
 * `liesel reply` give a terminal agent - open a board, wait for its notes, answer them -
 * as tools. Messages are newline-delimited JSON-RPC 2.0; stdout carries nothing else.
 */

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * @typedef {{
 *   name: string,
 *   description: string,
 *   inputSchema: Record<string, unknown>,
 *   call: (args: Record<string, any>) => Promise<unknown>,
 * }} McpTool
 */

/**
 * @param {{ tools: McpTool[], name?: string, version?: string, instructions?: string }} options
 */
export function createMcpHandler({ tools, name = "liesel", version = "", instructions = "" }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  /**
   * @param {any} message
   * @returns {Promise<any | null>} the response, or null for a notification
   */
  return async function handle(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(message?.id ?? null, -32600, "Invalid request");
    }
    const isNotification = message.id === undefined || message.id === null;
    const { id, method } = message;
    const params = message.params && typeof message.params === "object" ? message.params : {};
    if (isNotification) return null;
    switch (method) {
      case "initialize": {
        const requested = String(params.protocolVersion || "");
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
      case "tools/call": {
        const tool = byName.get(String(params.name || ""));
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
        try {
          const result = await tool.call(
            params.arguments && typeof params.arguments === "object" ? params.arguments : {},
          );
          return rpcResult(id, {
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
          });
        } catch (error) {
          const detail = /** @type {any} */ (error);
          const text = JSON.stringify(
            {
              error: detail?.message || String(error),
              ...(detail?.code ? { code: detail.code } : {}),
              ...(Array.isArray(detail?.suggestions) && detail.suggestions.length > 0
                ? { help: detail.suggestions }
                : {}),
            },
            null,
            2,
          );
          return rpcResult(id, { content: [{ type: "text", text }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}

/** @param {any} id @param {unknown} result */
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/** @param {any} id @param {number} code @param {string} message */
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Serves `handle` over newline-delimited JSON on `input`/`output` until input closes.
 * Calls run concurrently (a long poll must not block a ping), and each response is
 * written as one line.
 * @param {{ handle: (message: any) => Promise<any | null>, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} options
 */
export async function runMcpStdio({ handle, input = process.stdin, output = process.stdout }) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  /** @type {Set<Promise<void>>} */
  const inflight = new Set();
  const write = (/** @type {any} */ response) => {
    if (response) output.write(`${JSON.stringify(response)}\n`);
  };
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write(rpcError(null, -32700, "Parse error"));
      continue;
    }
    const messages = Array.isArray(message) ? message : [message];
    for (const entry of messages) {
      const task = handle(entry)
        .then(write)
        .catch((error) => write(rpcError(entry?.id ?? null, -32603, error?.message || String(error))));
      inflight.add(task);
      task.finally(() => inflight.delete(task));
    }
  }
  await Promise.allSettled([...inflight]);
}

const BOARD_ARG = {
  type: "string",
  description: "The board folder (absolute path), or its board.json",
};

/**
 * The Liesel tools, bound to the CLI's own board, poll and reply implementations.
 * @param {{
 *   openBoard: (args: { board: string, name?: string }) => Promise<unknown>,
 *   boardStatus: (args: { board: string }) => Promise<unknown>,
 *   poll: (args: { board: string, timeout_seconds?: number, reply?: string }) => Promise<unknown>,
 *   reply: (args: { board: string, message: string, thread?: string, pending?: string }) => Promise<unknown>,
 * }} client
 * @returns {McpTool[]}
 */
export function createLieselMcpTools(client) {
  return [
    {
      name: "liesel_board_open",
      description:
        "Open (or create) a Liesel board for a folder of HTML designs and return its URL for the user. Every .html file in the folder becomes an item on the board.",
      inputSchema: {
        type: "object",
        properties: { board: BOARD_ARG, name: { type: "string", description: "Board name for a new board" } },
        required: ["board"],
      },
      call: (args) => client.openBoard({ board: String(args.board || ""), name: args.name }),
    },
    {
      name: "liesel_board_status",
      description: "List a board's tabs and items (id, label, file) so notes can be matched to HTML files.",
      inputSchema: { type: "object", properties: { board: BOARD_ARG }, required: ["board"] },
      call: (args) => client.boardStatus({ board: String(args.board || "") }),
    },
    {
      name: "liesel_poll",
      description:
        'Wait for the user\'s notes on a board. Returns {session:{status:"feedback"}, prompts:[...]} when notes arrive: each prompt names its item {id,label}, the pinned selector, the note text, and image attachment paths. Apply each note to that item\'s HTML file, then call liesel_reply. Returns status "waiting" when timeout_seconds pass with no notes; call it again to keep waiting. Pass `reply` to answer the previous notes and keep waiting in one call.',
      inputSchema: {
        type: "object",
        properties: {
          board: BOARD_ARG,
          timeout_seconds: {
            type: "number",
            description: "How long to wait before returning waiting (default 50, max 600)",
          },
          reply: { type: "string", description: "Optional answer to post before waiting" },
        },
        required: ["board"],
      },
      call: (args) =>
        client.poll({
          board: String(args.board || ""),
          timeout_seconds: args.timeout_seconds,
          ...(typeof args.reply === "string" && args.reply.trim() ? { reply: args.reply } : {}),
        }),
    },
    {
      name: "liesel_reply",
      description:
        "Post your answer to the board's chat. It settles every note delivered so far. Use `thread` to answer one note's thread, and `pending` with an item id when you promise a new version of that item.",
      inputSchema: {
        type: "object",
        properties: {
          board: BOARD_ARG,
          message: { type: "string", description: "Your answer, in Markdown" },
          thread: { type: "string", description: "The thread id a prompt carried" },
          pending: { type: "string", description: "Item id a new version is coming for" },
        },
        required: ["board", "message"],
      },
      call: (args) =>
        client.reply({
          board: String(args.board || ""),
          message: String(args.message || ""),
          ...(args.thread ? { thread: String(args.thread) } : {}),
          ...(args.pending ? { pending: String(args.pending) } : {}),
        }),
    },
  ];
}

export const LIESEL_MCP_INSTRUCTIONS =
  "Liesel shows a folder of HTML designs on one board where the user pins notes. Open a board with liesel_board_open and give the user its URL. Then loop: liesel_poll waits for notes; apply each note to the HTML file of the item it names; answer with liesel_reply (or liesel_poll with reply to answer and keep waiting).";
