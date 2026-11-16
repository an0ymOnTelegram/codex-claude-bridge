import { describe, expect, test } from "bun:test";
import { allTools, outputSchema, prepareClaudePrompt, requestToPrompt, splitConversation, systemPrompt, toolDescriptors, validateRequest, validateToolCalls } from "../src/request";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];

describe("Request translation", () => {
  test("preserves roles, namespaces and tool outputs in JSON records", () => {
    const request = { model: "sonnet", input: [{ role: "user", content: "hi" }, { role: "developer", content: "instructions" }, { type: "function_call", namespace: "functions", name: "lookup", call_id: "call1", arguments: "{}" }, { type: "function_call_output", call_id: "call1", output: "result" }], tools };
    const prompt = requestToPrompt(request);
    expect(prompt).toContain('"role":"developer"');
    expect(prompt).toContain('"namespace":"functions"');
    expect(prompt).toContain('"output":"result"');
  });
  test("normalizes namespaced and deferred tools", () => {
    const descriptors = toolDescriptors([{ type: "namespace", name: "functions", tools }, { type: "tool_search" }, { type: "computer" }]);
    expect(descriptors.map(t => t.proxyName)).toEqual(["functions.lookup", "__codex_tool_search", "__codex_computer_use"]);
  });
  test("forwards user, tool and browser images as native image blocks without disk files", async () => {
    const prepared = await prepareClaudePrompt({ model: "sonnet", input: [
      { role: "user", content: [{ type: "input_image", image_url: png }] },
      { type: "computer_call_output", output: { type: "computer_screenshot", image_url: png } },
      { type: "function_call_output", output: [{ type: "image", data: png.split(",")[1], mimeType: "image/png" }] },
    ] });
    expect(prepared.content.filter(c => c.type === "image")).toHaveLength(3);
    expect(prepared.prompt).not.toContain("base64");
    expect(prepared.prompt).toContain('"image_number":3');
    await prepared.cleanup();
  });
  test("long chats with many screenshots send only the newest 20 images", async () => {
    const input = Array.from({ length: 25 }, () => ({ role: "user", content: [{ type: "input_image", image_url: png }] }));
    // Older images are not even decoded, so a broken old screenshot cannot fail the turn.
    (input[0].content[0] as any).image_url = "data:image/png;base64,%%%";
    const prepared = await prepareClaudePrompt({ model: "sonnet", input });
    expect(prepared.content.filter(c => c.type === "image")).toHaveLength(20);
    expect(prepared.prompt.match(/image_omitted/g)).toHaveLength(5);
    expect(prepared.prompt).toContain('"image_number":20');
    expect(prepared.prompt).not.toContain('"image_number":21');
    await prepared.cleanup();
  });
  test("never fetches remote, file or malformed images, and describes them instead of failing the turn", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:1234", "file:///etc/passwd", "data:image/png;base64,%%%"]) {
      const prepared = await prepareClaudePrompt({ model: "sonnet", input: [{ role: "user", content: [{ type: "input_image", image_url: url }] }] });
      expect(prepared.content.filter(c => c.type === "image")).toHaveLength(0);
      expect(prepared.prompt).toContain("image_unavailable");
    }
  });
  test("leaves out OpenAI-hosted and unknown tools; files become documents, text or a note", async () => {
    expect(() => validateRequest({ model: "sonnet", input: "x", tools: [{ type: "web_search" }] })).not.toThrow();
    expect(toolDescriptors([{ type: "web_search" }, { type: "image_generation" }, { type: "mystery" }])).toEqual([]);
    expect(() => validateRequest({ model: "sonnet", input: "x", tools: [{ type: "mystery" }] })).not.toThrow();
    const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 test").toString("base64")}`;
    const text = `data:text/plain;base64,${Buffer.from("hello from file").toString("base64")}`;
    const prepared = await prepareClaudePrompt({ model: "sonnet", input: [{ role: "user", content: [
      { type: "input_file", file_id: "file-x" }, { type: "input_file", filename: "a.pdf", file_data: pdf }, { type: "input_file", filename: "notes.txt", file_data: text },
    ] }] });
    expect(prepared.content.filter(c => c.type === "document")).toHaveLength(1);
    expect(prepared.prompt).toContain("hello from file");
    expect(prepared.prompt).toContain("file_unavailable");
  });
  test("GPT history (reasoning, encrypted compaction, tool catalogs, metadata) is translated compactly", async () => {
    const request = { model: "opus", input: [
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "exec_js", parameters: {} }] },
      { role: "user", content: "start" },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Plan: read the file" }], encrypted_content: "gAAAA-secret-blob" },
      { type: "compaction", id: "cmp_1", encrypted_content: "gAAAA-other-blob" },
      { type: "message", id: "msg_1", status: "completed", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "done", annotations: [], logprobs: [] }], internal_chat_message_metadata_passthrough: { turn_id: "t" } },
    ] };
    expect(() => validateRequest(request)).not.toThrow();
    expect(allTools(request).map(t => t.name)).not.toContain("exec_js");
    const prompt = (await prepareClaudePrompt(request)).prompt;
    expect(prompt).toContain("Plan: read the file");
    expect(prompt).toContain("compacted_history");
    for (const noise of ["gAAAA", "additional_tools", "internal_chat_message_metadata_passthrough", "logprobs", "msg_1", "rs_1"]) expect(prompt).not.toContain(noise);
  });
  test("enforces no tools, required tools and no parallel calls", () => {
    const request = { model: "sonnet", input: "x", tools };
    expect(() => validateToolCalls({ ...request, tool_choice: "none" }, [{ name: "lookup", arguments: "{}" }])).toThrow();
    expect(() => validateToolCalls({ ...request, tool_choice: "required" }, [])).toThrow();
    expect(() => validateToolCalls({ ...request, parallel_tool_calls: false }, [{ name: "lookup", arguments: "{}" }, { name: "lookup", arguments: "{}" }])).toThrow();
    expect(() => validateToolCalls(request, [{ name: "lookup", arguments: "not-json" }])).toThrow();
    expect(() => validateToolCalls(request, [{ name: "unknown", arguments: "{}" }])).toThrow();
    expect(JSON.stringify(outputSchema(tools, { ...request, tool_choice: "none" }))).toContain('"maxItems":0');
  });
  test("rejects malformed messages and tolerates GPT-only effort levels", () => {
    for (const value of [{ input: "x" }, { model: "sonnet", input: [null] }, { model: "sonnet", input: "x", stream: "yes" }, { model: "sonnet", input: "x", reasoning: "high" }]) expect(() => validateRequest(value)).toThrow();
    for (const effort of ["ultra", "minimal", "none", "future-level"]) expect(() => validateRequest({ model: "opus", input: "x", reasoning: { effort } })).not.toThrow();
  });
  test("moves stable developer context and tools into the cacheable system prompt", () => {
    const request = { model: "sonnet", tools, input: [{ role: "developer", content: [{ type: "input_text", text: "dev rules" }] }, { role: "user", content: "question" }, { role: "developer", content: "later note" }] };
    const split = splitConversation(request);
    expect(split.context).toEqual(["dev rules"]);
    expect(split.items).toHaveLength(2);
    const system = systemPrompt("BASE", request);
    expect(system).toContain("dev rules");
    expect(system).toContain('"proxyName":"lookup"');
    expect(system).not.toContain("question");
  });
  test("tools from tool_search output become callable", () => {
    const request = { model: "sonnet", tools: [{ type: "tool_search" }], input: [{ type: "tool_search_output", call_id: "s1", tools: [{ type: "namespace", name: "gmail", tools }] }, { type: "tool_search_output", call_id: "s2", tools: [{ type: "namespace", name: "gmail", tools }] }] };
    expect(allTools(request).map(t => t.proxyName)).toEqual(["__codex_tool_search", "gmail.lookup"]);
    expect(() => validateToolCalls(request, [{ name: "gmail.lookup", arguments: "{}" }])).not.toThrow();
    // The schema must stay identical so Claude's prompt cache survives tool discovery.
    expect(JSON.stringify(outputSchema(request.tools, request))).toBe(JSON.stringify(outputSchema(request.tools, { ...request, input: [] })));
    const calls = [{ name: "lookup", arguments: "{}" }];
    validateToolCalls(request, calls);
    expect(calls[0].name).toBe("gmail.lookup");
  });
});
