import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_PATH = join(getAgentDir(), "extensions", "pi-dual-compaction", "config.json");
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  portableSummaryModel: undefined,
  portableSummaryThinkingLevel: "off",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseModelSpec(spec) {
  if (typeof spec !== "string") return undefined;
  const value = spec.trim();
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

export function normalizeConfig(raw, source = CONFIG_PATH) {
  const config = { ...DEFAULT_CONFIG };
  const warnings = [];
  if (!isObject(raw)) {
    if (raw !== undefined) warnings.push(`Ignoring ${source}: expected a JSON object.`);
    return { config, warnings, source: undefined };
  }

  if (raw.enabled === undefined || typeof raw.enabled === "boolean") config.enabled = raw.enabled ?? config.enabled;
  else warnings.push("Ignoring enabled: expected a boolean.");

  if (raw.portableSummaryModel === null || raw.portableSummaryModel === undefined) {
    config.portableSummaryModel = undefined;
  } else if (parseModelSpec(raw.portableSummaryModel)) {
    config.portableSummaryModel = raw.portableSummaryModel.trim();
  } else {
    warnings.push('Ignoring portableSummaryModel: expected "provider/model-id" or null.');
  }

  if (raw.portableSummaryThinkingLevel === undefined) {
    // Keep the default.
  } else if (THINKING_LEVELS.includes(raw.portableSummaryThinkingLevel)) {
    config.portableSummaryThinkingLevel = raw.portableSummaryThinkingLevel;
  } else {
    warnings.push(`Ignoring portableSummaryThinkingLevel: expected one of ${THINKING_LEVELS.join(", ")}.`);
  }

  return { config, warnings, source };
}

export function loadConfig(path = CONFIG_PATH) {
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    if (error?.code === "ENOENT") return { config: { ...DEFAULT_CONFIG }, warnings: [], source: undefined };
    return {
      config: { ...DEFAULT_CONFIG },
      warnings: [`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`],
      source: undefined,
    };
  }
}
