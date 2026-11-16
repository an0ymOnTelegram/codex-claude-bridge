export type ResponseTool = {
  type: string;
  name?: string;
  namespace?: string;
  description?: string;
  parameters?: unknown;
  format?: unknown;
  tools?: ResponseTool[];
  [key: string]: unknown;
};

export type ResponseContentPart = {
  type?: string;
  text?: string;
  image_url?: string;
  file_id?: string;
  [key: string]: unknown;
};

export type ResponseInputItem = {
  type?: string;
  role?: string;
  content?: string | ResponseContentPart[];
  name?: string;
  call_id?: string;
  arguments?: string;
  input?: string;
  output?: string | unknown;
  tools?: unknown[];
  execution?: string;
  status?: string;
  action?: unknown;
  actions?: unknown[];
  namespace?: string;
  proxy_image_paths?: string[];
  [key: string]: unknown;
};

export type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: string | ResponseInputItem[];
  tools?: ResponseTool[];
  tool_choice?: unknown;
  stream?: boolean;
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string };
  prompt_cache_key?: string;
  client_metadata?: Record<string, unknown>;
  previous_response_id?: string;
  store?: boolean;
  include?: unknown[];
};

export type ClaudeContent = { type: "text"; text: string } | {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
} | {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
  title?: string;
};

export type ClaudeResult = {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  structured_output?: {
    text: string;
    tool_calls: Array<{ name: string; arguments: string }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Usage of the last API call in the turn (the real context size). */
  context_usage?: ClaudeResult["usage"];
};

export type ProxyOutput = {
  text: string;
  toolCalls: Array<{ name: string; arguments: string; callId?: string }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; cachedTokens?: number };
};
