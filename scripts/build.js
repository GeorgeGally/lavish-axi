import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as esbuild from "esbuild";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await mkdir("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["bin/liesel.js"],
  outfile: "dist/cli.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.LIESEL_BUILD_UMAMI_HOST": JSON.stringify(process.env.LIESEL_UMAMI_HOST || ""),
    "process.env.LIESEL_BUILD_UMAMI_WEBSITE_ID": JSON.stringify(process.env.LIESEL_UMAMI_WEBSITE_ID || ""),
    "process.env.LIESEL_BUILD_VERSION": JSON.stringify(packageJson.version),
  },
});

await chmod("dist/cli.mjs", 0o755);

await esbuild.build({
  entryPoints: ["bin/liesel-server.js"],
  outfile: "dist/server.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [
    {
      name: "external-cli",
      setup(build) {
        build.onResolve({ filter: /^\.\/liesel\.js$/ }, () => ({
          path: "./cli.mjs",
          external: true,
        }));
      },
    },
  ],
});
await chmod("dist/server.mjs", 0o755);

await copyFile("src/chrome-client.js", "dist/chrome-client.js");
await copyFile("src/chrome.css", "dist/chrome.css");
await copyFile("src/board-client.js", "dist/board-client.js");
await copyFile("src/board-sdk.js", "dist/board-sdk.js");
await copyFile("src/board.css", "dist/board.css");
await mkdir("dist/design", { recursive: true });
await copyFile("node_modules/daisyui/daisyui.css", "dist/design/daisyui.css");
await copyFile("node_modules/daisyui/themes.css", "dist/design/daisyui-themes.css");
await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", "dist/design/tailwindcss-browser.js");

// Whiteboard frame: a self-contained browser bundle (Excalidraw + the Mermaid
// converter + its exactly-pinned mermaid + React) served from
// /whiteboard-assets/ by an embedded frame for every rendered Mermaid diagram
// in a `.mermaid` container.
// Everything is vendored so the eagerly loaded whiteboards work fully offline.
await mkdir("dist/whiteboard", { recursive: true });
await esbuild.build({
  entryPoints: { whiteboard: "src/whiteboard-frame.js" },
  outdir: "dist/whiteboard",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  conditions: ["production"],
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.IS_PREACT": '"false"',
  },
});

// Excalidraw lazily fetches canvas fonts from `EXCALIDRAW_ASSET_PATH/fonts/`.
// Vendor every family except Xiaolai (12 MB of CJK glyphs; those fall back to
// Excalidraw's CDN fallback or the system font when missing locally).
const fontFamilies = ["Assistant", "Cascadia", "ComicShanns", "Excalifont", "Liberation", "Lilita", "Nunito", "Virgil"];
await mkdir("dist/whiteboard/fonts", { recursive: true });
for (const family of fontFamilies) {
  await cp(`node_modules/@excalidraw/excalidraw/dist/prod/fonts/${family}`, `dist/whiteboard/fonts/${family}`, {
    recursive: true,
  });
}

// Written last, so an open during a build still sees the old id and the finished build is what
// replaces the server (`isDifferentBuild` in src/cli.js). Hashed from content, so re-running the
// build over unchanged code does not restart anything.
const buildHash = createHash("sha256");
const builtFiles = await readdir("dist", { recursive: true, withFileTypes: true });
const builtPaths = builtFiles
  .filter((entry) => entry.isFile() && entry.name !== "build-id")
  .map((entry) => path.join(entry.parentPath, entry.name))
  .sort();
for (const file of builtPaths) {
  buildHash.update(file);
  buildHash.update(await readFile(file));
}
await writeFile("dist/build-id", `${buildHash.digest("hex")}\n`);
