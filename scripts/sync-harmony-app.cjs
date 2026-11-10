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
// --node-modules  also refresh app/node_modules with exactly the packages the main
//                 process requires (discovered by scanning electron/**) plus their
//                 transitive closure
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
// Packages deliberately left out of the payload. Everything else is discovered by
// scanning the main process for require()/import(), so this list only names what we
// must not ship: modules that cannot load on HarmonyOS (desktop binaries, native
// builds the port never reaches) and SDKs the agent drivers import lazily inside
// try/catch, which would otherwise add hundreds of megabytes of x64 binaries.
const SKIPPED_PACKAGES = new Set([
  "node-pty",
  "serialport",
  "@serialport",
  "@vscode/windows-process-tree",
  "electron-updater",
  "@withfig/autocomplete",
  "@anthropic-ai/claude-agent-sdk",
  "@cursor/sdk",
  "@github/copilot-sdk",
  "@mimo-ai/sdk",
  "@openai/codex-sdk",
  "@opencode-ai/sdk",
  "@tencent-ai/agent-sdk",
]);

function isSkippedPackage(name) {
  if (SKIPPED_PACKAGES.has(name)) return true;
  for (const skipped of SKIPPED_PACKAGES) {
    if (name.startsWith(`${skipped}/`)) return true;
  }
  return false;
}

function topLevelPackageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function collectSourceFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "build") continue;
      collectSourceFiles(path.join(dir, entry.name), out);
    } else if (/\.(cjs|js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Scan the shipped main-process code for every package it can reach. Dynamic
// require(variable) calls do not occur outside tests, so this is exhaustive.
function collectMainProcessRequires() {
  const builtins = new Set(require("node:module").builtinModules);
  const pattern = /(?:require\(\s*|import\(\s*)["']([^"']+)["']/g;
  const names = new Set();
  // electron/ is the main process itself; lib/, domain/ and infrastructure/ hold the
  // shared .cjs helpers it requires, and those in turn require packages of their own.
  const scanRoots = ["electron", "lib", "domain", "infrastructure"];
  const files = [];
  for (const root of scanRoots) {
    collectSourceFiles(path.join(repoRoot, root), files);
  }
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (specifier.startsWith("node:") || builtins.has(specifier)) continue;
      if (specifier === "electron") continue;
      const name = topLevelPackageName(specifier);
      if (isSkippedPackage(name)) continue;
      names.add(name);
    }
  }
  return names;
}

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

function collectNodeModuleNames(seedNames) {
  const sourceRoot = path.join(repoRoot, "node_modules");
  const names = new Set(seedNames);
  const queue = [...seedNames];
  while (queue.length) {
    const name = queue.pop();
    const manifestPath = path.join(sourceRoot, name, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(manifest[field] || {})) {
        if (isSkippedPackage(dependency)) continue;
        if (names.has(dependency)) continue;
        if (!fs.existsSync(path.join(sourceRoot, dependency))) continue;
        names.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return [...names].sort();
}

function syncNodeModules() {
  const sourceRoot = path.join(repoRoot, "node_modules");
  const targetRoot = path.join(appDir, "node_modules");
  const names = collectNodeModuleNames([...collectMainProcessRequires()]);
  // Rebuild from scratch: a stale directory would otherwise keep packages that a
  // previous (unpruned) run copied in.
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  let copied = 0;
  let bytes = 0;
  for (const name of names) {
    const source = path.join(sourceRoot, name);
    if (!fs.existsSync(source)) {
      log(`skip missing dependency ${name}`);
      continue;
    }
    fs.cpSync(source, path.join(targetRoot, name), { recursive: true, force: true });
    copied += 1;
    bytes += directorySize(source);
  }
  log(
    `refreshed ${copied}/${names.length} node_modules entries (${(bytes / 1048576).toFixed(1)} MB, main-process requires + closure)`,
  );
}

function directorySize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // ignore races on transient files
        }
      }
    }
  }
  return total;
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
