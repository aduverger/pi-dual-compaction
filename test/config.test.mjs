import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, parseModelSpec } from "../src/config.mjs";

test("missing config uses safe always-portable defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dual-config-"));
  try {
    const result = loadConfig(join(root, "missing.json"));
    assert.deepEqual(result.config, { ...DEFAULT_CONFIG });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.source, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config accepts a dedicated model whose id contains slashes", () => {
  const result = normalizeConfig({
    enabled: true,
    portableSummaryModel: "openrouter/google/gemini-flash",
    portableSummaryThinkingLevel: "low",
  }, "test.json");
  assert.deepEqual(parseModelSpec(result.config.portableSummaryModel), { provider: "openrouter", modelId: "google/gemini-flash" });
  assert.equal(result.config.portableSummaryThinkingLevel, "low");
  assert.deepEqual(result.warnings, []);
});

test("invalid fields warn and retain defaults", () => {
  const result = normalizeConfig({ enabled: "yes", portableSummaryModel: "invalid", portableSummaryThinkingLevel: "extreme" });
  assert.deepEqual(result.config, { ...DEFAULT_CONFIG });
  assert.equal(result.warnings.length, 3);
});

test("malformed JSON fails open with a warning", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dual-config-"));
  const path = join(root, "config.json");
  try {
    writeFileSync(path, "{");
    const result = loadConfig(path);
    assert.deepEqual(result.config, { ...DEFAULT_CONFIG });
    assert.equal(result.warnings.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
