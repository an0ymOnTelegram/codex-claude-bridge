import { ProxyError } from "./security";
import { isOpenAICiphertext } from "./request";
import { saveOpenAICatalog, openAICatalogAge } from "./models";

// Codex sends its ChatGPT login with every request to this provider. GPT
// requests are relayed unchanged to the ChatGPT Codex backend: the proxy only
// streams them through and never stores the credential.
export const upstreamBase = () => (process.env.CHATGPT_UPSTREAM || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");

const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "content-length", "accept-encoding", "x-claude-proxy-key", "origin", "referer", "cookie"]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie", "alt-svc"]);

export function upstreamUrl(subpath: string, search: string): URL {
  const base = new URL(upstreamBase());
  const target = new URL(upstreamBase() + subpath + search);
  if (target.origin !== base.origin || !(target.pathname === base.pathname || target.pathname.startsWith(`${base.pathname}/`))) {
    throw new ProxyError("Invalid upstream path", 400);
  }
  return target;
}

function forwardHeaders(request: Request, rewritten: boolean): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => { if (!DROP_REQUEST.has(key.toLowerCase()) && !(rewritten && key.toLowerCase() === "content-encoding")) headers.set(key, value); });
  headers.set("accept-encoding", "identity");
  return headers;
}

/**
 * A Claude agent's message to a GPT sub-agent arrives as plain text in an
 * "encrypted_content" part, which OpenAI would try to decrypt. Such parts are
 * sent as ordinary text instead. Returns true when the request was changed.
 */
export function plainTextForOpenAI(body: unknown): boolean {
  const input = (body as { input?: unknown })?.input;
  if (!Array.isArray(input)) return false;
  let changed = false;
  for (const item of input) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    content.forEach((part, index) => {
      const value = (part as { type?: unknown; encrypted_content?: unknown })?.encrypted_content;
      if ((part as { type?: unknown })?.type === "encrypted_content" && typeof value === "string" && !isOpenAICiphertext(value)) {
        content[index] = { type: "input_text", text: value };
        changed = true;
      }
    });
  }
  return changed;
}

export async function forward(request: Request, subpath: string, body?: Uint8Array<ArrayBuffer>, rewritten = false): Promise<Response> {
  const source = new URL(request.url);
  const target = upstreamUrl(subpath, source.search);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method, headers: forwardHeaders(request, rewritten), redirect: "manual", signal: request.signal,
      ...(body && body.length && !["GET", "HEAD"].includes(request.method) ? { body } : {}),
    });
  } catch (cause) {
    if (request.signal.aborted) throw new ProxyError("Request cancelled", 499, "cancelled");
    throw new ProxyError(`ChatGPT is not reachable: ${cause instanceof Error ? cause.message : cause}`, 502, "upstream_unreachable");
  }
  const headers = new Headers();
  upstream.headers.forEach((value, key) => { if (!DROP_RESPONSE.has(key.toLowerCase())) headers.set(key, value); });
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

let refreshing: Promise<void> | undefined;

/** Keep the GPT part of the model menu current, using the login of a request that is already in flight. */
export function refreshOpenAICatalog(request: Request): void {
  if (refreshing || openAICatalogAge() < 6 * 3_600_000) return;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return;
  const version = /\/(\d+\.\d+\.\d+)/.exec(request.headers.get("user-agent") ?? "")?.[1];
  if (!version) return;
  const headers = new Headers();
  for (const key of ["authorization", "chatgpt-account-id", "originator", "user-agent", "version"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set("accept", "application/json");
  headers.set("accept-encoding", "identity");
  refreshing = (async () => {
    try {
      const response = await fetch(upstreamUrl("/models", `?client_version=${encodeURIComponent(version)}`), { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return;
      const body = await response.json() as { models?: unknown };
      if (Array.isArray(body.models)) await saveOpenAICatalog(body.models, version);
    } catch { /* The menu keeps its previous GPT entries. */ }
    finally { refreshing = undefined; }
  })();
}
