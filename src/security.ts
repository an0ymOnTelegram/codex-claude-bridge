import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export class ProxyError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_request") { super(message); }
}

/** Upper limit for relayed GPT requests (they may carry many images). */
export const MAX_BODY_BYTES = 128 * 1024 * 1024;
/** Upper limit for requests answered by Claude. */
export const MAX_CLAUDE_BODY_BYTES = 32 * 1024 * 1024;

export function accountDirectory(): string {
  return process.env.CLAUDE_SUBSCRIPTION_DIR || join(homedir(), ".codex", "integrations", "claude-subscription", "account");
}

// The official CLI owns login and token refresh. Never read its credential store.
// Do not inherit a gateway, API key, hooks, plugins or arbitrary provider flags.
export function claudeEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const permitted = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"];
  const env = Object.fromEntries(permitted.flatMap((key) => source[key] ? [[key, source[key]!]] : []));
  return { ...env, CLAUDE_CONFIG_DIR: accountDirectory() };
}

export function authorize(request: Request): void {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new ProxyError("Loopback requests only", 403);
  // This endpoint is for the local Codex process, not web pages.
  if (request.headers.has("origin")) throw new ProxyError("Browser-origin requests are not allowed", 403);
  const key = process.env.PROXY_API_KEY;
  if (!key || key.length < 32) throw new ProxyError("Configure a PROXY_API_KEY of at least 32 characters", 503, "not_configured");
  // Combined provider: Authorization carries the ChatGPT login for OpenAI, so
  // the local key travels in its own header. The legacy /v1 route uses Bearer.
  const header = request.headers.get("x-claude-proxy-key");
  const expected = Buffer.from(header === null ? `Bearer ${key}` : key);
  const actual = Buffer.from(header ?? request.headers.get("authorization") ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ProxyError("Invalid API key", 401, "unauthorized");
}

export async function readBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("content-length")) > limit) throw new ProxyError("Request body too large", 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new ProxyError("Request body too large", 413);
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new ProxyError("Content-Type must be application/json", 415);
  if (!request.body) throw new ProxyError("Request body is required");
  const body = await readBody(request, MAX_CLAUDE_BODY_BYTES);
  try { return JSON.parse(Buffer.from(body).toString("utf8")); }
  catch { throw new ProxyError("Request body must be valid JSON"); }
}
