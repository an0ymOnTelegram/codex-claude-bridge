import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { accountDirectory, claudeEnvironment, ProxyError } from "./security";

export type ClaudeModel = { value: string; resolvedModel?: string; displayName: string; description: string; supportsEffort?: boolean; supportedEffortLevels?: string[] };
let cached: { at: number; models: ClaudeModel[] } | undefined;
let pending: Promise<ClaudeModel[]> | undefined;

export async function discoverModels(): Promise<ClaudeModel[]> {
  if (cached && Date.now() - cached.at < 3_600_000) return cached.models;
  if (pending) return pending;
  pending = (async () => {
    const child = Bun.spawn([process.env.CLAUDE_BIN ?? "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome"], {
      cwd: process.env.CLAUDE_CWD || process.cwd(), env: claudeEnvironment(), stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      child.stdin.write(JSON.stringify({ type: "control_request", request_id: "model_discovery", request: { subtype: "initialize" } }) + "\n");
      child.stdin.end();
      const stdout = await new Response(child.stdout).text();
      await child.exited;
      if (stdout.length > 2_000_000) throw new Error("Oversized model response");
      for (const line of stdout.split("\n")) {
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (value.type !== "control_response" || value.response?.request_id !== "model_discovery") continue;
        const raw = value.response?.response?.models;
        if (!Array.isArray(raw)) continue;
        const models = raw.filter((model: ClaudeModel) => model && model.value !== "default" && /^[a-zA-Z0-9._-]+$/.test(model.value) && typeof model.displayName === "string").map((model: ClaudeModel) => ({
          value: model.value, resolvedModel: model.resolvedModel, displayName: model.displayName, description: model.description,
          supportsEffort: model.supportsEffort, supportedEffortLevels: model.supportedEffortLevels,
        }));
        if (!models.length) throw new Error("No models available");
        cached = { at: Date.now(), models };
        return models;
      }
      throw new Error("No model catalog in Claude initialization response");
    } finally { clearTimeout(timer); child.kill(); }
  })();
  try { return await pending; }
  catch { if (cached) return cached.models; throw new ProxyError("Cannot load Claude models. Check the subscription login and Claude Code version.", 503, "models_unavailable"); }
  finally { pending = undefined; }
}

export function contextWindow(model: ClaudeModel): number {
  const id = model.resolvedModel ?? model.value;
  // Anthropic's documented native windows. Older 4.6 models need [1m]
  // explicitly, so their ordinary entries remain at 200k.
  return /^claude-(?:fable-|(?:sonnet|haiku)-5|opus-(?:[5-9]|4-[789]))/.test(id) ? 1_000_000 : 200_000;
}

// Menu order: Opus, Sonnet, Haiku, then Fable (Fable can use purchased credits).
// Inside a family the newest version comes first.
const FAMILIES = ["opus", "sonnet", "haiku", "fable"];
function family(model: ClaudeModel): number {
  const text = `${model.value} ${model.resolvedModel ?? ""} ${model.displayName}`.toLowerCase();
  const index = FAMILIES.findIndex(name => text.includes(name));
  return index < 0 ? FAMILIES.length : index;
}
function version(model: ClaudeModel): number {
  const match = /(\d+)(?:\.(\d+))?/.exec(model.displayName) ?? /-(\d+)-(\d+)(?:-|$)/.exec(model.resolvedModel ?? model.value);
  return match ? Number(match[1]) * 100 + Number(match[2] ?? 0) : 0;
}

export function sortClaudeModels(models: ClaudeModel[]): ClaudeModel[] {
  const ordered = models.map((model, index) => ({ model, index })).sort((a, b) =>
    family(a.model) - family(b.model) || version(b.model) - version(a.model)
    // An alias such as "opus" is listed before the same version's full ID.
    || Number(a.model.value.startsWith("claude-")) - Number(b.model.value.startsWith("claude-")) || a.index - b.index);
  const seen = new Set<string>();
  return ordered.map(entry => entry.model).filter(model => {
    const key = model.displayName.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Only the newest model of each family is offered in the menu. */
export function latestPerFamily(models: ClaudeModel[]): ClaudeModel[] {
  const seen = new Set<number>();
  return sortClaudeModels(models).filter(model => {
    const key = family(model);
    if (key === FAMILIES.length) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Menu variant of Fable that plans and delegates coding to Opus sub-agents
 * (the proxy maps `<model>-orchestrator` to the base model plus instructions).
 */
function withOrchestrator(models: ClaudeModel[]): Array<ClaudeModel & { orchestrator?: boolean }> {
  const result: Array<ClaudeModel & { orchestrator?: boolean }> = [...models];
  const fable = models.find(model => family(model) === FAMILIES.indexOf("fable"));
  const opus = models.find(model => family(model) === FAMILIES.indexOf("opus"));
  if (fable && opus) result.push({ ...fable, value: `${fable.value}-orchestrator`, displayName: `${fable.displayName} Orchestrator`, description: `${fable.displayName} plans, delegates coding to ${opus.displayName} sub-agents and reviews their work`, orchestrator: true });
  return result;
}

export function toCodexCatalog(models: ClaudeModel[], firstPriority = 0) {
  return withOrchestrator(latestPerFamily(models)).map((model, index) => ({
    slug: model.value, display_name: `Claude ${model.displayName}`,
    description: model.description + (model.value.includes("fable") ? " — Depending on your plan, Fable may consume purchased Claude usage credits." : " — Claude subscription"),
    default_reasoning_level: model.supportsEffort ? "medium" : "none",
    supported_reasoning_levels: (model.supportedEffortLevels ?? []).filter(level => ["low", "medium", "high", "xhigh", "max"].includes(level)).map(effort => ({ effort, description: `${effort} reasoning effort` })),
    shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: firstPriority + index,
    availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
    supports_parallel_tool_calls: true, apply_patch_tool_type: "freeform",
    // Sub-agents (spawn_agent, wait_agent, ...) and effort changes mid-chat,
    // like the GPT models. Claude models can then also be chosen as sub-agent models.
    multi_agent_version: "v2", multi_agent_reasoning_effort: model.orchestrator ? "high" : "medium",
    supports_reasoning_effort_updates: true, prefer_websockets: false,
    include_skills_usage_instructions: true, include_plugin_usage_instructions: true, include_apps_usage_instructions: true,
    node_repl_auto_review_required: false, node_repl_disabled: false,
    // Deferred tool loading: app/MCP tool schemas (hundreds of KB) are only
    // sent after Claude searches for them, instead of with every request.
    supports_search_tool: true,
    truncation_policy: { mode: "bytes", limit: 100_000 }, supports_image_detail_original: true,
    context_window: contextWindow(model), experimental_supported_tools: ["clock"], input_modalities: ["text", "image"],
    base_instructions: "You are a coding agent in Codex. Follow the system and developer instructions. Use the supplied Codex tools, including available plugins, apps, skills and browser tools. Request tools through the structured output, and wait for their results before claiming success.",
  }));
}

// ---- Combined GPT + Claude menu for Codex (model_catalog_json) ----

export const integrationDirectory = () => process.env.INTEGRATION_DIR || dirname(accountDirectory());
const openAIFile = () => join(integrationDirectory(), "openai-models.json");
const catalogFile = () => join(integrationDirectory(), "models.json");

type CatalogEntry = { slug: string; priority?: number; [key: string]: unknown };

// Codex's own cache of the GPT model list; used until the proxy has fetched its own copy.
const codexModelsCache = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");

function readCatalog(path: string): CatalogEntry[] {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data.models) ? data.models.filter((m: CatalogEntry) => typeof m?.slug === "string") : [];
  } catch { return []; }
}

export function loadOpenAICatalog(): CatalogEntry[] {
  const own = readCatalog(openAIFile());
  return own.length ? own : readCatalog(codexModelsCache());
}

export function openAICatalogAge(): number {
  try { return Date.now() - statSync(openAIFile()).mtimeMs; } catch { return Number.POSITIVE_INFINITY; }
}

function atomicWrite(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

export function mergeCatalog(openai: CatalogEntry[], claude: ClaudeModel[]) {
  const gpt = [...openai].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const next = gpt.reduce((max, m) => Math.max(max, m.priority ?? 0), 0) + 1;
  return [...gpt, ...toCodexCatalog(claude, next)];
}

export async function combinedCatalog() {
  return mergeCatalog(loadOpenAICatalog(), await discoverModels());
}

/** Writes the Codex model menu. Codex reads it at startup. */
export async function writeCombinedCatalog(): Promise<number> {
  const models = await combinedCatalog();
  const text = `${JSON.stringify({ models }, null, 2)}\n`;
  if (!existsSync(catalogFile()) || readFileSync(catalogFile(), "utf8") !== text) atomicWrite(catalogFile(), text);
  return models.length;
}

export async function saveOpenAICatalog(models: unknown[], clientVersion: string): Promise<void> {
  const valid = models.filter((m): m is CatalogEntry => !!m && typeof (m as CatalogEntry).slug === "string");
  if (!valid.length) return;
  atomicWrite(openAIFile(), `${JSON.stringify({ client_version: clientVersion, fetched_at: new Date().toISOString(), models: valid }, null, 2)}\n`);
  await writeCombinedCatalog().catch(() => {});
}
