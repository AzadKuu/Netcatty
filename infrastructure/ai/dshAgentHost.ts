import type { Host, SSHKey, Identity } from "../../domain/models";
import { STORAGE_KEY_HOSTS, STORAGE_KEY_IDENTITIES, STORAGE_KEY_KEYS, STORAGE_KEY_KNOWN_HOSTS } from "../config/storageKeys";
import { localStorageAdapter } from "../persistence/localStorageAdapter";
import { decryptField } from "../persistence/secureFieldAdapter";

/**
 * A pinned agent host, written as `ssh://user@host[:port][/path/to/dsh]` in the
 * agent's custom-path field. The DSH ACP driver runs `dsh --profile acp` on that
 * host, so a single installation serves every chat regardless of which terminal
 * session the chat is bound to.
 */
export interface DshAgentHostTarget {
  username?: string;
  hostname: string;
  port?: number;
}

export function parseDshAgentHostTarget(command: string | undefined | null): DshAgentHostTarget | null {
  const raw = typeof command === "string" ? command.trim() : "";
  if (!raw.toLowerCase().startsWith("ssh://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.trim();
  if (!hostname) return null;
  const port = parsed.port ? Number(parsed.port) : undefined;
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  return {
    hostname,
    ...(username ? { username } : {}),
    ...(Number.isFinite(port) && port ? { port } : {}),
  };
}

function normalizeHostname(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function findHostForAgentTarget(
  hosts: Host[],
  target: DshAgentHostTarget,
): Host | undefined {
  const wanted = normalizeHostname(target.hostname);
  return hosts.find((host) => {
    if (normalizeHostname(host.hostname) !== wanted) return false;
    if (target.username && host.username && host.username !== target.username) return false;
    if (target.port && host.port && Number(host.port) !== target.port) return false;
    return true;
  });
}

export interface StartSshSessionBridge {
  startSSHSession?: (options: Record<string, unknown>) => Promise<unknown>;
  credentialsDecrypt?: (value: string) => Promise<string | undefined>;
}

export interface EnsureDshAgentSessionOptions {
  command: string | undefined;
  /** Terminal sessions already open in the app; a matching one is reused. */
  connectedSessions?: ReadonlyArray<{ sessionId: string; hostname?: string; username?: string; port?: number }>;
  bridge: StartSshSessionBridge | undefined;
  createSessionId: () => string;
}

/**
 * Resolves the SSH session the DSH driver should execute over. Reuses an already
 * connected terminal session to the pinned host when there is one, otherwise
 * opens a dedicated connection with the vault's stored credentials.
 */
export async function ensureDshAgentSshSession(
  options: EnsureDshAgentSessionOptions,
): Promise<string | undefined> {
  const target = parseDshAgentHostTarget(options.command);
  if (!target) return undefined;

  const wantedHost = normalizeHostname(target.hostname);
  const reusable = (options.connectedSessions || []).find((session) => {
    if (normalizeHostname(session.hostname) !== wantedHost) return false;
    if (target.username && session.username && session.username !== target.username) return false;
    if (target.port && session.port && Number(session.port) !== target.port) return false;
    return true;
  });
  if (reusable) return reusable.sessionId;

  const bridge = options.bridge;
  if (!bridge?.startSSHSession) return undefined;

  const hosts = localStorageAdapter.read<Host[]>(STORAGE_KEY_HOSTS) || [];
  const host = findHostForAgentTarget(hosts, target);
  if (!host) return undefined;

  const keys = localStorageAdapter.read<SSHKey[]>(STORAGE_KEY_KEYS) || [];
  const identities = localStorageAdapter.read<Identity[]>(STORAGE_KEY_IDENTITIES) || [];
  const knownHosts = localStorageAdapter.read<unknown[]>(STORAGE_KEY_KNOWN_HOSTS) || [];

  let password: string | undefined;
  if (host.password) {
    password = await decryptField(host.password);
  }
  if (host.authMethod === "password" && !password) return undefined;

  const sessionId = options.createSessionId();
  const port = target.port || Number(host.port) || 22;
  await bridge.startSSHSession({
    sessionId,
    hostLabel: host.label || host.hostname,
    hostname: host.hostname,
    hostId: host.id,
    username: host.username || target.username,
    authMethod: host.authMethod || "password",
    port,
    password,
    keyId: host.keyId,
    cols: 100,
    rows: 30,
    host,
    hosts,
    keys,
    identities,
    knownHosts,
    // The dedicated transport is not a user-visible terminal, so there is no
    // dialog to confirm a host key in: trust this attempt only.
    verifyHostKeys: false,
    keepaliveInterval: 0,
    keepaliveCountMax: 3,
  });
  return sessionId;
}
