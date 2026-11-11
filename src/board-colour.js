// The colour maths behind the Controls colour control. A classic script, so the board
// client (served raw, no imports) can read it from window, and tests can import it.
/** @type {any} */ (globalThis).LieselColour = (() => {
  const SIX_DIGITS = /^#[0-9a-f]{6}$/;
  const THREE_DIGITS = /^#[0-9a-f]{3}$/;
  // Either side, the opposite, and the two thirds round the wheel.
  const HUE_TURNS = [-30, 30, 180, 120, 240];
  const TONE_LIGHTNESS = [15, 32, 50, 68, 85];
  // Below this a hue turn is invisible, so the turns borrow a colour that shows.
  const MIN_VISIBLE_SATURATION = 45;
  const MAX_SITE_SWATCHES = 24;
  const VARIABLE_NAME = /^--[\w-]{1,80}$/;

  /** `#rrggbb`, or "" for anything that is not a hex colour. @param {unknown} value */
  function normalizeHex(value) {
    const text = String(value ?? "")
      .trim()
      .toLowerCase();
    const hex = text.startsWith("#") ? text : `#${text}`;
    if (SIX_DIGITS.test(hex)) return hex;
    if (!THREE_DIGITS.test(hex)) return "";
    return `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`;
  }

  /** @param {string} hex a `#rrggbb` colour */
  function hexToHsl(hex) {
    const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    const range = high - low;
    const lightness = (high + low) / 2;
    if (range === 0) return { h: 0, s: 0, l: Math.round(lightness * 100) };
    const saturation = range / (1 - Math.abs(2 * lightness - 1));
    let hue = (g - b) / range;
    if (high === g) hue = (b - r) / range + 2;
    if (high === b) hue = (r - g) / range + 4;
    return {
      h: Math.round((hue * 60 + 360) % 360),
      s: Math.round(saturation * 100),
      l: Math.round(lightness * 100),
    };
  }

  /** @param {{ h: number, s: number, l: number }} hsl */
  function hslToHex({ h, s, l }) {
    const saturation = s / 100;
    const lightness = l / 100;
    const reach = saturation * Math.min(lightness, 1 - lightness);
    /** @param {number} offset */
    const channel = (offset) => {
      const k = (offset + h / 30) % 12;
      const value = lightness - reach * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(value * 255)
        .toString(16)
        .padStart(2, "0");
    };
    return `#${channel(0)}${channel(8)}${channel(4)}`;
  }

  /** @param {{ h: number, s: number, l: number }} hsl */
  function harmonySwatches({ h, s, l }) {
    const saturation = Math.max(s, MIN_VISIBLE_SATURATION);
    const lightness = Math.max(30, Math.min(70, l));
    return {
      hues: HUE_TURNS.map((turn) => hslToHex({ h: (h + turn + 360) % 360, s: saturation, l: lightness })),
      tones: TONE_LIGHTNESS.map((tone) => hslToHex({ h, s, l: tone })),
    };
  }

  /**
   * The site colours a frame reported, as swatches: each a `#rrggbb`, with the custom
   * property behind it when there is one. One per hex, capped, junk dropped.
   * @param {unknown} value
   * @returns {{ hex: string, name?: string }[]}
   */
  function normalizePalette(value) {
    if (!Array.isArray(value)) return [];
    /** @type {Map<string, { hex: string, name?: string }>} */
    const byHex = new Map();
    for (const entry of value) {
      if (byHex.size >= MAX_SITE_SWATCHES) break;
      const hex = normalizeHex(entry?.hex);
      if (!hex || byHex.has(hex)) continue;
      const name = String(entry?.name ?? "");
      byHex.set(hex, VARIABLE_NAME.test(name) ? { hex, name } : { hex });
    }
    return [...byHex.values()];
  }

  /** The custom property a value is exactly `var(--name)` of, or "". @param {unknown} value */
  function variableOf(value) {
    const match = /^var\(\s*(--[\w-]+)\s*\)$/.exec(String(value ?? "").trim());
    return match && VARIABLE_NAME.test(match[1]) ? match[1] : "";
  }

  return { normalizeHex, hexToHsl, hslToHex, harmonySwatches, normalizePalette, variableOf };
})();
