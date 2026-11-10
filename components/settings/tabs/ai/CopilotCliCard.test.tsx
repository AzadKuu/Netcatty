import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopilotCliCard } from "./CopilotCliCard";

function firstButton(markup: string): string {
  const match = markup.match(/<button\b[^>]*>/);
  return match?.[0] ?? "";
}

test("Cursor check button stays enabled without a custom path", () => {
  const markup = renderToStaticMarkup(
    <CopilotCliCard
      pathInfo={{ path: null, version: null, available: false }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      i18nPrefix="ai.cursor"
      allowEmptyCheck
    />,
  );

  assert.equal(firstButton(markup).includes("disabled=\"\""), false);
});

test("Copilot check button still requires a custom path", () => {
  const markup = renderToStaticMarkup(
    <CopilotCliCard
      pathInfo={{ path: null, version: null, available: false }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
    />,
  );

  assert.equal(firstButton(markup).includes("disabled=\"\""), true);
});

test("Grok card surfaces ACP runtime toggle when detected", () => {
  const markup = renderToStaticMarkup(
    <CopilotCliCard
      pathInfo={{ path: "/usr/bin/grok", version: "0.2.118", available: true }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      i18nPrefix="ai.grok"
      grokRuntime="acp"
      onGrokRuntimeChange={() => {}}
    />,
  );

  assert.match(markup, /ai\.grok\.runtime\.acp\.title|Use Grok ACP/);
  assert.match(markup, /role="switch"/);
});

test("Grok card hides ACP toggle without runtime change handler", () => {
  const markup = renderToStaticMarkup(
    <CopilotCliCard
      pathInfo={{ path: "/usr/bin/grok", version: "0.2.118", available: true }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      i18nPrefix="ai.grok"
      grokRuntime="acp"
    />,
  );

  assert.doesNotMatch(markup, /role="switch"/);
  assert.doesNotMatch(markup, /ai\.grok\.runtime\.acp\.title|Use Grok ACP \(agent stdio\)/);
});

test("DSH card surfaces the autonomy notice", () => {
  const markup = renderToStaticMarkup(
    <CopilotCliCard
      pathInfo={{ path: "/usr/bin/dsh", version: "0.0.1", available: true }}
      isResolvingPath={false}
      customPath=""
      onCustomPathChange={() => {}}
      onRecheckPath={() => {}}
      i18nPrefix="ai.dsh"
    />,
  );

  assert.match(markup, /ai\.dsh\.autonomyNotice/);
});

test("other managed agent cards do not surface the DSH autonomy notice", () => {
  for (const i18nPrefix of ["ai.copilot", "ai.mimo", "ai.grok"] as const) {
    const markup = renderToStaticMarkup(
      <CopilotCliCard
        pathInfo={{ path: "/usr/bin/agent", version: "1.0.0", available: true }}
        isResolvingPath={false}
        customPath=""
        onCustomPathChange={() => {}}
        onRecheckPath={() => {}}
        i18nPrefix={i18nPrefix}
      />,
    );

    assert.doesNotMatch(markup, /ai\.dsh\./);
  }
});
