import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindHost, clientHost, extraAllowedHosts, hostForUrl, LOOPBACK_HOST, linkHost } from "../src/paths.js";

test("bindHost defaults to loopback and honors LIESEL_HOST", () => {
  assert.equal(bindHost({}), LOOPBACK_HOST);
  assert.equal(bindHost({ LIESEL_HOST: "" }), LOOPBACK_HOST);
  assert.equal(bindHost({ LIESEL_HOST: "  " }), LOOPBACK_HOST);
  assert.equal(bindHost({ LIESEL_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(bindHost({ LIESEL_HOST: " 0.0.0.0 " }), "0.0.0.0");
});

test("clientHost dials the concrete primary listener for wildcard binds", () => {
  assert.equal(clientHost({}), LOOPBACK_HOST);
  assert.equal(clientHost({ LIESEL_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(clientHost({ LIESEL_HOST: "0.0.0.0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LIESEL_HOST: "::" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LIESEL_HOST: "[::]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LIESEL_HOST: "0:0:0:0:0:0:0:0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LIESEL_HOST: "[0:0:0:0:0:0:0:0]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LIESEL_HOST: "::ffff:0.0.0.0" }), LOOPBACK_HOST);
});

test("extraAllowedHosts parses the whitespace-separated opt-in list", () => {
  assert.deepEqual(extraAllowedHosts({}), []);
  assert.deepEqual(extraAllowedHosts({ LIESEL_ALLOWED_HOSTS: "" }), []);
  assert.deepEqual(extraAllowedHosts({ LIESEL_ALLOWED_HOSTS: "  " }), []);
  assert.deepEqual(extraAllowedHosts({ LIESEL_ALLOWED_HOSTS: "proxy.example" }), ["proxy.example"]);
  assert.deepEqual(extraAllowedHosts({ LIESEL_ALLOWED_HOSTS: "  a.example   b.example\tc.example  " }), [
    "a.example",
    "b.example",
    "c.example",
  ]);
  assert.deepEqual(extraAllowedHosts({ LIESEL_ALLOWED_HOSTS: "*" }), ["*"]);
});

test("linkHost prefers LIESEL_LINK_HOST, then falls back to the dial host", () => {
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ LIESEL_LINK_HOST: "host.example" }), "host.example");
  assert.equal(linkHost({ LIESEL_LINK_HOST: "  " }), LOOPBACK_HOST);
  // Non-wildcard bind with no explicit link host -> links reuse the bind address.
  assert.equal(linkHost({ LIESEL_HOST: "100.64.0.1" }), "100.64.0.1");
  // Wildcard bind with an explicit link host -> links use the hostname, not 0.0.0.0.
  assert.equal(linkHost({ LIESEL_HOST: "0.0.0.0", LIESEL_LINK_HOST: "host.example" }), "host.example");
  // IPv6 wildcard bind with no explicit link host -> links use the concrete loopback listener.
  assert.equal(linkHost({ LIESEL_HOST: "::" }), LOOPBACK_HOST);
});

test("hostForUrl brackets IPv6 literals but leaves IPv4 and hostnames alone", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("host.example"), "host.example");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});

test("Liesel's default port and state dir never collide with the tool it grew from", async () => {
  const { DEFAULT_PORT, defaultPort, stateDir } = await import("../src/paths.js");
  const saved = { ...process.env };
  try {
    for (const key of ["LIESEL_PORT", "LIESEL_STATE_DIR"]) delete process.env[key];
    assert.equal(defaultPort(), DEFAULT_PORT);
    assert.notEqual(DEFAULT_PORT, 4387, "4387 is another tool's default");
    const home = await mkdtemp(path.join(os.tmpdir(), "liesel-home-"));
    assert.equal(stateDir(home), path.join(home, ".liesel"));
    process.env.LIESEL_PORT = "5001";
    assert.equal(defaultPort(), 5001);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("adoptLegacyEnv reads the pre-rename settings as silent fallbacks, never over a LIESEL_ value", async () => {
  const { adoptLegacyEnv } = await import("../src/brand.js");
  const env = {
    LAVISH_AXI_PORT: "4401",
    LAVISH_AXI_STATE_DIR: "/tmp/old-state",
    LAVISH_AXI_HOST: "",
    LAVISH_AXI_DEBUG: "0",
    EASEL_DEBUG: "1",
    EASEL_AGENT_NAME: "Codex",
    EASEL_LINK_HOST: "",
    LIESEL_STATE_DIR: "/tmp/new-state",
  };
  adoptLegacyEnv(env);
  assert.equal(env.LIESEL_PORT, "4401");
  assert.equal(env.LIESEL_STATE_DIR, "/tmp/new-state");
  assert.equal(env.LIESEL_HOST, undefined);
  assert.equal(env.LIESEL_AGENT_NAME, "Codex");
  assert.equal(env.LIESEL_DEBUG, "1", "the newer EASEL_ name wins over LAVISH_AXI_");
  assert.equal(env.LIESEL_LINK_HOST, undefined);
});

test("stateDir keeps using an existing ~/.easel until ~/.liesel exists", async () => {
  const { stateDir } = await import("../src/paths.js");
  const saved = process.env.LIESEL_STATE_DIR;
  delete process.env.LIESEL_STATE_DIR;
  try {
    const home = await mkdtemp(path.join(os.tmpdir(), "liesel-home-"));
    assert.equal(stateDir(home), path.join(home, ".liesel"));
    await mkdir(path.join(home, ".easel"));
    assert.equal(stateDir(home), path.join(home, ".easel"));
    await mkdir(path.join(home, ".liesel"));
    assert.equal(stateDir(home), path.join(home, ".liesel"));
    process.env.LIESEL_STATE_DIR = "/tmp/explicit-state";
    assert.equal(stateDir(home), "/tmp/explicit-state");
  } finally {
    if (saved === undefined) delete process.env.LIESEL_STATE_DIR;
    else process.env.LIESEL_STATE_DIR = saved;
  }
});
