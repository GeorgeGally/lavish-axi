import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  crawlDevServer,
  discoverRoutes,
  mergePages,
  pagesFromHtml,
  pagesFromSitemap,
  patternMatcher,
} from "../src/project-pages.js";

async function project(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), "liesel-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
  return root;
}

const paths = (routes) => routes.map((route) => route.path || `~${route.pattern}`).sort();

test("Next.js app and pages routers: groups, private folders, slots and API routes are not pages", async (t) => {
  const root = await project(t, {
    "package.json": JSON.stringify({ dependencies: { next: "15" } }),
    "app/page.tsx": "export default function Home() {}",
    "app/(marketing)/pricing/page.tsx": "",
    "app/blog/[slug]/page.tsx": "",
    "app/_components/page.tsx": "",
    "app/@modal/login/page.tsx": "",
    "app/api/route.ts": "",
    "src/pages/about.tsx": "",
    "src/pages/_app.tsx": "",
    "src/pages/api/hello.ts": "",
    "node_modules/x/app/page.tsx": "",
    ".next/server/app/page.js": "",
  });
  const found = await discoverRoutes(root);
  assert.equal(found.framework, "Next.js");
  assert.deepEqual(paths(found.routes), ["/", "/about", "/pricing", "~/blog/:slug"]);
});

test("SvelteKit, Astro, Nuxt and Remix routes come from their own folders", async (t) => {
  const svelte = await project(t, {
    "package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": "2" } }),
    "src/routes/+page.svelte": "",
    "src/routes/(app)/settings/+page.svelte": "",
    "src/routes/posts/[id=int]/+page.svelte": "",
    "src/routes/+layout.svelte": "",
  });
  assert.deepEqual(paths((await discoverRoutes(svelte)).routes), ["/", "/settings", "~/posts/:id"]);

  const astro = await project(t, {
    "package.json": JSON.stringify({ dependencies: { astro: "4" } }),
    "src/pages/index.astro": "",
    "src/pages/about.md": "",
    "src/pages/_draft.astro": "",
    "src/pages/rss.xml.js": "",
  });
  assert.deepEqual(paths((await discoverRoutes(astro)).routes), ["/", "/about"]);

  const nuxt = await project(t, {
    "package.json": JSON.stringify({ devDependencies: { nuxt: "3" } }),
    "pages/index.vue": "",
    "pages/team/[name].vue": "",
    "pages/contact.vue": "",
  });
  assert.deepEqual(paths((await discoverRoutes(nuxt)).routes), ["/", "/contact", "~/team/:name"]);

  const remix = await project(t, {
    "package.json": JSON.stringify({ devDependencies: { "@remix-run/dev": "2" } }),
    "app/routes/_index.tsx": "export default function Index() {}",
    "app/routes/blog.$slug.tsx": "export default function Post() {}",
    "app/routes/_auth.login.tsx": "export default function Login() {}",
    "app/routes/healthz.ts": "export const loader = () => null;",
    "app/routes/account/route.tsx": "export default function Account() {}",
  });
  assert.deepEqual(paths((await discoverRoutes(remix)).routes), ["/", "/account", "/login", "~/blog/:slug"]);
});

test("a plain folder or a Vite app offers its HTML files and its absolute client routes", async (t) => {
  const plain = await project(t, {
    "index.html": "",
    "flow.html": "",
    "docs/index.html": "",
    "Claude outputs/a b.html": "",
    "node_modules/pkg/readme.html": "",
  });
  const found = await discoverRoutes(plain);
  assert.equal(found.framework, "HTML");
  assert.deepEqual(paths(found.routes), ["/", "/Claude%20outputs/a%20b.html", "/docs/", "/flow.html"]);

  const vite = await project(t, {
    "package.json": JSON.stringify({
      dependencies: { react: "18", "react-router-dom": "6" },
      devDependencies: { vite: "5" },
    }),
    "index.html": "",
    "src/main.jsx":
      'import { createBrowserRouter } from "react-router-dom";\nconst router = createBrowserRouter([{ path: "/", element: null }, { path: "/about" }, { path: "/users/:id" }, { path: "edit" }, { path: "*" }]);',
    "src/App.jsx": 'import { Route } from "react-router-dom";\n<Route path="/contact" element={<Contact />} />',
  });
  const viteFound = await discoverRoutes(vite);
  assert.equal(viteFound.framework, "Vite");
  assert.deepEqual(paths(viteFound.routes), ["/", "/", "/about", "/contact", "~/users/:id"]);
});

test("links and sitemaps name same-site pages only, without assets or the dev server's own files", () => {
  assert.deepEqual(
    pagesFromHtml(
      `<a href="/about">About</a><a href='pricing?plan=1#top'>P</a><a href=https://elsewhere.example/x>x</a>
       <a href="mailto:a@b.c">m</a><a href="/logo.png">i</a><a href="/_next/static/x">n</a><a href="http://localhost:3000/blog/hello">b</a><a href="#x">h</a>`,
      "/",
    ),
    ["/about", "/pricing", "/blog/hello"],
  );
  assert.deepEqual(
    pagesFromSitemap(
      "<urlset><url><loc>https://shop.example/</loc></url><url><loc> https://shop.example/store </loc></url></urlset>",
    ),
    ["/", "/store"],
  );
});

test("a dynamic route is offered only with examples the site links to; the rest are counted as skipped", () => {
  assert.equal(patternMatcher("/blog/:slug")("/blog/hello"), true);
  assert.equal(patternMatcher("/blog/:slug")("/blog/hello/more"), false);
  const merged = mergePages({
    routes: [{ path: "/about" }, { pattern: "/blog/:slug" }, { pattern: "/users/:id" }, { path: "/" }],
    crawled: ["/", "/blog/hello", "/contact"],
    board: ["/store"],
  });
  assert.deepEqual(
    merged.pages.map((page) => [page.path, page.source, page.pattern || ""]),
    [
      ["/", "files", ""],
      ["/about", "files", ""],
      ["/blog/hello", "site", "/blog/:slug"],
      ["/contact", "site", ""],
      ["/store", "board", ""],
    ],
  );
  assert.deepEqual(merged.skipped, ["/users/:id"]);
});

test("the running site is read for its sitemap and its home page's links", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end("<urlset><url><loc>http://x/store</loc></url></urlset>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<a href="/about">About</a>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.deepEqual((await crawlDevServer(port)).sort(), ["/", "/about", "/store"]);
  assert.deepEqual(await crawlDevServer(0), []);
});
