import assert from "node:assert/strict";
import test from "node:test";

import { MAX_LAYER_PX, maxFrameHeight, pointInsideArtboard, popoverPosition } from "../src/board-geometry.js";

test("pointInsideArtboard divides by the artboard scale at every zoom", () => {
  const rect = { left: 40, top: 100 };
  for (const scale of [0.05, 0.2, 0.5, 1, 1.5]) {
    const point = { clientX: 40 + 300 * scale, clientY: 100 + 200 * scale };
    const inside = pointInsideArtboard(rect, point, scale);
    assert.ok(Math.abs(inside.x - 300) < 0.0001, `x at scale ${scale}`);
    assert.ok(Math.abs(inside.y - 200) < 0.0001, `y at scale ${scale}`);
  }
});

test("pointInsideArtboard tolerates a missing scale", () => {
  assert.deepEqual(pointInsideArtboard({ left: 0, top: 0 }, { clientX: 12, clientY: 34 }, 0), { x: 12, y: 34 });
});

test("pointInsideArtboard maps a scrolled frame by its viewport origin only", () => {
  // elementFromPoint resolves the frame's own scroll, so the mapping must NOT add it:
  // a point 250px below the artboard's top edge is always 250/scale inside the viewport.
  const rect = { left: -120, top: 60 };
  const scale = 0.5;
  const inside = pointInsideArtboard(rect, { clientX: -120 + 250 * scale, clientY: 60 + 400 * scale }, scale);
  assert.deepEqual(inside, { x: 250, y: 400 });
});

test("popoverPosition keeps the card on screen and flips above near the bottom", () => {
  const viewport = { width: 1440, height: 900 };
  const card = { width: 290, height: 190 };
  const middle = popoverPosition({ left: 100, top: 56 }, { x: 400, y: 300 }, 1, { viewport, card });
  assert.equal(middle.flipped, false);
  assert.equal(middle.left, 518);
  assert.equal(middle.top, 350);

  const nearBottom = popoverPosition({ left: 100, top: 56 }, { x: 400, y: 780 }, 1, { viewport, card });
  assert.equal(nearBottom.flipped, true);
  assert.ok(nearBottom.top + card.height <= viewport.height);

  const offRight = popoverPosition({ left: 100, top: 56 }, { x: 1400, y: 300 }, 1, { viewport, card });
  assert.ok(offRight.left + card.width <= viewport.width);
});

test("popoverPosition stays inside a narrow phone artboard at small scale", () => {
  const viewport = { width: 1440, height: 900 };
  const card = { width: 290, height: 190 };
  const position = popoverPosition({ left: 1200, top: 56 }, { x: 380, y: 500 }, 0.27, { viewport, card });
  assert.ok(position.left >= 16);
  assert.ok(position.left + card.width <= viewport.width);
});

// A frame taller than the GPU's largest texture once zoomed vanishes from the board in
// headed Chrome: a 30000px phone frame at DPR 2 crossed 16384 device px between 23% and 28%.
test("maxFrameHeight keeps every frame under the GPU texture limit from Fit to 100%", () => {
  assert.equal(MAX_LAYER_PX, 16384);
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    const cap = maxFrameHeight(dpr);
    assert.ok(cap >= 4096, `a frame keeps a usable height at DPR ${dpr}`);
    for (const zoom of [0.02, 0.1, 0.23, 0.273, 0.2875, 0.5, 0.75, 1]) {
      assert.ok(cap * zoom * dpr <= MAX_LAYER_PX, `${cap}px at zoom ${zoom}, DPR ${dpr}`);
    }
  }
  assert.ok(30000 * 0.2875 * 2 > MAX_LAYER_PX, "the old 30000px cap broke past 27% at DPR 2");
});

test("maxFrameHeight treats a missing or tiny pixel ratio as 1", () => {
  assert.equal(maxFrameHeight(0), maxFrameHeight(1));
  assert.equal(maxFrameHeight(Number.NaN), maxFrameHeight(1));
  assert.equal(maxFrameHeight(0.5), maxFrameHeight(1));
});
