#!/usr/bin/env bun
import { handleRequest } from "./app";
import { stopAllWorkers } from "./claude";
import { writeCombinedCatalog } from "./models";
import { MAX_BODY_BYTES } from "./security";

const hostname = "127.0.0.1";
const port = Number(process.env.PORT ?? 3456);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be between 1024 and 65535");
if (!process.env.PROXY_API_KEY || process.env.PROXY_API_KEY.length < 32) throw new Error("PROXY_API_KEY must contain at least 32 characters");
if (!process.env.CLAUDE_SUBSCRIPTION_DIR || !process.env.CLAUDE_CWD) throw new Error("Set CLAUDE_SUBSCRIPTION_DIR and CLAUDE_CWD to isolated directories");
const server = Bun.serve({ hostname, port, maxRequestBodySize: MAX_BODY_BYTES, idleTimeout: 120, fetch: handleRequest });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopAllWorkers(); void server.stop(true); process.exit(0); });
console.log(`ChatGPT + Claude provider listening at ${server.url}`);
// Refresh the Codex model menu once the Claude model list is known.
writeCombinedCatalog().then(count => console.log(`Model menu written (${count} models)`), cause => console.error(`Model menu not written: ${cause instanceof Error ? cause.message : cause}`));
