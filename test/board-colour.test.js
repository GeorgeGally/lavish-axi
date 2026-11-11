import assert from "node:assert/strict";
import test from "node:test";

import "../src/board-colour.js";

const { normalizeHex, hexToHsl, hslToHex, harmonySwatches, normalizePalette, variableOf } = /** @type {any} */ (
  globalThis
).LieselColour;

test("normalizeHex accepts what a person types and refuses the rest", () => {
  assert.equal(normalizeHex("#AABBCC"), "#aabbcc");
  assert.equal(normalizeHex("abc"), "#aabbcc");
  assert.equal(normalizeHex(" #0f0 "), "#00ff00");
  for (const bad of ["", "#12", "#1234", "#ggg", "red", undefined]) assert.equal(normalizeHex(bad), "");
});

test("hexToHsl and hslToHex agree on known colours", () => {
  assert.deepEqual(hexToHsl("#ff0000"), { h: 0, s: 100, l: 50 });
  assert.deepEqual(hexToHsl("#ffffff"), { h: 0, s: 0, l: 100 });
  assert.deepEqual(hexToHsl("#000000"), { h: 0, s: 0, l: 0 });
  assert.equal(hslToHex({ h: 120, s: 100, l: 50 }), "#00ff00");
  assert.equal(hslToHex({ h: 240, s: 100, l: 25 }), "#000080");
  assert.equal(hslToHex({ h: 360, s: 100, l: 50 }), "#ff0000");
  assert.equal(hslToHex({ h: 0, s: 0, l: 50 }), "#808080");
});

test("harmony swatches turn the hue and keep it for the tones", () => {
  const { hues, tones } = harmonySwatches({ h: 0, s: 100, l: 50 });
  // Neighbours either side, the opposite, and the two thirds round the wheel.
  assert.deepEqual(hues, ["#ff0080", "#ff8000", "#00ffff", "#00ff00", "#0000ff"]);
  assert.equal(tones.length, 5);
  assert.deepEqual(
    tones.map((hex) => hexToHsl(hex).h),
    [0, 0, 0, 0, 0],
  );
  const lightness = tones.map((hex) => hexToHsl(hex).l);
  assert.deepEqual(
    lightness,
    [...lightness].sort((a, b) => a - b),
  );
  assert.equal(new Set(tones).size, 5);
});

test("a grey, black or white still offers five different colours", () => {
  for (const hsl of [
    { h: 0, s: 0, l: 0 },
    { h: 0, s: 0, l: 20 },
    { h: 0, s: 0, l: 100 },
  ]) {
    assert.equal(new Set(harmonySwatches(hsl).hues).size, 5, JSON.stringify(hsl));
    assert.equal(new Set(harmonySwatches(hsl).tones).size, 5, JSON.stringify(hsl));
  }
});

test("a site palette keeps one swatch per hex, named only by a real custom property", () => {
  assert.deepEqual(
    normalizePalette([
      { hex: "#B95546", name: "--brand" },
      { hex: "#b95546", name: "--brand-copy" },
      { hex: "fff" },
      { hex: "red", name: "--named" },
      { hex: "#222222", name: "brand; color: red" },
      null,
    ]),
    [{ hex: "#b95546", name: "--brand" }, { hex: "#ffffff" }, { hex: "#222222" }],
  );
  assert.deepEqual(normalizePalette("nope"), []);
  const many = Array.from({ length: 40 }, (_, index) => ({ hex: `#0000${index.toString(16).padStart(2, "0")}` }));
  assert.equal(normalizePalette(many).length, 24);
});

test("variableOf names the token a value is exactly var() of", () => {
  assert.equal(variableOf("var(--brand)"), "--brand");
  assert.equal(variableOf(" var( --ink-2 ) "), "--ink-2");
  for (const other of ["#b95546", "var(--a, red)", "calc(var(--a))", "", undefined])
    assert.equal(variableOf(other), "");
});
