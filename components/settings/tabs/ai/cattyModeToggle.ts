import {
  DEFAULT_CATTY_AGENT_MODE,
  normalizeCattyAgentMode,
  type CattyAgentMode,
} from "../../../../infrastructure/ai/cattyAgent/cattyMode";

/**
 * Settings → AI exposes the Catty behaviour preset as a single on/off switch.
 * Keep the boolean <-> mode mapping here so the component stays a thin view and
 * the persistence write stays in one place.
 */
export function cattyModeFromEnhancedToggle(enabled: boolean): CattyAgentMode {
  return enabled ? "enhanced" : DEFAULT_CATTY_AGENT_MODE;
}

export function isCattyEnhancedMode(mode: CattyAgentMode): boolean {
  return normalizeCattyAgentMode(mode) === "enhanced";
}
