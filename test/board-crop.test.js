import assert from "node:assert/strict";
import test from "node:test";

import { CROP_MARGIN, CROP_MAX_HEIGHT, cropBox, cropFrameHtml, findChrome } from "../src/board-crop.js";

test("cropBox grows the element's box by the margin and keeps it on the page", () => {
  assert.deepEqual(cropBox({ x: 100, y: 300, w: 160, h: 44 }, 1440), {
    x: 100 - CROP_MARGIN,
    y: 300 - CROP_MARGIN,
    width: 160 + CROP_MARGIN * 2,
    height: 44 + CROP_MARGIN * 2,
  });
  // Against the page's top-left and right edge.
  assert.deepEqual(cropBox({ x: 10, y: 5, w: 400, h: 20 }, 390), { x: 0, y: 0, width: 390, height: 65 });
  // A tall element is cut at the cap.
  assert.equal(cropBox({ x: 0, y: 0, w: 390, h: 5000 }, 390)?.height, CROP_MAX_HEIGHT);
  for (const bad of [null, {}, { x: 0, y: 0, w: 0, h: 10 }, { x: "a", y: 0, w: 10, h: 10 }]) {
    assert.equal(cropBox(bad, 1440), null);
  }
});

test("cropFrameHtml shifts the sandboxed item so the crop fills the window", () => {
  const html = cropFrameHtml({
    src: '/board/k/item/v1/index.html?device=phone&x="<',
    deviceWidth: 390,
    deviceHeight: 844,
    box: { x: 20, y: 1000, width: 200, height: 120 },
  });
  assert.match(html, /left: -20px; top: -1000px; width: 390px; height: 1120px;/);
  assert.match(
    html,
    /<iframe sandbox="allow-scripts" src="\/board\/k\/item\/v1\/index\.html\?device=phone&amp;x=&quot;&lt;">/,
  );
});

test("findChrome honours a configured path and refuses one that is missing", () => {
  assert.equal(findChrome({ LIESEL_CHROME: "/nonexistent/chrome" }), "");
  assert.equal(findChrome({ LIESEL_CHROME: process.execPath }), process.execPath);
});

test("cropFrameHtml frames a live page by name on its own origin, and a file item opaque", () => {
  const box = { x: 0, y: 10, width: 100, height: 50 };
  const live = cropFrameHtml({
    src: "http://127.0.0.1:5000/store",
    deviceWidth: 390,
    deviceHeight: 844,
    box,
    live: "liesel:store:phone",
  });
  assert.match(
    live,
    /<iframe sandbox="allow-scripts allow-same-origin" name="liesel:store:phone" src="http:\/\/127\.0\.0\.1:5000\/store">/,
  );
  const file = cropFrameHtml({
    src: "/board/k/item/a/index.html?device=phone",
    deviceWidth: 390,
    deviceHeight: 844,
    box,
  });
  assert.match(file, /<iframe sandbox="allow-scripts" src=/);
});
