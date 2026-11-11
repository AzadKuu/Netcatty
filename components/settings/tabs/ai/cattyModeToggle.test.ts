import assert from "node:assert/strict";
import test from "node:test";
import { cattyModeFromEnhancedToggle, isCattyEnhancedMode } from "./cattyModeToggle";

test("cattyModeFromEnhancedToggle maps the switch to a stored mode", () => {
  assert.equal(cattyModeFromEnhancedToggle(true), "enhanced");
  assert.equal(cattyModeFromEnhancedToggle(false), "classic");
});

test("isCattyEnhancedMode only reports enhanced as enabled", () => {
  assert.equal(isCattyEnhancedMode("enhanced"), true);
  assert.equal(isCattyEnhancedMode("classic"), false);
});
