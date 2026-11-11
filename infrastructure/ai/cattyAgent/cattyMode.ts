import { localStorageAdapter } from "../../persistence/localStorageAdapter";
import { STORAGE_KEY_CATTY_AGENT_MODE } from "../../config/storageKeys";

/**
 * Behaviour preset for the built-in Catty agent.
 *
 * - "classic": the original prompt and tool set, unchanged.
 * - "enhanced": adds the plan/self-check loop (`plan_update` tool), the
 *   retry-once policy for failed tools, and the stricter execution discipline
 *   prompt section.
 *
 * The mode is read once per turn from localStorage, so flipping the switch in
 * Settings takes effect on the next message without restarting the app.
 */
export type CattyAgentMode = "classic" | "enhanced";

export const DEFAULT_CATTY_AGENT_MODE: CattyAgentMode = "classic";

export function normalizeCattyAgentMode(value: unknown): CattyAgentMode {
  return value === "enhanced" ? "enhanced" : DEFAULT_CATTY_AGENT_MODE;
}

export function readCattyAgentMode(): CattyAgentMode {
  try {
    return normalizeCattyAgentMode(localStorageAdapter.readString(STORAGE_KEY_CATTY_AGENT_MODE));
  } catch {
    return DEFAULT_CATTY_AGENT_MODE;
  }
}

export function writeCattyAgentMode(mode: CattyAgentMode): void {
  try {
    localStorageAdapter.writeString(STORAGE_KEY_CATTY_AGENT_MODE, normalizeCattyAgentMode(mode));
  } catch {
    // Storage unavailable (private mode / quota): keep the in-memory default.
  }
}
