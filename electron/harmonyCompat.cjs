const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const HARMONY_PLATFORM = "harmony";
const HARMONY_FILES_DIR = "/data/storage/el2/base/files";

let hcLogPathResolved = false;
let hcLogPathCache = null;
function resolveHcLogPath() {
  if (hcLogPathResolved) return hcLogPathCache;
  hcLogPathResolved = true;
  const candidates = [
    path.join(HARMONY_FILES_DIR, "netcatty_debug.log"),
    path.join(os.homedir(), "netcatty_debug.log"),
    "/tmp/netcatty_debug.log",
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.appendFileSync(candidate, "");
      hcLogPathCache = candidate;
      return candidate;
    } catch {}
  }
  hcLogPathCache = null;
  return null;
}

function hcLog(...args) {
  try {
    const logPath = resolveHcLogPath();
    if (!logPath) return;
    const line = `[${new Date().toISOString()}] [harmonyCompat] ${args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ")}\n`;
    fs.appendFileSync(logPath, line);
  } catch {}
}

let lastHomeLogKey = null;
function hcLogHome(info) {
  try {
    const key = JSON.stringify(info);
    if (key === lastHomeLogKey) return;
    lastHomeLogKey = key;
    hcLog("getSafeHomeDir", info);
  } catch {}
}

const probeWritableCache = new Map();
function probeWritable(dir) {
  if (!dir) return "empty";
  if (probeWritableCache.has(dir)) return probeWritableCache.get(dir);
  const probeFile = path.join(dir, `.netcatty_write_probe_${process.pid}`);
  let result;
  try {
    fs.writeFileSync(probeFile, "1");
    fs.unlinkSync(probeFile);
    result = true;
  } catch (error) {
    result = `no:${error?.code || error?.message || "unknown"}`;
  }
  probeWritableCache.set(dir, result);
  return result;
}

function isHarmony(platform = process.platform) {
  return platform === HARMONY_PLATFORM || platform === "ohos" || platform === "openharmony";
}

if (isHarmony()) {
  hcLog("WebAssembly check:", "typeof:", typeof WebAssembly, "available:", typeof WebAssembly !== "undefined");
}

function isDesktopPlatform(platform = process.platform) {
  return platform === "win32" || platform === "darwin" || platform === "linux";
}

function getSafeHomeDir(app) {
  const platform = process.platform;
  let resolvedApp = app && typeof app.getPath === "function" ? app : null;
  let requireError = null;
  if (isHarmony(platform) && !resolvedApp) {
    try {
      // Callers cannot always import the Electron app. On HarmonyOS the real
      // home directory is not writable, so lazily resolve the app to use the
      // sandboxed per-app userData directory instead of os.homedir().
      const electron = require("electron");
      if (electron && electron.app && typeof electron.app.getPath === "function") {
        resolvedApp = electron.app;
      }
    } catch (error) {
      requireError = error;
    }
  }

  let userDataPath = null;
  let userDataError = null;
  if (isHarmony(platform) && resolvedApp) {
    try {
      userDataPath = resolvedApp.getPath("userData");
    } catch (error) {
      userDataError = error;
    }
  }

  const osHome = os.homedir();
  let finalHome;
  if (isHarmony(platform) && userDataPath) {
    finalHome = userDataPath;
  } else if (osHome && osHome.length > 0) {
    finalHome = osHome;
  } else if (resolvedApp) {
    try {
      finalHome = resolvedApp.getPath("userData");
    } catch {
      finalHome = "/tmp";
    }
  } else {
    finalHome = "/tmp";
  }

  if (isHarmony(platform)) {
    hcLogHome({
      platform,
      hadAppArg: Boolean(app && typeof app.getPath === "function"),
      resolvedApp: Boolean(resolvedApp),
      requireError: requireError ? `${requireError.code || ""} ${requireError.message}`.trim() : null,
      userDataPath,
      userDataWritable: probeWritable(userDataPath),
      userDataError: userDataError ? `${userDataError.code || ""} ${userDataError.message}`.trim() : null,
      osHome,
      osHomeWritable: probeWritable(osHome),
      harmonyFilesWritable: probeWritable(HARMONY_FILES_DIR),
      finalHome,
      finalHomeWritable: probeWritable(finalHome),
    });
  }

  return finalHome;
}

function getSafeSshDir(app) {
  return path.join(getSafeHomeDir(app), ".ssh");
}

function getSafeKeyRoot(app) {
  return path.join(getSafeHomeDir(app), ".netcatty", "keys");
}

function getSafeKnownHostsPath(app) {
  return path.join(getSafeSshDir(app), "known_hosts");
}

function shouldUseDevServer() {
  if (isHarmony()) return false;
  return Boolean(process.env.VITE_DEV_SERVER_URL);
}

function shouldQuitOnWindowAllClosed(platform = process.platform) {
  if (platform === "darwin") return false;
  return true;
}

function isLocalTerminalAvailable(platform = process.platform) {
  if (isHarmony(platform)) return false;
  return true;
}

function isAutoLaunchSupported(platform = process.platform) {
  if (isHarmony(platform)) return false;
  return platform === "darwin" || platform === "win32";
}

function isDeepLinkSupported(platform = process.platform) {
  if (isHarmony(platform)) return false;
  return true;
}

function isExplorerContextMenuSupported(platform = process.platform) {
  if (isHarmony(platform)) return false;
  return platform === "win32";
}

function isPortableDataSupported(platform = process.platform) {
  if (isHarmony(platform)) return false;
  return platform === "win32";
}

function isTerminalWorkerSupported(platform = process.platform) {
  // HarmonyOS: the port's utilityProcess child (com.<bundle>:NodeService) traps
  // with SIGTRAP while booting its node runtime, so every terminal worker dies on
  // fork. Run the terminal/SSH/SFTP bridges in the main process instead.
  if (isHarmony(platform)) return false;
  return true;
}

module.exports = {
  HARMONY_PLATFORM,
  isHarmony,
  isDesktopPlatform,
  getSafeHomeDir,
  getSafeSshDir,
  getSafeKeyRoot,
  getSafeKnownHostsPath,
  shouldUseDevServer,
  shouldQuitOnWindowAllClosed,
  isLocalTerminalAvailable,
  isAutoLaunchSupported,
  isDeepLinkSupported,
  isExplorerContextMenuSupported,
  isPortableDataSupported,
  isTerminalWorkerSupported,
};
