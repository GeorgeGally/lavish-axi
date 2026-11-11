import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CHANGE_CONTRACT_RULE, normalizeChangeRecords } from "../src/board-changes.js";
import { buildRunnerPrompt } from "../src/board-runner.js";
import { createPollOutput } from "../src/cli.js";
import { SessionStore } from "../src/session-store.js";

// What the board client sends for one tune: a value a custom property drives, and a
// value changed on every card "like this one".
const RAW_CHANGES = [
  {
    selector: "main > section.hero > h1",
    label: "Heading",
    property: "color",
    old_value: "#1f2a44",
    new_value: "#0b5fff",
    viewport: { width: 1440, height: 900, zoom: 0.4567, device: "desktop" },
    scope: { kind: "element", count: 1 },
    variable: { name: "--brand-ink", value: "#1f2a44", declared: "var(--title-ink)" },
    frame: { item: "v1", device: "desktop", file: "v1.html" },
    injected: "dropped",
  },
  {
    selector: "div.rail > article.card > h3",
    label: "Card title",
    property: "font-size",
    old_value: "18px",
    new_value: "22px",
    viewport: { width: 390, height: 844, zoom: 1, device: "phone", only: true, media: "@media (max-width: 390px)" },
    scope: { kind: "repeated", count: 6, selector: "div.rail > article.card > h3" },
    frame: { item: "v1", device: "phone", file: "v1.html" },
  },
];

test("a change record keeps the variable behind a value and the repeated elements it reaches", () => {
  const [variableDriven, repeated] = normalizeChangeRecords(RAW_CHANGES);

  assert.deepEqual(variableDriven, {
    selector: "main > section.hero > h1",
    label: "Heading",
    property: "color",
    old_value: "#1f2a44",
    new_value: "#0b5fff",
    scope: { kind: "element", count: 1 },
    viewport: { width: 1440, height: 900, zoom: 0.457, device: "desktop" },
    variable: { name: "--brand-ink", value: "#1f2a44", declared: "var(--title-ink)" },
    frame: { item: "v1", device: "desktop", file: "v1.html" },
    summary:
      "Heading: color #1f2a44 → #0b5fff on `main > section.hero > h1` only (driven by --brand-ink) seen at 1440×900",
  });

  assert.deepEqual(repeated.scope, { kind: "repeated", count: 6, selector: "div.rail > article.card > h3" });
  assert.deepEqual(repeated.viewport, {
    width: 390,
    height: 844,
    zoom: 1,
    device: "phone",
    only: true,
    media: "@media (max-width: 390px)",
  });
  assert.equal(repeated.variable, undefined);
  assert.equal(
    repeated.summary,
    "Card title: font-size 18px → 22px on all 6 matching `div.rail > article.card > h3` at 390×844 only",
  );
});

test("records that cannot name a selector and a property are dropped, not guessed", () => {
  assert.deepEqual(normalizeChangeRecords("nope"), []);
  assert.deepEqual(
    normalizeChangeRecords([
      { property: "color", new_value: "red" },
      { selector: "h1", property: "color; background: red", new_value: "red" },
      { selector: "h1", property: "color", variable: { name: "brand" }, scope: { kind: "repeated", count: 1 } },
    ]).map((change) => [change.selector, change.variable, change.scope]),
    [["h1", undefined, { kind: "element", count: 1 }]],
  );
});

test("poll, MCP and the agent runner hand the agent the same change records and the source-edit rule", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "liesel-changes-"));
  try {
    const board = path.join(dir, "board.json");
    await writeFile(board, "{}");
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(board, "http://localhost:4387/board/test");
    await store.queuePrompts(session.key, {
      domSnapshot: "",
      prompts: [
        {
          uid: "u1",
          prompt: "Tune Hero (v1.html), element h1.",
          tag: "tune",
          selector: RAW_CHANGES[0].selector,
          item: { id: "v1", label: "Hero" },
          changes: RAW_CHANGES,
        },
      ],
    });
    const taken = await store.takeFeedback(session.key);
    assert.equal(taken.status, "feedback");
    const [prompt] = taken.prompts;
    assert.deepEqual(prompt.changes, normalizeChangeRecords(RAW_CHANGES));

    // `liesel poll` and the MCP liesel_poll tool both shape the server response here.
    const poll = createPollOutput({ file: board, response: taken });
    assert.deepEqual(poll.prompts[0].changes, prompt.changes);
    assert.ok(poll.next_step.includes(CHANGE_CONTRACT_RULE));
    assert.match(CHANGE_CONTRACT_RULE, /Never paste the board CSS as inline styles/);

    const runner = buildRunnerPrompt({
      boardDir: dir,
      boardName: "Hero",
      cwd: dir,
      items: [{ id: "v1", label: "Hero", file: "v1.html" }],
      prompts: taken.prompts,
    });
    assert.ok(runner.includes(CHANGE_CONTRACT_RULE));
    const records = [...runner.matchAll(/^ {5}Record: (.+)$/gm)].map((match) => JSON.parse(match[1]));
    assert.deepEqual(records, prompt.changes);
    for (const change of prompt.changes) assert.ok(runner.includes(`   - ${change.summary}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a poll without change records does not carry the change rule", () => {
  const poll = createPollOutput({
    file: "/tmp/board.json",
    response: { status: "feedback", dom_snapshot: "", prompts: [{ prompt: "Calmer", tag: "message" }] },
  });
  assert.ok(!poll.next_step.includes(CHANGE_CONTRACT_RULE));
});
