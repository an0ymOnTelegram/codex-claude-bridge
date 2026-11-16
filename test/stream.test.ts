import { describe, expect, test } from "bun:test";
import { streamInference } from "../src/responses";
const output = { text: "Finished", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
describe("SSE lifecycle", () => {
  test("opens immediately and preserves one response ID", async () => {
    let finish!: (value: typeof output) => void;
    const response = streamInference({ model: "sonnet", input: "x" }, () => new Promise(resolve => { finish = resolve; }));
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("response.created");
    finish(output);
    let rest = "";
    while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
    expect(rest).not.toContain('"type":"response.created"');
    const firstId = /"id":"(resp_[^"]+)"/.exec(first)![1];
    expect(rest).toContain(firstId);
    expect(rest).toContain("response.completed");
  });
  test("propagates client cancellation to inference", async () => {
    let aborted = false;
    const response = streamInference({ model: "sonnet", input: "x" }, signal => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); })));
    await response.body!.cancel();
    expect(aborted).toBe(true);
  });
  test("reports provider failures without pretending completion", async () => {
    const response = streamInference({ model: "sonnet", input: "x" }, async () => { throw new Error("subscription unavailable"); });
    const body = await response.text();
    expect(body).toContain("response.failed");
    expect(body).not.toContain("response.completed");
  });
});
