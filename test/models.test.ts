import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextWindow, loadOpenAICatalog, mergeCatalog, sortClaudeModels, toCodexCatalog } from "../src/models";
const m = (value: string, displayName: string) => ({ value, displayName, description: "", supportsEffort: true, supportedEffortLevels: ["low"] });
test("model catalog retains real names, thinking levels, cost notes and context limits", () => {
  const model = { value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2", description: "Most capable", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] };
  const catalog = toCodexCatalog([model]);
  expect(catalog[0].display_name).toBe("Claude Fable 5.2");
  expect(catalog[0].description).toContain("purchased Claude usage credits");
  expect(catalog[0].context_window).toBe(1_000_000);
  expect(catalog[0].supported_reasoning_levels).toHaveLength(5);
  expect(catalog[0].supports_search_tool).toBe(true);
  expect(contextWindow({ ...model, resolvedModel: "claude-opus-4-6" })).toBe(200_000);
  expect(contextWindow({ ...model, resolvedModel: "claude-haiku-5-5" })).toBe(1_000_000);
});
test("Claude models are grouped by family, newest first, without duplicates", () => {
  const input = [m("opus", "Opus 5.5"), m("fable", "Fable 5.2"), m("sonnet", "Sonnet 5.5"), m("haiku", "Haiku 5.5"), m("claude-fable-5-1", "Fable 5.1"), m("claude-haiku-4-5-20251001", "Haiku 4.5"), m("claude-sonnet-5", "Sonnet 5"), m("claude-opus-5", "Opus 5"), m("claude-fable-5", "Fable 5"), m("claude-opus-4-8", "Opus 4.8"), m("claude-opus-4-7", "Opus 4.7"), m("claude-opus-4-6", "Opus 4.6"), m("claude-sonnet-4-6", "Sonnet 4.6"), m("claude-opus-5-5", "Opus 5.5")];
  expect(sortClaudeModels(input).map(x => x.value)).toEqual(["opus", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "sonnet", "claude-sonnet-5", "claude-sonnet-4-6", "haiku", "claude-haiku-4-5-20251001", "fable", "claude-fable-5-1", "claude-fable-5"]);
  expect(toCodexCatalog(input).map(x => x.slug)).toEqual(["opus", "sonnet", "haiku", "fable", "fable-orchestrator"]);
});
test("Claude entries support sub-agents; the orchestrator entry exists only with Fable and Opus", () => {
  const catalog = toCodexCatalog([m("opus", "Opus 5.5"), m("fable", "Fable 5.2")]);
  const orchestrator = catalog.find(x => x.slug === "fable-orchestrator")!;
  expect(orchestrator.display_name).toBe("Claude Fable 5.2 Orchestrator");
  expect(orchestrator.description).toContain("Opus 5.5 sub-agents");
  for (const entry of catalog) expect(entry.multi_agent_version).toBe("v2");
  expect(toCodexCatalog([m("fable", "Fable 5.2")]).map(x => x.slug)).toEqual(["fable"]);
});
test("the menu keeps every GPT model and lists Claude after them", () => {
  const merged = mergeCatalog([{ slug: "b", priority: 3 }, { slug: "a", priority: 1 }, { slug: "auto-review", priority: 10, visibility: "hide" }], [m("haiku", "Haiku 5.5"), m("opus", "Opus 5.5")]);
  expect(merged.map(x => x.slug)).toEqual(["a", "b", "auto-review", "opus", "haiku"]);
  expect(merged[3].priority).toBe(11);
});
test("GPT models come from Codex's own cache until the proxy has fetched them", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-claude-bridge-models-"));
  const saved = { INTEGRATION_DIR: process.env.INTEGRATION_DIR, CODEX_HOME: process.env.CODEX_HOME };
  try {
    process.env.INTEGRATION_DIR = dir; process.env.CODEX_HOME = dir;
    expect(loadOpenAICatalog()).toEqual([]);
    writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-cached" }] }));
    expect(loadOpenAICatalog().map(x => x.slug)).toEqual(["gpt-cached"]);
    writeFileSync(join(dir, "openai-models.json"), JSON.stringify({ models: [{ slug: "gpt-fresh" }] }));
    expect(loadOpenAICatalog().map(x => x.slug)).toEqual(["gpt-fresh"]);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});
