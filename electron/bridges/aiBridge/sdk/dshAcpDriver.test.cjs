/* eslint-disable no-undef */
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const driver = require("./dshAcpDriver.cjs");

function createFakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners = new Map();
  const child = {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill() {
      this.killed = true;
      listeners.get("exit")?.(0, null);
    },
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args);
    },
  };
  return child;
}

function collectMessages(stdin) {
  const messages = [];
  let buffer = "";
  stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) messages.push(JSON.parse(line));
      index = buffer.indexOf("\n");
    }
  });
  return messages;
}

test("buildDshSpawnSpec quotes launcher paths that contain spaces", () => {
  const spec = driver.buildDshSpawnSpec("C:\\Program Files\\DeepSeek Harness\\dsh.cmd", driver.DSH_ACP_ARGS);
  assert.equal(spec.shell, true);
  assert.match(spec.command, /"C:\\Program Files\\DeepSeek Harness\\dsh\.cmd"/);
  assert.match(spec.command, /"--profile" "acp"/);
});

test("buildDshSpawnSpec falls back to the bare command name", () => {
  const spec = driver.buildDshSpawnSpec("", driver.DSH_ACP_ARGS);
  assert.equal(spec.shell, false);
  assert.equal(spec.command, driver.DEFAULT_DSH_COMMAND);
  assert.deepEqual(spec.args, ["--profile", "acp"]);
});

test("openDshAcpConnection correlates responses and dispatches notifications", async () => {
  const child = createFakeChild();
  const messages = collectMessages(child.stdin);
  const notifications = [];
  const connection = driver.openDshAcpConnection({
    binPath: "dsh",
    spawnImpl: () => child,
    onNotification: (params) => notifications.push(params),
  });
  assert.ok(connection);

  const pending = connection.request("initialize", { protocolVersion: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].method, "initialize");

  child.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: messages[0].id, result: { protocolVersion: 1 } })}\n`,
  );
  child.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    })}\n`,
  );

  assert.deepEqual(await pending, { protocolVersion: 1 });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].update.text, undefined);
  assert.equal(notifications[0].update.content.text, "hi");
  await connection.close(10);
});

test("permission requests are answered through the injected handler", async () => {
  const child = createFakeChild();
  const messages = collectMessages(child.stdin);
  let seenMethod = null;
  const connection = driver.openDshAcpConnection({
    binPath: "dsh",
    spawnImpl: () => child,
    onRequest: (method, params) => {
      seenMethod = `${method}:${params.options.length}`;
      return { outcome: { outcome: "selected", optionId: "reject-once" } };
    },
  });

  child.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: { sessionId: "s1", toolCall: { toolCallId: "c1" }, options: [{ optionId: "reject-once" }, { optionId: "allow-once" }] },
    })}\n`,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(seenMethod, "session/request_permission:2");
  const reply = messages.find((message) => message.id === 77);
  assert.deepEqual(reply.result, { outcome: { outcome: "selected", optionId: "reject-once" } });
  await connection.close(10);
});

test("rejects pending requests when the agent exits", async () => {
  const child = createFakeChild();
  const connection = driver.openDshAcpConnection({ binPath: "dsh", spawnImpl: () => child });
  const pending = connection.request("session/prompt", { sessionId: "s1" });
  await new Promise((resolve) => setImmediate(resolve));
  child.stderr.write("boom\n");
  child.emit("exit", 3, null);
  await assert.rejects(pending, /exited unexpectedly \(code 3\): boom/);
});

test("flattenAcpModelOptions keeps group context in the display name", () => {
  const models = driver.flattenAcpModelOptions({
    id: "model",
    options: [
      { group: "deepseek-official", name: "DeepSeek", options: [
        { value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" },
        { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
      ] },
      { value: '["plain","model"]', name: "Plain" },
    ],
  });
  assert.deepEqual(models.map((model) => model.name), [
    "DeepSeek · deepseek-v4-flash",
    "DeepSeek · DeepSeek-V4-Pro",
    "Plain",
  ]);
});

test("readModelConfigOption only matches the model config id", () => {
  assert.equal(driver.readModelConfigOption([{ id: "model", currentValue: "x" }]).currentValue, "x");
  assert.equal(driver.readModelConfigOption([{ id: "other" }]), null);
  assert.equal(driver.readModelConfigOption(null), null);
});

test("parseSshDshCommand keeps remote command lines and appends the acp profile", () => {
  assert.equal(driver.parseSshDshCommand("ssh:"), "dsh --profile acp");
  assert.equal(driver.parseSshDshCommand("ssh:dsh"), "dsh --profile acp");
  assert.equal(driver.parseSshDshCommand("ssh:/opt/dsh/bin/dsh"), "/opt/dsh/bin/dsh --profile acp");
  assert.equal(
    driver.parseSshDshCommand("ssh:dsh --profile acp --log-level debug"),
    "dsh --profile acp --log-level debug",
  );
  assert.equal(driver.parseSshDshCommand("dsh"), null);
  assert.equal(driver.parseSshDshCommand(""), null);
});

test("createSshAcpChild bridges an ssh exec channel to the ACP plumbing", async () => {
  const { EventEmitter } = require("node:events");
  const channel = new EventEmitter();
  channel.stderr = new EventEmitter();
  channel.written = [];
  channel.write = (chunk) => channel.written.push(chunk.toString());
  channel.closed = false;
  channel.close = () => { channel.closed = true; channel.emit("close"); };

  const child = driver.createSshAcpChild(channel);
  const lines = [];
  child.stdout.on("data", (chunk) => lines.push(chunk.toString()));
  const exits = [];
  child.on("exit", (code, signal) => exits.push([code, signal]));

  assert.equal(child.stdin.write('{"jsonrpc":"2.0"}\n'), true);
  channel.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1}\n'));
  channel.stderr.emit("data", Buffer.from("diag line"));

  assert.deepEqual(channel.written, ['{"jsonrpc":"2.0"}\n']);
  assert.deepEqual(lines, ['{"jsonrpc":"2.0","id":1}\n']);

  child.stdin.end();
  assert.equal(channel.closed, false, "end must not close the shared channel");

  child.kill();
  assert.equal(channel.closed, true);
  assert.deepEqual(exits, [[null, null]]);
  assert.equal(child.stdin.write("x"), false);
});

test("runDshAcpTurn refuses ssh mode without a live SSH target session", async () => {
  const events = [];
  const emitter = {
    emitEvent: (event) => events.push(event),
    text: () => {},
    reasoning: () => {},
    reasoningEnd: () => {},
    toolCall: () => {},
    toolResult: () => {},
    usage: () => {},
    warning: () => {},
    sessionId: () => {},
  };
  await assert.rejects(
    driver.runDshAcpTurn({
      emitter,
      binPath: "ssh:dsh",
      prompt: "hi",
      cwd: "/",
      getSession: () => ({ sshClient: null }),
      targetSessionId: "term-1",
    }),
    /target session is not a live SSH session/,
  );
});
