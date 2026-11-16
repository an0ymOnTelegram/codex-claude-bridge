import type { Server } from "bun";
import { compactClaude, isClaudeModel, runClaude, resolveModel, workerStats } from "./claude";
import { forward, plainTextForOpenAI, refreshOpenAICatalog } from "./hybrid";
import { combinedCatalog, discoverModels, toCodexCatalog } from "./models";
import { validateRequest } from "./request";
import { responseObject, streamInference } from "./responses";
import { authorize, MAX_BODY_BYTES, MAX_CLAUDE_BODY_BYTES, ProxyError, readBody, readJson } from "./security";
import type { ResponseInputItem, ResponsesRequest } from "./types";
import { version } from "../package.json";

const HYBRID_PREFIX = "/chatgpt";

function noTimeout(request: Request, server?: Server<unknown>): void {
  // Long reasoning streams must not be cut by the HTTP idle timeout.
  try { server?.timeout(request, 0); } catch {}
}

// Recent Claude responses, so a client that sends previous_response_id with
// only the new input still gets the full conversation (bounded, in memory).
const MAX_STORED = 64;
const stored = new Map<string, ResponseInputItem[]>();
function remember(body: ResponsesRequest, response: ReturnType<typeof responseObject>): void {
  // Codex sends store:false and always the full history; nothing is kept then.
  if (body.store === false) return;
  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : body.input;
  stored.set(response.id, [...input, ...(response.output as ResponseInputItem[])]);
  while (stored.size > MAX_STORED) stored.delete(stored.keys().next().value!);
}
function withHistory(body: ResponsesRequest): ResponsesRequest {
  if (!body.previous_response_id) return body;
  const history = stored.get(body.previous_response_id);
  if (!history) throw new ProxyError("previous_response_id is unknown to the local Claude provider; send the full conversation", 400, "previous_response_not_found");
  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : body.input;
  return { ...body, previous_response_id: undefined, input: [...history, ...input] };
}

function claudeResponse(raw: ResponsesRequest, request: Request, server?: Server<unknown>): Response | Promise<Response> {
  const body = withHistory(raw);
  resolveModel(body.model);
  noTimeout(request, server);
  if (body.stream) return streamInference(body, (signal, onText) => runClaude(body, signal, onText), request.signal, response => remember(body, response));
  return runClaude(body, request.signal).then(output => {
    const response = responseObject(body, output);
    remember(body, response);
    return Response.json(response);
  });
}

async function claudeCompaction(body: ResponsesRequest, request: Request, server?: Server<unknown>): Promise<Response> {
  resolveModel(body.model);
  noTimeout(request, server);
  const result = await compactClaude(withHistory(body), request.signal);
  return Response.json({
    output: result.output,
    usage: { input_tokens: result.usage.inputTokens, input_tokens_details: { cached_tokens: result.usage.cachedTokens ?? 0 }, output_tokens: result.usage.outputTokens, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: result.usage.totalTokens },
  });
}

function decode(bytes: Uint8Array<ArrayBuffer>, encoding: string | null): Uint8Array {
  const kind = encoding?.trim().toLowerCase();
  if (!kind || kind === "identity") return bytes;
  try {
    if (kind === "zstd") return Bun.zstdDecompressSync(bytes);
    if (kind === "gzip") return Bun.gunzipSync(bytes);
    if (kind === "deflate") return Bun.inflateSync(bytes);
  } catch { throw new ProxyError("Request body could not be decompressed", 400); }
  throw new ProxyError(`Unsupported content-encoding: ${kind}`, 415);
}

async function hybrid(request: Request, subpath: string, server?: Server<unknown>): Promise<Response> {
  let body = ["GET", "HEAD"].includes(request.method) ? undefined : await readBody(request, MAX_BODY_BYTES);
  let rewritten = false;
  if (request.method === "POST" && (subpath === "/responses" || subpath === "/responses/compact")) {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(decode(body!, request.headers.get("content-encoding")))); } catch (cause) {
      if (cause instanceof ProxyError) throw cause;
      parsed = undefined;
    }
    const model = (parsed as { model?: unknown } | undefined)?.model;
    if (process.env.CLAUDE_PROXY_DUMP_DIR && parsed) {
      try { await Bun.write(`${process.env.CLAUDE_PROXY_DUMP_DIR}/${Date.now()}-${String(model)}${subpath.replaceAll("/", "_")}.json`, JSON.stringify(parsed)); } catch {}
    }
    if (isClaudeModel(model)) {
      if (body!.length > MAX_CLAUDE_BODY_BYTES) throw new ProxyError("Request body too large", 413);
      if (subpath === "/responses/compact") return claudeCompaction(validateRequest(parsed), request, server);
      return claudeResponse(validateRequest(parsed), request, server);
    }
    refreshOpenAICatalog(request);
    if (parsed && plainTextForOpenAI(parsed)) {
      body = new Uint8Array(Buffer.from(JSON.stringify(parsed)));
      rewritten = true;
    }
  }
  noTimeout(request, server);
  return forward(request, subpath, body, rewritten);
}

export async function handleRequest(request: Request, server?: Server<unknown>): Promise<Response> {
  try {
    authorize(request);
    const url = new URL(request.url);
    if (url.pathname === HYBRID_PREFIX || url.pathname.startsWith(`${HYBRID_PREFIX}/`)) return await hybrid(request, url.pathname.slice(HYBRID_PREFIX.length), server);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok", version, provider: "chatgpt+claude-code-subscription", workers: workerStats() });
    if (request.method === "GET" && url.pathname === "/v1/models") {
      const modelCatalog = toCodexCatalog(await discoverModels());
      return Response.json({ models: modelCatalog, object: "list", data: modelCatalog.map(model => ({ id: model.slug, object: "model", created: 0, owned_by: "anthropic-subscription" })) });
    }
    if (request.method === "GET" && url.pathname === "/catalog") return Response.json({ models: await combinedCatalog() });
    if (request.method === "POST" && url.pathname === "/v1/responses/compact") return await claudeCompaction(validateRequest(await readJson(request)), request, server);
    if (request.method !== "POST" || url.pathname !== "/v1/responses") throw new ProxyError("Not found", 404);
    return await claudeResponse(validateRequest(await readJson(request)), request, server);
  } catch (cause) {
    const status = cause instanceof ProxyError ? cause.status : 502;
    const message = cause instanceof Error ? cause.message : "Claude request failed";
    return Response.json({ error: { message, type: status < 500 ? "invalid_request_error" : "server_error", code: cause instanceof ProxyError ? cause.code : "upstream_error" } }, { status });
  }
}
