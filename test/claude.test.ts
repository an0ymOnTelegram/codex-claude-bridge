import { describe, expect, test } from "bun:test";
import { buildClaudeArgs, claudeEffort, isClaudeModel, resolveModel, TextFieldStreamer, toolSignature } from "../src/claude";
import { claudeEnvironment } from "../src/security";

describe("Claude isolation", () => {
  test("cannot bypass Codex through native tools, configuration, MCP or providers", () => {
    const args = buildClaudeArgs({ model: "sonnet", input: "hello", instructions: "A trusted system instruction" });
    expect(args).not.toContain("--dangerously-skip-permissions");
    for (const flag of ["--tools", "--setting-sources"]) expect(args[args.indexOf(flag) + 1]).toBe("");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args[args.indexOf("--system-prompt") + 1]).toContain("A trusted system instruction");
    const env = claudeEnvironment({ HOME: "/test", PATH: "/bin", ANTHROPIC_API_KEY: "secret", ANTHROPIC_BASE_URL: "https://gateway", CLAUDE_CODE_OAUTH_TOKEN: "secret", CLAUDE_CODE_USE_BEDROCK: "1", PROXY_API_KEY: "secret", NODE_OPTIONS: "--require evil" });
    expect(env.HOME).toBe("/test");
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "PROXY_API_KEY", "NODE_OPTIONS"]) expect(env[key]).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toContain("claude-subscription");
  });
  test("model identifiers cannot inject CLI arguments", () => {
    expect(resolveModel("claude-fable-5-2")).toBe("claude-fable-5-2");
    expect(resolveModel("fable")).toBe("fable");
    expect(() => resolveModel("--dangerously-skip-permissions")).toThrow();
    expect(() => resolveModel("sonnet; touch /tmp/test")).toThrow();
  });
  test("web search uses only Claude's server-side WebSearch tool", () => {
    const args = buildClaudeArgs({ model: "sonnet", input: "x", tools: [{ type: "web_search" }] });
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch");
    expect(args.join(" ")).not.toContain("Bash");
  });
  test("very large system prompts go through a private file", () => {
    const args = buildClaudeArgs({ model: "sonnet", input: "x" }, "/tmp/prompt.txt");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("/tmp/prompt.txt");
    expect(args).not.toContain("--system-prompt");
  });
  test("schema, instructions and effort changes invalidate worker reuse", () => {
    const original = { model: "opus", input: "hello", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] };
    for (const changed of [{ ...original, instructions: "New instructions" }, { ...original, reasoning: { effort: "high" } }, { ...original, tools: [{ ...original.tools[0], parameters: { type: "string" } }] }]) expect(toolSignature(changed)).not.toBe(toolSignature(original));
  });
  test("GPT effort names map to Claude levels", () => {
    expect(claudeEffort("ultra")).toBe("max");
    expect(claudeEffort("minimal")).toBe("low");
    expect(claudeEffort("none")).toBeUndefined();
    expect(claudeEffort("xhigh")).toBe("xhigh");
    expect(claudeEffort("galactic")).toBeUndefined();
    const args = buildClaudeArgs({ model: "opus", input: "x", reasoning: { effort: "ultra" } });
    expect(args[args.indexOf("--effort") + 1]).toBe("max");
  });
  test("the orchestrator variant runs the base model with delegation instructions", () => {
    expect(isClaudeModel("fable-orchestrator")).toBe(true);
    expect(resolveModel("fable-orchestrator")).toBe("fable");
    const args = buildClaudeArgs({ model: "fable-orchestrator", input: "x" });
    expect(args[args.indexOf("--model") + 1]).toBe("fable");
    expect(args[args.indexOf("--system-prompt") + 1]).toContain('model "opus"');
    expect(buildClaudeArgs({ model: "fable", input: "x" }).join(" ")).not.toContain("orchestrator_mode");
    expect(() => resolveModel("gpt-6-astra-orchestrator")).toThrow();
  });
  test("streams only the top-level text value out of partial JSON", () => {
    const seen: string[] = [];
    const streamer = new TextFieldStreamer(text => seen.push(text));
    for (const chunk of ['{"tool_calls": [{"name": "x", "arguments": "{\\"text\\": \\"no\\"}"}], "te', 'xt": "Gr\\u00fc', '\\u00dfe \\ud83d', '\\ude00 \\"q\\"\\n', '!"}']) streamer.push(chunk);
    expect(seen.join("")).toBe('Gr\u00fc\u00dfe \ud83d\ude00 "q"\n!');
    expect(seen.some(part => part.includes("no"))).toBe(false);
  });
});
