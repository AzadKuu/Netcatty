import test from "node:test";
import assert from "node:assert/strict";
import type { Host } from "../../../../domain/models";
import {
  DSH_LOCAL_AGENT_HOST_VALUE,
  DSH_UNMATCHED_AGENT_HOST_VALUE,
  buildDshAgentHostCommand,
  resolveDshAgentHostSelectValue,
  resolveDshSelectedHostId,
} from "./dshAgentHostSelection";

function makeHost(overrides: Partial<Host> & Pick<Host, "id" | "hostname" | "username">): Host {
  return {
    label: overrides.id,
    tags: [],
    os: "linux",
    ...overrides,
  } as Host;
}

const host22 = makeHost({ id: "h1", label: "Build box", hostname: "mc.example.com", username: "shawn", port: 22 });
const host2222 = makeHost({ id: "h2", label: "Jump", hostname: "jump.example.com", username: "ops", port: 2222 });
const hostNoPort = makeHost({ id: "h3", hostname: "bare.example.com", username: "root" });

test("buildDshAgentHostCommand writes an ssh pin and omits the default port", () => {
  assert.equal(buildDshAgentHostCommand(host22), "ssh://shawn@mc.example.com");
  assert.equal(buildDshAgentHostCommand(hostNoPort), "ssh://root@bare.example.com");
});

test("buildDshAgentHostCommand keeps a non-default port", () => {
  assert.equal(buildDshAgentHostCommand(host2222), "ssh://ops@jump.example.com:2222");
});

test("buildDshAgentHostCommand omits the user part and rejects an empty host", () => {
  assert.equal(buildDshAgentHostCommand({ hostname: "solo.example.com", username: "", port: 22 }), "ssh://solo.example.com");
  assert.equal(buildDshAgentHostCommand({ hostname: "  ", username: "shawn", port: 22 }), null);
});

test("resolveDshSelectedHostId preselects the host behind an ssh pin", () => {
  const hosts = [host22, host2222, hostNoPort];
  assert.equal(resolveDshSelectedHostId(hosts, "ssh://shawn@mc.example.com"), "h1");
  assert.equal(resolveDshSelectedHostId(hosts, "ssh://ops@jump.example.com:2222"), "h2");
  // A pin that spells out the default port still selects the host.
  assert.equal(resolveDshSelectedHostId(hosts, "ssh://shawn@mc.example.com:22"), "h1");
});

test("resolveDshSelectedHostId keeps Local for empty or non-ssh values", () => {
  const hosts = [host22, host2222];
  assert.equal(resolveDshSelectedHostId(hosts, ""), "");
  assert.equal(resolveDshSelectedHostId(hosts, "dsh"), "");
  assert.equal(resolveDshSelectedHostId(hosts, "C:\\Tools\\dsh\\dsh.cmd"), "");
});

test("resolveDshSelectedHostId does not match a different user or port", () => {
  const hosts = [host22, host2222];
  assert.equal(resolveDshSelectedHostId(hosts, "ssh://other@mc.example.com"), "");
  assert.equal(resolveDshSelectedHostId(hosts, "ssh://shawn@mc.example.com:2222"), "");
  assert.equal(resolveDshSelectedHostId(hosts, "ssh://shawn@unknown.example.com"), "");
});

test("resolveDshAgentHostSelectValue keeps an unmatched ssh pin visible", () => {
  const hosts = [host22, host2222];
  // Radix Select rejects an empty item value, so "local" is a sentinel.
  assert.equal(resolveDshAgentHostSelectValue(hosts, ""), DSH_LOCAL_AGENT_HOST_VALUE);
  assert.equal(resolveDshAgentHostSelectValue(hosts, "ssh://shawn@mc.example.com"), "h1");
  assert.equal(
    resolveDshAgentHostSelectValue(hosts, "ssh://gone@retired.example.com"),
    DSH_UNMATCHED_AGENT_HOST_VALUE,
  );
  // A pin may carry a dsh path suffix; the host still matches.
  assert.equal(
    resolveDshAgentHostSelectValue(hosts, "ssh://shawn@mc.example.com/opt/dsh/bin/dsh"),
    "h1",
  );
});
