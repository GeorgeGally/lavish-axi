import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeBoard } from "../src/board.js";
import { normalizeChangeRecords } from "../src/board-changes.js";
import { buildRunnerPrompt } from "../src/board-runner.js";
import * as boardSource from "../src/board-source.js";
import { inlineBoardSource } from "../src/server.js";

const { cleanSourcePath, elementSourceOf, normalizeSource, sourceLabel, sourceText, stackLocation } = boardSource;

// Fibre-shaped stand-ins for what a React development build leaves on a DOM node.
function Hero() {}
function Button() {}
const heroFiber = { type: Hero, _debugOwner: null, _debugSource: { fileName: "/app/src/App.tsx", lineNumber: 9 } };
const buttonFiber = {
  type: Button,
  _debugOwner: heroFiber,
  _debugSource: { fileName: "/app/components/Hero.tsx", lineNumber: 42, columnNumber: 7 },
};
const hostFiber = {
  type: "button",
  _debugOwner: buttonFiber,
  _debugSource: { fileName: "/app/components/Button.tsx", lineNumber: 12, columnNumber: 5 },
};

test("a React 18 dev fibre names the component and the line its element is written at, with the components above", () => {
  const element = { __reactFiber$abc123: hostFiber, parentElement: null };
  assert.deepEqual(elementSourceOf(element), {
    framework: "react",
    component: "Button",
    file: "/app/components/Button.tsx",
    line: 12,
    column: 5,
    // Hero has no owner of its own, so where <Hero> is used is not known.
    owners: [{ component: "Hero", file: "/app/components/Hero.tsx", line: 42, column: 7 }],
  });
});

test("an element React did not create takes its nearest rendered ancestor's source", () => {
  const parent = { __reactFiber$x: hostFiber, parentElement: null };
  const child = { parentElement: parent };
  assert.equal(elementSourceOf(child)?.component, "Button");
});

test("a production fibre (no _debugOwner field) and a plain element say nothing", () => {
  assert.equal(elementSourceOf({ __reactFiber$x: { type: "div", return: null }, parentElement: null }), null);
  assert.equal(elementSourceOf({ parentElement: null }), null);
  assert.equal(sourceLabel(null), "source unknown");
  assert.equal(sourceLabel({ unknown: true }), "source unknown");
});

test("a library's own components are skipped for the nearest one in the user's files", () => {
  function Primitive() {}
  const primitive = {
    type: { render: Primitive },
    _debugOwner: buttonFiber,
    _debugSource: { fileName: "/app/components/Button.tsx", lineNumber: 20 },
  };
  const host = {
    type: "div",
    _debugOwner: primitive,
    _debugSource: { fileName: "/app/node_modules/@radix-ui/react-primitive/dist/index.mjs", lineNumber: 3 },
  };
  const source = elementSourceOf({ __reactFiber$x: host, parentElement: null });
  assert.equal(source?.component, "Button");
  assert.equal(source?.file, "/app/components/Button.tsx");
  assert.equal(source?.line, 20);
});

test("React 19 fibres: the JSX call site comes from _debugStack, skipping React's own frames", () => {
  const owner = { type: Button, _debugOwner: null };
  const host = {
    type: "button",
    _debugOwner: owner,
    _debugStack: {
      stack: [
        "Error: react-stack-top-frame",
        "    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)",
        "    at Button (http://localhost:5173/src/components/Button.tsx?t=1700000000:12:5)",
        "    at react-dom.development.js:100:1",
      ].join("\n"),
    },
  };
  assert.deepEqual(elementSourceOf({ __reactFiber$x: host, parentElement: null }), {
    framework: "react",
    component: "Button",
    file: "src/components/Button.tsx",
    line: 12,
    column: 5,
  });
  // A bundled chunk's line is not the source's; a webpack module keeps its file only.
  assert.equal(stackLocation("    at Hero (http://localhost:3000/_next/static/chunks/app_page_abc._.js:42:9)"), null);
  assert.deepEqual(stackLocation("    at Hero (webpack-internal:///(app-pages-browser)/./components/Hero.tsx:42:9)"), {
    file: "components/Hero.tsx",
  });
});

test("Vue and Svelte dev builds name the component file", () => {
  assert.deepEqual(
    elementSourceOf({ __vueParentComponent: { type: { __name: "HeroBanner", __file: "/app/src/HeroBanner.vue" } } }),
    { framework: "vue", component: "HeroBanner", file: "/app/src/HeroBanner.vue" },
  );
  assert.deepEqual(elementSourceOf({ __svelte_meta: { loc: { file: "src/lib/Card.svelte", line: 3, column: 2 } } }), {
    framework: "svelte",
    component: "Card",
    file: "src/lib/Card.svelte",
    line: 4,
  });
  assert.equal(
    elementSourceOf({ __svelte_meta: { parent: null, loc: { file: "src/lib/Card.svelte", line: 3, column: 2 } } })
      ?.line,
    3,
  );
});

test("source paths read as files, and labels are relative to the project", () => {
  assert.equal(cleanSourcePath("http://localhost:5173/@fs/Users/me/app/src/A.tsx?t=1"), "/Users/me/app/src/A.tsx");
  assert.equal(cleanSourcePath("webpack://_N_E/./components/Hero.tsx"), "components/Hero.tsx");
  assert.equal(cleanSourcePath("file:///app/src/A.tsx"), "/app/src/A.tsx");
  const source = { component: "Button", file: "/app/components/Hero.tsx", line: 42 };
  assert.equal(sourceLabel(source, "/app"), "Button · components/Hero.tsx:42");
  assert.equal(sourceLabel(source), "Button · components/Hero.tsx:42");
  assert.equal(sourceLabel({ component: "Button", file: "" }), "Button · source unknown");
  assert.equal(
    sourceText({ ...source, owners: [{ component: "Page", file: "/app/app/page.tsx", line: 7 }] }, "/app"),
    "Button · components/Hero.tsx:42, used in Page · app/page.tsx:7",
  );
});

test("normalizeSource keeps a source to its fixed, bounded shape", () => {
  assert.deepEqual(normalizeSource({ unknown: true, component: "x" }), { unknown: true });
  assert.equal(normalizeSource("Button"), null);
  assert.equal(normalizeSource({ line: 3 }), null);
  assert.deepEqual(
    normalizeSource({
      framework: "angular",
      component: "  Button  ",
      file: "a.tsx",
      line: -1,
      extra: "dropped",
      owners: [{ component: "Hero", file: "h.tsx", line: 2 }, "bad", {}, { component: "A" }, { component: "B" }],
    }),
    { component: "Button", file: "a.tsx", owners: [{ component: "Hero", file: "h.tsx", line: 2 }] },
  );
  assert.equal(/** @type {any} */ (normalizeSource({ component: "x".repeat(500), file: "" }))?.component.length, 120);
});

test("the board scripts get the helpers inlined at their placeholder, and nothing on window", async () => {
  for (const name of ["board-sdk.js", "board-client.js"]) {
    const script = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.match(script, /\/\* liesel:board-source \*\/ \{\}/, name);
    const served = inlineBoardSource(script);
    assert.doesNotMatch(served, /liesel:board-source/, name);
    assert.match(served, /const elementSourceOf=/, name);
  }
  const served = inlineBoardSource("const h = (/* liesel:board-source */ {}); globalThis.h = h;");
  const scope = /** @type {any} */ ({});
  new Function("globalThis", served)(scope);
  assert.equal(scope.h.sourceLabel({ component: "A", file: "b.tsx", line: 1 }), "A · b.tsx:1");
});

test("a live note keeps its source in board.json, and the runner names it", () => {
  const board = normalizeBoard(
    {
      items: [
        {
          file: "a.html",
          notes: [
            {
              id: "n1",
              number: 1,
              selector: "#hero > button",
              source: { component: "Button", file: "c.tsx", line: 4 },
            },
          ],
        },
      ],
    },
    "b",
  );
  const note = /** @type {any} */ (board.items[0].notes[0]);
  assert.deepEqual(note.source, { component: "Button", file: "c.tsx", line: 4 });
  const prompt = buildRunnerPrompt({
    boardDir: "/app/.liesel",
    boardName: "app",
    cwd: "/app",
    project: { root: "/app", url: "http://localhost:3000" },
    items: [{ id: "home", label: "Home", file: "", page: "/" }],
    prompts: [
      {
        prompt: "Make it bigger",
        selector: "#hero > button",
        item: { id: "home", page: "/" },
        pin: { number: 1, source: { component: "Button", file: "/app/components/Hero.tsx", line: 42 } },
      },
      {
        prompt: "Tune",
        tag: "tune",
        selector: "#hero > h1",
        item: { id: "home", page: "/" },
        changes: normalizeChangeRecords([
          {
            selector: "#hero > h1",
            label: "h1",
            property: "color",
            old_value: "#000",
            new_value: "#333",
            source: { framework: "react", component: "Hero", file: "/app/components/Hero.tsx", line: 11 },
          },
        ]),
      },
    ],
  });
  assert.match(prompt, /\n {3}Source: Button · components\/Hero\.tsx:42\n/);
  // A tune hands the source over inside its change record, and the summary names it.
  assert.match(prompt, /- h1: color #000 → #333 on `#hero > h1` only in Hero · components\/Hero\.tsx:11\n/);
  assert.match(
    prompt,
    /"source":\{"framework":"react","component":"Hero","file":"\/app\/components\/Hero\.tsx","line":11\}/,
  );
});

test("a change record keeps a source to the shape notes use, unknown included", () => {
  const [known, unknown, junk] = normalizeChangeRecords([
    {
      selector: "a",
      property: "color",
      source: {
        component: "Link",
        file: "src/Link.tsx",
        line: 3,
        owners: [{ component: "Nav", file: "src/Nav.tsx", line: 9 }],
        extra: 1,
      },
    },
    { selector: "a", property: "color", source: { unknown: true } },
    { selector: "a", property: "color", source: "src/Link.tsx" },
  ]);
  assert.deepEqual(known.source, {
    component: "Link",
    file: "src/Link.tsx",
    line: 3,
    owners: [{ component: "Nav", file: "src/Nav.tsx", line: 9 }],
  });
  assert.match(known.summary, / in Link · src\/Link\.tsx:3$/);
  assert.deepEqual(unknown.source, { unknown: true });
  assert.doesNotMatch(unknown.summary, / in /);
  assert.equal("source" in junk, false);
});
