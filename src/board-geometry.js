// The board maps a pointer on the plane into an artboard's own viewport. Kept as a
// module (and mirrored by two lines in src/board-client.js, which is served raw and
// cannot import) so the rule is testable: divide by the artboard scale, subtract the
// iframe's on-screen origin, and let elementFromPoint resolve the iframe's scroll.
/**
 * @param {{ left: number, top: number }} iframeRect
 * @param {{ clientX: number, clientY: number }} point
 * @param {number} scale
 * @returns {{ x: number, y: number }} coordinates in the artboard's viewport
 */
export function pointInsideArtboard(iframeRect, point, scale) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    x: (point.clientX - iframeRect.left) / safeScale,
    y: (point.clientY - iframeRect.top) / safeScale,
  };
}

/**
 * Where a note's popover belongs on screen, from the anchor's viewport position inside
 * the artboard. Flips above the anchor when the card would run off the bottom.
 * @param {{ left: number, top: number }} iframeRect
 * @param {{ x: number, y: number }} anchor
 * @param {number} scale
 * @param {{ viewport: { width: number, height: number }, card: { width: number, height: number } }} bounds
 * @returns {{ left: number, top: number, flipped: boolean }}
 */
export function popoverPosition(iframeRect, anchor, scale, bounds) {
  const { viewport, card } = bounds;
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const anchorLeft = iframeRect.left + anchor.x * safeScale;
  const anchorTop = iframeRect.top + anchor.y * safeScale;
  const margin = 16;
  const left = Math.min(Math.max(anchorLeft + 18, margin), Math.max(margin, viewport.width - card.width - margin));
  const below = anchorTop + card.height + margin <= viewport.height;
  const top = below
    ? Math.max(margin, anchorTop - 6)
    : Math.min(
        Math.max(anchorTop - card.height - 12, margin),
        Math.max(margin, viewport.height - card.height - margin),
      );
  return { left, top, flipped: !below };
}
