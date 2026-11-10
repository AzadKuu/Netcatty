const { execSync } = require("node:child_process");

console.log("[HarmonyOS] Running harmony postinstall (patch-only)...");

try {
  execSync("npx patch-package", { stdio: "inherit" });
} catch (err) {
  console.warn("[HarmonyOS] patch-package failed:", err?.message || err);
}

try {
  execSync("node scripts/patch-xterm-macos-column-selection.cjs", { stdio: "inherit" });
} catch (err) {
  console.warn("[HarmonyOS] xterm column selection patch failed:", err?.message || err);
}

try {
  execSync("node scripts/patch-xterm-webgl-atlas.cjs", { stdio: "inherit" });
} catch (err) {
  console.warn("[HarmonyOS] xterm webgl atlas patch failed:", err?.message || err);
}

console.log("[HarmonyOS] postinstall complete.");
