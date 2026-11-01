/** Wire types intentionally target the verified Qwen 3.8 Shared Inference contract. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export interface TextPart { type: 'text'; text: string }
export interface ImagePart { type: 'image_url'; image_url: { url: string } }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface AssistantMessage {
  role: 'assistant'; content?: string | null; reasoning?: string | null; name?: string;
  tool_calls?: ToolCall[] | null;
}
export type Message =
  | { role: 'system' | 'developer'; content: string | TextPart[]; name?: string }
  | { role: 'user'; content: string | (TextPart | ImagePart)[]; name?: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string | TextPart[]; name?: string };
export interface FunctionTool {
  type: 'function'; function: { name: string; description?: string; parameters: JsonSchema; strict?: boolean };
}
export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
export type ResponseFormat = { type: 'text' } | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; description?: string; schema: JsonSchema; strict?: boolean } };
export interface ChatRequest {
  messages: Message[];
  /** Shared Inference model is fixed; omit this or supply the exact ID. */
  model?: 'qwen-3.8-27b';
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high';
  /** Qwen raw is accepted but still returns separated reasoning. Hidden is unsupported. */
  reasoning_format?: 'parsed' | 'raw' | 'none';
  clear_thinking?: boolean;
  max_completion_tokens?: number;
  min_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  seed?: number;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: 1;
  tools?: FunctionTool[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: ResponseFormat;
  prompt_cache_key?: string;
  user?: string;
}
export interface Usage {
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; image_tokens?: number; [key: string]: unknown };
  completion_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}
export interface TokenLogprob {
  token: string; logprob: number; bytes?: number[] | null;
  top_logprobs?: { token: string; logprob: number; bytes?: number[] | null }[];
}
export interface ChoiceLogprobs { content?: TokenLogprob[] | null; reasoning?: TokenLogprob[] | null }
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | (string & {});
export interface ChatCompletion {
  id: string; object: 'chat.completion'; created: number; model: string;
  choices: { index: number; message: AssistantMessage; finish_reason: FinishReason; logprobs?: ChoiceLogprobs | null; reasoning_logprobs?: unknown }[];
  usage?: Usage; system_fingerprint?: string | null; time_info?: Record<string, number>;
  [key: string]: unknown;
}
export interface ToolCallDelta {
  index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string };
}
export interface ChatChunk {
  id: string; object: 'chat.completion.chunk'; created: number; model: string;
  choices: { index: number; delta: { role?: 'assistant'; content?: string | null; reasoning?: string | null; tool_calls?: ToolCallDelta[] }; finish_reason?: FinishReason | null; logprobs?: ChoiceLogprobs | null; reasoning_logprobs?: unknown }[];
  usage?: Usage | null; system_fingerprint?: string | null; time_info?: Record<string, number>;
  [key: string]: unknown;
}
export interface ModelInfo { id: string; object: 'model'; created: number; owned_by: string; [key: string]: unknown }
export interface ModelList { object: 'list'; data: ModelInfo[] }
export interface RequestOptions { signal?: AbortSignal; /** Total deadline including stream/body consumption and retries. */ timeoutMs?: number }
export interface ClientOptions {
  apiKey: string;
  /** Must be an HTTPS /v1 endpoint. Explicitly trusted by the caller to receive the key. */
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Defaults to 0: retries may duplicate billable inference. Only explicit retryable HTTP responses are retried. */
  maxRetries?: number;
  /** Defaults to free-trial limits. Selecting paid asserts account capacity; does not upgrade it. */
  capacity?: 'free-trial' | 'paid';
}
export interface CerebrasClient {
  complete(request: ChatRequest, options?: RequestOptions): Promise<ChatCompletion>;
  stream(request: ChatRequest, options?: RequestOptions): AsyncGenerator<ChatChunk, void, unknown>;
  generateText(prompt: string, parameters?: Omit<ChatRequest, 'messages'>, options?: RequestOptions): Promise<ChatCompletion>;
  generateJson<T>(request: ChatRequest, validate: (value: unknown) => T, options?: RequestOptions): Promise<{ data: T; completion: ChatCompletion }>;
  listModels(options?: RequestOptions): Promise<ModelList>;
  retrieveModel(options?: RequestOptions): Promise<ModelInfo>;
}
