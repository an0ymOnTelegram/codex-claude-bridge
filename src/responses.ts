import type { ProxyOutput, ResponsesRequest } from "./types";
import { allTools, COMPUTER_TOOL_NAME, findTool, TOOL_SEARCH_NAME } from "./request";
import { ProxyError } from "./security";

type OutputItem = Record<string, unknown>;

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function outputItems(request: ResponsesRequest, output: ProxyOutput, messageId?: string): OutputItem[] {
  const items: OutputItem[] = [];
  if (output.text || messageId) {
    const commentary = output.toolCalls.length > 0;
    items.push({
      id: messageId ?? id("msg"), type: "message", status: "completed", role: "assistant",
      // GPT models mark progress text vs. the final answer with `phase`.
      channel: commentary ? "commentary" : "final", phase: commentary ? "commentary" : "final_answer",
      content: [{ type: "output_text", annotations: [], text: output.text }],
    });
  }
  const descriptors = allTools(request);
  for (const call of output.toolCalls) {
    const descriptor = findTool(descriptors, call.name);
    if (call.name === TOOL_SEARCH_NAME || descriptor?.type === "tool_search") {
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(call.arguments);
      } catch {
        throw new Error("Tool search arguments must be valid JSON");
      }
      if (!argumentsValue || typeof argumentsValue !== "object" || typeof (argumentsValue as { query?: unknown }).query !== "string") {
        throw new Error("Tool search arguments must include a query string");
      }
      items.push({
        id: id("ts"), type: "tool_search_call", status: "completed",
        call_id: call.callId ?? id("call"), execution: "client", arguments: argumentsValue,
      });
      continue;
    }
    if (call.name === COMPUTER_TOOL_NAME || descriptor?.type === "computer") {
      let action: unknown;
      try {
        action = JSON.parse(call.arguments);
      } catch {
        throw new Error("Computer tool arguments must be valid JSON");
      }
      const batched = action && typeof action === "object" && Array.isArray((action as { actions?: unknown }).actions)
        ? (action as { actions: unknown[] }).actions
        : undefined;
      items.push({
        id: id("cu"), type: "computer_call", status: "completed",
        call_id: call.callId ?? id("call"), pending_safety_checks: [],
        ...(batched ? { actions: batched } : { action }),
      });
      continue;
    }
    if (descriptor?.type === "custom") {
      items.push({
        id: id("ctc"), type: "custom_tool_call", status: "completed",
        call_id: call.callId ?? id("call"), name: descriptor.name, namespace: descriptor.namespace, input: call.arguments,
      });
      continue;
    }
    items.push({
      id: id("fc"), type: "function_call", status: "completed",
      call_id: call.callId ?? id("call"), name: descriptor?.name ?? call.name, namespace: descriptor?.namespace, arguments: call.arguments,
    });
  }
  return items;
}

export function responseObject(request: ResponsesRequest, output: ProxyOutput, messageId?: string) {
  return {
    id: id("resp"), object: "response", created_at: Math.floor(Date.now() / 1000),
    status: "completed", error: null, incomplete_details: null,
    model: request.model, output: outputItems(request, output, messageId), parallel_tool_calls: request.parallel_tool_calls !== false,
    tool_choice: request.tool_choice ?? "auto", tools: request.tools ?? [],
    usage: {
      input_tokens: output.usage.inputTokens,
      input_tokens_details: { cached_tokens: output.usage.cachedTokens ?? 0 },
      output_tokens: output.usage.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: output.usage.totalTokens,
    },
  };
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Event writer for one response. When the message text was already streamed
 * as deltas, `streamed` holds its index so it is completed instead of re-added.
 */
function responseEvents(response: ReturnType<typeof responseObject>, sequence: { next: number }, streamed?: { itemId: string; text: string }): string[] {
  const chunks: string[] = [];
  const seq = () => sequence.next++;
  response.output.forEach((item, outputIndex) => {
    const alreadyOpen = streamed && item.id === streamed.itemId;
    if (!alreadyOpen) {
      const inProgress: OutputItem = { ...item, status: "in_progress" };
      if (item.type === "message") inProgress.content = [];
      if (item.type === "function_call") inProgress.arguments = "";
      if (item.type === "custom_tool_call") inProgress.input = "";
      chunks.push(sse("response.output_item.added", { type: "response.output_item.added", sequence_number: seq(), output_index: outputIndex, item: inProgress }));
    }
    if (item.type === "message") {
      const part = (item.content as Array<Record<string, unknown>>)[0];
      const text = String(part.text ?? "");
      if (!alreadyOpen) chunks.push(sse("response.content_part.added", { type: "response.content_part.added", sequence_number: seq(), item_id: item.id, output_index: outputIndex, content_index: 0, part: { ...part, text: "" } }));
      // Send whatever was not streamed yet (all of it, or the rest after a corrected retry).
      const missing = alreadyOpen ? (text.startsWith(streamed!.text) ? text.slice(streamed!.text.length) : "") : text;
      if (missing) chunks.push(sse("response.output_text.delta", { type: "response.output_text.delta", sequence_number: seq(), item_id: item.id, output_index: outputIndex, content_index: 0, delta: missing }));
      chunks.push(sse("response.output_text.done", { type: "response.output_text.done", sequence_number: seq(), item_id: item.id, output_index: outputIndex, content_index: 0, text }));
      chunks.push(sse("response.content_part.done", { type: "response.content_part.done", sequence_number: seq(), item_id: item.id, output_index: outputIndex, content_index: 0, part }));
    } else if (item.type === "function_call") {
      chunks.push(sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", sequence_number: seq(), item_id: item.id, output_index: outputIndex, delta: item.arguments }));
      chunks.push(sse("response.function_call_arguments.done", { type: "response.function_call_arguments.done", sequence_number: seq(), item_id: item.id, output_index: outputIndex, arguments: item.arguments }));
    } else if (item.type === "custom_tool_call") {
      chunks.push(sse("response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", sequence_number: seq(), item_id: item.id, call_id: item.call_id, output_index: outputIndex, delta: item.input }));
      chunks.push(sse("response.custom_tool_call_input.done", { type: "response.custom_tool_call_input.done", sequence_number: seq(), item_id: item.id, call_id: item.call_id, output_index: outputIndex, input: item.input }));
    }
    chunks.push(sse("response.output_item.done", { type: "response.output_item.done", sequence_number: seq(), output_index: outputIndex, item }));
  });
  chunks.push(sse("response.completed", { type: "response.completed", sequence_number: seq(), response }));
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

const streamHeaders = { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" };

export function streamResponse(response: ReturnType<typeof responseObject>): Response {
  const sequence = { next: 0 };
  const created = sse("response.created", { type: "response.created", sequence_number: sequence.next++, response: { ...response, status: "in_progress", output: [], usage: null } });
  return new Response(created + responseEvents(response, sequence).join(""), { headers: streamHeaders });
}

export type InferenceRunner = (signal: AbortSignal, onText: (delta: string) => void) => Promise<ProxyOutput>;

// Open SSE immediately. Reply text streams as Claude writes it; tool calls
// follow once the structured result is complete. Heartbeats prevent timeouts.
// Closing the stream cancels the paid request.
export function streamInference(request: ResponsesRequest, run: InferenceRunner, outerSignal?: AbortSignal, onComplete?: (response: ReturnType<typeof responseObject>) => void): Response {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  outerSignal?.addEventListener("abort", onAbort, { once: true });
  if (outerSignal?.aborted) abort.abort();
  const initial = responseObject(request, { text: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  const encoder = new TextEncoder();
  const sequence = { next: 0 };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => { if (!closed) controller.enqueue(encoder.encode(chunk)); };
      send(sse("response.created", { type: "response.created", sequence_number: sequence.next++, response: { ...initial, status: "in_progress", usage: null } }));
      heartbeat = setInterval(() => send(": keep-alive\n\n"), 15_000);
      let streamed: { itemId: string; text: string } | undefined;
      const onText = (delta: string) => {
        if (!delta || closed) return;
        if (!streamed) {
          streamed = { itemId: id("msg"), text: "" };
          const item = { id: streamed.itemId, type: "message", status: "in_progress", role: "assistant", content: [] };
          send(sse("response.output_item.added", { type: "response.output_item.added", sequence_number: sequence.next++, output_index: 0, item }));
          send(sse("response.content_part.added", { type: "response.content_part.added", sequence_number: sequence.next++, item_id: streamed.itemId, output_index: 0, content_index: 0, part: { type: "output_text", annotations: [], text: "" } }));
        }
        streamed.text += delta;
        send(sse("response.output_text.delta", { type: "response.output_text.delta", sequence_number: sequence.next++, item_id: streamed.itemId, output_index: 0, content_index: 0, delta }));
      };
      void (async () => {
        try {
          const output = await run(abort.signal, onText);
          const response = { ...responseObject(request, output, streamed?.itemId), id: initial.id, created_at: initial.created_at };
          for (const chunk of responseEvents(response, sequence, streamed)) send(chunk);
          onComplete?.(response);
        } catch (cause) {
          const error = { code: cause instanceof ProxyError ? cause.code : "upstream_error", message: cause instanceof Error ? cause.message : "Claude request failed" };
          send(sse("response.failed", { type: "response.failed", sequence_number: sequence.next++, response: { ...initial, status: "failed", error } }));
          send("data: [DONE]\n\n");
        } finally {
          clearInterval(heartbeat);
          outerSignal?.removeEventListener("abort", onAbort);
          if (!closed) { closed = true; controller.close(); }
        }
      })();
    },
    cancel() { closed = true; clearInterval(heartbeat); outerSignal?.removeEventListener("abort", onAbort); abort.abort(); },
  });
  return new Response(stream, { headers: streamHeaders });
}
