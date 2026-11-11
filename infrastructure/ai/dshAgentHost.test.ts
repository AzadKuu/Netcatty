import test from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '../../domain/models';
import { ensureDshAgentSshSession, findHostForAgentTarget, parseDshAgentHostTarget } from './dshAgentHost';

const host = (overrides: Partial<Host>): Host => ({
  id: 'h1',
  label: 'Agent host',
  hostname: 'example.com',
  port: 22,
  username: 'shawn',
  ...overrides,
} as Host);

test('parseDshAgentHostTarget reads user, host and port', () => {
  assert.deepEqual(parseDshAgentHostTarget('ssh://shawn@mc.example.com:2222'), {
    hostname: 'mc.example.com',
    username: 'shawn',
    port: 2222,
  });
});

test('parseDshAgentHostTarget ignores ssh:dsh shorthand', () => {
  assert.equal(parseDshAgentHostTarget('ssh:dsh'), null);
  assert.equal(parseDshAgentHostTarget('ssh:/opt/dsh/bin/dsh'), null);
});

test('parseDshAgentHostTarget rejects commands without a host', () => {
  assert.equal(parseDshAgentHostTarget('ssh://'), null);
  assert.equal(parseDshAgentHostTarget('dsh'), null);
  assert.equal(parseDshAgentHostTarget(undefined), null);
});

test('parseDshAgentHostTarget keeps the optional dsh path out of the target', () => {
  assert.deepEqual(parseDshAgentHostTarget('ssh://shawn@mc.example.com/opt/dsh/bin/dsh'), {
    hostname: 'mc.example.com',
    username: 'shawn',
  });
});

test('findHostForAgentTarget matches hostname case-insensitively', () => {
  const hosts = [host({ hostname: 'MC.Example.com' })];
  const found = findHostForAgentTarget(hosts, { hostname: 'mc.example.COM' });
  assert.equal(found?.id, 'h1');
});

test('findHostForAgentTarget honours the requested username and port', () => {
  const hosts = [host({ username: 'shawn', port: 22 })];
  assert.equal(findHostForAgentTarget(hosts, { hostname: 'example.com', username: 'other' }), undefined);
  assert.equal(findHostForAgentTarget(hosts, { hostname: 'example.com', port: 2222 }), undefined);
  assert.equal(findHostForAgentTarget(hosts, { hostname: 'example.com', username: 'shawn', port: 22 })?.id, 'h1');
});

test('findHostForAgentTarget returns nothing for an unknown host', () => {
  assert.equal(findHostForAgentTarget([host({})], { hostname: 'missing.example.com' }), undefined);
});

function stubHosts(hosts: unknown[]) {
  const store = new Map<string, string>([['netcatty_hosts_v1', JSON.stringify(hosts)]]);
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

test('ensureDshAgentSshSession reuses a connected session to the pinned host', async () => {
  stubHosts([]);
  const calls: unknown[] = [];
  const sessionId = await ensureDshAgentSshSession({
    command: 'ssh://shawn@mc.example.com',
    bridge: { startSSHSession: async (options) => { calls.push(options); } },
    createSessionId: () => 'agent-session-1',
    connectedSessions: [
      { sessionId: 'term-other', hostname: '192.168.2.129' },
      { sessionId: 'term-agent', hostname: 'mc.example.com' },
    ],
  });
  assert.equal(sessionId, 'term-agent');
  assert.equal(calls.length, 0);
});

test('ensureDshAgentSshSession opens a dedicated connection with vault credentials', async () => {
  stubHosts([{ id: 'h1', label: 'Agent', hostname: 'mc.example.com', port: 2222, username: 'shawn', authMethod: 'password', password: 'secret' }]);
  const calls: Array<Record<string, unknown>> = [];
  const sessionId = await ensureDshAgentSshSession({
    command: 'ssh://shawn@mc.example.com',
    bridge: { startSSHSession: async (options) => { calls.push(options as Record<string, unknown>); } },
    createSessionId: () => 'agent-session-2',
    connectedSessions: [{ sessionId: 'term-other', hostname: '192.168.2.129' }],
  });
  assert.equal(sessionId, 'agent-session-2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, 'mc.example.com');
  assert.equal(calls[0].port, 2222);
  assert.equal(calls[0].username, 'shawn');
  assert.equal(calls[0].password, 'secret');
  assert.equal(calls[0].verifyHostKeys, false);
});

test('ensureDshAgentSshSession stays out of the way without a pinned host', async () => {
  stubHosts([]);
  const sessionId = await ensureDshAgentSshSession({
    command: 'ssh:dsh',
    bridge: { startSSHSession: async () => { throw new Error('should not connect'); } },
    createSessionId: () => 'unused',
  });
  assert.equal(sessionId, undefined);
});
