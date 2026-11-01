import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { bindHost, clientHost, extraAllowedHosts, hostForUrl, LOOPBACK_HOST, linkHost } from "../src/paths.js";

test("bindHost defaults to loopback and honors EASEL_HOST", () => {
  assert.equal(bindHost({}), LOOPBACK_HOST);
  assert.equal(bindHost({ EASEL_HOST: "" }), LOOPBACK_HOST);
  assert.equal(bindHost({ EASEL_HOST: "  " }), LOOPBACK_HOST);
  assert.equal(bindHost({ EASEL_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(bindHost({ EASEL_HOST: " 0.0.0.0 " }), "0.0.0.0");
});

test("clientHost dials the concrete primary listener for wildcard binds", () => {
  assert.equal(clientHost({}), LOOPBACK_HOST);
  assert.equal(clientHost({ EASEL_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(clientHost({ EASEL_HOST: "0.0.0.0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ EASEL_HOST: "::" }), LOOPBACK_HOST);
  assert.equal(clientHost({ EASEL_HOST: "[::]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ EASEL_HOST: "0:0:0:0:0:0:0:0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ EASEL_HOST: "[0:0:0:0:0:0:0:0]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ EASEL_HOST: "::ffff:0.0.0.0" }), LOOPBACK_HOST);
});

test("extraAllowedHosts parses the whitespace-separated opt-in list", () => {
  assert.deepEqual(extraAllowedHosts({}), []);
  assert.deepEqual(extraAllowedHosts({ EASEL_ALLOWED_HOSTS: "" }), []);
  assert.deepEqual(extraAllowedHosts({ EASEL_ALLOWED_HOSTS: "  " }), []);
  assert.deepEqual(extraAllowedHosts({ EASEL_ALLOWED_HOSTS: "proxy.example" }), ["proxy.example"]);
  assert.deepEqual(extraAllowedHosts({ EASEL_ALLOWED_HOSTS: "  a.example   b.example\tc.example  " }), [
    "a.example",
    "b.example",
    "c.example",
  ]);
  assert.deepEqual(extraAllowedHosts({ EASEL_ALLOWED_HOSTS: "*" }), ["*"]);
});

test("linkHost prefers EASEL_LINK_HOST, then falls back to the dial host", () => {
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ EASEL_LINK_HOST: "host.example" }), "host.example");
  assert.equal(linkHost({ EASEL_LINK_HOST: "  " }), LOOPBACK_HOST);
  // Non-wildcard bind with no explicit link host -> links reuse the bind address.
  assert.equal(linkHost({ EASEL_HOST: "100.64.0.1" }), "100.64.0.1");
  // Wildcard bind with an explicit link host -> links use the hostname, not 0.0.0.0.
  assert.equal(linkHost({ EASEL_HOST: "0.0.0.0", EASEL_LINK_HOST: "host.example" }), "host.example");
  // IPv6 wildcard bind with no explicit link host -> links use the concrete loopback listener.
  assert.equal(linkHost({ EASEL_HOST: "::" }), LOOPBACK_HOST);
});

test("hostForUrl brackets IPv6 literals but leaves IPv4 and hostnames alone", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("host.example"), "host.example");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});

test("Easel's default port and state dir never collide with the tool it grew from", async () => {
  const { DEFAULT_PORT, defaultPort, stateDir } = await import("../src/paths.js");
  const saved = { ...process.env };
  try {
    for (const key of ["EASEL_PORT", "EASEL_STATE_DIR"]) delete process.env[key];
    assert.equal(defaultPort(), DEFAULT_PORT);
    assert.notEqual(DEFAULT_PORT, 4387, "4387 is another tool's default");
    assert.equal(path.basename(stateDir()), ".easel");
    process.env.EASEL_PORT = "5001";
    assert.equal(defaultPort(), 5001);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("adoptLegacyEnv reads the pre-rename settings as silent fallbacks, never over an EASEL_ value", async () => {
  const { adoptLegacyEnv, LEGACY_ENV_PREFIX } = await import("../src/brand.js");
  const env = {
    [`${LEGACY_ENV_PREFIX}PORT`]: "4401",
    [`${LEGACY_ENV_PREFIX}STATE_DIR`]: "/tmp/old-state",
    [`${LEGACY_ENV_PREFIX}HOST`]: "",
    EASEL_STATE_DIR: "/tmp/new-state",
  };
  adoptLegacyEnv(env);
  assert.equal(env.EASEL_PORT, "4401");
  assert.equal(env.EASEL_STATE_DIR, "/tmp/new-state");
  assert.equal(env.EASEL_HOST, undefined);
});
