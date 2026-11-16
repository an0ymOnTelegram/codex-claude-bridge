import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequest } from "../src/app";
import { activeWorkerCount, stopAllWorkers } from "../src/claude";

let directory = "";
const saved: Record<string, string | undefined> = {};
const key = "test-local-secret-that-is-more-than-32-characters";
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const request = (path: string, body?: unknown, extra: Record<string, string> = {}) => new Request(`http://127.0.0.1:3456${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const hybridHeaders = { authorization: "Bearer chatgpt-login-token", "chatgpt-account-id": "acct-1", "x-claude-proxy-key": key, "content-type": "application/json", "user-agent": "codex_exec/0.169.0-alpha.1 (Mac OS)" };
const hybrid = (path: string, body?: unknown, extra: Record<string, string> = {}) => new Request(`http://127.0.0.1:3456/chatgpt${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...hybridHeaders, ...extra }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });

// Fake ChatGPT backend that records what reaches it.
const seen: Array<{ path: string; headers: Record<string, string>; body: string }> = [];
let upstream: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "claude-codex-proxy-test-"));
  const mock = join(directory, "claude");
  // Each mock process counts its own turns, so tests can see whether a session was reused.
  await writeFile(mock, `#!/bin/sh
turn=0
while IFS= read -r input; do
  if printf '%s' "$input" | grep -q 'model_discovery'; then
    printf '%s\\n' '{"type":"control_response","response":{"request_id":"model_discovery","response":{"models":[{"value":"haiku","displayName":"Haiku 5.5","description":"Fast","supportsEffort":true,"supportedEffortLevels":["low","high"]},{"value":"claude-opus-4-8","displayName":"Opus 4.8","description":"Older","supportsEffort":true,"supportedEffortLevels":["low","high"]},{"value":"opus","displayName":"Opus 5.5","description":"Test model","supportsEffort":true,"supportedEffortLevels":["low","high"]}]}}}'
    continue
  fi
  turn=$((turn+1))
  printf '%s\\n' '{"type":"assistant","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":1000,"cache_creation_input_tokens":20,"output_tokens":7}}}'
  if printf '%s' "$input" | grep -q 'count-me'; then
    printf '{"type":"result","is_error":false,"usage":{"output_tokens":7},"structured_output":{"text":"process-turn-%s","tool_calls":[]}}\\n' "$turn"
  elif [ "$turn" -eq 2 ] && printf '%s' "$input" | grep -q 'conversation_continuation_json'; then
    printf '%s\\n' '{"type":"result","is_error":false,"structured_output":{"text":"continued-in-worker","tool_calls":[]}}'
  elif printf '%s' "$input" | grep -q 'stream-me'; then
    printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"StructuredOutput","input":{}}}}'
    printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"text\\": \\"Hal"}}}'
    printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"lo \\\\u00e4\\\\n Welt\\", \\"tool_calls\\": []}"}}}'
    printf '%s\\n' '{"type":"result","is_error":false,"structured_output":{"text":"Hallo \\u00e4\\n Welt","tool_calls":[]}}'
  elif printf '%s' "$input" | grep -q 'persistent-first'; then
    printf '%s\\n' '{"type":"result","is_error":false,"structured_output":{"text":"","tool_calls":[{"name":"lookup","arguments":"{}"}]}}'
  elif printf '%s' "$input" | grep -q 'previous structured output was rejected'; then
    printf '%s\\n' '{"type":"result","is_error":false,"structured_output":{"text":"","tool_calls":[{"name":"lookup","arguments":"{}"}]}}'
  elif printf '%s' "$input" | grep -q 'call-wrong-tool'; then
    printf '%s\\n' '{"type":"result","is_error":false,"structured_output":{"text":"","tool_calls":[{"name":"does_not_exist","arguments":"{}"}]}}'
  elif printf '%s' "$input" | grep -q 'search-notion'; then
    printf '%s\\n' '{"type":"result","is_error":false,"structured_output":{"text":"","tool_calls":[{"name":"mcp__notion.search","arguments":"{\\"q\\":\\"x\\"}"}]}}'
  else
    printf '%s\\n' '{"type":"result","is_error":false,"structured_output":{"text":"mock-ok","tool_calls":[]}}'
  fi
done
`);
  await chmod(mock, 0o755);
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const h: Record<string, string> = {};
    req.headers.forEach((v, k) => { h[k] = v; });
    const path = new URL(req.url).pathname + new URL(req.url).search;
    seen.push({ path, headers: h, body: req.method === "POST" ? await req.text() : "" });
    if (path.startsWith("/backend-api/codex/models")) return Response.json({ models: [{ slug: "gpt-test", display_name: "GPT Test", priority: 2 }, { slug: "gpt-hidden", visibility: "hide", priority: 9 }] });
    if (path === "/backend-api/codex/responses") return new Response("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n", { headers: { "content-type": "text/event-stream" } });
    return Response.json({ error: "nope" }, { status: 404 });
  } });
  for (const name of ["CLAUDE_BIN", "PROXY_API_KEY", "CHATGPT_UPSTREAM", "INTEGRATION_DIR", "CODEX_HOME"]) saved[name] = process.env[name];
  process.env.CLAUDE_BIN = mock; process.env.PROXY_API_KEY = key;
  process.env.CHATGPT_UPSTREAM = `http://127.0.0.1:${upstream.port}/backend-api/codex`;
  process.env.INTEGRATION_DIR = directory;
  process.env.CODEX_HOME = directory;
});
afterAll(async () => {
  stopAllWorkers();
  upstream.stop(true);
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  await rm(directory, { recursive: true, force: true });
});

describe("Authenticated HTTP interface", () => {
  test("rejects missing credentials, web origins and DNS rebinding hosts", async () => {
    expect((await handleRequest(new Request("http://127.0.0.1:3456/v1/models"))).status).toBe(401);
    expect((await handleRequest(request("/v1/models", undefined, { origin: "https://untrusted.example" }))).status).toBe(403);
    expect((await handleRequest(new Request("http://untrusted.example/v1/models", { headers }))).status).toBe(403);
  });
  test("discovers the actual CLI model catalog, sorted", async () => {
    const models = await (await handleRequest(request("/v1/models"))).json() as any;
    expect(models.models.map((m: any) => m.display_name)).toEqual(["Claude Opus 5.5", "Claude Haiku 5.5"]);
    expect(models.models[0].supported_reasoning_levels.map((level: any) => level.effort)).toEqual(["low", "high"]);
    expect(models.models[0].supports_search_tool).toBe(true);
  });
  test("returns validation failures before starting inference", async () => {
    expect((await handleRequest(request("/v1/responses", { model: "bad", input: "x" }))).status).toBe(400);
    expect((await handleRequest(request("/v1/responses", { model: "sonnet", input: [null] }))).status).toBe(400);
    expect((await handleRequest(request("/v1/responses", {}, { "content-length": "999999999" }))).status).toBe(413);
    expect((await handleRequest(request("/v1/responses", {}, { "content-type": "text/plain" }))).status).toBe(415);
  });
  test("runs a text response and reports real context usage", async () => {
    const response = await handleRequest(request("/v1/responses", { model: "sonnet", input: "hello" }));
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.output[0].content[0].text).toBe("mock-ok");
    expect(body.output[0].channel).toBe("final");
    expect(body.usage.input_tokens).toBe(1025);
    expect(body.usage.input_tokens_details.cached_tokens).toBe(1000);
  });
  test("continues the Codex tool loop in the same worker", async () => {
    const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];
    const first = await (await handleRequest(request("/v1/responses", { model: "sonnet", input: "persistent-first", tools }))).json() as any;
    const call = first.output.find((item: any) => item.type === "function_call");
    expect(call).toBeDefined();
    const second = await (await handleRequest(request("/v1/responses", { model: "sonnet", tools, input: [{ role: "user", content: "persistent-first" }, call, { type: "function_call_output", call_id: call.call_id, output: "result" }] }))).json() as any;
    expect(second.output[0].content[0].text).toBe("continued-in-worker");
  });
});

describe("Claude sessions across user turns", () => {
  const meta = (thread: string) => ({ prompt_cache_key: thread, client_metadata: { thread_id: thread } });
  const dev = { type: "message", role: "developer", content: [{ type: "input_text", text: "stable developer context" }] };
  const say = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  const reply = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  const ask = async (body: unknown) => ((await (await handleRequest(request("/v1/responses", body))).json()) as any).output[0].content[0].text as string;

  test("the next user message reuses the session and sends only the new records", async () => {
    stopAllWorkers();
    const first = await ask({ model: "opus", ...meta("t1"), input: [dev, say("count-me 1")] });
    expect(first).toBe("process-turn-1");
    const second = await ask({ model: "opus", ...meta("t1"), input: [dev, say("count-me 1"), reply(first), say("count-me 2")] });
    expect(second).toBe("process-turn-2");
    expect(activeWorkerCount()).toBe(1);
  });
  test("edited history, another thread or another effort start a fresh session", async () => {
    stopAllWorkers();
    const first = await ask({ model: "opus", ...meta("t2"), input: [dev, say("count-me a")] });
    expect(await ask({ model: "opus", ...meta("t2"), input: [dev, say("count-me EDITED"), reply(first), say("count-me b")] })).toBe("process-turn-1");
    expect(await ask({ model: "opus", ...meta("t3"), input: [dev, say("count-me a"), reply(first), say("count-me b")] })).toBe("process-turn-1");
    expect(await ask({ model: "opus", reasoning: { effort: "high" }, ...meta("t2"), input: [dev, say("count-me EDITED"), reply("process-turn-1"), say("count-me c")] })).toBe("process-turn-1");
  });
  test("a compaction request does not keep a session", async () => {
    stopAllWorkers();
    const compaction = { client_metadata: { thread_id: "t4", "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) } };
    await ask({ model: "opus", tools: [], ...compaction, input: [dev, say("count-me summarize")] });
    await Bun.sleep(50);
    expect(activeWorkerCount()).toBe(0);
  });
  test("tools found by tool_search are callable and map to their namespace", async () => {
    stopAllWorkers();
    const found = { type: "tool_search_output", call_id: "ts1", status: "completed", execution: "client", tools: [{ type: "namespace", name: "mcp__notion", tools: [{ type: "function", name: "search", parameters: { type: "object" } }] }] };
    const body = await (await handleRequest(request("/v1/responses", { model: "opus", tools: [{ type: "tool_search" }], input: [say("search-notion"), { type: "tool_search_call", call_id: "ts1", arguments: { query: "notion" } }, found] }))).json() as any;
    expect(body.output[0]).toMatchObject({ type: "function_call", name: "search", namespace: "mcp__notion" });
  });
  test("an invalid tool call is corrected inside the session instead of failing the turn", async () => {
    stopAllWorkers();
    const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];
    const response = await handleRequest(request("/v1/responses", { model: "opus", tools, input: "call-wrong-tool" }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).output[0]).toMatchObject({ type: "function_call", name: "lookup" });
  });
  test("OpenAI-hosted tools are left out instead of failing the turn", async () => {
    const response = await handleRequest(request("/v1/responses", { model: "opus", tools: [{ type: "web_search" }, { type: "image_generation" }], input: "hello" }));
    expect(response.status).toBe(200);
  });
});

describe("Combined ChatGPT + Claude provider", () => {
  test("GPT requests are relayed unchanged with the ChatGPT login, without the local key", async () => {
    seen.length = 0;
    const body = JSON.stringify({ model: "gpt-6-astra", input: [{ role: "user", content: "hi" }], stream: true });
    const response = await handleRequest(hybrid("/responses", body));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.completed");
    const relayed = seen.find(r => r.path === "/backend-api/codex/responses")!;
    expect(relayed.body).toBe(body);
    expect(relayed.headers.authorization).toBe("Bearer chatgpt-login-token");
    expect(relayed.headers["chatgpt-account-id"]).toBe("acct-1");
    expect(relayed.headers["x-claude-proxy-key"]).toBeUndefined();
  });
  test("Claude models on the combined route stay local", async () => {
    seen.length = 0;
    const response = await handleRequest(hybrid("/responses", { model: "opus", input: "hello" }));
    expect(((await response.json()) as any).output[0].content[0].text).toBe("mock-ok");
    expect(seen.some(r => r.path.endsWith("/responses"))).toBe(false);
  });
  test("compressed Claude requests are understood", async () => {
    const compressed = new Uint8Array(Bun.zstdCompressSync(JSON.stringify({ model: "opus", input: "hello" })));
    const response = await handleRequest(new Request("http://127.0.0.1:3456/chatgpt/responses", { method: "POST", headers: { ...hybridHeaders, "content-encoding": "zstd" }, body: compressed }));
    expect(((await response.json()) as any).output[0].content[0].text).toBe("mock-ok");
  });
  test("other ChatGPT endpoints are relayed", async () => {
    const response = await handleRequest(hybrid("/models?client_version=0.169.0"));
    expect(((await response.json()) as any).models[0].slug).toBe("gpt-test");
  });
  test("a ChatGPT login alone is not enough to use the proxy", async () => {
    const { "x-claude-proxy-key": _, ...withoutKey } = hybridHeaders;
    const response = await handleRequest(new Request("http://127.0.0.1:3456/chatgpt/responses", { method: "POST", headers: withoutKey, body: JSON.stringify({ model: "opus", input: "x" }) }));
    expect(response.status).toBe(401);
  });
  test("an unreachable backend is reported as 502", async () => {
    const previous = process.env.CHATGPT_UPSTREAM;
    process.env.CHATGPT_UPSTREAM = "http://127.0.0.1:9/backend-api/codex";
    try { expect((await handleRequest(hybrid("/responses", { model: "gpt-x", input: "x" }))).status).toBe(502); }
    finally { process.env.CHATGPT_UPSTREAM = previous; }
  });
  test("GPT traffic refreshes the menu: GPT models first, then sorted Claude models", async () => {
    await handleRequest(hybrid("/responses", { model: "gpt-6-astra", input: "x" }));
    let menu: any;
    for (let i = 0; i < 50 && !menu; i++) { await Bun.sleep(20); try { menu = JSON.parse(await readFile(join(directory, "models.json"), "utf8")); } catch {} }
    expect(menu.models.map((m: any) => m.slug)).toEqual(["gpt-test", "gpt-hidden", "opus", "haiku"]);
    expect(menu.models[2].priority).toBeGreaterThan(9);
  });
});

describe("Model switching, streaming and compaction", () => {
  test("reply text streams as deltas before the response completes", async () => {
    stopAllWorkers();
    const body = await (await handleRequest(request("/v1/responses", { model: "opus", input: "stream-me", stream: true }))).text();
    const events = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const deltas = events.filter(e => e.type === "response.output_text.delta").map(e => e.delta);
    expect(deltas.join("")).toBe("Hallo \u00e4\n Welt");
    expect(deltas.length).toBeGreaterThan(1);
    expect(events.filter(e => e.type === "response.output_item.added")).toHaveLength(1);
    expect(body).toContain('"phase":"final_answer"');
    expect(body.indexOf("output_text.delta")).toBeLessThan(body.indexOf("response.completed"));
  });
  test("a GPT thread continues with Claude: reasoning, encrypted compaction and ultra effort are accepted", async () => {
    const response = await handleRequest(hybrid("/responses", { model: "opus", reasoning: { effort: "ultra" }, input: [
      { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: { type: "grammar" } }] }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", summary: [], encrypted_content: "gAAAA" },
      { type: "compaction", encrypted_content: "gAAAA" },
      { type: "custom_tool_call", call_id: "c1", name: "exec", input: "text(1)" },
      { type: "custom_tool_call_output", call_id: "c1", output: "1" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "weiter" }] },
    ] }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).output[0].content[0].text).toBe("mock-ok");
  });
  test("remote compaction for Claude returns recent user messages plus a summary", async () => {
    const response = await handleRequest(hybrid("/responses/compact", { model: "opus", input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Baue Feature X" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ] }));
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.output.map((item: any) => item.content[0].text)).toEqual(["Baue Feature X", expect.stringContaining("mock-ok")]);
    expect(body.output[1].content[0].text).toStartWith("Another language model");
  });
  test("previous_response_id continues a stored Claude response", async () => {
    const first = await (await handleRequest(request("/v1/responses", { model: "opus", input: "hello" }))).json() as any;
    const next = await handleRequest(request("/v1/responses", { model: "opus", previous_response_id: first.id, input: [{ role: "user", content: "again" }] }));
    expect(next.status).toBe(200);
    const unknown = await handleRequest(request("/v1/responses", { model: "opus", previous_response_id: "resp_unknown", input: "x" }));
    expect(unknown.status).toBe(400);
  });
});
