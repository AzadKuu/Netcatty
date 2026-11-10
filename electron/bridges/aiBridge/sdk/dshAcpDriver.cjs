/* eslint-disable no-undef */
/**
 * DeepSeek Harness (DSH) driver: speaks Agent Client Protocol (ACP) JSON-RPC
 * over stdio with `dsh --profile acp`.
 *
 * The dsh launcher is a .cmd wrapper around an Electron binary run with
 * ELECTRON_RUN_AS_NODE, so the executable path contains spaces and must go
 * through prepareCommandForSpawn instead of a bare spawn().
 */

const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { prepareCommandForSpawn } = require("../../ai/shellUtils.cjs");

const DEFAULT_DSH_COMMAND = "dsh";
const DSH_ACP_ARGS = ["--profile", "acp"];
const ACP_PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: "netcatty", version: "0.0.0" };
const MAX_LINE_CHARS = 10 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const INIT_TIMEOUT_MS = 30_000;
const MODEL_TIMEOUT_MS = 60_000;
const CANCEL_GRACE_MS = 1_500;
const MODEL_CONFIG_ID = "model";

function createDshLineReader(onLine, maxChars = MAX_LINE_CHARS) {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
      buffer += decoder.write(bytes);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
        index = buffer.indexOf("\n");
      }
      if (buffer.length > maxChars) buffer = "";
    },
    flush() {
      buffer += decoder.end();
      const line = buffer.trim();
      buffer = "";
      if (line) onLine(line);
    },
  };
}

function resolveDshCommand(binPath) {
  const normalized = typeof binPath === "string" ? binPath.trim() : "";
  return normalized || DEFAULT_DSH_COMMAND;
}

function buildDshSpawnSpec(binPath, args) {
  return prepareCommandForSpawn(resolveDshCommand(binPath), args);
}

function formatAcpError(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
  return message;
}

/**
 * One ACP connection over a `dsh --profile acp` child process.
 * Returns null when the runtime cannot start the agent at all.
 */
function openDshAcpConnection({ binPath, cwd, env, spawnImpl = spawn, onNotification, onRequest }) {
  const spec = buildDshSpawnSpec(binPath, DSH_ACP_ARGS);
  let child;
  try {
    child = spawnImpl(spec.command, spec.args, {
      shell: spec.shell,
      cwd: cwd || undefined,
      env: env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (!child || !child.stdin || !child.stdout) return null;

  let closed = false;
  let exited = false;
  let exitInfo = null;
  let stderrTail = "";
  let nextId = 1;
  const pending = new Map();
  const exitWaiters = new Set();

  function settleAll(reason) {
    for (const [, entry] of pending) {
      entry.reject(new Error(reason));
    }
    pending.clear();
    for (const waiter of exitWaiters) waiter();
    exitWaiters.clear();
  }

  function send(message) {
    if (closed || exited || !child.stdin || child.stdin.destroyed) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function respond(id, result) {
    if (id === undefined || id === null) return;
    send({ jsonrpc: "2.0", id, result });
  }

  function respondError(id, message) {
    if (id === undefined || id === null) return;
    send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
  }

  function request(method, params, options = {}) {
    if (exited) return Promise.reject(new Error(buildExitMessage()));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (options.timeoutMs) {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP request timed out: ${method}`));
        }, options.timeoutMs);
      }
      pending.set(id, {
        method,
        resolve(value) {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      if (!send({ jsonrpc: "2.0", id, method, params })) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error(`ACP request could not be written: ${method}`));
      }
    });
  }

  function buildExitMessage() {
    const code = exitInfo ? exitInfo.code : null;
    const signal = exitInfo ? exitInfo.signal : null;
    const lines = stderrTail.trim().split("\n").filter((line) => line.trim());
    // The tail alone is usually the Node.js stack epilogue; the actual failure
    // ("Error: ENOENT ...") sits at the head, so show both ends when trimmed.
    const head = lines.slice(0, 6);
    const tail = lines.length > 2 ? lines.slice(-2) : [];
    const detail = head.concat(tail).join(" | ");
    const status = signal ? `signal ${signal}` : `code ${code}`;
    return `deepseek-harness (dsh) exited unexpectedly (${status})${detail ? `: ${detail}` : ""}`;
  }

  function waitForExit(timeoutMs) {
    if (exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        exitWaiters.delete(done);
        resolve();
      }, timeoutMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      exitWaiters.add(done);
    });
  }

  function handleNotification(message) {
    if (message.method === "session/update") {
      if (typeof onNotification === "function") onNotification(message.params || {});
      return;
    }
    if (typeof onNotification === "function") {
      onNotification({ sessionUpdate: message.method, ...(message.params || {}) });
    }
  }

  function handleRequest(message) {
    let decision;
    try {
      decision = typeof onRequest === "function" ? onRequest(message.method, message.params || {}) : null;
    } catch (error) {
      respondError(message.id, formatAcpError(error));
      return;
    }
    if (decision === undefined) respondError(message.id, `unsupported ACP client request: ${message.method}`);
    else respond(message.id, decision);
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      if (message.method) {
        handleRequest(message);
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(formatAcpError(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method) handleNotification(message);
  }

  const reader = createDshLineReader(handleLine);
  child.stdout.on("data", (chunk) => {
    try {
      reader.push(chunk);
    } catch {
      // Malformed frame; keep the connection alive.
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrTail += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    if (stderrTail.length > MAX_STDERR_CHARS) stderrTail = stderrTail.slice(-MAX_STDERR_CHARS);
  });
  child.on("error", () => {
    exited = true;
    settleAll("deepseek-harness (dsh) could not be started");
  });
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    settleAll(buildExitMessage());
  });

  return {
    request,
    get exited() {
      return exited;
    },
    get stderrTail() {
      return stderrTail;
    },
    waitForExit,
    async close(graceMs = CANCEL_GRACE_MS) {
      closed = true;
      if (exited) return;
      try {
        child.stdin.end();
      } catch {}
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, graceMs);
      await waitForExit(graceMs + 1_000);
      clearTimeout(timer);
      try {
        if (!exited) child.kill("SIGKILL");
      } catch {}
    },
  };
}

function normalizeAcpModelValue(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readModelConfigOption(configOptions) {
  if (!Array.isArray(configOptions)) return null;
  return configOptions.find((option) => option && option.id === MODEL_CONFIG_ID) || null;
}

function flattenAcpModelOptions(configOption) {
  if (!configOption || !Array.isArray(configOption.options)) return [];
  const models = [];
  for (const group of configOption.options) {
    const grouped = Boolean(group && Array.isArray(group.options));
    const entries = grouped ? group.options : [group];
    for (const entry of entries) {
      if (!entry) continue;
      const id = normalizeAcpModelValue(entry.value);
      if (!id) continue;
      const entryName = typeof entry.name === "string" && entry.name.trim() ? entry.name : id;
      const groupName = grouped && typeof group.name === "string" && group.name.trim() ? group.name.trim() : "";
      models.push({
        id,
        name: groupName ? `${groupName} · ${entryName}` : entryName,
        ...(groupName ? { description: groupName } : {}),
      });
    }
  }
  return models;
}

function textFromAcpContent(content) {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  return "";
}

function serializeAcpOutput(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildToolCallArgs(rawInput) {
  if (rawInput && typeof rawInput === "object") return rawInput;
  if (typeof rawInput === "string" && rawInput.trim()) {
    try {
      const parsed = JSON.parse(rawInput);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return { input: rawInput };
    }
    return { input: rawInput };
  }
  return {};
}

function isPermissionAllowed(mode) {
  return mode === "confirm" || mode === "auto" || mode === "danger-full-access";
}

async function openSession(connection, { cwd, resumeSessionId }) {
  const params = { cwd, mcpServers: [] };
  if (resumeSessionId) {
    try {
      const resumed = await connection.request("session/resume", { ...params, sessionId: resumeSessionId });
      if (resumed && resumed.sessionId) return resumed;
    } catch {
      // A stale session id must not fail the turn; fall through to a new one.
    }
  }
  return await connection.request("session/new", params);
}

async function runDshAcpTurn(ctx) {
  const { emitter, signal } = ctx;
  if (!emitter) throw new Error("runDshAcpTurn requires an emitter");
  if (signal?.aborted) throw new Error("Turn cancelled");

  let assistantText = "";
  let reasoningChars = 0;
  const toolTitles = new Map();

  const connection = openDshAcpConnection({
    binPath: ctx.binPath,
    cwd: ctx.cwd,
    env: ctx.env,
    onNotification: (params) => {
      const update = params && typeof params.update === "object" ? params.update : params;
      if (!update || typeof update !== "object") return;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = textFromAcpContent(update.content);
          if (!text) return;
          assistantText += text;
          emitter.text(text);
          return;
        }
        case "agent_thought_chunk": {
          const text = textFromAcpContent(update.content);
          if (!text) return;
          reasoningChars += text.length;
          emitter.reasoning(text);
          return;
        }
        case "tool_call": {
          const toolCallId = update.toolCallId ? String(update.toolCallId) : undefined;
          const title = typeof update.title === "string" && update.title ? update.title : "tool";
          if (toolCallId) toolTitles.set(toolCallId, title);
          emitter.toolCall(title, buildToolCallArgs(update.rawInput), toolCallId);
          return;
        }
        case "tool_call_update": {
          const toolCallId = update.toolCallId ? String(update.toolCallId) : undefined;
          if (!toolCallId) return;
          if (update.status !== "completed" && update.status !== "failed") return;
          const output = serializeAcpOutput(update.rawOutput ?? update.content ?? update.status);
          emitter.toolResult(toolCallId, output, toolTitles.get(toolCallId));
          toolTitles.delete(toolCallId);
          return;
        }
        case "usage_update": {
          const used = Number(update.used);
          if (Number.isFinite(used) && used > 0) emitter.usage({ totalTokens: used });
          return;
        }
        case "config_option_update": {
          return;
        }
        default:
          return;
      }
    },
    onRequest: (method, params) => {
      if (method !== "session/request_permission") return undefined;
      const allowed = isPermissionAllowed(ctx.permissionMode);
      const options = Array.isArray(params.options) ? params.options : [];
      const preferred = options.find((option) => {
        const kind = option && typeof option.kind === "string" ? option.kind : "";
        return allowed ? kind === "allow_once" || kind === "allow_always" : kind === "reject_once" || kind === "reject_always";
      });
      if (!preferred) {
        if (allowed) {
          emitter.warning?.(`Auto-approved an agent permission request in ${ctx.permissionMode} mode`);
        } else {
          emitter.warning?.("Denied an agent permission request: observer mode is read-only");
        }
      }
      if (!preferred || !preferred.optionId) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: preferred.optionId } };
    },
  });

  if (!connection) {
    throw new Error(`Unable to start deepseek-harness (dsh): ${resolveDshCommand(ctx.binPath)} is not executable`);
  }

  let sessionId = null;
  const abortHandler = () => {
    connection.request("session/cancel", { sessionId: sessionId || "" }).catch(() => {});
  };

  try {
    await connection.request(
      "initialize",
      { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { promptCapabilities: { image: false, audio: false } }, clientInfo: CLIENT_INFO },
      { timeoutMs: INIT_TIMEOUT_MS },
    );
    if (typeof ctx.assertSessionValid === "function") ctx.assertSessionValid();

    const session = await openSession(connection, {
      cwd: ctx.cwd || process.cwd(),
      resumeSessionId: ctx.resumeSessionId || ctx.resumeThreadId,
    });
    if (!session || typeof session.sessionId !== "string" || !session.sessionId) {
      throw new Error("deepseek-harness (dsh) did not return a session id");
    }
    sessionId = session.sessionId;
    emitter.sessionId(sessionId);

    const requestedModel = normalizeAcpModelValue(ctx.model);
    if (requestedModel) {
      await connection
        .request(
          "session/set_config_option",
          { sessionId, configId: MODEL_CONFIG_ID, value: requestedModel },
          { timeoutMs: MODEL_TIMEOUT_MS },
        )
        .catch(() => {
          emitter.warning?.(`deepseek-harness (dsh) refused model override: ${requestedModel}`);
        });
    }

    const promptText = typeof ctx.prompt === "string" && ctx.prompt.trim() ? ctx.prompt : "";
    if (!promptText) throw new Error("runDshAcpTurn requires a prompt");

    if (signal) signal.addEventListener("abort", abortHandler, { once: true });
    const promptParts = [{ type: "text", text: promptText }];
    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Turn cancelled"));
        return;
      }
      connection
        .request("session/prompt", { sessionId, prompt: promptParts })
        .then(resolve, reject);
    });
    if (reasoningChars > 0) emitter.reasoningEnd();
  } catch (error) {
    if (reasoningChars > 0) emitter.reasoningEnd();
    throw error;
  } finally {
    if (signal) signal.removeEventListener("abort", abortHandler);
    await connection.close();
  }

  return { sessionId, assistantText };
}

async function listDshAcpModels(ctx) {
  const connection = openDshAcpConnection({
    binPath: ctx.binPath,
    cwd: ctx.cwd,
    env: ctx.env,
  });
  if (!connection) return null;
  try {
    await connection.request(
      "initialize",
      { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: CLIENT_INFO },
      { timeoutMs: INIT_TIMEOUT_MS },
    );
    const session = await connection.request("session/new", { cwd: ctx.cwd || process.cwd(), mcpServers: [] });
    const option = readModelConfigOption(session && session.configOptions);
    if (!option) return { currentModelId: null, models: [] };
    const currentModelId = normalizeAcpModelValue(option.currentValue);
    return {
      currentModelId: currentModelId || null,
      models: flattenAcpModelOptions(option),
      ...(session && session.sessionId ? { sessionId: session.sessionId } : {}),
    };
  } catch {
    return null;
  } finally {
    await connection.close();
  }
}

module.exports = {
  DSH_ACP_ARGS,
  DEFAULT_DSH_COMMAND,
  buildDshSpawnSpec,
  flattenAcpModelOptions,
  listDshAcpModels,
  openDshAcpConnection,
  readModelConfigOption,
  runDshAcpTurn,
};
