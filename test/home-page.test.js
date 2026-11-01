import assert from "node:assert/strict";
import test from "node:test";

import { createHomeHtml, folderLabels, relativeTime } from "../src/home-page.js";

const HOME = "/Users/ada";

test("folder labels shorten to the last two folders and grow until same-named boards differ", () => {
  assert.deepEqual(
    folderLabels(
      [
        "/Users/ada/work/data/hftw-lab-v8",
        "/Users/ada/work/data/hftw-lab-v9",
        "/Users/ada/work/data/flyd-live-activity/variants",
        "/Users/ada/work/data/flyd-boards/live-activity",
      ],
      HOME,
    ),
    ["…/data/hftw-lab-v8", "…/data/hftw-lab-v9", "…/flyd-live-activity/variants", "…/flyd-boards/live-activity"],
  );
  // A short path is shown whole, with the home folder as ~.
  assert.deepEqual(folderLabels(["/Users/ada/Liesel/shop", "/srv/site"], HOME), ["~/Liesel/shop", "/srv/site"]);
  // Two folders whose last two names match keep growing until they differ.
  assert.deepEqual(folderLabels(["/Users/ada/p/a/x/site/variants", "/Users/ada/p/b/x/site/variants"], HOME), [
    "…/a/x/site/variants",
    "…/b/x/site/variants",
  ]);
  // When the label would hold all but the first folder, the whole path is shown instead.
  assert.deepEqual(folderLabels(["/Users/ada/a/x/site", "/Users/ada/b/x/site"], HOME), ["~/a/x/site", "~/b/x/site"]);
});

test("relative times read as plain words and fall back to a date", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  assert.equal(relativeTime("2026-11-01T11:59:40Z", now), "Just now");
  assert.equal(relativeTime("2026-11-01T11:59:00Z", now), "1 minute ago");
  assert.equal(relativeTime("2026-11-01T11:15:00Z", now), "45 minutes ago");
  assert.equal(relativeTime("2026-11-01T09:00:00Z", now), "3 hours ago");
  assert.equal(relativeTime("2026-10-31T09:00:00Z", now), "Yesterday");
  assert.equal(relativeTime("2026-10-28T12:00:00Z", now), "4 days ago");
  assert.match(relativeTime("2026-09-02T12:00:00Z", now), /^Sep [12]$/);
  assert.match(relativeTime("2025-09-02T12:00:00Z", now), /^Sep [12], 2025$/);
  assert.equal(relativeTime("", now), "");
});

test("the home page shows each board as a card with its preview, folder, time and replies", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  const html = createHomeHtml(
    [
      {
        key: "aaaaaaaaaaaaaaaa",
        name: "Checkout <redo>",
        folder: "…/data/checkout",
        folderTitle: "/Users/ada/data/checkout",
        updatedAt: "2026-11-01T09:00:00Z",
        agentReplies: 3,
        preview: { kind: "frame", src: "/board/aaaaaaaaaaaaaaaa/item/v1/v1.html" },
      },
      {
        key: "bbbbbbbbbbbbbbbb",
        name: "Shop",
        folder: "~/Liesel/shop",
        folderTitle: "/Users/ada/Liesel/shop",
        updatedAt: "2026-10-31T09:00:00Z",
        agentReplies: 0,
        preview: { kind: "image", src: "/board/bbbbbbbbbbbbbbbb/item/v1/thumb/abcdef12" },
      },
      {
        key: "cccccccccccccccc",
        name: "Empty",
        folder: "~/Liesel/empty",
        folderTitle: "/Users/ada/Liesel/empty",
        updatedAt: "2026-10-30T09:00:00Z",
        agentReplies: 0,
        preview: null,
      },
    ],
    { now },
  );
  assert.match(html, /<title>Liesel<\/title>/);
  assert.match(html, /<h1>Liesel<\/h1>/);
  assert.match(html, /<a href="\/board\/aaaaaaaaaaaaaaaa">Checkout &lt;redo&gt;<\/a>/);
  assert.match(html, /data-src="\/board\/aaaaaaaaaaaaaaaa\/item\/v1\/v1\.html"/);
  assert.match(html, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.match(html, /<img[^>]*src="\/board\/bbbbbbbbbbbbbbbb\/item\/v1\/thumb\/abcdef12"/);
  assert.match(html, /No designs yet/);
  assert.match(html, /title="\/Users\/ada\/data\/checkout">…\/data\/checkout</);
  assert.match(html, /3 hours ago/);
  assert.match(html, /Yesterday/);
  assert.match(html, /data-unread-key="aaaaaaaaaaaaaaaa" data-replies="3"/);
  // The order given is the order shown.
  assert.ok(html.indexOf("aaaaaaaaaaaaaaaa") < html.indexOf("bbbbbbbbbbbbbbbb"));
  assert.ok(html.indexOf("bbbbbbbbbbbbbbbb") < html.indexOf("cccccccccccccccc"));
  assert.doesNotMatch(html, /No boards open/);
  // The page holds no underlined link list and no eyebrow-style tracking.
  assert.doesNotMatch(html, /<ul class="boards">/);
  for (const match of html.matchAll(/letter-spacing:\s*([-\d.]+)em/g)) {
    assert.ok(Number(match[1]) <= 0.04, `letter-spacing ${match[1]}em`);
  }
});

test("the home page has an empty state and a compact New board dialog with one short hint", () => {
  const html = createHomeHtml([], { now: Date.now() });
  assert.match(html, /No boards open yet/);
  assert.match(html, /<dialog[^>]*id="newBoardDialog"/);
  assert.match(html, /<form[^>]*id="newBoard"/);
  assert.match(html, /name="name"/);
  assert.match(html, /name="folder"/);
  assert.match(html, /id="browseFolder"/);
  const hint = /<p class="hint"[^>]*>([^<]*)<\/p>/.exec(html);
  assert.ok(hint, "the dialog has a hint line");
  assert.ok(hint[1].length <= 80, `hint stays one short line: ${hint[1]}`);
  assert.match(html, /prefers-color-scheme: ?dark/);
});

test("the home page leads with Open project, and marks project boards", () => {
  const html = createHomeHtml(
    [
      {
        key: "k1",
        name: "shop",
        folder: "~/code/shop",
        folderTitle: "/Users/me/code/shop",
        updatedAt: new Date().toISOString(),
        agentReplies: 0,
        preview: null,
        project: true,
      },
    ],
    { now: Date.now() },
  );
  assert.match(html, /<button class="button button-primary" type="button" data-open-project>Open project<\/button>/);
  assert.match(html, /<dialog[^>]*id="openProjectDialog"/);
  assert.match(html, /<form[^>]*id="openProject"/);
  assert.match(html, /name="path"/);
  assert.match(html, /id="browseProject"/);
  assert.match(html, /<span class="kind">Project<\/span>/);
  assert.match(html, /fetch\("\/api\/projects"/);
  const hints = [...html.matchAll(/<p class="hint"[^>]*>([^<]*)<\/p>/g)].map((match) => match[1]);
  for (const hint of hints) assert.ok(hint.length <= 80, `hint stays one short line: ${hint}`);
});

test("a board's New menu opens the home page's own dialog, and closing it returns to the board", () => {
  const html = createHomeHtml([], { now: Date.now() });
  assert.match(html, /"#new-board": \[dialog, "\[data-open-new-board\]"\]/);
  assert.match(html, /"#open-project": \[projectDialog, "\[data-open-project\]"\]/);
  assert.match(html, /from\.pathname\.startsWith\("\/board\/"\)/);
  assert.match(html, /addEventListener\("close", \(\) => history\.back\(\), \{ once: true \}\)/);
});
