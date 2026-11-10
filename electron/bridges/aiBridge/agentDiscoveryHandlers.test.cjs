"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeCursorInstallState,
  resolveDshCliPath,
} = require("./agentDiscoveryHandlers.cjs");

test("computeCursorInstallState: bundled SDK is not a user Cursor install", () => {
  const state = computeCursorInstallState({
    sdkInstalled: true,
    cliBinPath: null,
    cliLoginOk: false,
  });
  assert.equal(state.sdkInstalled, true);
  assert.equal(state.installed, false);
});

test("computeCursorInstallState: Agent CLI on PATH is a user Cursor install", () => {
  const state = computeCursorInstallState({
    sdkInstalled: true,
    cliBinPath: "/usr/local/bin/cursor-agent",
    cliLoginOk: false,
  });
  assert.equal(state.sdkInstalled, true);
  assert.equal(state.installed, true);
});

test("computeCursorInstallState: logged-out CLI path is installed without cliLoginOk", () => {
  const state = computeCursorInstallState({
    sdkInstalled: true,
    cliBinPath: "/bin/cursor-agent",
    cliLoginOk: false,
  });
  assert.equal(state.installed, true);
  assert.equal(state.sdkInstalled, true);
});

test("computeCursorInstallState: proven CLI login is a user Cursor install", () => {
  const state = computeCursorInstallState({
    sdkInstalled: false,
    cliBinPath: null,
    cliLoginOk: true,
  });
  assert.equal(state.sdkInstalled, false);
  assert.equal(state.installed, true);
});

test("resolveDshCliPath honours DSH_CLI_PATH when the launcher exists", async () => {
  const resolved = await resolveDshCliPath(
    { DSH_CLI_PATH: process.execPath, LOCALAPPDATA: "", HOME: "", USERPROFILE: "" },
    async () => "/should/not/be/used",
  );
  assert.equal(resolved, process.execPath);
});

test("resolveDshCliPath ignores a stale DSH_CLI_PATH and falls back to PATH", async () => {
  const resolved = await resolveDshCliPath(
    { DSH_CLI_PATH: "/definitely/missing/dsh", LOCALAPPDATA: "", HOME: "", USERPROFILE: "" },
    async (command) => (command === "dsh" ? "/from/path/dsh" : null),
  );
  assert.equal(resolved, "/from/path/dsh");
});

test("resolveDshCliPath returns null when nothing is installed", async () => {
  const resolved = await resolveDshCliPath(
    { LOCALAPPDATA: "/missing-appdata", HOME: "/missing-home", USERPROFILE: "" },
    async () => null,
  );
  assert.equal(resolved, null);
});
