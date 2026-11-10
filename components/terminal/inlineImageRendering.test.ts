import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const runtimeSource = readFileSync(
  new URL("./runtime/createXTermRuntime.ts", import.meta.url),
  "utf8",
);
const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");

const readCallbackBody = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must exist`);

  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `${marker} must have a body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }

  assert.fail(`${marker} body must close`);
};

test("the image addon is created from settings and only when inline images are on", () => {
  assert.match(runtimeSource, /import type \{ ImageAddon \} from "@xterm\/addon-image"/);
  assert.doesNotMatch(
    runtimeSource,
    /^import \{ ImageAddon \} from "@xterm\/addon-image"/m,
    "the addon package must not be imported eagerly: evaluating it needs WebAssembly",
  );
  assert.match(runtimeSource, /const InlineImageAddon = getInlineImageAddonCtor\(\);/);
  assert.match(
    runtimeSource,
    /const inlineImageOptions = resolveTerminalInlineImageAddonOptions\(settings\);[\s\S]{0,600}?if \(inlineImageOptions && InlineImageAddon\) \{[\s\S]{0,300}?new InlineImageAddon\(inlineImageOptions\)[\s\S]{0,120}?term\.loadAddon\(imageAddon\)/,
    "the addon must be constructed from resolved settings and skipped when they resolve to null",
  );

  const openIndex = runtimeSource.indexOf("term.open(ctx.container)");
  const imageAddonIndex = runtimeSource.indexOf("new InlineImageAddon(inlineImageOptions)");
  const webglIndex = runtimeSource.indexOf("const webglController = createWebglRendererController(");

  assert.ok(openIndex !== -1 && imageAddonIndex !== -1 && webglIndex !== -1);
  assert.ok(
    openIndex < imageAddonIndex,
    "the addon needs the render service, so it must be loaded after term.open",
  );
  assert.ok(
    imageAddonIndex < webglIndex,
    "the addon must patch setRenderer before the WebGL renderer is created, so image layers survive renderer swaps",
  );
});

test("the addon loader stays off runtimes without WebAssembly", () => {
  const loaderSource = readFileSync(
    new URL("./runtime/inlineImageAddon.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    loaderSource,
    /typeof WebAssembly !== "undefined"/,
    "the loader must gate the dynamic import on WebAssembly being available",
  );
  assert.match(
    loaderSource,
    /loadPromise = import\("@xterm\/addon-image"\)/,
    "the addon package must be loaded through a dynamic import",
  );

  for (const mountSource of [
    readFileSync(new URL("./terminalRuntimeMount.ts", import.meta.url), "utf8"),
    readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8"),
  ]) {
    const loadIndex = mountSource.indexOf("await loadInlineImageAddon()");
    const createIndex = mountSource.indexOf("createXTermRuntime({");
    assert.ok(loadIndex !== -1, "terminal boot must await the addon loader");
    assert.ok(
      loadIndex < createIndex,
      "the addon must be loaded before the runtime is created so it can patch the render service",
    );
  }
});

test("the image addon is disposed before the terminal that owns its layers", () => {
  const disposeBody = readCallbackBody(runtimeSource, "    dispose: () => {");
  const imageDisposeIndex = disposeBody.indexOf("imageAddon.dispose()");
  const termDisposeIndex = disposeBody.indexOf("term.dispose()");

  assert.notEqual(imageDisposeIndex, -1, "runtime dispose must release the image addon");
  assert.notEqual(termDisposeIndex, -1);
  assert.ok(
    imageDisposeIndex < termDisposeIndex,
    "image storage and canvas layers must be released before xterm tears down its screen element",
  );
});

test("hasInlineImages reports live image storage instead of a sticky flag", () => {
  assert.match(runtimeSource, /hasInlineImages: \(\) => boolean;/);
  assert.match(
    runtimeSource,
    /const hasInlineImages = \(\): boolean => \{[\s\S]{0,200}?imageAddon\.storageUsage > 0/,
    "a session must stop blocking hibernate once its image cache is emptied",
  );
  assert.match(runtimeSource, /\n {4}hasInlineImages,\r?\n/, "the runtime must expose hasInlineImages");
});

test("a session holding inline images degrades to soft-hide instead of full hibernate", () => {
  assert.match(
    terminalSource,
    /const runtimeHasInlineImages = useCallback\(\s*\(\) => xtermRuntimeRef\.current\?\.hasInlineImages\(\) === true,/,
  );

  const hibernateBody = readCallbackBody(terminalSource, "const hibernateRuntime = useCallback(() =>");
  const gateIndex = hibernateBody.indexOf("if (runtimeHasInlineImages()) {");
  const softHideIndex = hibernateBody.indexOf("hideRuntimeOnly();", gateIndex);
  const keepCountIndex = hibernateBody.indexOf("resolveHibernateKeepRendererCount(terminalSettings)");
  const evictionIndex = hibernateBody.indexOf("retainLeavingTabAfterEviction(");
  const fullHibernateIndex = hibernateBody.indexOf("void fullHibernateRuntime()");

  assert.notEqual(gateIndex, -1, "hibernate must check for inline images");
  assert.ok(gateIndex < softHideIndex, "the inline image branch must soft-hide the runtime");
  assert.ok(
    gateIndex < keepCountIndex && gateIndex < evictionIndex && gateIndex < fullHibernateIndex,
    "the inline image branch must run before the keep-count, eviction and full-hibernate paths",
  );
});

test("full hibernate and the eviction upgrade both re-check inline images", () => {
  const fullHibernateBody = readCallbackBody(
    terminalSource,
    "const fullHibernateRuntime = useCallback(async (): Promise<boolean> =>",
  );
  const canFinishIndex = fullHibernateBody.indexOf("const canFinishHibernate = () => (");
  const imageCheckIndex = fullHibernateBody.indexOf("&& !runtimeHasInlineImages()", canFinishIndex);
  const canFinishEndIndex = fullHibernateBody.indexOf(");", canFinishIndex);

  assert.notEqual(canFinishIndex, -1);
  assert.notEqual(imageCheckIndex, -1, "canFinishHibernate must reject sessions holding images");
  assert.ok(
    imageCheckIndex < canFinishEndIndex,
    "the image check must be part of canFinishHibernate so it is re-evaluated after every async step",
  );

  const evictionIndex = terminalSource.indexOf(
    "terminalHiddenRendererStore.consumeEvictionRequest(sessionId)",
  );
  const evictionGuardIndex = terminalSource.indexOf(
    "if (runtimeHasInlineImages()) return;",
    evictionIndex,
  );
  const evictionUpgradeIndex = terminalSource.indexOf(
    "upgradeSoftHiddenRuntimeToHibernate();",
    evictionIndex,
  );
  const upgradeBody = readCallbackBody(
    terminalSource,
    "const upgradeSoftHiddenRuntimeToHibernate = useCallback(() =>",
  );

  assert.notEqual(evictionIndex, -1);
  assert.notEqual(
    evictionGuardIndex,
    -1,
    "an evicted soft-hidden session with images must stay soft-hidden",
  );
  assert.ok(
    evictionGuardIndex < evictionUpgradeIndex,
    "the image guard must run before the renderer is woken for the hibernate upgrade",
  );
  assert.match(
    upgradeBody,
    /wakeSoftHiddenRuntimeRef\.current\?\.\(\);[\s\S]*?fullHibernateRuntime\(\)/,
    "the shared upgrade path must wake the soft-hidden renderer before hibernating",
  );
});
