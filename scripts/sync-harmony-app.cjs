// Copies the desktop app tree into the HarmonyOS HAP resource payload.
//
// The HAP ships the Electron app as plain files under
// harmony/web_engine/src/main/resources/resfile/resources/app, so every build has
// to refresh that snapshot from the repo. The snapshot keeps the repository
// layout (electron/, lib/, domain/, infrastructure/) because the Electron main
// process resolves those siblings with relative requires.
//
// Usage:
//   node scripts/sync-harmony-app.cjs [--node-modules] [--version <x.y.z>]
//
// --node-modules  also refresh app/node_modules from the repo install, limited to
//                 the packages listed in scripts/harmony/node-modules.txt
// --version       override the app version stamped into app/package.json

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const appDir = path.join(
  repoRoot,
  "harmony/web_engine/src/main/resources/resfile/resources/app",
);
const appJsonPath = path.join(repoRoot, "harmony/AppScope/app.json5");
const nodeModulesListPath = path.join(repoRoot, "scripts/harmony/node-modules.txt");

// Directories copied verbatim into the payload. `electron/` keeps the repo shape
// so relative requires into lib/, domain/ and infrastructure/ keep working.
const COPIED_DIRS = ["dist", "public", "electron", "lib", "domain", "infrastructure"];

const args = process.argv.slice(2);
const includeNodeModules = args.includes("--node-modules");
const versionFlagIndex = args.indexOf("--version");
const versionOverride =
  versionFlagIndex >= 0 ? args[versionFlagIndex + 1] : process.env.NETCATTY_VERSION;

function log(message) {
  console.log(`[harmony:sync] ${message}`);
}

function resolveVersion() {
  if (versionOverride) return versionOverride.replace(/^v/, "");
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (tag) return tag.replace(/^v/, "");
  } catch {
    // No tags in the clone (shallow or tagless); fall back to the manifest.
  }
  const appJson = fs.readFileSync(appJsonPath, "utf8");
  const match = appJson.match(/"versionName"\s*:\s*"([^"]+)"/);
  return match ? match[1] : "0.0.0";
}

function toVersionCode(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(/[.+-]/).map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
  return major * 1_000_000 + minor * 1_000 + patch;
}

function copyDir(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`missing source directory: ${path.relative(repoRoot, source)}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      if (base === "node_modules" || base === ".DS_Store") return false;
      // Unit tests live next to their subject in electron/ but never ship.
      if (/\.test\.(cjs|mjs|js)$/.test(base)) return false;
      return true;
    },
  });
  log(`copied ${path.relative(repoRoot, source)} -> ${path.relative(repoRoot, target)}`);
}

function writeAppPackageJson(version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const payload = {
    name: pkg.name,
    // app.getName() feeds the About panel and issue reports; the HAP bundle
    // metadata only carries the ArkTS app label.
    productName: pkg.productName || "Netcatty",
    version,
    main: "electron/main.cjs",
    dependencies: pkg.dependencies,
  };
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  log(`app/package.json version=${version}`);
}

function writeAppScopeVersion(version) {
  const source = fs.readFileSync(appJsonPath, "utf8");
  const versionCode = toVersionCode(version);
  const updated = source
    .replace(/"versionName"\s*:\s*"[^"]+"/, `"versionName": "${version}"`)
    .replace(/"versionCode"\s*:\s*\d+/, `"versionCode": ${versionCode}`);
  if (updated !== source) {
    fs.writeFileSync(appJsonPath, updated, "utf8");
    log(`AppScope/app.json5 versionName=${version} versionCode=${versionCode}`);
  }
}

function syncNodeModules() {
  const names = fs
    .readFileSync(nodeModulesListPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const sourceRoot = path.join(repoRoot, "node_modules");
  const targetRoot = path.join(appDir, "node_modules");
  fs.mkdirSync(targetRoot, { recursive: true });
  let copied = 0;
  for (const name of names) {
    const source = path.join(sourceRoot, name);
    if (!fs.existsSync(source)) {
      log(`skip missing dependency ${name}`);
      continue;
    }
    fs.cpSync(source, path.join(targetRoot, name), { recursive: true, force: true });
    copied += 1;
  }
  log(`refreshed ${copied}/${names.length} node_modules entries`);
}

function main() {
  if (!fs.existsSync(appDir)) {
    throw new Error(
      `payload directory not found: ${path.relative(repoRoot, appDir)} (is harmony/ checked out?)`,
    );
  }
  if (!fs.existsSync(path.join(repoRoot, "dist/index.html"))) {
    throw new Error("dist/index.html missing: run `npm run build:harmony` first");
  }

  const version = resolveVersion();
  for (const dir of COPIED_DIRS) {
    copyDir(path.join(repoRoot, dir), path.join(appDir, dir));
  }
  writeAppPackageJson(version);
  writeAppScopeVersion(version);
  if (includeNodeModules) syncNodeModules();
  log(`payload ready (version ${version}); run hvigor assembleHap next`);
}

main();
