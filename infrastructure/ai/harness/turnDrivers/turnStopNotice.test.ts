import test from "node:test";
import assert from "node:assert/strict";
import { buildTurnStopNotice } from "./turnStopNotice";

test("no notice when the turn finished on its own", () => {
  assert.equal(buildTurnStopNotice({ completedSteps: 4, maxIterations: 20, finishReason: "stop" }), null);
});

test("step budget exhaustion is reported", () => {
  const notice = buildTurnStopNotice({ completedSteps: 20, maxIterations: 20, finishReason: "tool-calls", language: "en-US" });
  assert.ok(notice);
  assert.match(notice, /20-step budget/);
  assert.match(notice, /continue/);
});

test("output truncation is reported and wins over the step hint", () => {
  const notice = buildTurnStopNotice({ completedSteps: 20, maxIterations: 20, finishReason: "length", language: "en-US" });
  assert.ok(notice);
  assert.match(notice, /output limit/);
});

test("chinese copy is used for zh locales", () => {
  const notice = buildTurnStopNotice({ completedSteps: 20, maxIterations: 20, finishReason: "tool-calls", language: "zh-CN" });
  assert.ok(notice);
  assert.match(notice, /步上限/);
});

test("a single step under a large budget stays silent", () => {
  assert.equal(buildTurnStopNotice({ completedSteps: 1, maxIterations: 60, finishReason: "tool-calls" }), null);
});
