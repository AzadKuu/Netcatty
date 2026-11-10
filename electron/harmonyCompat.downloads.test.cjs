const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  HARMONY_PLATFORM,
  getDownloadDir,
  remapLocalTransferTarget,
  resetDownloadDirCache,
} = require("./harmonyCompat.cjs");

const DOWNLOAD_DIR = path.join("/app/data", "Downloads", "Netcatty");

function makeSandboxApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-harmony-dl-"));
  return {
    root,
    app: {
      getPath(name) {
        if (name !== "userData") throw new Error(`unexpected path request: ${name}`);
        return root;
      },
    },
  };
}

test("remapLocalTransferTarget leaves non-Harmony payloads untouched", () => {
  const payload = { targetType: "local", targetPath: "/nowhere/outside/a.zip" };
  assert.equal(remapLocalTransferTarget(payload, { platform: "win32" }), payload);
});

test("remapLocalTransferTarget leaves non-local targets untouched", () => {
  const payload = { targetType: "sftp", targetPath: "/srv/a.zip" };
  assert.equal(
    remapLocalTransferTarget(payload, { platform: HARMONY_PLATFORM, isDirectoryWritable: () => false }),
    payload,
  );
});

test("remapLocalTransferTarget keeps writable HarmonyOS targets", () => {
  const payload = { targetType: "local", targetPath: "/app/downloads/keep.zip" };
  const remapped = remapLocalTransferTarget(payload, {
    platform: HARMONY_PLATFORM,
    isDirectoryWritable: () => true,
  });
  assert.equal(remapped, payload);
});

test("remapLocalTransferTarget redirects an unwritable folder into the app Downloads dir", () => {
  const remapped = remapLocalTransferTarget(
    { targetType: "local", targetPath: "/storage/Users/currentUser/sky.zip", transferId: "t1" },
    {
      platform: HARMONY_PLATFORM,
      isDirectoryWritable: () => false,
      downloadDir: DOWNLOAD_DIR,
    },
  );
  assert.equal(remapped.targetPath, path.join(DOWNLOAD_DIR, "sky.zip"));
  assert.equal(remapped.transferId, "t1");
  assert.equal(remapped.targetType, "local");
});

test("remapLocalTransferTarget treats Node's real ohos platform strings as HarmonyOS", () => {
  // process.platform reports "openharmony" on device; a strict === comparison
  // against HARMONY_PLATFORM silently disabled the redirect once already.
  for (const platform of ["openharmony", "ohos"]) {
    const remapped = remapLocalTransferTarget(
      { targetType: "local", targetPath: "/storage/Users/currentUser/sky.zip" },
      { platform, isDirectoryWritable: () => false, downloadDir: DOWNLOAD_DIR },
    );
    assert.equal(remapped.targetPath, path.join(DOWNLOAD_DIR, "sky.zip"));
  }
});

test("remapLocalTransferTarget only probes the target directory", () => {
  const seen = [];
  remapLocalTransferTarget(
    { targetType: "local", targetPath: "/storage/Users/currentUser/Downloads/x/y.tar.gz" },
    {
      platform: HARMONY_PLATFORM,
      isDirectoryWritable: (dir) => {
        seen.push(dir);
        return true;
      },
      downloadDir: DOWNLOAD_DIR,
    },
  );
  assert.deepEqual(seen, [path.dirname("/storage/Users/currentUser/Downloads/x/y.tar.gz")]);
});

test("getDownloadDir keeps desktop platforms on the user home Downloads folder", () => {
  resetDownloadDirCache();
  const { app } = makeSandboxApp();
  assert.equal(getDownloadDir(app, "win32"), path.join(os.homedir(), "Downloads", "Netcatty"));
  resetDownloadDirCache();
});

test("getDownloadDir always resolves to an app-owned Netcatty folder on HarmonyOS", () => {
  resetDownloadDirCache();
  const { app } = makeSandboxApp();
  const dir = getDownloadDir(app, HARMONY_PLATFORM);
  assert.equal(path.basename(dir), "Netcatty");
  assert.ok(dir.length > 0);
  resetDownloadDirCache();
});
