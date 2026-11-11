import type { Host } from "../../../../domain/models";

/**
 * DSH can run on a remote machine: the custom-path field accepts an
 * `ssh://[user@]host[:port]` pin, so one installation serves every chat.
 * These helpers only build that string and match it back to a vault host.
 */
const DEFAULT_SSH_PORT = 22;

export function buildDshAgentHostCommand(
  host: Pick<Host, "hostname" | "username" | "port">,
): string | null {
  const hostname = String(host.hostname ?? "").trim();
  if (!hostname) return null;
  const username = String(host.username ?? "").trim();
  const port = Number(host.port);
  const includePort = Number.isFinite(port) && port > 0 && port !== DEFAULT_SSH_PORT;
  const userPart = username ? `${encodeURIComponent(username)}@` : "";
  const portPart = includePort ? `:${port}` : "";
  return `ssh://${userPart}${hostname}${portPart}`;
}

interface ParsedAgentHostTarget {
  hostname: string;
  username?: string;
  port?: number;
}

function parseAgentHostTarget(command: string): ParsedAgentHostTarget | null {
  const raw = command.trim();
  if (!/^ssh:\/\//i.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.trim();
  if (!hostname) return null;
  const port = parsed.port ? Number(parsed.port) : undefined;
  return {
    hostname,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(Number.isFinite(port) && port ? { port } : {}),
  };
}

function normalizeHostname(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Value for the DSH "agent host" selector: "" means local (no pin), otherwise
 * the vault host id whose SSH target matches the current custom path.
 * Tolerates a pin that spells out the default port.
 */
export function resolveDshSelectedHostId(hosts: readonly Host[], command: string): string {
  const target = parseAgentHostTarget(command);
  if (!target) return "";
  const hostname = normalizeHostname(target.hostname);
  const targetPort = target.port ?? DEFAULT_SSH_PORT;
  const targetUsername = target.username?.trim();
  const match = hosts.find((host) => {
    if (normalizeHostname(host.hostname) !== hostname) return false;
    const hostPort = Number(host.port);
    const normalizedHostPort = Number.isFinite(hostPort) && hostPort > 0 ? hostPort : DEFAULT_SSH_PORT;
    if (normalizedHostPort !== targetPort) return false;
    const hostUsername = String(host.username ?? "").trim();
    if (targetUsername && hostUsername && hostUsername !== targetUsername) return false;
    return true;
  });
  return match?.id ?? "";
}

/**
 * Select value for an `ssh://` pin that matches no vault host (hand-typed, or
 * the host was deleted). Keeps the closed select honest instead of claiming
 * "Local" while the field still points at a remote machine.
 */
export const DSH_UNMATCHED_AGENT_HOST_VALUE = "__dsh_unmatched_agent_host__";

/**
 * Select value for "run DSH locally" (no `ssh://` pin). Radix rejects an empty
 * Select.Item value, so local needs an explicit sentinel instead of "".
 */
export const DSH_LOCAL_AGENT_HOST_VALUE = "__dsh_local_agent_host__";

export function resolveDshAgentHostSelectValue(
  hosts: readonly Host[],
  command: string,
): string {
  const trimmed = command.trim();
  if (!/^ssh:\/\//i.test(trimmed)) return DSH_LOCAL_AGENT_HOST_VALUE;
  return resolveDshSelectedHostId(hosts, trimmed) || DSH_UNMATCHED_AGENT_HOST_VALUE;
}
