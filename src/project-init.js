// `liesel init`: turn any project folder into one an agent can review designs in. It makes a
// board folder with a starter item, writes LIESEL.md (the loop, for any agent that can run a
// shell command), and appends a short pointer section to the agent instruction files the
// common harnesses read. Nothing the project already has is ever overwritten.
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { addItem, readOrCreateBoard, writeBoard } from "./board.js";
import { CLI_NAME, PRODUCT_NAME } from "./brand.js";

export const DEFAULT_BOARD_DIR = "board";
export const STARTER_FILE = "welcome.html";
export const GUIDE_FILE = "LIESEL.md";
export const AGENT_SECTION_START = "<!-- liesel:start -->";
export const AGENT_SECTION_END = "<!-- liesel:end -->";

// AGENTS.md is read by Codex, Cursor, OpenCode, Amp, Copilot and others; Claude Code reads
// CLAUDE.md. Both are created when missing. GEMINI.md is only appended to when the project
// already has one, since Gemini CLI can be pointed at AGENTS.md instead.
const AGENT_FILES = Object.freeze([
  { name: "AGENTS.md", create: true },
  { name: "CLAUDE.md", create: true },
  { name: "GEMINI.md", create: false },
]);

export class ProjectInitError extends Error {}

/**
 * @param {string} boardDir board folder as the agent will type it, relative to the project
 * @returns {string}
 */
export function createGuideMarkdown(boardDir) {
  const board = boardDir;
  return `# ${PRODUCT_NAME}

This project reviews designs on a ${PRODUCT_NAME} board. \`${board}/\` holds \`board.json\` plus one HTML file per design. The reviewer looks at the designs in a browser, leaves notes on them, and sends the notes to you. Any agent that can run a shell command can work this loop.

## The loop

1. Open the board: \`${CLI_NAME} board open ${board}\`. It prints the board URL; give it to the user if no browser opened.
2. Make or change designs as HTML files in \`${board}/\`. A new file shows up on the board within a few seconds. \`${CLI_NAME} board add ${board} <file.html>\` copies one in from elsewhere.
3. Wait for notes: \`${CLI_NAME} poll ${board}\`. Run it in the foreground and let it block. It is silent until the reviewer sends something; never kill it and do not pass \`--timeout-ms\`.
4. Apply each note to the HTML file of the item it names. A note's target carries the item id and label, and a pin carries the element's selector.
5. Answer and wait again: \`${CLI_NAME} poll ${board} --agent-reply "<what you changed>"\`. When you are handing back a result and not waiting any more, use \`${CLI_NAME} reply ${board} --agent-reply "<message>"\` instead.
6. When the poll says the session ended, stop. Do not reopen the board unless the user asks.

Every command ends its output with a \`next_step\`. Follow it: it is the current instruction and wins over this file. \`${CLI_NAME} board --help\` lists every board command.

## Design files

- One self-contained HTML file per design. Relative assets next to it (\`style.css\`, \`assets/\`) load as usual.
- \`<meta name="liesel-title" content="...">\` and \`<meta name="liesel-explain" content="...">\` set the heading and the line the board shows above a design.
- For a new version of an existing design, write a new file with \`<meta name="liesel-parent" content="<item-id>">\`; it sits under its parent so the two can be compared.
`;
}

/**
 * @param {string} boardDir
 * @returns {string}
 */
export function createAgentSection(boardDir) {
  return `${AGENT_SECTION_START}
## ${PRODUCT_NAME} design board

Designs for this project are reviewed on a ${PRODUCT_NAME} board in \`${boardDir}/\`. Before design or UI work the user wants to review, read \`${GUIDE_FILE}\`: it is the loop for opening the board, adding designs, and collecting the reviewer's notes with \`${CLI_NAME} poll ${boardDir}\`.
${AGENT_SECTION_END}
`;
}

/**
 * The first item on a new board: a page the reviewer can practise the gestures on.
 * @param {string} name
 * @returns {string}
 */
export function createStarterHtml(name) {
  const title = escapeHtml(name);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="liesel-title" content="Welcome" />
    <meta name="liesel-explain" content="A starter design to try the board on. Ask your agent to replace it." />
    <title>${title}</title>
    <style>
      :root {
        --paper: #f6f3ee;
        --ink: #1d1b18;
        --muted: #6f6a62;
        --line: #e2ddd4;
        --accent: #b4532a;
        --radius: 14px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--paper);
        color: var(--ink);
        font: 17px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        display: grid;
        place-items: center;
        padding: 64px 24px;
      }
      main { width: min(720px, 100%); }
      h1 {
        font-size: clamp(36px, 6vw, 56px);
        line-height: 1.05;
        letter-spacing: -0.02em;
        margin: 0 0 20px;
      }
      p { margin: 0 0 32px; color: var(--muted); max-width: 52ch; }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        border-top: 1px solid var(--line);
      }
      li {
        display: grid;
        grid-template-columns: 140px 1fr;
        align-items: baseline;
        gap: 24px;
        padding: 16px 0;
        border-bottom: 1px solid var(--line);
      }
      kbd {
        font: 600 15px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--accent);
      }
      .card {
        margin-top: 40px;
        padding: 24px;
        border-radius: var(--radius);
        background: #fff;
        border: 1px solid var(--line);
      }
      .card p { margin: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title} is ready for review</h1>
      <p>This page is a placeholder. Leave a note on it, then ask your agent to read LIESEL.md and build the real thing.</p>
      <ul>
        <li><kbd>Cmd</kbd><span>Tap to turn notes on, click anything to pin a note, tap again to turn them off.</span></li>
        <li><kbd>Option</kbd><span>Tap to pick an element and tune its colour, type and spacing in Controls.</span></li>
        <li><kbd>Space</kbd><span>Hold and drag to move around the board.</span></li>
        <li><kbd>Tab</kbd><span>Switch the sidebar between Chat and Controls.</span></li>
        <li><kbd>Drop</kbd><span>Drag an image onto a picture to replace it, or an HTML file onto the board to add it.</span></li>
        <li><kbd>History</kbd><span>Step back through earlier builds of a design and compare them side by side.</span></li>
      </ul>
      <div class="card">
        <p>Try it: tap Cmd, click this box, and write what it should say instead.</p>
      </div>
    </main>
  </body>
</html>
`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

/**
 * @param {string} file
 * @param {string} section
 * @param {{ create: boolean, seen: Set<string> }} options
 * @returns {Promise<"created" | "appended" | "kept" | "skipped">}
 */
async function appendAgentSection(file, section, { create, seen }) {
  const exists = existsSync(file);
  if (!exists) {
    if (!create) return "skipped";
    await writeFile(file, section, "utf8");
    seen.add(await realpath(file));
    return "created";
  }
  const stats = await lstat(file);
  const real = await realpath(file);
  if (seen.has(real)) return "kept";
  seen.add(real);
  if (!stats.isFile() && !stats.isSymbolicLink()) return "skipped";
  const contents = await readFile(file, "utf8");
  if (contents.includes(AGENT_SECTION_START)) return "kept";
  // A CLAUDE.md that imports AGENTS.md already carries the section through the import.
  if (path.basename(file) === "CLAUDE.md" && /^@AGENTS\.md\s*$/m.test(contents)) return "kept";
  const separator = contents === "" ? "" : contents.endsWith("\n\n") ? "" : contents.endsWith("\n") ? "\n" : "\n\n";
  await appendFile(file, `${separator}${section}`, "utf8");
  return "appended";
}

/**
 * @param {{ projectDir: string, boardDir?: string, name?: string }} options
 */
export async function initProject({ projectDir, boardDir = DEFAULT_BOARD_DIR, name } = { projectDir: "." }) {
  const project = path.resolve(projectDir);
  await mkdir(project, { recursive: true });
  const boardAbsolute = path.resolve(project, boardDir);
  const relative = path.relative(project, boardAbsolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProjectInitError(`The board folder must be inside the project: ${boardDir}`);
  }
  const boardLabel = toPosix(relative);
  const boardName = String(name || "").trim() || path.basename(project);
  /** @type {{ path: string, action: string }[]} */
  const files = [];

  await mkdir(boardAbsolute, { recursive: true });
  const board = await readOrCreateBoard(boardAbsolute, { name: boardName });
  const starter = path.join(boardAbsolute, STARTER_FILE);
  if (board.items.length === 0 && !existsSync(starter)) {
    await writeFile(starter, createStarterHtml(boardName), "utf8");
    addItem(board, { file: STARTER_FILE, label: "Welcome" });
    await writeBoard(boardAbsolute, board);
    files.push({ path: starter, action: "created" });
  } else {
    files.push({ path: starter, action: "kept" });
  }

  const guide = path.join(project, GUIDE_FILE);
  if (existsSync(guide)) {
    files.push({ path: guide, action: "kept" });
  } else {
    await writeFile(guide, createGuideMarkdown(boardLabel), "utf8");
    files.push({ path: guide, action: "created" });
  }

  const section = createAgentSection(boardLabel);
  const seen = new Set();
  for (const entry of AGENT_FILES) {
    const file = path.join(project, entry.name);
    const action = await appendAgentSection(file, section, { create: entry.create, seen });
    if (action !== "skipped") files.push({ path: file, action });
  }

  return {
    project,
    board: { dir: boardAbsolute, arg: boardLabel, name: boardName },
    files,
  };
}
